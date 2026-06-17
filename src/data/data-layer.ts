import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { ParquetData, ParquetReader } from './repository.js';
import { createParquetReader } from './repository.js';
import type { WhereCondition, ScatterPlotError } from '../types.js';
import { createError } from '../errors.js';
import type { AllPointsData } from '../renderer/gpu-layer.js';
import { SpatialPointIndex } from './spatial-index.js';

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
  onDataChanged?: () => void | Promise<void>;
  /** WHERE条件変更時にビジビリティフラグ更新が必要な場合のコールバック */
  onVisibilityChanged?: () => void | Promise<void>;
}

/**
 * 全ポイントデータのキャッシュ（SoA形式）
 */
interface PointsCache {
  xArr: Float64Array | Float32Array;
  yArr: Float64Array | Float32Array;
  length: number;
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
  private onDataChanged?: () => void | Promise<void>;
  /** WHERE条件変更時のビジビリティ更新コールバック */
  private onVisibilityChanged?: () => void | Promise<void>;

  /** 全ポイントデータのキャッシュ（ポイント検索用、SoA形式） */
  private pointsCache: PointsCache = {
    xArr: new Float64Array(0),
    yArr: new Float64Array(0),
    length: 0,
  };

  /** WhereConditionから生成されたビジビリティフラグのキャッシュ（WHERE条件なし時は空） */
  private visibilityFlags = new Uint32Array(0);
  /** GPUフィルターカラムデータのキャッシュ（4値/ポイント） */
  private filterColumnData = new Float32Array(0);
  /** 現在のGPUフィルターレンジ（スライダーで高頻度更新） */
  private gpuFilterRanges: { columnIndex: number; min: number; max: number }[] = [];
  /** 空間ポイントインデックス（四分木ベース） */
  private spatialIndex = new SpatialPointIndex();

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
   * @param source ParquetファイルのURL、またはArrayBuffer/File
   * @returns 処理済みの全データ
   */
  async initialize(
    source: string | ArrayBuffer | File,
    onDatabaseReady?: (conn: AsyncDuckDBConnection) => Promise<void>
  ): Promise<AllPointsData> {
    this.repository = await createParquetReader();
    if (typeof source === 'string') {
      await this.repository.loadParquetFromUrl(source);
    } else {
      const buffer = source instanceof File ? await source.arrayBuffer() : source;
      await this.repository.loadParquetFromBuffer(buffer);
    }
    if (onDatabaseReady) {
      await onDatabaseReady(this.repository.getConnection());
    }
    return await this.loadAllPoints();
  }

  /**
   * GeoJSONラベルデータをDuckDBテーブルに読み込む
   * @param geojson GeoJSON FeatureCollectionオブジェクト
   */
  async loadLabelData(geojson: any): Promise<void> {
    await this.repository!.loadGeoJson(geojson);
  }

  /**
   * 単一の条件からWHERE句文字列を構築する
   * @param condition WHERE条件
   * @returns SQL WHERE句の文字列
   */
  private buildWhereClauseString(condition: WhereCondition): string {
    switch (condition.type) {
      case 'numeric':
        return `${condition.column} ${condition.operator} ${condition.value}`;
      case 'raw':
        return condition.sql;
      case 'string': {
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
  }

  /**
   * 全データを読み込んでGPU用フォーマットに変換する
   * WHERE条件によるフィルタリングはビットフラグで行うため、ここでは適用しない
   * @returns 処理済みの全データ
   */
  async loadAllPoints(): Promise<AllPointsData> {
    try {
      const data = await this.repository!.query({
        toString: () =>
          `SELECT x, y, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data ORDER BY rowid`,
      });
      if (!data) {
        return {
          instanceData: new Float32Array(0),
          totalCount: 0,
        };
      }

      const xColumn = data.columnData.get('x')!;
      const yColumn = data.columnData.get('y')!;
      const sizeColumn = data.columnData.get('__size__')!;
      const colorColumn = data.columnData.get('__color__')!;

      const buffer = new ArrayBuffer(data.rowCount * 16);
      const floatView = new Float32Array(buffer);
      const uint32View = new Uint32Array(buffer);

      const xArr = xColumn.toArray();
      const yArr = yColumn.toArray();
      const sizeArr = sizeColumn.toArray();
      const colorArr = colorColumn.toArray();

      const rowCount = data.rowCount;

      for (let i = 0; i < rowCount; i++) {
        const base = i * 4;
        floatView[base] = xArr[i];
        floatView[base + 1] = yArr[i];
        uint32View[base + 2] = colorArr[i];
        floatView[base + 3] = sizeArr[i];
      }

      this.pointsCache = { xArr, yArr, length: rowCount };
      this.spatialIndex.build(xArr, yArr, rowCount);

      return {
        instanceData: floatView,
        totalCount: data.rowCount,
      };
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
    columnMapping: Map<string, number>;
  } | null> {
    if (this.gpuFilterColumns.length === 0) {
      return null;
    }

    const columns = this.gpuFilterColumns.slice(0, 4);

    try {
      const columnSelects = columns
        .map((col, i) => `CAST(${col} AS DOUBLE) AS __filter_col_${i}__`)
        .join(', ');

      const data = await this.repository!.query({
        // ORDER BY rowid: GPU filter column buffer の行順を loadAllPoints/loadVisibilityFlags
        //（いずれも ORDER BY rowid）と揃える。これが無いと per-point の filter 値が point
        // buffer と別順序になり、GPU range フィルタや fade（filterColumns[pointIdx] 参照）が
        // 誤った行の値を読む潜在バグになる。
        toString: () => `SELECT ${columnSelects} FROM parquet_data ORDER BY rowid`,
      });
      if (!data || data.rowCount === 0) {
        return null;
      }

      const filterData = new Float32Array(data.rowCount * 4);

      for (let i = 0; i < data.rowCount; i++) {
        const baseIndex = i * 4;
        for (let j = 0; j < 4; j++) {
          if (j < columns.length) {
            const colData = data.columnData.get(`__filter_col_${j}__`)!;
            filterData[baseIndex + j] = colData.get(i);
          } else {
            filterData[baseIndex + j] = 0;
          }
        }
      }

      const columnMapping = new Map<string, number>();
      columns.forEach((col, i) => columnMapping.set(col, i));

      this.filterColumnData = filterData;

      return {
        data: filterData,
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
    try {
      const totalCount = this.pointsCache.length;

      if (totalCount === 0) {
        return null;
      }

      // WHERE条件がない場合は全ポイント可視
      if (this.whereConditions.length === 0) {
        this.visibilityFlags = new Uint32Array(0);
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
      const data = await this.repository!.query({
        toString: () => `SELECT rowid FROM parquet_data ${whereClause} ORDER BY rowid`,
      });
      if (!data) {
        return null;
      }

      // ビットマップを構築（初期値は全て0=非可視）
      const wordCount = Math.ceil(totalCount / 32);
      const flags = new Uint32Array(wordCount);
      flags.fill(0);

      const idxArray = data.columnData.get('rowid')!.toArray();
      for (let i = 0; i < idxArray.length; i++) {
        const idx = Number(idxArray[i]);
        flags[idx >> 5] |= 1 << (idx & 31);
      }

      this.visibilityFlags = this.whereConditions.length === 0 ? new Uint32Array(0) : flags;

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
    return this.repository!.query(typeof query === 'string' ? { toString: () => query } : query);
  }

  /**
   * 設定オプションを更新する
   * @param options 更新する設定オプション
   * @returns 変更の種類を示すオブジェクト
   */
  async updateOptions(options: Partial<DataLayerOptions>): Promise<{
    gpuFilterColumnsChanged: boolean;
  }> {
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
      await this.onDataChanged();
    } else if (needsVisibilityUpdate && this.onVisibilityChanged) {
      await this.onVisibilityChanged();
    }

    return { gpuFilterColumnsChanged };
  }

  /**
   * GPUフィルターレンジを更新する（findNearestPointで使用）
   * スライダー変更時にO(1)で呼び出される
   */
  setGpuFilterRanges(ranges: { columnIndex: number; min: number; max: number }[]): void {
    this.gpuFilterRanges = ranges;
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
    if (!this.spatialIndex.isBuilt()) {
      return null;
    }

    const clipX = (screenX / canvasWidth) * 2 - 1;
    const clipY = -((screenY / canvasHeight) * 2 - 1);

    const worldX = ((clipX - panX) * aspectRatio) / zoom;
    const worldY = (clipY - panY) / zoom;

    const thresholdClip = (thresholdPixels / canvasWidth) * 2;
    const thresholdWorld = (thresholdClip * aspectRatio) / zoom;
    const thresholdWorldSq = thresholdWorld * thresholdWorld;

    const nearestRowid = this.spatialIndex.findNearest(
      worldX,
      worldY,
      thresholdWorldSq,
      this.visibilityFlags,
      this.filterColumnData,
      this.gpuFilterRanges
    );

    if (nearestRowid == null) {
      return null;
    }

    return this.findPointById(nearestRowid);
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
    const data = await this.repository!.query({
      toString: () =>
        `SELECT *, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data WHERE rowid = ${pointId}`,
    });

    if (!data || data.rowCount === 0) {
      return null;
    }
    const row: Record<string, any> = {};
    for (let j = 0; j < data.columns.length; j++) {
      const colName = data.columns[j];
      const column = data.columnData.get(colName)!;
      row[colName] = column.get(0);
    }
    return row;
  }

  /**
   * リソースをクリーンアップする
   */
  async destroy(): Promise<void> {
    this.spatialIndex.destroy();
    if (this.repository) {
      await this.repository.close();
      this.repository = null;
    }
  }
}
