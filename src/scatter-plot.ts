import type {
  Label,
  ScatterPlotOptions,
  ScatterPlotEventMap,
  ScatterPlotError,
  PointId,
  LabelIdentifier,
  GpuWhereCondition,
} from './types.js';
import { DataLayer, type ParquetData } from './data/index.js';
import { GpuLayer } from './renderer/index.js';
import { LabelLayer } from './ui/index.js';
import { EventEmitter } from './event-emitter.js';
import { createError } from './errors.js';

/**
 * WebGPUを使用して散布図を描画するメインクラス
 *
 * このクラスは3つの異なるレイヤーのファサード/コーディネーターとして機能する:
 * - DataLayer: データ取得とクエリ管理を担当
 * - GpuLayer: WebGPUレンダリングと変換を管理（LODと境界計算もGPU側で実行）
 * - LabelLayer: ラベル用の2Dキャンバスオーバーレイを担当
 */
export class ScatterPlot extends EventEmitter<ScatterPlotEventMap> {
  // 3つの異なるレイヤー
  private readonly dataLayer: DataLayer;
  private gpuLayer: GpuLayer;
  private labelLayer: LabelLayer;

  // 設定
  private readonly dataUrl: string;
  private readonly labelUrl?: string;

  /** GPUフィルターカラム名→インデックスのマッピング */
  private gpuFilterColumnMapping: Map<string, number> = new Map();

  /**
   * ScatterPlotインスタンスを作成する
   * @param options 散布図の設定オプション
   */
  constructor(options: ScatterPlotOptions) {
    super();

    // データレイヤーを初期化（Parquetデータの読み込みとクエリを担当）
    this.dataLayer = new DataLayer({
      sizeSql: options.data.sizeSql,
      colorSql: options.data.colorSql,
      whereConditions: options.data.whereConditions,
      gpuFilterColumns: options.data.gpuFilterColumns,
      idColumn: options.data.idColumn,
      onError: (error) => this.emitError(error),
      onDataChanged: () => this.handleDataChanged(),
    });

    // GPUレイヤーを初期化（WebGPUレンダリングを担当）
    this.gpuLayer = new GpuLayer({
      canvas: options.canvas,
      backgroundColor: options.gpu?.backgroundColor,
      visiblePointLimit: options.data.visiblePointLimit,
    });

    // ラベルレイヤーを初期化（2Dキャンバスでのラベル描画を担当）
    this.labelLayer = new LabelLayer({
      canvas: options.canvas,
      labelFontSize: options.labels?.fontSize,
      filterLambda: options.labels?.filterLambda,
      onLabelClick: options.labels?.onClick,
      onPointHover: (data) => this.handlePointHover(data, options.interaction?.onPointHover),
      onLabelHover: options.interaction?.onLabelHover,
      hoverOutlineOptions: options.labels?.hoverOutlineOptions,
      dataLayer: this.dataLayer,
    });

    // 初期化時の自動フェッチ用にURLを保存
    this.dataUrl = options.dataUrl;
    this.labelUrl = options.labels?.url;
  }

  /**
   * WebGPUを初期化し、レンダリングリソースを作成する
   */
  async initialize(): Promise<void> {
    try {
      // データレイヤーを初期化し、全データをParquetファイルから読み込む
      const allPointsData = await this.dataLayer.initialize(this.dataUrl);

      // GPUレイヤーを全データで初期化
      await this.gpuLayer.initialize(allPointsData);

      // GPUフィルターカラムデータを読み込んでアップロード
      const gpuFilterData = await this.dataLayer.loadGpuFilterColumns();
      if (gpuFilterData) {
        this.gpuLayer.uploadFilterColumns(gpuFilterData.data, gpuFilterData.columnCount);
        this.gpuFilterColumnMapping = gpuFilterData.columnMapping;
      }

      // ラベルレイヤーを初期化（キャンバスオーバーレイを作成）
      this.labelLayer.initialize();
    } catch (e) {
      // 例外をスローせず、エラーイベントを発行する
      const error = this.categorizeInitError(e);
      this.emitError(error);
      return;
    }

    // labelUrlが指定されている場合、ラベルを自動フェッチ
    if (this.labelUrl) {
      await this.loadLabelsFromUrl(this.labelUrl);
    }
  }

  /**
   * データ変更時のハンドラ（sizeSql, colorSql, whereConditions変更時）
   */
  private async handleDataChanged(): Promise<void> {
    try {
      // 全データを再読み込み
      const allPointsData = await this.dataLayer.loadAllPoints();
      // GPUにアップロード
      this.gpuLayer.uploadAllPoints(allPointsData);
      // 再レンダリング
      this.render();
    } catch (e) {
      this.emitError(
        createError('QUERY_FAILED', 'Failed to reload data after options change', {
          cause: e instanceof Error ? e : undefined,
        })
      );
    }
  }

  /**
   * URLからラベルデータを読み込み、エラーハンドリングを行う
   * @param url ラベルデータのURL
   */
  private async loadLabelsFromUrl(url: string): Promise<void> {
    try {
      // 指定されたURLからラベルデータをフェッチ
      const response = await fetch(url);
      // HTTPステータスコードが成功でない場合はエラーを発行
      if (!response.ok) {
        this.emitError(
          createError(
            'LABEL_FETCH_FAILED',
            `Failed to fetch labels: ${response.status} ${response.statusText}`,
            {
              context: { url, status: response.status },
            }
          )
        );
        return;
      }
      // レスポンスをJSONとしてパース
      const labelData = await response.json();
      // ラベルをラベルレイヤーに読み込む
      this.loadLabels(labelData);
      // ラベルデータをデータレイヤーにも読み込む（クエリ用）
      await this.dataLayer.loadLabelData(labelData);
    } catch (e) {
      // ネットワークエラーの場合はエラーイベントを発行
      this.emitError(
        createError('LABEL_FETCH_FAILED', 'Network error while fetching labels', {
          cause: e instanceof Error ? e : undefined,
          context: { url },
        })
      );
    }
  }

  /**
   * 初期化エラーをScatterPlotError型に分類する
   * @param e 発生した例外
   * @returns 分類されたScatterPlotErrorオブジェクト
   */
  private categorizeInitError(e: unknown): ScatterPlotError {
    // エラーメッセージと原因を抽出
    const message = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error ? e : undefined;

    // エラーメッセージの内容に基づいてエラーコードを決定
    if (message.includes('WebGPU is not supported')) {
      return createError('WEBGPU_NOT_SUPPORTED', message, { cause });
    }
    if (message.includes('GPU adapter') || message.includes('Failed to get GPU adapter')) {
      return createError('GPU_ADAPTER_NOT_AVAILABLE', message, { cause });
    }
    if (message.includes('GPU device') || message.includes('Failed to get GPU device')) {
      return createError('GPU_DEVICE_FAILED', message, { cause });
    }
    if (message.includes('WebGPU context') || message.includes('Failed to get WebGPU context')) {
      return createError('WEBGPU_CONTEXT_FAILED', message, { cause });
    }
    if (message.includes('Database not initialized') || message.includes('not initialized')) {
      return createError('DATA_LAYER_NOT_INITIALIZED', message, { cause });
    }
    if (message.includes('Parquet') || message.includes('parquet') || message.includes('load')) {
      return createError('PARQUET_LOAD_FAILED', message, { cause });
    }

    // 不明な初期化エラーの場合はWebGPU未サポートとして扱う
    return createError('WEBGPU_NOT_SUPPORTED', message, { cause });
  }

  /**
   * エラーイベントを発行する。リスナーが登録されていない場合はconsole.warnに出力する
   * @param error 発行するエラーオブジェクト
   */
  private emitError(error: ScatterPlotError): void {
    // errorイベントを発行し、リスナーの有無を確認
    const hasListeners = this.emit('error', error);
    // リスナーがいない場合はコンソールに警告を出力
    if (!hasListeners) {
      // eslint-disable-next-line no-console
      console.warn('[scatter-anti]', `${error.code}: ${error.message}`);
    }
  }

  /**
   * 散布図をレンダリングする（GPUレイヤーとラベルの両方）
   */
  render(): void {
    // まずGPUレイヤーをレンダリング（WebGPUで点を描画）
    this.gpuLayer.render();

    // その上にラベルをレンダリング（2Dキャンバスでテキストを描画）
    this.labelLayer.render();
  }

  /**
   * GeoJSONデータからラベルを読み込む
   * @param geojsonData ラベルポイントを含むGeoJSON FeatureCollection
   */
  loadLabels(geojsonData: any): void {
    // GeoJSONデータをラベルレイヤーに渡す
    this.labelLayer.loadLabels(geojsonData);

    // 新しいラベルを表示するために再レンダリング
    this.render();
  }

  /**
   * プロットデータを更新して再レンダリングする
   * @param options 更新する設定オプション
   */
  async update(options: Partial<ScatterPlotOptions>): Promise<void> {
    // データレイヤーの設定を更新（変更があればonDataChangedが呼ばれる）
    if (options.data !== undefined) {
      const result = this.dataLayer.updateOptions({
        sizeSql: options.data.sizeSql,
        colorSql: options.data.colorSql,
        whereConditions: options.data.whereConditions,
        gpuFilterColumns: options.data.gpuFilterColumns,
      });

      // GPUフィルターカラムが変更された場合は再読み込み
      if (result.gpuFilterColumnsChanged) {
        const gpuFilterData = await this.dataLayer.loadGpuFilterColumns();
        if (gpuFilterData) {
          this.gpuLayer.uploadFilterColumns(gpuFilterData.data, gpuFilterData.columnCount);
          this.gpuFilterColumnMapping = gpuFilterData.columnMapping;
        } else {
          this.gpuFilterColumnMapping.clear();
        }
      }

      // GPUフィルター条件を更新
      if (options.data.gpuWhereConditions !== undefined) {
        const conditions = this.convertGpuWhereConditions(options.data.gpuWhereConditions);
        this.gpuLayer.setGpuFilterConditions(conditions);
      }
    }

    // GPUレイヤーの設定を更新
    if (options.gpu !== undefined || options.data?.visiblePointLimit !== undefined) {
      this.gpuLayer.updateOptions({
        backgroundColor: options.gpu?.backgroundColor,
        visiblePointLimit: options.data?.visiblePointLimit,
      });
    }

    // ラベルレイヤーの設定を更新
    if (options.labels !== undefined) {
      this.labelLayer.updateOptions({
        labelFontSize: options.labels.fontSize,
        filterLambda: options.labels.filterLambda,
        onLabelClick: options.labels.onClick,
        hoverOutlineOptions: options.labels.hoverOutlineOptions,
      });

      // URLが指定されている場合はラベルを読み込む
      if (options.labels.url !== undefined) {
        await this.loadLabelsFromUrl(options.labels.url);
      }
    }

    // インタラクションコールバックを更新
    if (options.interaction !== undefined) {
      this.labelLayer.updateOptions({
        onPointHover: (data) => this.handlePointHover(data, options.interaction?.onPointHover),
        onLabelHover: options.interaction.onLabelHover,
      });
    }

    // 再レンダリング
    this.render();
  }

  /**
   * キャンバスをリサイズして再レンダリングする
   * @param width 新しい幅（ピクセル）
   * @param height 新しい高さ（ピクセル）
   */
  resize(width: number, height: number): void {
    // GPUレイヤーのキャンバスサイズを更新
    this.gpuLayer.resize(width, height);
    // ラベルレイヤーのキャンバスサイズを更新
    this.labelLayer.resize(width, height);
    // 新しいサイズで再レンダリング
    this.render();
  }

  /**
   * ズームレベルを設定する
   * @param zoom ズームレベル（1.0 = 通常、>1.0 = ズームイン、<1.0 = ズームアウト）
   */
  setZoom(zoom: number): void {
    // GPUレイヤーのズームを更新
    this.gpuLayer.setZoom(zoom);

    // ラベルレイヤーのビュー変換を更新
    const pan = this.gpuLayer.getPan();
    this.labelLayer.updateViewTransform(this.gpuLayer.getZoom(), pan.x, pan.y);

    // 即座にレンダリング
    this.render();
  }

  /**
   * 現在のズームレベルを取得する
   * @returns 現在のズームレベル
   */
  getZoom(): number {
    return this.gpuLayer.getZoom();
  }

  /**
   * 指定した倍率でズームインする
   * @param factor ズーム倍率（デフォルト: 1.2）
   */
  zoomIn(factor: number = 1.2): void {
    // 現在のズームレベルに倍率を掛ける
    this.setZoom(this.gpuLayer.getZoom() * factor);
  }

  /**
   * 指定した倍率でズームアウトする
   * @param factor ズーム倍率（デフォルト: 1.2）
   */
  zoomOut(factor: number = 1.2): void {
    // 現在のズームレベルを倍率で割る
    this.setZoom(this.gpuLayer.getZoom() / factor);
  }

  /**
   * 指定した画面座標を中心にズームする
   * @param newZoom 新しいズームレベル
   * @param screenX 画面X座標（キャンバスピクセル単位）
   * @param screenY 画面Y座標（キャンバスピクセル単位）
   */
  zoomToPoint(newZoom: number, screenX: number, screenY: number): void {
    // GPUレイヤーで指定座標を中心にズーム処理
    this.gpuLayer.zoomToPoint(newZoom, screenX, screenY);

    // ラベルレイヤーのビュー変換を更新
    const pan = this.gpuLayer.getPan();
    this.labelLayer.updateViewTransform(this.gpuLayer.getZoom(), pan.x, pan.y);

    // 即座にレンダリング
    this.render();
  }

  /**
   * ズームとパンをデフォルト値にリセットする
   */
  resetView(): void {
    // ズームを1.0（初期値）に設定
    this.gpuLayer.setZoom(1.0);
    // パンを原点(0, 0)に設定
    this.gpuLayer.setPan(0.0, 0.0);

    // ラベルレイヤーのビュー変換を初期値に更新
    this.labelLayer.updateViewTransform(1.0, 0.0, 0.0);

    // 即座にレンダリング
    this.render();
  }

  /**
   * パンオフセットを設定する
   * @param x 正規化座標でのX方向パンオフセット（-1から1）
   * @param y 正規化座標でのY方向パンオフセット（-1から1）
   */
  setPan(x: number, y: number): void {
    // GPUレイヤーのパンを更新
    this.gpuLayer.setPan(x, y);

    // ラベルレイヤーのビュー変換を更新
    this.labelLayer.updateViewTransform(this.gpuLayer.getZoom(), x, y);

    // 即座にレンダリング
    this.render();
  }

  /**
   * 現在のパンオフセットを取得する
   * @returns x, y座標を含むオブジェクト
   */
  getPan(): { x: number; y: number } {
    return this.gpuLayer.getPan();
  }

  /**
   * 指定した差分だけパンする
   * @param dx 正規化座標でのX方向の差分
   * @param dy 正規化座標でのY方向の差分
   */
  pan(dx: number, dy: number): void {
    // 現在のパン位置を取得
    const currentPan = this.gpuLayer.getPan();
    // 差分を加算して新しいパン位置を設定
    this.setPan(currentPan.x + dx, currentPan.y + dy);
  }

  /**
   * ラベルレイヤーからのポイントホバーイベントを処理する
   * @param data ホバー中のポイントデータ（またはnull）
   * @param userCallback ユーザー定義のコールバック
   */
  private handlePointHover(
    data: { row: any[]; columns: string[] } | null,
    userCallback?: any
  ): void {
    // ユーザーのコールバックが指定されている場合は呼び出す
    if (userCallback) {
      userCallback(data);
    }
  }

  /**
   * GpuWhereConditionをGpuLayer用の形式に変換する
   * @param conditions ユーザー指定のGPUフィルター条件
   * @returns GpuLayer用のフィルター条件配列
   */
  private convertGpuWhereConditions(
    conditions: GpuWhereCondition[]
  ): { columnIndex: number; min: number; max: number }[] {
    return conditions
      .filter((c) => this.gpuFilterColumnMapping.has(c.column))
      .map((c) => ({
        columnIndex: this.gpuFilterColumnMapping.get(c.column)!,
        min: c.min ?? -Infinity,
        max: c.max ?? Infinity,
      }));
  }

  /**
   * カスタムSQLクエリを実行する
   * @param query 実行するSQLクエリ文字列またはtoStringメソッドを持つオブジェクト
   * @returns クエリ結果のParquetData
   */
  async runQuery(query: string | { toString: () => string }): Promise<ParquetData | undefined> {
    return await this.dataLayer.executeQuery(query);
  }

  /**
   * 読み込まれたすべてのラベルを取得する
   * @returns ラベルの配列
   */
  getLabels(): Label[] {
    return this.labelLayer.getLabels();
  }

  // ============================================
  // プログラマティックホバー制御API
  // ============================================

  /**
   * IDを指定してプログラム的にポイントをホバー状態にする
   * @param pointId ホバーするポイントのidColumn値
   * @returns ポイントが見つかりホバーされた場合はtrue、そうでない場合はfalse
   */
  async setPointHover(pointId: PointId): Promise<boolean> {
    // データレイヤーが初期化されていない場合は失敗
    if (!this.dataLayer.isInitialized()) {
      return false;
    }

    // 指定されたIDでポイントデータを検索
    const pointData = await this.dataLayer.findPointById(pointId);
    if (!pointData) {
      return false;
    }

    // ラベルレイヤーにホバー状態を設定
    this.labelLayer.setHoveredPoint(pointData);
    return true;
  }

  /**
   * ポイントのホバー状態をクリアする
   */
  clearPointHover(): void {
    this.labelLayer.setHoveredPoint(null);
  }

  /**
   * 現在ホバー中のポイントデータを取得する
   * @returns ホバー中の場合はポイントデータ、そうでない場合はnull
   */
  getHoveredPoint(): { row: any[]; columns: string[] } | null {
    return this.labelLayer.getHoveredPoint();
  }

  /**
   * プログラム的にラベルをホバー状態にする
   * @param identifier ラベル識別子（テキストまたはクラスターで識別）
   * @returns ラベルが見つかりホバーされた場合はtrue、そうでない場合はfalse
   */
  setLabelHover(identifier: LabelIdentifier): boolean {
    // 識別子でラベルを検索
    const label = this.labelLayer.findLabel(identifier);
    if (!label) {
      return false;
    }

    // ラベルレイヤーにホバー状態を設定
    this.labelLayer.setHoveredLabel(label);
    return true;
  }

  /**
   * ラベルのホバー状態をクリアする
   */
  clearLabelHover(): void {
    this.labelLayer.setHoveredLabel(null);
  }

  /**
   * 現在ホバー中のラベルを取得する
   * @returns ホバー中の場合はラベル、そうでない場合はnull
   */
  getHoveredLabel(): Label | null {
    return this.labelLayer.getHoveredLabel();
  }

  /**
   * すべてのホバー状態をクリアする（ポイントとラベルの両方）
   */
  clearAllHover(): void {
    // ポイントのホバー状態をクリア
    this.labelLayer.setHoveredPoint(null);
    // ラベルのホバー状態をクリア
    this.labelLayer.setHoveredLabel(null);
  }

  // ============================================
  // ポイント表示スタイルAPI
  // ============================================

  /**
   * グローバル透明度を設定する
   * @param alpha 透明度 (0.0-1.0)
   */
  setPointAlpha(alpha: number): void {
    this.gpuLayer.setPointAlpha(alpha);
    this.render();
  }

  /**
   * 現在のグローバル透明度を取得する
   * @returns 現在の透明度値 (0.0-1.0)
   */
  getPointAlpha(): number {
    return this.gpuLayer.getPointAlpha();
  }

  /**
   * グローバルサイズスケールを設定する
   * @param scale サイズスケール (0.01以上)
   */
  setPointSizeScale(scale: number): void {
    this.gpuLayer.setPointSizeScale(scale);
    this.render();
  }

  /**
   * 現在のグローバルサイズスケールを取得する
   * @returns 現在のサイズスケール値
   */
  getPointSizeScale(): number {
    return this.gpuLayer.getPointSizeScale();
  }

  /**
   * リソースを破棄する
   */
  async destroy(): Promise<void> {
    // データレイヤーのリソースを破棄（DuckDB接続を閉じる）
    await this.dataLayer.destroy();
    // GPUレイヤーのリソースを破棄（GPUバッファを解放）
    this.gpuLayer.destroy();
    // ラベルレイヤーのリソースを破棄（キャンバスを削除）
    this.labelLayer.destroy();
  }
}
