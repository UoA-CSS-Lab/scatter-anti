import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type {
  Label,
  ScatterPlotOptions,
  ScatterPlotEventMap,
  ScatterPlotError,
  LabelIdentifier,
  GpuWhereCondition,
  FilteredPointDisplayMode,
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
  private readonly dataLayer: DataLayer;
  private gpuLayer: GpuLayer;
  private labelLayer: LabelLayer;

  private readonly dataUrl: string;
  private readonly labelUrl?: string;
  private readonly onDatabaseReady?: (conn: AsyncDuckDBConnection) => Promise<void>;

  /** GPUフィルターカラム名→インデックスのマッピング */
  private gpuFilterColumnMapping: Map<string, number> = new Map();

  /**
   * ScatterPlotインスタンスを作成する
   * @param options 散布図の設定オプション
   */
  constructor(options: ScatterPlotOptions) {
    super();

    this.dataLayer = new DataLayer({
      sizeSql: options.data.sizeSql,
      colorSql: options.data.colorSql,
      whereConditions: options.data.whereConditions,
      gpuFilterColumns: options.data.gpuFilterColumns,
      onError: (error) => this.emitError(error),
      onDataChanged: () => this.handleDataChanged(),
      onVisibilityChanged: () => this.handleVisibilityChanged(),
    });

    this.gpuLayer = new GpuLayer({
      canvas: options.canvas,
      backgroundColor: options.gpu?.backgroundColor,
      visiblePointLimit: options.data.visiblePointLimit,
    });

    this.labelLayer = new LabelLayer({
      canvas: options.canvas,
      labelFontSize: options.labels?.fontSize,
      filterLambda: options.labels?.filterLambda,
      onLabelClick: options.labels?.onClick,
      onPointHover: options.interaction?.onPointHover,
      onLabelHover: options.interaction?.onLabelHover,
      hoverOutlineOptions: options.labels?.hoverOutlineOptions,
      dataLayer: this.dataLayer,
    });

    this.dataUrl = options.dataUrl;
    this.labelUrl = options.labels?.url;
    this.onDatabaseReady = options.onDatabaseReady;
  }

  /**
   * WebGPUを初期化し、レンダリングリソースを作成する
   */
  async initialize(): Promise<void> {
    try {
      const allPointsData = await this.dataLayer.initialize(this.dataUrl, this.onDatabaseReady);
      await this.gpuLayer.initialize(allPointsData);

      const gpuFilterData = await this.dataLayer.loadGpuFilterColumns();
      if (gpuFilterData) {
        this.gpuLayer.uploadFilterColumns(gpuFilterData.data);
        this.gpuFilterColumnMapping = gpuFilterData.columnMapping;
      }

      // 初期WHERE条件がある場合はビットフラグを設定
      const visibilityData = await this.dataLayer.loadVisibilityFlags();
      if (visibilityData) {
        const hasWhereConditions = visibilityData.flags.some((word) => word !== 0xffffffff);
        if (hasWhereConditions) {
          this.gpuLayer.uploadVisibilityFlags(visibilityData.flags, true);
        }
      }
    } catch (e) {
      const error = this.categorizeInitError(e);
      this.emitError(error);
      return;
    }

    if (this.labelUrl) {
      await this.loadLabelsFromUrl(this.labelUrl);
    }
  }

  /**
   * データ変更時のハンドラ（sizeSql, colorSql変更時）
   */
  private async handleDataChanged(): Promise<void> {
    try {
      const allPointsData = await this.dataLayer.loadAllPoints();
      this.gpuLayer.uploadAllPoints(allPointsData);
      // WHERE条件があればビットフラグを再設定、なければクリア
      const visibilityData = await this.dataLayer.loadVisibilityFlags();
      if (visibilityData) {
        const hasWhereConditions = visibilityData.flags.some((word) => word !== 0xffffffff);
        if (hasWhereConditions) {
          this.gpuLayer.uploadVisibilityFlags(visibilityData.flags, true);
        } else {
          this.gpuLayer.clearVisibilityFlags();
        }
      } else {
        this.gpuLayer.clearVisibilityFlags();
      }
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
   * WHERE条件変更時のハンドラ（ビジビリティフラグのみ更新）
   */
  private async handleVisibilityChanged(): Promise<void> {
    try {
      const visibilityData = await this.dataLayer.loadVisibilityFlags();
      if (visibilityData) {
        this.gpuLayer.uploadVisibilityFlags(visibilityData.flags, true);
      } else {
        this.gpuLayer.clearVisibilityFlags();
      }
      this.render();
    } catch (e) {
      this.emitError(
        createError('QUERY_FAILED', 'Failed to update visibility flags', {
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
      const response = await fetch(url);
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
      const labelData = await response.json();
      this.loadLabels(labelData);
      await this.dataLayer.loadLabelData(labelData);
    } catch (e) {
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
    const message = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error ? e : undefined;

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

    return createError('WEBGPU_NOT_SUPPORTED', message, { cause });
  }

  /**
   * エラーイベントを発行する。リスナーが登録されていない場合はconsole.warnに出力する
   * @param error 発行するエラーオブジェクト
   */
  private emitError(error: ScatterPlotError): void {
    const hasListeners = this.emit('error', error);
    if (!hasListeners) {
      // eslint-disable-next-line no-console
      console.warn('[duckscatter]', `${error.code}: ${error.message}`);
    }
  }

  /**
   * 散布図をレンダリングする（GPUレイヤーとラベルの両方）
   */
  render(): void {
    this.gpuLayer.render();
    this.labelLayer.render();
  }

  /**
   * GeoJSONデータからラベルを読み込む
   * @param geojsonData ラベルポイントを含むGeoJSON FeatureCollection
   */
  loadLabels(geojsonData: any): void {
    this.labelLayer.loadLabels(geojsonData);
    this.render();
  }

  /**
   * プロットデータを更新して再レンダリングする
   * @param options 更新する設定オプション
   */
  async update(options: Partial<ScatterPlotOptions>): Promise<void> {
    if (options.data !== undefined) {
      const result = this.dataLayer.updateOptions({
        sizeSql: options.data.sizeSql,
        colorSql: options.data.colorSql,
        whereConditions: options.data.whereConditions,
        gpuFilterColumns: options.data.gpuFilterColumns,
      });

      if (result.gpuFilterColumnsChanged) {
        const gpuFilterData = await this.dataLayer.loadGpuFilterColumns();
        if (gpuFilterData) {
          this.gpuLayer.uploadFilterColumns(gpuFilterData.data);
          this.gpuFilterColumnMapping = gpuFilterData.columnMapping;
        } else {
          this.gpuFilterColumnMapping.clear();
        }
      }

      if (options.data.gpuWhereConditions !== undefined) {
        const conditions = this.convertGpuWhereConditions(options.data.gpuWhereConditions);
        this.gpuLayer.setGpuFilterConditions(conditions);
        this.dataLayer.setGpuFilterRanges(conditions);
      }

      if (options.data.filteredPointDisplayMode !== undefined) {
        this.gpuLayer.setFilteredPointDisplayMode(options.data.filteredPointDisplayMode);
      }
    }

    if (options.gpu !== undefined || options.data?.visiblePointLimit !== undefined) {
      this.gpuLayer.updateOptions({
        backgroundColor: options.gpu?.backgroundColor,
        visiblePointLimit: options.data?.visiblePointLimit,
      });
    }

    if (options.labels !== undefined) {
      this.labelLayer.updateOptions({
        labelFontSize: options.labels.fontSize,
        filterLambda: options.labels.filterLambda,
        onLabelClick: options.labels.onClick,
        hoverOutlineOptions: options.labels.hoverOutlineOptions,
      });

      if (options.labels.url !== undefined) {
        await this.loadLabelsFromUrl(options.labels.url);
      }
    }

    if (options.interaction !== undefined) {
      this.labelLayer.updateOptions({
        onPointHover: options.interaction?.onPointHover,
        onLabelHover: options.interaction.onLabelHover,
      });
    }

    this.render();
  }

  /**
   * キャンバスをリサイズして再レンダリングする
   * @param width 新しい幅（ピクセル）
   * @param height 新しい高さ（ピクセル）
   */
  resize(width: number, height: number): void {
    this.gpuLayer.resize(width, height);
    this.labelLayer.resize(width, height);
    this.render();
  }

  /**
   * ズームレベルを設定する
   * @param zoom ズームレベル（1.0 = 通常、>1.0 = ズームイン、<1.0 = ズームアウト）
   */
  setZoom(zoom: number): void {
    this.gpuLayer.setZoom(zoom);
    this.syncLabelViewTransform();
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
    this.setZoom(this.gpuLayer.getZoom() * factor);
  }

  /**
   * 指定した倍率でズームアウトする
   * @param factor ズーム倍率（デフォルト: 1.2）
   */
  zoomOut(factor: number = 1.2): void {
    this.setZoom(this.gpuLayer.getZoom() / factor);
  }

  /**
   * 指定した画面座標を中心にズームする
   * @param newZoom 新しいズームレベル
   * @param screenX 画面X座標（キャンバスピクセル単位）
   * @param screenY 画面Y座標（キャンバスピクセル単位）
   */
  zoomToPoint(newZoom: number, screenX: number, screenY: number): void {
    this.gpuLayer.zoomToPoint(newZoom, screenX, screenY);
    this.syncLabelViewTransform();
    this.render();
  }

  /**
   * ズームとパンをデフォルト値にリセットする
   */
  resetView(): void {
    this.gpuLayer.setZoom(1.0);
    this.gpuLayer.setPan(0.0, 0.0);
    this.syncLabelViewTransform();
    this.render();
  }

  /**
   * パンオフセットを設定する
   * @param x 正規化座標でのX方向パンオフセット（-1から1）
   * @param y 正規化座標でのY方向パンオフセット（-1から1）
   */
  setPan(x: number, y: number): void {
    this.gpuLayer.setPan(x, y);
    this.syncLabelViewTransform();
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
    const currentPan = this.gpuLayer.getPan();
    this.setPan(currentPan.x + dx, currentPan.y + dy);
  }

  /**
   * ラベルレイヤーのビュー変換をGPUレイヤーと同期する
   */
  private syncLabelViewTransform(): void {
    const pan = this.gpuLayer.getPan();
    this.labelLayer.updateViewTransform(this.gpuLayer.getZoom(), pan.x, pan.y);
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

  /**
   * IDを指定してプログラム的にポイントをホバー状態にする
   * @param pointId ホバーするポイントのrowid
   * @returns ポイントが見つかりホバーされた場合はtrue、そうでない場合はfalse
   */
  async setPointHover(pointId: number): Promise<boolean> {
    if (!this.dataLayer.isInitialized()) {
      return false;
    }

    const pointData = await this.dataLayer.findPointById(pointId);
    if (!pointData) {
      return false;
    }

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
  getHoveredPoint(): Record<string, any> | null {
    return this.labelLayer.getHoveredPoint();
  }

  /**
   * プログラム的にラベルをホバー状態にする
   * @param identifier ラベル識別子（テキストまたはクラスターで識別）
   * @returns ラベルが見つかりホバーされた場合はtrue、そうでない場合はfalse
   */
  setLabelHover(identifier: LabelIdentifier): boolean {
    const label = this.labelLayer.findLabel(identifier);
    if (!label) {
      return false;
    }

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
    this.labelLayer.setHoveredPoint(null);
    this.labelLayer.setHoveredLabel(null);
  }

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
   * フィルターされたポイントの表示モードを設定する
   * @param mode 'hidden'（非表示）または 'grayed'（灰色表示）
   */
  setFilteredPointDisplayMode(mode: FilteredPointDisplayMode): void {
    this.gpuLayer.setFilteredPointDisplayMode(mode);
    this.render();
  }

  /**
   * 現在のフィルター表示モードを取得する
   * @returns 現在のフィルター表示モード
   */
  getFilteredPointDisplayMode(): FilteredPointDisplayMode {
    return this.gpuLayer.getFilteredPointDisplayMode();
  }

  /**
   * リソースを破棄する
   */
  async destroy(): Promise<void> {
    await this.dataLayer.destroy();
    this.gpuLayer.destroy();
    this.labelLayer.destroy();
  }
}
