import * as duckdb from '@duckdb/duckdb-wasm';

/** データベース未初期化エラーメッセージ */
const ERROR_DB_NOT_INITIALIZED = 'Database not initialized. Call initialize() first.';

/**
 * Parquetデータの構造を表すインターフェース
 */
export interface ParquetData {
  /** カラム名の配列 */
  columns: string[];
  /** カラム名からArrowベクター（型付き配列または値）へのマップ */
  columnData: Map<string, any>;
  /** 行数 */
  rowCount: number;
}

/**
 * DuckDB-WASMを使用してParquetファイルを読み込み、クエリを実行するクラス
 */
export class ParquetReader {
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;

  /**
   * DuckDB-WASMを初期化する
   */
  async initialize(): Promise<void> {
    // jsDelivrからDuckDB-WASMバンドルを取得
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();

    // 環境に適したバンドルを選択
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

    // Web Workerを作成するためのBlobURLを生成
    const worker_url = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
    );

    // Web Workerインスタンスを作成
    const worker = new Worker(worker_url);
    // コンソールロガーを作成
    const logger = new duckdb.ConsoleLogger();

    // AsyncDuckDBインスタンスを作成
    this.db = new duckdb.AsyncDuckDB(logger, worker);
    // DuckDBをインスタンス化（WASMモジュールをロード）
    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    // BlobURLを解放（もう不要）
    URL.revokeObjectURL(worker_url);

    // データベース接続を開く
    this.conn = await this.db.connect();
  }

  /**
   * URLからParquetファイルを読み込み、テーブルを作成する
   * @param url Parquetファイルのurl
   * @param idColumn 一意のインデックスを作成するカラム名
   */
  async loadParquetFromUrl(url: string, idColumn: string): Promise<void> {
    // 初期化チェック
    if (!this.conn) {
      throw new Error(ERROR_DB_NOT_INITIALIZED);
    }

    // URLからParquetファイルをフェッチ
    const response = await fetch(url);
    // レスポンスをArrayBufferとして取得
    const arrayBuffer = await response.arrayBuffer();
    // Uint8Arrayに変換
    const uint8Array = new Uint8Array(arrayBuffer);

    // 仮想ファイルシステムにParquetファイルを登録
    await this.db!.registerFileBuffer('temp.parquet', uint8Array);
    // Parquetファイルからテーブルを作成
    await this.conn.query(
      `CREATE TABLE IF NOT EXISTS parquet_data AS SELECT * FROM read_parquet('temp.parquet')`
    );
    // 仮想ファイルを削除（メモリ解放）
    await this.db!.dropFile('temp.parquet');
    // idColumnに一意のインデックスを作成（高速検索用）
    await this.conn.query(`CREATE UNIQUE INDEX idx_${idColumn} ON parquet_data (${idColumn});`);
  }

  /**
   * SQLクエリを実行し、結果を返す
   * @param queryObj toStringメソッドを持つクエリオブジェクト
   * @returns クエリ結果のParquetData
   */
  async query(queryObj: any): Promise<ParquetData> {
    // 初期化チェック
    if (!this.conn) {
      throw new Error(ERROR_DB_NOT_INITIALIZED);
    }

    // クエリオブジェクトからSQL文字列を取得
    const rawSql = queryObj.toString();
    // クエリを実行
    const result = await this.conn.query(rawSql);

    // スキーマからカラム名を抽出
    const columns = result.schema.fields.map((field) => field.name);
    const columnData = new Map<string, any>();

    // Arrowの結果から各カラムを直接取得（行ごとの抽出は行わない）
    for (let j = 0; j < result.numCols; j++) {
      const column = result.getChildAt(j);
      const columnName = columns[j];
      columnData.set(columnName, column);
    }

    return {
      columns,
      columnData,
      rowCount: result.numRows,
    };
  }

  /**
   * GeoJSONデータをテーブルとして読み込む
   * @param geojson GeoJSON FeatureCollectionオブジェクト
   */
  async loadGeoJson(geojson: any): Promise<void> {
    // 初期化チェック
    if (!this.conn) {
      throw new Error(ERROR_DB_NOT_INITIALIZED);
    }

    const features = geojson.features;
    // フィーチャーがない場合は何もしない
    if (features.length === 0) return;

    // GeoJSONフィーチャーをフラットなオブジェクト配列に変換
    const values = features.map((f: any) => {
      // 座標を抽出（デフォルトは[0, 0]）
      const coords = f.geometry?.coordinates || [0, 0];
      // プロパティを抽出
      const props = f.properties || {};
      // x, yと他のプロパティをマージ
      return { x: coords[0], y: coords[1], ...props };
    });

    // JSON文字列を仮想ファイルとして登録
    await this.db!.registerFileText('label_data.json', JSON.stringify(values));
    // JSONからテーブルを作成
    await this.conn.query(
      `CREATE TABLE IF NOT EXISTS label_data AS SELECT * FROM read_json_auto('label_data.json')`
    );
    // 仮想ファイルを削除（メモリ解放）
    await this.db!.dropFile('label_data.json');
  }

  /**
   * データベース接続を閉じてリソースを解放する
   */
  async close(): Promise<void> {
    // 接続がある場合は閉じる
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
    // データベースインスタンスがある場合は終了
    if (this.db) {
      await this.db.terminate();
      this.db = null;
    }
  }
}

/**
 * ParquetReaderインスタンスを作成し、初期化して返す
 * @returns 初期化済みのParquetReaderインスタンス
 */
export async function createParquetReader(): Promise<ParquetReader> {
  // 新しいParquetReaderインスタンスを作成
  const reader = new ParquetReader();
  // 初期化（DuckDB-WASMのセットアップ）
  await reader.initialize();
  return reader;
}
