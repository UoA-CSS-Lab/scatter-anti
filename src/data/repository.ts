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
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

    const worker_url = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
    );

    const worker = new Worker(worker_url);
    const logger = new duckdb.ConsoleLogger();

    this.db = new duckdb.AsyncDuckDB(logger, worker);
    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    URL.revokeObjectURL(worker_url);

    this.conn = await this.db.connect();
  }

  /**
   * URLからParquetファイルを読み込み、テーブルを作成する
   * @param url Parquetファイルのurl
   */
  async loadParquetFromUrl(url: string): Promise<void> {
    if (!this.conn) {
      throw new Error(ERROR_DB_NOT_INITIALIZED);
    }

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    await this.db!.registerFileBuffer('temp.parquet', uint8Array);
    await this.conn.query(
      `CREATE TABLE IF NOT EXISTS parquet_data AS SELECT * FROM read_parquet('temp.parquet')`
    );
    await this.db!.dropFile('temp.parquet');
  }

  /**
   * SQLクエリを実行し、結果を返す
   * @param queryObj toStringメソッドを持つクエリオブジェクト
   * @returns クエリ結果のParquetData
   */
  async query(queryObj: any): Promise<ParquetData> {
    if (!this.conn) {
      throw new Error(ERROR_DB_NOT_INITIALIZED);
    }

    const rawSql = queryObj.toString();
    const result = await this.conn.query(rawSql);

    const columns = result.schema.fields.map((field) => field.name);
    const columnData = new Map<string, any>();

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
    if (!this.conn) {
      throw new Error(ERROR_DB_NOT_INITIALIZED);
    }

    const features = geojson.features;
    if (features.length === 0) return;

    const values = features.map((f: any) => {
      const coords = f.geometry?.coordinates || [0, 0];
      const props = f.properties || {};
      return { x: coords[0], y: coords[1], ...props };
    });

    await this.db!.registerFileText('label_data.json', JSON.stringify(values));
    await this.conn.query(
      `CREATE TABLE IF NOT EXISTS label_data AS SELECT * FROM read_json_auto('label_data.json')`
    );
    await this.db!.dropFile('label_data.json');
  }

  /**
   * データベース接続を取得する
   * @returns DuckDBの接続オブジェクト
   */
  getConnection(): duckdb.AsyncDuckDBConnection {
    if (!this.conn) {
      throw new Error(ERROR_DB_NOT_INITIALIZED);
    }
    return this.conn;
  }

  /**
   * データベース接続を閉じてリソースを解放する
   */
  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
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
  const reader = new ParquetReader();
  await reader.initialize();
  return reader;
}
