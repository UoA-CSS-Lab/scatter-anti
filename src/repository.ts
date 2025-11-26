import * as duckdb from '@duckdb/duckdb-wasm';

export interface ParquetData {
  columns: string[];
  columnData: Map<string, any>; // Column name -> Arrow vector (typed array or values)
  rowCount: number;
}

export class ParquetReader {
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;

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

  async loadParquetFromUrl(url: string, idColumn: string): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    await this.db!.registerFileBuffer('temp.parquet', uint8Array);
    await this.conn.query(
      `CREATE TABLE IF NOT EXISTS parquet_data AS SELECT * FROM read_parquet('temp.parquet')`
    );
    await this.db!.dropFile('temp.parquet');
    await this.conn.query(`CREATE UNIQUE INDEX idx_${idColumn} ON parquet_data (${idColumn});`);
  }

  async query(queryObj: any): Promise<ParquetData> {
    if (!this.conn) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const rawSql = queryObj.toString();
    const result = await this.conn.query(rawSql);

    const columns = result.schema.fields.map((field) => field.name);
    const columnData = new Map<string, any>();

    // Store columns directly from Arrow result (no row-by-row extraction)
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

  async getSchema(): Promise<string[]> {
    if (!this.conn) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const result = await this.conn.query('DESCRIBE parquet_data');
    const columns: string[] = [];

    for (let i = 0; i < result.numRows; i++) {
      const nameColumn = result.getChildAt(0);
      columns.push(nameColumn?.get(i));
    }

    return columns;
  }

  async loadGeoJson(geojson: any): Promise<void> {
    if (!this.conn) {
      throw new Error('Database not initialized. Call initialize() first.');
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

export async function createParquetReader(): Promise<ParquetReader> {
  const reader = new ParquetReader();
  await reader.initialize();
  return reader;
}
