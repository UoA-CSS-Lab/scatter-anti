import * as duckdb from '@duckdb/duckdb-wasm';

export interface ParquetData {
    columns: string[];
    columnData: Map<string, any>;  // Column name -> Arrow vector (typed array or values)
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

    async loadParquetFile(filePath: string): Promise<void> {
        if (!this.conn) {
            throw new Error('Database not initialized. Call initialize() first.');
        }

        await this.conn.query(`CREATE TABLE IF NOT EXISTS parquet_data AS SELECT * FROM read_parquet('${filePath}')`);
    }

    async loadParquetFromUrl(url: string): Promise<void> {
        if (!this.conn) {
            throw new Error('Database not initialized. Call initialize() first.');
        }

        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        await this.db!.registerFileBuffer('temp.parquet', uint8Array);
        await this.conn.query(`CREATE TABLE IF NOT EXISTS parquet_data AS SELECT * FROM read_parquet('temp.parquet')`);
    }

    async query(sql: string, params: any[]): Promise<ParquetData> {
        if (!this.conn) {
            throw new Error('Database not initialized. Call initialize() first.');
        }

        const rawSql = formatSql(sql, params);
        // console.log(rawSql);
        const result = await this.conn.query(rawSql);

        const columns = result.schema.fields.map(field => field.name);
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
            rowCount: result.numRows
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

// TODO: これはAIに生成させたやつ。ちゃんとしたクエリビルダのライブラリを探して使う
/**
 * SQLテンプレートとパラメータから実行可能なSQL文を作成
 * 注意: この関数はデバッグ/ロギング用です。実際のクエリ実行にはプレースホルダーを使用してください
 */
function formatSql(sql: string, params: any[]): string {
    let index = 0;
    return sql.replace(/\?/g, () => {
        if (index >= params.length) {
            return '?';
        }
        const param = params[index++];
        return formatParam(param);
    });
}

function formatParam(param: any): string {
    if (param === null || param === undefined) {
        return 'NULL';
    }

    if (typeof param === 'string') {
        // TODO: シングルクォートをエスケープ
        return `${param.replace(/'/g, "''")}`;
    }

    if (typeof param === 'number') {
        return param.toString();
    }

    if (typeof param === 'boolean') {
        return param ? 'TRUE' : 'FALSE';
    }

    if (param instanceof Date) {
        return `'${param.toISOString()}'`;
    }

    if (Array.isArray(param)) {
        return `(${param.map(formatParam).join(', ')})`;
    }

    // オブジェクトの場合はJSON文字列として扱う
    return `'${JSON.stringify(param).replace(/'/g, "''")}'`;
}
