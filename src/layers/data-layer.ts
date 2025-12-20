import type { ParquetData, ParquetReader } from '../repository.js';
import { createParquetReader } from '../repository.js';
import type { WhereCondition, ScatterPlotError, PointId } from '../types.js';
import { createError } from '../errors.js';

/**
 * DataLayerの設定オプション
 */
export interface DataLayerOptions {
  /** 表示するポイントの最大数 */
  visiblePointLimit?: number;
  /** ポイントサイズを計算するSQL式 */
  sizeSql?: string;
  /** ポイント色を計算するSQL式（ARGB形式） */
  colorSql?: string;
  /** データフィルタリング用のWHERE条件 */
  whereConditions?: WhereCondition[];
  /** ポイントを識別するためのカラム名 */
  idColumn: string;
  /** エラーをScatterPlotに通知するためのコールバック */
  onError?: (error: ScatterPlotError) => void;
}

/**
 * 表示範囲の境界を表すインターフェース
 */
export interface VisibleBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * GPU用に処理されたデータ
 */
export interface ProcessedData {
  /** インスタンスデータ（位置、色、サイズ）のFloat32Array */
  instanceData: Float32Array;
  /** 行数 */
  rowCount: number;
  /** 表示ポイント数の上限 */
  visiblePointLimit: number;
}

/**
 * 現在表示中のポイントデータ
 */
interface VisibleData {
  id: string;
  x: number;
  y: number;
  size: number;
}

/**
 * データ取得とクエリ管理を担当するレイヤー
 * 責務:
 * - ParquetReaderを介したParquetデータの読み込みと管理
 * - 表示範囲の境界計算
 * - ビューポートに基づくデータのクエリとフィルタリング
 * - パフォーマンス最適化のためのクエリスロットリング
 * - データをGPU用フォーマットに変換
 */
export class DataLayer {
  /** Parquetデータへのアクセスを提供するリポジトリ */
  private repository: ParquetReader | null = null;
  /** 表示するポイントの最大数 */
  private visiblePointLimit: number = 100000;
  /** ポイントサイズのSQL式 */
  private sizeSql: string = '3';
  /** ポイント色のSQL式（ARGB形式: a=0.3, r=0.3, g=0.3, b=0.8） */
  private colorSql: string = '0x4D4D4DCC';
  /** フィルタリング用のWHERE条件 */
  private whereConditions: WhereCondition[] = [];
  /** エラー通知用コールバック */
  private onError?: (error: ScatterPlotError) => void;

  /** 現在表示中のポイントデータのキャッシュ */
  private currentVisibleData: VisibleData[] = [];
  /** ポイント識別用のカラム名 */
  private idColumn: string = '';

  // 空間クエリ最適化
  /** ビューポートの余白（各辺に50%追加） */
  private readonly VIEWPORT_MARGIN = 0.5;

  // クエリキャンセルと状態追跡
  /** 現在のクエリID（新しいクエリごとにインクリメント） */
  private currentQueryId: number = 0;
  /** 最後にリクエストされたビューポート情報 */
  private latestRequestedViewport: {
    zoom: number;
    panX: number;
    panY: number;
    queryId: number;
  } | null = null;

  // クエリスロットリング
  /** クエリ間の最小間隔（ミリ秒） */
  private readonly queryThrottleInterval: number = 300;
  /** 最後のクエリ実行時刻 */
  private lastQueryTime: number = 0;
  /** スロットリング用タイマーID */
  private throttleTimer: number | null = null;

  /**
   * DataLayerインスタンスを作成する
   * @param options 設定オプション
   */
  constructor(options: DataLayerOptions) {
    // オプションから設定値を初期化
    this.visiblePointLimit = options.visiblePointLimit ?? this.visiblePointLimit;
    this.sizeSql = options.sizeSql ?? this.sizeSql;
    this.colorSql = options.colorSql ?? this.colorSql;
    this.whereConditions = options.whereConditions ?? [];
    this.idColumn = options.idColumn;
    this.onError = options.onError;
  }

  /**
   * データレイヤーを初期化し、データを読み込む
   * @param dataUrl Parquetファイルのurl
   * @param aspectRatio キャンバスのアスペクト比
   * @returns 処理済みの初期データ
   */
  async initialize(dataUrl: string, aspectRatio: number = 1.0): Promise<ProcessedData> {
    // ParquetReaderを作成して初期化
    this.repository = await createParquetReader();
    // URLからParquetファイルを読み込み
    await this.repository.loadParquetFromUrl(dataUrl, this.idColumn);

    // 初期データを読み込んで返す
    return await this.loadInitialData(aspectRatio);
  }

  /**
   * GeoJSONラベルデータをDuckDBテーブルに読み込む
   * @param geojson GeoJSON FeatureCollectionオブジェクト
   */
  async loadLabelData(geojson: any): Promise<void> {
    // 初期化チェック
    if (!this.repository) {
      throw new Error('DataLayer not initialized. Call initialize() first.');
    }
    // GeoJSONをテーブルとして読み込み
    await this.repository.loadGeoJson(geojson);
  }

  /**
   * 単一の条件からWHERE句文字列を構築する
   * @param condition WHERE条件
   * @returns SQL WHERE句の文字列
   */
  private buildWhereClauseString(condition: WhereCondition): string {
    if (condition.type === 'numeric') {
      // 数値フィルタ: カラム 演算子 値
      return `${condition.column} ${condition.operator} ${condition.value}`;
    } else if (condition.type === 'raw') {
      // 生のSQL
      return condition.sql;
    } else {
      // 文字列フィルタ - シングルクォートをエスケープ
      const escapedValue = condition.value.replace(/'/g, "''");

      // 演算子に基づいてSQL LIKE句を構築
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
   * 指定された境界内のポイントをクエリする
   * @param bounds 表示範囲の境界
   * @returns クエリ結果のParquetData
   */
  async runQuery(bounds: VisibleBounds): Promise<ParquetData | undefined> {
    return this.repository?.query({
      toString: () => {
        // 境界条件を配列に追加
        const whereConditions: string[] = [
          `x BETWEEN ${bounds.minX} AND ${bounds.maxX}`,
          `y BETWEEN ${bounds.minY} AND ${bounds.maxY}`,
        ];

        // カスタムWHERE条件を追加（すべてANDで結合）
        for (const condition of this.whereConditions) {
          whereConditions.push(this.buildWhereClauseString(condition));
        }

        // WHERE句を構築
        const whereClause = whereConditions.join(' AND ');

        // 最終的なSQLクエリを構築
        return `SELECT x, y, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__, ${this.idColumn} FROM parquet_data WHERE ${whereClause} LIMIT ${this.visiblePointLimit}`;
      },
    });
  }

  /**
   * カスタムSQLクエリを実行する
   * 文字列クエリとtoStringメソッドを持つオブジェクトの両方をサポート
   * @param query SQLクエリ
   * @returns クエリ結果のParquetData
   */
  async executeQuery(query: string | { toString: () => string }): Promise<ParquetData | undefined> {
    // リポジトリが未初期化の場合はundefinedを返す
    if (!this.repository) {
      return undefined;
    }
    // 文字列の場合はオブジェクトに変換
    const queryObj = typeof query === 'string' ? { toString: () => query } : query;
    return this.repository.query(queryObj);
  }

  /**
   * デフォルトビューポート用の初期データを読み込む
   * @param aspectRatio キャンバスのアスペクト比
   * @returns 処理済みデータ
   */
  private async loadInitialData(aspectRatio: number = 1.0): Promise<ProcessedData> {
    // 初期ビュー（ズーム1.0、パン0,0）の境界を計算
    const bounds = this.calculateVisibleBounds(1.0, 0.0, 0.0, aspectRatio);
    // 境界内のデータをクエリ
    const data = await this.runQuery(bounds);

    // データがない場合は空のデータを返す
    if (!data) {
      return {
        instanceData: new Float32Array(0),
        rowCount: 0,
        visiblePointLimit: this.visiblePointLimit,
      };
    }

    // GPU用フォーマットに変換して返す
    return this.processDataToGpuFormat(data);
  }

  /**
   * 余白付きでワールド座標での表示範囲を計算する
   * @param zoom ズームレベル
   * @param panX X方向のパンオフセット
   * @param panY Y方向のパンオフセット
   * @param aspectRatio アスペクト比
   * @returns 表示範囲の境界
   */
  calculateVisibleBounds(
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number
  ): VisibleBounds {
    // 余白付きのクリップ空間の境界
    const clipMin = -1 - this.VIEWPORT_MARGIN;
    const clipMax = 1 + this.VIEWPORT_MARGIN;

    // クリップ空間をワールド座標に変換（アスペクト比補正を考慮）
    // ビュー行列はXをzoom/aspectRatioで、Yをzoomでスケールするので、逆変換が必要:
    // worldX = (clipX - panX) * aspectRatio / zoom
    // worldY = (clipY - panY) / zoom
    const minX = ((clipMin - panX) * aspectRatio) / zoom;
    const maxX = ((clipMax - panX) * aspectRatio) / zoom;
    const minY = (clipMin - panY) / zoom;
    const maxY = (clipMax - panY) / zoom;

    return { minX, maxX, minY, maxY };
  }

  /**
   * スロットリング付きで表示ポイントの更新をスケジュールする
   * @param zoom ズームレベル
   * @param panX X方向のパンオフセット
   * @param panY Y方向のパンオフセット
   * @param aspectRatio アスペクト比
   * @param callback 更新完了時に呼び出されるコールバック
   */
  scheduleVisiblePointsUpdate(
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number,
    callback: (data: ProcessedData) => void
  ): void {
    // クエリIDをインクリメントして最新のビューポートリクエストを保存
    this.currentQueryId++;
    const queryId = this.currentQueryId;
    this.latestRequestedViewport = { zoom, panX, panY, queryId };

    // 既存のスケジュール済みクエリをクリア
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const now = performance.now();
    const timeSinceLastQuery = now - this.lastQueryTime;

    // 十分な時間が経過していれば即座にクエリを実行
    if (timeSinceLastQuery >= this.queryThrottleInterval) {
      this.updateVisiblePoints(zoom, panX, panY, aspectRatio, queryId, callback);
    } else {
      // そうでなければスロットル期間後にクエリをスケジュール
      const delay = this.queryThrottleInterval - timeSinceLastQuery;
      this.throttleTimer = window.setTimeout(() => {
        this.throttleTimer = null;
        // 実行前にこれがまだ最新のリクエストかチェック
        if (this.latestRequestedViewport && this.latestRequestedViewport.queryId === queryId) {
          this.updateVisiblePoints(zoom, panX, panY, aspectRatio, queryId, callback);
        }
      }, delay);
    }
  }

  /**
   * 空間クエリを使用して表示ポイントを更新する（キャンセル機能付きの非ブロッキング）
   * @param zoom ズームレベル
   * @param panX X方向のパンオフセット
   * @param panY Y方向のパンオフセット
   * @param aspectRatio アスペクト比
   * @param queryId このクエリのID
   * @param callback 更新完了時に呼び出されるコールバック
   */
  private async updateVisiblePoints(
    zoom: number,
    panX: number,
    panY: number,
    aspectRatio: number,
    queryId: number,
    callback: (data: ProcessedData) => void
  ): Promise<void> {
    // リポジトリが未初期化なら何もしない
    if (!this.repository) {
      return;
    }

    // 最後のクエリ時刻を更新
    this.lastQueryTime = performance.now();

    try {
      // 表示範囲の境界を計算
      const bounds = this.calculateVisibleBounds(zoom, panX, panY, aspectRatio);
      // データをクエリ
      const data = await this.runQuery(bounds);

      // このクエリがまだ有効か確認（より新しいクエリに置き換えられていないか）
      if (queryId !== this.currentQueryId) {
        return;
      }

      // データがなければ終了
      if (!data) {
        return;
      }

      // GPU用フォーマットに変換
      const processedData = this.processDataToGpuFormat(data);

      // 結果を適用する前に最終チェック
      if (queryId === this.currentQueryId) {
        callback(processedData);
      }
    } catch (e) {
      // エラーを無視せずエラーイベントを発行
      if (this.onError) {
        this.onError(
          createError('QUERY_FAILED', 'Background viewport query failed', {
            cause: e instanceof Error ? e : undefined,
            context: { zoom, panX, panY, queryId },
          })
        );
      }
    }
  }

  /**
   * カラム形式のデータをGPU用インスタンスデータフォーマットに変換する
   * フォーマット: ポイントごとに [x, y, r, g, b, a, size]
   * @param data ParquetData形式のデータ
   * @returns 処理済みデータ
   */
  private processDataToGpuFormat(data: ParquetData): ProcessedData {
    // 各カラムを取得
    const xColumn = data.columnData.get('x');
    const yColumn = data.columnData.get('y');
    const sizeColumn = data.columnData.get('__size__');
    const colorColumn = data.columnData.get('__color__');
    const idColumn = data.columnData.get(this.idColumn);

    // 必要なカラムがない場合は空データを返す
    if (!xColumn || !yColumn || !sizeColumn || !colorColumn || !idColumn) {
      return {
        instanceData: new Float32Array(0),
        rowCount: 0,
        visiblePointLimit: this.visiblePointLimit,
      };
    }

    // キャッシュ用配列とインスタンスデータ配列を初期化
    const cachedData = new Array<VisibleData>(data.rowCount);
    const instanceData = new Float32Array(data.rowCount * 7);

    // 各行を処理
    for (let i = 0; i < data.rowCount; i++) {
      const x = xColumn.get(i);
      const y = yColumn.get(i);
      const size = sizeColumn.get(i);
      const argbRaw = colorColumn.get(i);

      // DuckDBからのBigIntを処理
      const argb = typeof argbRaw === 'bigint' ? Number(argbRaw) : argbRaw;

      // ARGB整数をRGBA浮動小数点（0-1範囲）に展開
      // ARGBフォーマット: 0xAARRGGBB
      const a = ((argb >>> 24) & 0xff) / 255;
      const r = ((argb >>> 16) & 0xff) / 255;
      const g = ((argb >>> 8) & 0xff) / 255;
      const b = (argb & 0xff) / 255;

      // インスタンスデータ配列にデータを格納
      instanceData[i * 7 + 0] = x;
      instanceData[i * 7 + 1] = y;
      instanceData[i * 7 + 2] = r;
      instanceData[i * 7 + 3] = g;
      instanceData[i * 7 + 4] = b;
      instanceData[i * 7 + 5] = a;
      instanceData[i * 7 + 6] = size;

      // キャッシュにデータを保存
      cachedData[i] = {
        id: idColumn.get(i),
        x: x,
        y: y,
        size: size,
      };
    }

    // 現在の表示データを更新
    this.currentVisibleData = cachedData;

    return { instanceData, rowCount: data.rowCount, visiblePointLimit: this.visiblePointLimit };
  }

  /**
   * 設定オプションを更新する
   * @param options 更新する設定オプション
   */
  updateOptions(options: Partial<DataLayerOptions>): void {
    // 各オプションが定義されていれば更新
    if (options.visiblePointLimit !== undefined) {
      this.visiblePointLimit = options.visiblePointLimit;
    }
    if (options.sizeSql !== undefined) {
      this.sizeSql = options.sizeSql;
    }
    if (options.colorSql !== undefined) {
      this.colorSql = options.colorSql;
    }
    if (options.whereConditions !== undefined) {
      this.whereConditions = options.whereConditions;
    }
    if (options.idColumn !== undefined) {
      this.idColumn = options.idColumn;
    }
  }

  /**
   * 行データからポイントの色を取得する（SQLからの__color__カラムが必要）
   * @param row 行データ
   * @param columns カラム名の配列
   * @returns RGBAカラーオブジェクト
   */
  getPointColor(row: any[], columns: string[]): { r: number; g: number; b: number; a: number } {
    // __color__カラムのインデックスを取得
    const colorIdx = columns.indexOf('__color__');
    // 見つからない場合はデフォルト色を返す
    if (colorIdx === -1) {
      return { r: 0.3, g: 0.3, b: 0.8, a: 0.3 };
    }
    const argbRaw = row[colorIdx];
    // BigIntをNumberに変換
    const argb = typeof argbRaw === 'bigint' ? Number(argbRaw) : argbRaw;
    // ARGBからRGBA成分を抽出
    return {
      a: ((argb >>> 24) & 0xff) / 255,
      r: ((argb >>> 16) & 0xff) / 255,
      g: ((argb >>> 8) & 0xff) / 255,
      b: (argb & 0xff) / 255,
    };
  }

  /**
   * 行データからポイントのサイズを取得する（SQLからの__size__カラムが必要）
   * @param row 行データ
   * @param columns カラム名の配列
   * @returns ポイントサイズ
   */
  getPointSize(row: any[], columns: string[]): number {
    // __size__カラムのインデックスを取得
    const sizeIdx = columns.indexOf('__size__');
    // 見つからない場合はデフォルトサイズを返す
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
    // 表示データがないかリポジトリが未初期化の場合はnullを返す
    if (this.currentVisibleData.length == 0 || this.repository == null) {
      return null;
    }

    // スクリーン座標をクリップ空間（-1から1）に変換
    const clipX = (screenX / canvasWidth) * 2 - 1;
    const clipY = -((screenY / canvasHeight) * 2 - 1); // Y軸を反転

    // クリップ空間をワールド座標に変換
    // 逆変換: clipPos = worldPos * vec2(zoom / aspectRatio, zoom) + vec2(panX, panY)
    const worldX = ((clipX - panX) * aspectRatio) / zoom;
    const worldY = (clipY - panY) / zoom;

    // ワールド空間での閾値を計算
    // ピクセル閾値をクリップ空間に変換し、次にワールド空間に変換
    const thresholdClip = (thresholdPixels / canvasWidth) * 2;
    const thresholdWorld = (thresholdClip * aspectRatio) / zoom;

    let nearestId: string | null = null;
    let nearestDistance = Infinity;

    // すべての表示ポイントを検索
    // TODO: 現在は全探索しているが、quad treeとか使ってもいいかもしれない
    for (let i = 0; i < this.currentVisibleData.length; i++) {
      const pointX = this.currentVisibleData[i].x;
      const pointY = this.currentVisibleData[i].y;

      // ワールド空間での距離を計算
      const dx = pointX - worldX;
      const dy = pointY - worldY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // より近いポイントで閾値内であれば更新
      if (distance < nearestDistance && distance <= thresholdWorld) {
        nearestDistance = distance;
        nearestId = this.currentVisibleData[i].id;
      }
    }

    // 見つからなかった場合はnullを返す
    if (nearestId == null) {
      return null;
    }

    // 見つかったIDでポイントの完全なデータをクエリ
    const data = await this.repository.query({
      toString: () =>
        `SELECT *, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data WHERE ${this.idColumn} = ${nearestId}`,
    });

    // クエリ結果がない場合はnullを返す
    if (!data) {
      return null;
    }

    // 最初の行を抽出
    const row: any[] = new Array(data.columns.length);
    for (let j = 0; j < data.columns.length; j++) {
      const column = data.columnData.get(data.columns[j]);
      row[j] = column?.get(0);
    }

    return { row, columns: data.columns };
  }

  /**
   * データレイヤーが初期化されているかチェックする
   * @returns 初期化されていればtrue
   */
  isInitialized(): boolean {
    return this.repository !== null;
  }

  /**
   * IDでポイントを検索する（idColumnの値で検索）
   * @param pointId 検索するポイントのidColumn値
   * @returns 見つかった場合はポイントデータ、そうでない場合はnull
   */
  async findPointById(pointId: PointId): Promise<{ row: any[]; columns: string[] } | null> {
    // リポジトリが未初期化の場合はnullを返す
    if (!this.repository) {
      return null;
    }

    // 文字列値はエスケープ、数値はそのまま使用
    const escapedId = typeof pointId === 'string' ? `'${pointId.replace(/'/g, "''")}'` : pointId;

    // IDでポイントデータをクエリ
    const data = await this.repository.query({
      toString: () =>
        `SELECT *, CAST((${this.sizeSql}) AS DOUBLE) AS __size__, CAST((${this.colorSql}) AS INTEGER) AS __color__ FROM parquet_data WHERE ${this.idColumn} = ${escapedId}`,
    });

    // 結果がないか行数が0の場合はnullを返す
    if (!data || data.rowCount === 0) {
      return null;
    }

    // 最初の行を抽出
    const row: any[] = new Array(data.columns.length);
    for (let j = 0; j < data.columns.length; j++) {
      const column = data.columnData.get(data.columns[j]);
      row[j] = column?.get(0);
    }

    return { row, columns: data.columns };
  }

  /**
   * リソースをクリーンアップする
   */
  async destroy(): Promise<void> {
    // 保留中のスロットルクエリをクリア
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    // リポジトリ接続を閉じる
    if (this.repository) {
      await this.repository.close();
      this.repository = null;
    }
  }
}
