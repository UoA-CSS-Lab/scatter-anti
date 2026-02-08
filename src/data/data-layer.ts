import type { ParquetData, ParquetReader } from './repository.js';
import { createParquetReader } from './repository.js';
import type { WhereCondition, ScatterPlotError } from '../types.js';
import { createError } from '../errors.js';
import type { AllPointsData } from '../renderer/gpu-layer.js';

/** DataLayer未初期化エラーメッセージ */
const ERROR_NOT_INITIALIZED = 'DataLayer not initialized. Call initialize() first.';

/**
 * DataLayerの設定オプション
 */
export interface DataLayerOptions {
  /** ポイントサイズを計算するSQL式 */
  sizeSql?: string;
  /** ポイント色を計算するSQL式（ARGB形式） */
  colorSql?: string;
  /** データフィルタリング用のWHERE条件 */
  whereConditions?: WhereCondition[];
  /** GPUでフィルタリングするカラム名（最大4つ） */
  gpuFilterColumns?: string[];
  /** エラーをScatterPlotに通知するためのコールバック */
  onError?: (error: ScatterPlotError) => void;
  /** データ変更時に呼び出されるコールバック */
  onDataChanged?: () => void;
  /** WHERE条件変更時にビジビリティフラグ更新が必要な場合のコールバック */
  onVisibilityChanged?: () => void;
}

/**
 * 現在表示中のポイントデータ（ポイント検索用）
 */
interface PointData {
  /** rowid (インデックス) */
  rowid: number;
  x: number;
  y: number;
  size: number;
}

/**
 * データ取得とクエリ管理を担当するレイヤー
 * 責務:
 * - ParquetReaderを介したParquetデータの読み込みと管理
 * - 全データをGPU用フォーマットに変換
 * - データ変更の検知と通知
 */
export class DataLayer {
  /** Parquetデータへのアクセスを提供するリポジトリ */
  private repository: ParquetReader | null = null;
  /** ポイントサイズのSQL式 */
  private sizeSql: string = '3';
  /** ポイント色のSQL式（ARGB形式: a=0.3, r=0.3, g=0.3, b=0.8） */
  private colorSql: string = '0x4D4D4DCC';
  /** フィルタリング用のWHERE条件 */
  private whereConditions: WhereCondition[] = [];
  /** GPUでフィルタリングするカラム名 */
  private gpuFilterColumns: string[] = [];
  /** エラー通知用コールバック */
  private onError?: (error: ScatterPlotError) => void;
  /** データ変更通知用コールバック */
  private onDataChanged?: () => void;
  /** WHERE条件変更時のビジビリティ更新コールバック */
  private onVisibilityChanged?: () => void;

  /** 全ポイントデータのキャッシュ（ポイント検索用） */
  private allPointsCache: PointData[] = [];
  /** 全ポイント数のキャッシュ（ビジビリティフラグ生成用） */
  private totalPointCount: number = 0;

  /**
   * DataLayerインスタンスを作成する
   * @param options 設定オプション
   */
  constructor(options: DataLayerOptions) {
    this.sizeSql = options.sizeSql ?? this.sizeSql;
    this.colorSql = options.colorSql ?? this.colorSql;
    this.whereConditions = options.whereConditions ?? [];
    this.gpuFilterColumns = options.gpuFilterColumns ?? [];
    this.onError = options.onError;
    this.onDataChanged = options.onDataChanged;
    this.onVisibilityChanged = options.onVisibilityChanged;
  }

  /**
   * データレイヤーを初期化し、データを読み込む
   * @param dataUrl Parquetファイルのurl
   * @returns 処理済みの全データ
   */
  async initialize(dataUrl: string): Promise<AllPointsData> {
    this.repository = await createParquetReader();
    await this.repository.loadParquetFromUrl(dataUrl);
    return await this.loadAllPoints();
  }

  /**
   * GeoJSONラベルデータをDuckDBテーブルに読み込む
   * @param geojson GeoJSON FeatureCollectionオブジェクト
   */
  async loadLabelData(geojson: any): Promise<void> {
    if (!this.repository) {
      throw new Error(ERROR_NOT_INITIALIZED);
    }
    await this.repository.loadGeoJson(geojson);
  }

  /**
   * 単一の条件からWHERE句文字列を構築する
   * @param condition WHERE条件
   * @returns SQL WHERE句の文字列
   */
  private buildWhereClauseString(condition: WhereCondition): string {
    if (condition.type === 'numeric') {
      return `${condition.column} ${condition.operator} ${condition.value}`;
    } else if (condition.type === 'raw') {
      return condition.sql;
    } else {
      const escapedValue = condition.value.replace(/'/g, "''");
      switch (condition.operator) {
        case 'equals':
          return `${condition.column} = '${escapedValue}'`;
        case 'contains':
          return `${condition.column} LIKE '%${escapedValue}%'`;
        case 'startsWith':
          return `${condition.column} LIKE '${escapedValue}%'`;
        case 'endsWith':
          return `${condition.column} LIKE '%${escapedValue}'`;
      }
    }
  }

  /**
   * 全データを読み込んでGPU用フォーマットに変換する
   * WHERE条件によるフィルタリングはビットフラグで行うため、ここでは適用しない
   * @returns 処理済みの全データ
   */
  async loadAllPoints(): Promise<AllPointsData> {
    if (!this.repository) {
      return {
        instanceData: new Float32Array(0),
        totalCount: 0,
      };
    }

    try {
      const sql = `SELECT x, y, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data ORDER BY rowid`;

      const data = await this.repository.query({ toString: () => sql });

      if (!data) {
        return {
          instanceData: new Float32Array(0),
          totalCount: 0,
        };
      }

      return this.processDataToGpuFormat(data);
    } catch (e) {
      if (this.onError) {
        this.onError(
          createError('QUERY_FAILED', 'Failed to load all points', {
            cause: e instanceof Error ? e : undefined,
          })
        );
      }
      return {
        instanceData: new Float32Array(0),
        totalCount: 0,
      };
    }
  }

  /**
   * GPUフィルターカラムデータを読み込む
   * @returns フィルターカラムデータとカラム数、カラムが指定されていない場合はnull
   */
  async loadGpuFilterColumns(): Promise<{
    data: Float32Array;
    columnCount: number;
    columnMapping: Map<string, number>;
  } | null> {
    if (this.gpuFilterColumns.length === 0 || !this.repository) {
      return null;
    }

    const columns = this.gpuFilterColumns.slice(0, 4);

    try {
      const columnSelects = columns
        .map((col, i) => `CAST(${col} AS DOUBLE) AS __filter_col_${i}__`)
        .join(', ');

      const sql = `SELECT ${columnSelects} FROM parquet_data`;
      const data = await this.repository.query({ toString: () => sql });

      if (!data || data.rowCount === 0) {
        return null;
      }

      const filterData = new Float32Array(data.rowCount * 4);

      for (let i = 0; i < data.rowCount; i++) {
        const baseIndex = i * 4;
        for (let j = 0; j < 4; j++) {
          if (j < columns.length) {
            const colData = data.columnData.get(`__filter_col_${j}__`);
            filterData[baseIndex + j] = colData?.get(i) ?? 0;
          } else {
            filterData[baseIndex + j] = 0;
          }
        }
      }

      const columnMapping = new Map<string, number>();
      columns.forEach((col, i) => columnMapping.set(col, i));

      return {
        data: filterData,
        columnCount: columns.length,
        columnMapping,
      };
    } catch (e) {
      if (this.onError) {
        this.onError(
          createError('QUERY_FAILED', 'Failed to load GPU filter columns', {
            cause: e instanceof Error ? e : undefined,
          })
        );
      }
      return null;
    }
  }

  /**
   * WHERE条件に基づいてビットフラグ配列を生成する
   * @returns 可視ポイントのビットマップと総ポイント数、エラー時はnull
   */
  async loadVisibilityFlags(): Promise<{
    flags: Uint32Array;
    totalCount: number;
  } | null> {
    if (!this.repository) {
      return null;
    }

    try {
      // 全ポイント数を取得（キャッシュがない場合のみ）
      let totalCount = this.totalPointCount;
      if (totalCount === 0) {
        const countResult = await this.repository.query({
          toString: () => `SELECT COUNT(*) as cnt FROM parquet_data`,
        });
        totalCount = Number(countResult?.columnData.get('cnt')?.get(0) ?? 0);
      }

      if (totalCount === 0) {
        return null;
      }

      // WHERE条件がない場合は全ポイント可視
      if (this.whereConditions.length === 0) {
        const wordCount = Math.ceil(totalCount / 32);
        const flags = new Uint32Array(wordCount);
        flags.fill(0xffffffff);
        return { flags, totalCount };
      }

      // WHERE句を構築
      const whereConditions: string[] = [];
      for (const condition of this.whereConditions) {
        whereConditions.push(this.buildWhereClauseString(condition));
      }
      const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

      // 可視ポイントのrowidを取得
      const sql = `SELECT rowid AS __idx__ FROM parquet_data ${whereClause} ORDER BY __idx__`;
      const data = await this.repository.query({ toString: () => sql });

      if (!data) {
        return null;
      }

      // ビットマップを構築（初期値は全て0=非可視）
      const wordCount = Math.ceil(totalCount / 32);
      const flags = new Uint32Array(wordCount);
      flags.fill(0);

      const idxColumn = data.columnData.get('__idx__');
      if (idxColumn) {
        for (let i = 0; i < data.rowCount; i++) {
          const idx = Number(idxColumn.get(i));
          const wordIndex = Math.floor(idx / 32);
          const bitIndex = idx % 32;
          flags[wordIndex] |= 1 << bitIndex;
        }
      }

      return { flags, totalCount };
    } catch (e) {
      if (this.onError) {
        this.onError(
          createError('QUERY_FAILED', 'Failed to load visibility flags', {
            cause: e instanceof Error ? e : undefined,
          })
        );
      }
      return null;
    }
  }

  /**
   * カスタムSQLクエリを実行する
   * @param query SQLクエリ
   * @returns クエリ結果のParquetData
   */
  async executeQuery(query: string | { toString: () => string }): Promise<ParquetData | undefined> {
    if (!this.repository) {
      return undefined;
    }
    const queryObj = typeof query === 'string' ? { toString: () => query } : query;
    return this.repository.query(queryObj);
  }

  /**
   * カラム形式のデータをGPU用インスタンスデータフォーマットに変換する
   * フォーマット: ポイントごとに [x (f32), y (f32), color (u32), size (f32)]
   * @param data ParquetData形式のデータ
   * @returns 処理済みデータ
   */
  private processDataToGpuFormat(data: ParquetData): AllPointsData {
    const xColumn = data.columnData.get('x');
    const yColumn = data.columnData.get('y');
    const sizeColumn = data.columnData.get('__size__');
    const colorColumn = data.columnData.get('__color__');

    if (!xColumn || !yColumn || !sizeColumn || !colorColumn) {
      return {
        instanceData: new Float32Array(0),
        totalCount: 0,
      };
    }

    const cachedData = new Array<PointData>(data.rowCount);

    const buffer = new ArrayBuffer(data.rowCount * 16);
    const floatView = new Float32Array(buffer);
    const uint32View = new Uint32Array(buffer);

    for (let i = 0; i < data.rowCount; i++) {
      const x = xColumn.get(i);
      const y = yColumn.get(i);
      const size = sizeColumn.get(i);
      const argbRaw = colorColumn.get(i);
      const argb = typeof argbRaw === 'bigint' ? Number(argbRaw) : argbRaw;

      const baseIndex = i * 4;
      floatView[baseIndex + 0] = x;
      floatView[baseIndex + 1] = y;
      uint32View[baseIndex + 2] = argb >>> 0;
      floatView[baseIndex + 3] = size;

      cachedData[i] = {
        rowid: i,
        x: x,
        y: y,
        size: size,
      };
    }

    this.allPointsCache = cachedData;
    this.totalPointCount = data.rowCount;

    return {
      instanceData: floatView,
      totalCount: data.rowCount,
    };
  }

  /**
   * 設定オプションを更新する
   * @param options 更新する設定オプション
   * @returns 変更の種類を示すオブジェクト
   */
  updateOptions(options: Partial<DataLayerOptions>): {
    needsFullReload: boolean;
    needsVisibilityUpdate: boolean;
    gpuFilterColumnsChanged: boolean;
  } {
    let needsFullReload = false;
    let needsVisibilityUpdate = false;
    let gpuFilterColumnsChanged = false;

    if (options.sizeSql !== undefined && options.sizeSql !== this.sizeSql) {
      this.sizeSql = options.sizeSql;
      needsFullReload = true;
    }
    if (options.colorSql !== undefined && options.colorSql !== this.colorSql) {
      this.colorSql = options.colorSql;
      needsFullReload = true;
    }
    if (options.whereConditions !== undefined) {
      const oldConditions = JSON.stringify(this.whereConditions);
      const newConditions = JSON.stringify(options.whereConditions);
      if (oldConditions !== newConditions) {
        this.whereConditions = options.whereConditions;
        // WHERE条件変更時はフルリロードではなくビジビリティ更新のみ
        needsVisibilityUpdate = true;
      }
    }
    if (options.gpuFilterColumns !== undefined) {
      const oldColumns = this.gpuFilterColumns.join(',');
      const newColumns = options.gpuFilterColumns.join(',');
      if (oldColumns !== newColumns) {
        this.gpuFilterColumns = options.gpuFilterColumns;
        gpuFilterColumnsChanged = true;
      }
    }
    if (options.onDataChanged !== undefined) {
      this.onDataChanged = options.onDataChanged;
    }
    if (options.onVisibilityChanged !== undefined) {
      this.onVisibilityChanged = options.onVisibilityChanged;
    }

    if (needsFullReload && this.onDataChanged) {
      this.onDataChanged();
    } else if (needsVisibilityUpdate && this.onVisibilityChanged) {
      this.onVisibilityChanged();
    }

    return { needsFullReload, needsVisibilityUpdate, gpuFilterColumnsChanged };
  }

  /**
   * 行データからポイントの色を取得する
   * @param row 行データ

   * @returns RGBAカラーオブジェクト
   */
  getPointColor(row: Record<string, any>): { r: number; g: number; b: number; a: number } {
    const argbRaw = row['__color__'];
    if (argbRaw == null) {
      return { r: 0.3, g: 0.3, b: 0.8, a: 0.3 };
    }
    const argb = typeof argbRaw === 'bigint' ? Number(argbRaw) : argbRaw;
    return {
      a: ((argb >>> 24) & 0xff) / 255,
      r: ((argb >>> 16) & 0xff) / 255,
      g: ((argb >>> 8) & 0xff) / 255,
      b: (argb & 0xff) / 255,
    };
  }

  /**
   * 行データからポイントのサイズを取得する
   * @param row 行データ

   * @returns ポイントサイズ
   */
  getPointSize(row: Record<string, any>): number {
    const size = row['__size__'];
    if (size == null) {
      return 3;
    }
    return size;
  }

  /**
   * 画面座標に最も近いポイントを検索する
   * @param screenX マウスのスクリーンX座標
   * @param screenY マウスのスクリーンY座標
   * @param canvasWidth キャンバスの幅（ピクセル）
   * @param canvasHeight キャンバスの高さ（ピクセル）
   * @param zoom 現在のズームレベル
   * @param panX 現在のパンX
   * @param panY 現在のパンY
   * @param aspectRatio キャンバスのアスペクト比
   * @param thresholdPixels ヒットと見なす最大距離（ピクセル、デフォルト: 10）
   * @returns 見つかった場合はポイントデータ、そうでない場合はnull
   */
  async findNearestPoint(
    screenX: number,
    screenY: number,
    canvasWidth: number,
    canvasHeight: number,
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number,
    thresholdPixels: number = 10
  ): Promise<Record<string, any> | null> {
    if (this.allPointsCache.length == 0 || this.repository == null) {
      return null;
    }

    const clipX = (screenX / canvasWidth) * 2 - 1;
    const clipY = -((screenY / canvasHeight) * 2 - 1);

    const worldX = ((clipX - panX) * aspectRatio) / zoom;
    const worldY = (clipY - panY) / zoom;

    const thresholdClip = (thresholdPixels / canvasWidth) * 2;
    const thresholdWorld = (thresholdClip * aspectRatio) / zoom;

    let nearestRowid: number | null = null;
    let nearestDistance = Infinity;

    for (let i = 0; i < this.allPointsCache.length; i++) {
      const pointX = this.allPointsCache[i].x;
      const pointY = this.allPointsCache[i].y;

      const dx = pointX - worldX;
      const dy = pointY - worldY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < nearestDistance && distance <= thresholdWorld) {
        nearestDistance = distance;
        nearestRowid = this.allPointsCache[i].rowid;
      }
    }

    if (nearestRowid == null) {
      return null;
    }

    const data = await this.repository.query({
      toString: () =>
        `SELECT *, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data WHERE rowid = ${nearestRowid}`,
    });

    if (!data) {
      return null;
    }

    return this.buildRowFromData(data, 0);
  }

  /**
   * データレイヤーが初期化されているかチェックする
   * @returns 初期化されていればtrue
   */
  isInitialized(): boolean {
    return this.repository !== null;
  }

  /**
   * rowidでポイントを検索する
   * @param pointId 検索するポイントのrowid
   * @returns 見つかった場合はポイントデータ、そうでない場合はnull
   */
  async findPointById(pointId: number): Promise<Record<string, any> | null> {
    if (!this.repository) {
      return null;
    }

    const data = await this.repository.query({
      toString: () =>
        `SELECT *, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data WHERE rowid = ${pointId}`,
    });

    if (!data || data.rowCount === 0) {
      return null;
    }

    return this.buildRowFromData(data, 0);
  }

  /**
   * ParquetDataから指定行のデータをレコードとして構築する
   * @param data ParquetData
   * @param rowIndex 行インデックス
   * @returns 行データの配列
   */
  private buildRowFromData(data: ParquetData, rowIndex: number): Record<string, any> {
    const row: Record<string, any> = {};
    for (let j = 0; j < data.columns.length; j++) {
      const colName = data.columns[j];
      const column = data.columnData.get(colName);
      row[colName] = column?.get(rowIndex);
    }
    return row;
  }

  /**
   * リソースをクリーンアップする
   */
  async destroy(): Promise<void> {
    if (this.repository) {
      await this.repository.close();
      this.repository = null;
    }
  }
}
