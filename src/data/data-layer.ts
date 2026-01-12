import type { ParquetData, ParquetReader } from './repository.js';
import { createParquetReader } from './repository.js';
import type { WhereCondition, ScatterPlotError, PointId } from '../types.js';
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
  /** ポイントを識別するためのカラム名 */
  idColumn: string;
  /** エラーをScatterPlotに通知するためのコールバック */
  onError?: (error: ScatterPlotError) => void;
  /** データ変更時に呼び出されるコールバック */
  onDataChanged?: () => void;
}

/**
 * 現在表示中のポイントデータ（ポイント検索用）
 */
interface PointData {
  id: string;
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

  /** 全ポイントデータのキャッシュ（ポイント検索用） */
  private allPointsCache: PointData[] = [];
  /** ポイント識別用のカラム名 */
  private idColumn: string = '';

  /**
   * DataLayerインスタンスを作成する
   * @param options 設定オプション
   */
  constructor(options: DataLayerOptions) {
    this.sizeSql = options.sizeSql ?? this.sizeSql;
    this.colorSql = options.colorSql ?? this.colorSql;
    this.whereConditions = options.whereConditions ?? [];
    this.gpuFilterColumns = options.gpuFilterColumns ?? [];
    this.idColumn = options.idColumn;
    this.onError = options.onError;
    this.onDataChanged = options.onDataChanged;
  }

  /**
   * データレイヤーを初期化し、データを読み込む
   * @param dataUrl Parquetファイルのurl
   * @returns 処理済みの全データ
   */
  async initialize(dataUrl: string): Promise<AllPointsData> {
    // ParquetReaderを作成して初期化
    this.repository = await createParquetReader();
    // URLからParquetファイルを読み込み
    await this.repository.loadParquetFromUrl(dataUrl, this.idColumn);

    // 全データを読み込んで返す
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
      // WHERE条件を構築
      const whereConditions: string[] = [];
      for (const condition of this.whereConditions) {
        whereConditions.push(this.buildWhereClauseString(condition));
      }
      const whereClause =
        whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      // LIMITなしで全データを取得
      const sql = `SELECT x, y, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__, ${this.idColumn} FROM parquet_data ${whereClause}`;

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

    // 有効なカラム数を制限（最大4）
    const columns = this.gpuFilterColumns.slice(0, 4);

    try {
      // カラムデータを取得するSQLを構築
      const columnSelects = columns
        .map((col, i) => `CAST(${col} AS DOUBLE) AS __filter_col_${i}__`)
        .join(', ');

      const sql = `SELECT ${columnSelects} FROM parquet_data`;
      const data = await this.repository.query({ toString: () => sql });

      if (!data || data.rowCount === 0) {
        return null;
      }

      // Float32Arrayに変換（各ポイントに4カラム分確保）
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

      // カラム名→インデックスのマッピングを作成
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
    const idColumn = data.columnData.get(this.idColumn);

    if (!xColumn || !yColumn || !sizeColumn || !colorColumn || !idColumn) {
      return {
        instanceData: new Float32Array(0),
        totalCount: 0,
      };
    }

    // キャッシュ用配列を初期化
    const cachedData = new Array<PointData>(data.rowCount);

    // ArrayBufferを作成し、Float32ArrayとUint32Arrayの両方のビューを取得
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
        id: idColumn.get(i),
        x: x,
        y: y,
        size: size,
      };
    }

    this.allPointsCache = cachedData;

    return {
      instanceData: floatView,
      totalCount: data.rowCount,
    };
  }

  /**
   * 設定オプションを更新する
   * @param options 更新する設定オプション
   * @returns GPUフィルターカラムが変更された場合はtrue
   */
  updateOptions(options: Partial<DataLayerOptions>): {
    gpuFilterColumnsChanged: boolean;
  } {
    let needsReload = false;
    let gpuFilterColumnsChanged = false;

    if (options.sizeSql !== undefined && options.sizeSql !== this.sizeSql) {
      this.sizeSql = options.sizeSql;
      needsReload = true;
    }
    if (options.colorSql !== undefined && options.colorSql !== this.colorSql) {
      this.colorSql = options.colorSql;
      needsReload = true;
    }
    if (options.whereConditions !== undefined) {
      const oldConditions = JSON.stringify(this.whereConditions);
      const newConditions = JSON.stringify(options.whereConditions);
      if (oldConditions !== newConditions) {
        this.whereConditions = options.whereConditions;
        needsReload = true;
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
    if (options.idColumn !== undefined) {
      this.idColumn = options.idColumn;
    }
    if (options.onDataChanged !== undefined) {
      this.onDataChanged = options.onDataChanged;
    }

    if (needsReload && this.onDataChanged) {
      this.onDataChanged();
    }

    return { gpuFilterColumnsChanged };
  }

  /**
   * 行データからポイントの色を取得する
   * @param row 行データ
   * @param columns カラム名の配列
   * @returns RGBAカラーオブジェクト
   */
  getPointColor(row: any[], columns: string[]): { r: number; g: number; b: number; a: number } {
    const colorIdx = columns.indexOf('__color__');
    if (colorIdx === -1) {
      return { r: 0.3, g: 0.3, b: 0.8, a: 0.3 };
    }
    const argbRaw = row[colorIdx];
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
   * @param columns カラム名の配列
   * @returns ポイントサイズ
   */
  getPointSize(row: any[], columns: string[]): number {
    const sizeIdx = columns.indexOf('__size__');
    if (sizeIdx === -1) {
      return 3;
    }
    return row[sizeIdx];
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
  ): Promise<{ row: any[]; columns: string[] } | null> {
    if (this.allPointsCache.length == 0 || this.repository == null) {
      return null;
    }

    // スクリーン座標をクリップ空間（-1から1）に変換
    const clipX = (screenX / canvasWidth) * 2 - 1;
    const clipY = -((screenY / canvasHeight) * 2 - 1);

    // クリップ空間をワールド座標に変換
    const worldX = ((clipX - panX) * aspectRatio) / zoom;
    const worldY = (clipY - panY) / zoom;

    // ワールド空間での閾値を計算
    const thresholdClip = (thresholdPixels / canvasWidth) * 2;
    const thresholdWorld = (thresholdClip * aspectRatio) / zoom;

    let nearestId: string | null = null;
    let nearestDistance = Infinity;

    // 全ポイントを検索
    for (let i = 0; i < this.allPointsCache.length; i++) {
      const pointX = this.allPointsCache[i].x;
      const pointY = this.allPointsCache[i].y;

      const dx = pointX - worldX;
      const dy = pointY - worldY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < nearestDistance && distance <= thresholdWorld) {
        nearestDistance = distance;
        nearestId = this.allPointsCache[i].id;
      }
    }

    if (nearestId == null) {
      return null;
    }

    // 見つかったIDでポイントの完全なデータをクエリ
    const data = await this.repository.query({
      toString: () =>
        `SELECT *, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data WHERE ${this.idColumn} = ${nearestId}`,
    });

    if (!data) {
      return null;
    }

    return { row: this.buildRowFromData(data, 0), columns: data.columns };
  }

  /**
   * データレイヤーが初期化されているかチェックする
   * @returns 初期化されていればtrue
   */
  isInitialized(): boolean {
    return this.repository !== null;
  }

  /**
   * IDでポイントを検索する
   * @param pointId 検索するポイントのidColumn値
   * @returns 見つかった場合はポイントデータ、そうでない場合はnull
   */
  async findPointById(pointId: PointId): Promise<{ row: any[]; columns: string[] } | null> {
    if (!this.repository) {
      return null;
    }

    const escapedId = typeof pointId === 'string' ? `'${pointId.replace(/'/g, "''")}'` : pointId;

    const data = await this.repository.query({
      toString: () =>
        `SELECT *, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data WHERE ${this.idColumn} = ${escapedId}`,
    });

    if (!data || data.rowCount === 0) {
      return null;
    }

    return { row: this.buildRowFromData(data, 0), columns: data.columns };
  }

  /**
   * ParquetDataから指定行のデータを配列として構築する
   * @param data ParquetData
   * @param rowIndex 行インデックス
   * @returns 行データの配列
   */
  private buildRowFromData(data: ParquetData, rowIndex: number): any[] {
    const row: any[] = new Array(data.columns.length);
    for (let j = 0; j < data.columns.length; j++) {
      const column = data.columnData.get(data.columns[j]);
      row[j] = column?.get(rowIndex);
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
