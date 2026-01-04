import type {
  Label,
  LabelFilterLambda,
  PointHoverCallback,
  HoverOutlineOptions,
  LabelIdentifier,
  LabelHoverCallback,
} from '../types.js';
import type { DataLayer } from './data-layer.js';

/**
 * ラベルレイヤーの初期化オプション
 */
export interface LabelLayerOptions {
  /** WebGPUキャンバス（位置決めに使用） */
  canvas: HTMLCanvasElement;
  /** ラベル間の最小距離（ピクセル） */
  minLabelDistance?: number;
  /** ラベルのフォントサイズ（ピクセル） */
  labelFontSize?: number;
  /** ラベルのフィルタリング関数 */
  filterLambda?: LabelFilterLambda;
  /** ラベルクリック時のコールバック */
  onLabelClick?: (label: Label) => void;
  /** ポイントホバー時のコールバック */
  onPointHover?: PointHoverCallback;
  /** ラベルホバー時のコールバック */
  onLabelHover?: LabelHoverCallback;
  /** ホバー時のアウトラインオプション */
  hoverOutlineOptions?: HoverOutlineOptions;
  /** データレイヤー参照 */
  dataLayer?: DataLayer;
  /** アウトライン付きポイントの追加サイズ */
  outlinedPointAddition?: number;
  /** ホバー時の最小サイズ */
  minimumHoverSize?: number;
}

/**
 * ラベル描画用の2Dキャンバスオーバーレイを管理するクラス
 * テキストラベルの描画、衝突検出、座標変換を担当する
 */
export class LabelLayer {
  /** WebGPUキャンバス（位置決めに使用） */
  private canvas: HTMLCanvasElement;
  /** ラベル描画用の2Dキャンバス */
  private labelCanvas: HTMLCanvasElement | null = null;
  /** 2Dキャンバスの描画コンテキスト */
  private labelContext: CanvasRenderingContext2D | null = null;
  /** 表示するラベルの配列 */
  private labels: Label[] = [];
  /** ラベル間の最小距離（ピクセル） */
  private readonly minLabelDistance: number = 40;
  /** ラベルのフォントサイズ（ピクセル） */
  private labelFontSize: number = 12;
  /** ラベルフィルタリング関数 */
  private filterLambda?: LabelFilterLambda;

  /** 現在のズーム倍率 */
  private zoom: number = 1.0;
  /** X方向のパン量 */
  private panX: number = 0.0;
  /** Y方向のパン量 */
  private panY: number = 0.0;

  /** ラベルクリック時のコールバック */
  private onLabelClick?: (label: Label) => void;
  /** 描画されたラベルのバウンディングボックス配列 */
  private renderedLabelBounds: Array<{
    label: Label;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  /** 現在ホバー中のラベル */
  private hoveredLabel: Label | null = null;
  /** 通常時のスケール */
  private readonly normalScale = 1.0;
  /** ホバー時のスケール */
  private readonly hoverScale = 1.3;
  /** ヒット検出用のパディング（ピクセル） */
  private readonly hitPadding = 10;

  /** ポイントホバー時のコールバック */
  private onPointHover?: PointHoverCallback;
  /** ラベルホバー時のコールバック */
  private onLabelHover?: LabelHoverCallback;
  /** 現在ホバー中のポイント */
  private hoveredPoint: { row: any[]; columns: string[] } | null = null;
  /** ホバーアウトラインのオプション */
  private hoverOutlineOptions: HoverOutlineOptions;
  /** データレイヤー参照 */
  private readonly dataLayer: DataLayer | null = null;

  /**
   * LabelLayerを初期化する
   * @param options 初期化オプション
   */
  constructor(options: LabelLayerOptions) {
    // キャンバス参照を保存
    this.canvas = options.canvas;
    // 最小ラベル距離を設定（デフォルト40）
    this.minLabelDistance = options.minLabelDistance ?? this.minLabelDistance;
    // フォントサイズを設定（デフォルト12）
    this.labelFontSize = options.labelFontSize ?? this.labelFontSize;
    // ラベル配列を空で初期化
    this.labels = [];
    // フィルタ関数を保存
    this.filterLambda = options.filterLambda;
    // 各コールバックを保存
    this.onLabelClick = options.onLabelClick;
    this.onPointHover = options.onPointHover;
    this.onLabelHover = options.onLabelHover;
    // データレイヤー参照を保存
    this.dataLayer = options.dataLayer ?? null;
    // ホバーアウトラインオプションをデフォルト値とマージ
    this.hoverOutlineOptions = {
      enabled: options.hoverOutlineOptions?.enabled ?? true,
      color: options.hoverOutlineOptions?.color ?? 'white',
      width: options.hoverOutlineOptions?.width ?? 2,
      minimumHoverSize: options.hoverOutlineOptions?.minimumHoverSize ?? 10,
      outlinedPointAddition: options.hoverOutlineOptions?.outlinedPointAddition ?? 3,
    };
  }

  /**
   * ラベルキャンバスオーバーレイを初期化する
   */
  initialize(): void {
    // 2Dキャンバスを作成して配置
    this.createLabelCanvas();
  }

  /**
   * ラベル描画用の2Dキャンバスを作成してDOMに追加する
   */
  private createLabelCanvas(): void {
    // 新しいcanvas要素を作成
    this.labelCanvas = document.createElement('canvas');
    // WebGPUキャンバスと同じサイズに設定
    this.labelCanvas.width = this.canvas.width;
    this.labelCanvas.height = this.canvas.height;
    // 絶対位置で配置
    this.labelCanvas.style.position = 'absolute';
    // 初期状態ではマウスイベントを通過させる
    this.labelCanvas.style.pointerEvents = 'none';
    this.labelCanvas.style.top = '0';
    this.labelCanvas.style.left = '0';
    // WebGPUキャンバスのCSSサイズをコピー（HiDPI対応）
    this.labelCanvas.style.width = this.canvas.style.width || `${this.canvas.width}px`;
    this.labelCanvas.style.height = this.canvas.style.height || `${this.canvas.height}px`;

    // 親要素を取得
    const parent = this.canvas.parentElement;
    if (parent) {
      // 親要素がstaticの場合はrelativeに変更
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }

      // WebGPUキャンバスの位置に合わせてラベルキャンバスを配置
      this.labelCanvas.style.top = `${this.canvas.offsetTop}px`;
      this.labelCanvas.style.left = `${this.canvas.offsetLeft}px`;

      // 親要素にラベルキャンバスを追加
      parent.appendChild(this.labelCanvas);
    }

    // 2D描画コンテキストを取得
    this.labelContext = this.labelCanvas.getContext('2d');

    // マウスイベントリスナーを設定
    this.setupEventListeners();
  }

  /**
   * ビュー変換の状態を更新する
   * @param zoom ズーム倍率
   * @param panX X方向のパン量
   * @param panY Y方向のパン量
   */
  updateViewTransform(zoom: number, panX: number, panY: number): void {
    // ズームとパン値を保存
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
  }

  /**
   * ラベルを2Dキャンバスに描画する
   */
  render(): void {
    // コンテキストがなければ終了
    if (!this.labelContext || !this.labelCanvas) {
      return;
    }

    // キャンバス全体をクリア
    this.labelContext.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height);
    // 描画済みラベルのバウンディングボックスをリセット
    this.renderedLabelBounds = [];

    // ラベルがなければ終了
    if (this.labels.length === 0) {
      return;
    }

    // テキスト描画の基本設定
    const fontSize = this.labelFontSize;
    this.labelContext.fillStyle = 'white';
    this.labelContext.strokeStyle = 'black';
    this.labelContext.lineWidth = 2;
    this.labelContext.textAlign = 'center';
    this.labelContext.textBaseline = 'middle';

    // 描画済みラベルの位置を記録する配列
    const renderedPositions: Array<{ x: number; y: number }> = [];

    // 各ラベルにフィルタを適用した結果を計算
    const labelsWithFilter = this.labels.map((label) => ({
      label,
      passedFilter:
        this.filterLambda && label.properties ? this.filterLambda(label.properties) : true,
    }));

    // フィルタを通過したラベルを優先的に描画するためソート
    labelsWithFilter.sort((a, b) => {
      if (a.passedFilter !== b.passedFilter) {
        return a.passedFilter ? -1 : 1;
      }
      return 0;
    });

    // 各ラベルを衝突検出しながら描画
    for (const { label, passedFilter } of labelsWithFilter) {
      // ラベルのワールド座標を取得
      const worldX = label.x;
      const worldY = label.y;

      // アスペクト比を計算
      const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;

      // ズームとパンを適用してクリップ空間座標に変換
      const clipX = worldX * (this.zoom / aspectRatio) + this.panX;
      const clipY = worldY * this.zoom + this.panY;

      // クリップ空間（-1〜1）からスクリーン空間（0〜キャンバスサイズ）に変換
      const screenX = (clipX + 1) * 0.5 * this.labelCanvas.width;
      // Y軸を反転してスクリーン座標に変換
      const screenY = (1 - clipY) * 0.5 * this.labelCanvas.height;

      // 可視範囲内かチェック
      if (
        screenX >= 0 &&
        screenX <= this.labelCanvas.width &&
        screenY >= 0 &&
        screenY <= this.labelCanvas.height
      ) {
        // フォントサイズに基づいて衝突検出距離を調整
        const effectiveMinDistance = this.minLabelDistance * (this.labelFontSize / 12);
        // 既存のラベルと近すぎるかチェック
        const tooClose = renderedPositions.some((pos) => {
          const dx = pos.x - screenX;
          const dy = pos.y - screenY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          return distance < effectiveMinDistance;
        });

        // 衝突しない場合のみ描画
        if (!tooClose) {
          // ホバー中のラベルは拡大表示
          const isHovered = this.hoveredLabel === label;
          const scale = isHovered ? this.hoverScale : this.normalScale;
          const scaledFontSize = fontSize * scale;

          // スケール適用済みのフォントを設定
          this.labelContext.font = `bold ${scaledFontSize}px sans-serif`;

          // テキストの幅を測定
          const textMetrics = this.labelContext.measureText(label.text);
          const textWidth = textMetrics.width;
          const textHeight = scaledFontSize;

          // 背景ボックスのサイズを計算
          const padding = 4;
          const boxX = screenX - textWidth / 2 - padding;
          const boxY = screenY - textHeight / 2 - padding;
          const boxWidth = textWidth + padding * 2;
          const boxHeight = textHeight + padding * 2;
          const borderRadius = 4;

          // フィルタ結果に応じてスタイルを設定
          if (passedFilter) {
            // アクティブラベル用の背景を描画
            this.labelContext.fillStyle = 'rgba(0, 0, 0, 0.7)';
            this.labelContext.beginPath();
            this.labelContext.roundRect(boxX, boxY, boxWidth, boxHeight, borderRadius);
            this.labelContext.fill();

            // カスタムカラーがあれば使用
            if (
              label.properties?.color &&
              Array.isArray(label.properties.color) &&
              label.properties.color.length === 3
            ) {
              const [r, g, b] = label.properties.color;
              this.labelContext.fillStyle = `rgb(${r}, ${g}, ${b})`;
              this.labelContext.strokeStyle = 'rgba(0, 0, 0, 0.3)';
            } else {
              // デフォルトは白色テキスト
              this.labelContext.fillStyle = 'white';
              this.labelContext.strokeStyle = 'rgba(0, 0, 0, 0.3)';
            }
            this.labelContext.lineWidth = 3;
          } else {
            // フィルタ対象外ラベル用の薄い背景を描画
            this.labelContext.fillStyle = 'rgba(0, 0, 0, 0.4)';
            this.labelContext.beginPath();
            this.labelContext.roundRect(boxX, boxY, boxWidth, boxHeight, borderRadius);
            this.labelContext.fill();

            // フィルタ対象外は薄いグレーで表示
            this.labelContext.fillStyle = 'rgba(180, 180, 180, 0.6)';
            this.labelContext.strokeStyle = 'rgba(40, 40, 40, 0.8)';
            this.labelContext.lineWidth = 2;
          }

          // テキストのアウトラインを描画
          this.labelContext.strokeText(label.text, screenX, screenY);
          // テキスト本体を描画
          this.labelContext.fillText(label.text, screenX, screenY);

          // ヒット検出用にバウンディングボックスを保存
          this.renderedLabelBounds.push({
            label,
            x: screenX - textWidth / 2,
            y: screenY - textHeight / 2,
            width: textWidth,
            height: textHeight,
          });

          // 衝突検出用に位置を記録
          renderedPositions.push({ x: screenX, y: screenY });
        }
      }
    }

    // ホバー中のポイントにアウトラインを描画
    this.renderPointOutline();
  }

  /**
   * ホバー中のポイントにアウトラインを描画する
   */
  private renderPointOutline(): void {
    // 必要なオブジェクトがなければ終了
    if (!this.labelContext || !this.labelCanvas || !this.hoveredPoint || !this.dataLayer) {
      return;
    }

    // アウトラインが無効なら終了
    if (!this.hoverOutlineOptions.enabled) {
      return;
    }

    // 行データからx,y座標のインデックスを取得
    const xIndex = this.hoveredPoint.columns.indexOf('x');
    const yIndex = this.hoveredPoint.columns.indexOf('y');

    // x,yカラムがなければ終了
    if (xIndex === -1 || yIndex === -1) {
      return;
    }

    // ワールド座標を取得
    const worldX = this.hoveredPoint.row[xIndex];
    const worldY = this.hoveredPoint.row[yIndex];

    // アスペクト比を計算
    const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;

    // ズームとパンを適用してクリップ空間座標に変換
    const clipX = worldX * (this.zoom / aspectRatio) + this.panX;
    const clipY = worldY * this.zoom + this.panY;

    // クリップ空間からスクリーン空間に変換
    const screenX = (clipX + 1) * 0.5 * this.labelCanvas.width;
    const screenY = (1 - clipY) * 0.5 * this.labelCanvas.height;

    // ポイントのサイズをデータレイヤーから取得
    const baseSize = this.dataLayer.getPointSize(this.hoveredPoint.row, this.hoveredPoint.columns);
    // ズームスケールを適用したサイズを計算
    const zoomScaledSize = Math.max(
      baseSize * Math.pow(this.zoom, 0.3) + (this.hoverOutlineOptions.outlinedPointAddition ?? 3),
      this.hoverOutlineOptions.minimumHoverSize ?? 10
    );

    // スクリーン上の半径を設定
    const screenRadius = zoomScaledSize;

    // 円形のアウトラインのパスを開始
    this.labelContext.beginPath();
    this.labelContext.arc(screenX, screenY, screenRadius, 0, Math.PI * 2);

    // ポイントの色をデータレイヤーから取得して塗りつぶし
    const color = this.dataLayer.getPointColor(this.hoveredPoint.row, this.hoveredPoint.columns);
    this.labelContext.fillStyle = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${Math.round(color.a * 255)})`;
    this.labelContext.fill();

    // アウトラインのストロークを描画
    this.labelContext.strokeStyle = this.hoverOutlineOptions.color ?? 'black';
    this.labelContext.lineWidth = this.hoverOutlineOptions.width ?? 2;
    this.labelContext.stroke();
  }

  /**
   * GeoJSONデータからラベルを読み込む
   * @param geojsonData GeoJSON形式のデータ
   */
  loadLabels(geojsonData: any): void {
    // データが無効なら終了
    if (!geojsonData || !geojsonData.features) {
      return;
    }

    // 各フィーチャーをラベルオブジェクトに変換
    const allLabels = geojsonData.features.map((feature: any) => ({
      text: feature.properties?.cluster_label || '',
      x: feature.geometry?.coordinates?.[0] || 0,
      y: feature.geometry?.coordinates?.[1] || 0,
      cluster: feature.properties?.cluster,
      count: feature.properties?.count || 0,
      properties: feature.properties || {},
    }));

    // countで降順ソートして保存
    this.labels = allLabels.sort((a: Label, b: Label) => (b.count || 0) - (a.count || 0));
  }

  /**
   * ホバーとクリック操作用のイベントリスナーを設定する
   */
  private setupEventListeners(): void {
    // ラベルキャンバスがなければ終了
    if (!this.labelCanvas) return;

    // 親要素を取得
    const parent = this.labelCanvas.parentElement;
    if (!parent) return;

    // マウス移動イベント - 親要素で監視してすべての動きをキャッチ
    parent.addEventListener('mousemove', async (e: MouseEvent) => {
      if (!this.labelCanvas) return;

      // マウス位置をキャンバス座標に変換（CSS座標から物理座標へスケーリング）
      const rect = this.labelCanvas.getBoundingClientRect();
      const scaleX = this.labelCanvas.width / rect.width;
      const scaleY = this.labelCanvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      // マウス位置にあるラベルを検索
      const labelAtPosition = this.getLabelAtPosition(x, y);

      // ラベルがない場合のみポイントホバーをチェック
      let pointHit: { row: any[]; columns: string[] } | null = null;
      if (!labelAtPosition && this.dataLayer) {
        const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;
        // データレイヤーで最近接ポイントを検索
        pointHit = await this.dataLayer.findNearestPoint(
          x,
          y,
          this.labelCanvas.width,
          this.labelCanvas.height,
          this.zoom,
          this.panX,
          this.panY,
          aspectRatio,
          10 // ピクセル単位の閾値
        );
      }

      // ラベルヒット時のみポインタイベントを有効化
      if (labelAtPosition) {
        this.labelCanvas.style.pointerEvents = 'auto';
        this.labelCanvas.style.cursor = 'pointer';
      } else {
        this.labelCanvas.style.pointerEvents = 'none';
        this.labelCanvas.style.cursor = pointHit ? 'pointer' : 'default';
      }

      // ラベルホバー状態が変化した場合
      if (labelAtPosition !== this.hoveredLabel) {
        this.hoveredLabel = labelAtPosition;
        // コールバックを呼び出し
        if (this.onLabelHover) {
          this.onLabelHover(this.hoveredLabel);
        }
        // ホバーエフェクトを反映するため再描画
        this.render();
      }

      // ポイントホバー状態が変化した場合
      if (pointHit !== this.hoveredPoint) {
        this.hoveredPoint = pointHit;

        // コールバックを呼び出し
        if (this.onPointHover) {
          this.onPointHover(this.hoveredPoint);
        }

        // ポイントアウトラインを表示するため再描画
        this.render();
      }
    });

    // ラベルキャンバス上のクリックイベント
    this.labelCanvas.addEventListener('click', (e: MouseEvent) => {
      // クリック位置をキャンバス座標に変換（CSS座標から物理座標へスケーリング）
      const rect = this.labelCanvas!.getBoundingClientRect();
      const scaleX = this.labelCanvas!.width / rect.width;
      const scaleY = this.labelCanvas!.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      // クリック位置のラベルを検索
      const labelAtPosition = this.getLabelAtPosition(x, y);

      // ラベルがあればコールバックを呼び出し
      if (labelAtPosition && this.onLabelClick) {
        this.onLabelClick(labelAtPosition);
        // イベントの伝播を停止
        e.stopPropagation();
      }
    });

    // ホイールイベントをWebGPUキャンバスに転送
    this.labelCanvas.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        // 同じイベントをWebGPUキャンバスに再発行
        const newEvent = new WheelEvent('wheel', e);
        this.canvas.dispatchEvent(newEvent);
      },
      { passive: false }
    );

    // マウスダウンイベントをWebGPUキャンバスに転送
    this.labelCanvas.addEventListener('mousedown', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mousedown', e);
      this.canvas.dispatchEvent(newEvent);
    });

    // マウス移動イベントをWebGPUキャンバスに転送
    this.labelCanvas.addEventListener('mousemove', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mousemove', e);
      this.canvas.dispatchEvent(newEvent);
    });

    // マウスアップイベントをWebGPUキャンバスに転送
    this.labelCanvas.addEventListener('mouseup', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mouseup', e);
      this.canvas.dispatchEvent(newEvent);
    });

    // マウスリーブイベントをWebGPUキャンバスに転送
    this.labelCanvas.addEventListener('mouseleave', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mouseleave', e);
      this.canvas.dispatchEvent(newEvent);
    });

    // 親要素からマウスが離れた時のイベント
    parent.addEventListener('mouseleave', () => {
      // 以前のホバー状態を記録
      const hadLabel = this.hoveredLabel !== null;
      const hadPoint = this.hoveredPoint !== null;

      // ホバー状態をリセット
      this.hoveredLabel = null;
      this.hoveredPoint = null;

      // ラベルホバー解除のコールバック
      if (hadLabel && this.onLabelHover) {
        this.onLabelHover(null);
      }

      // ポイントホバー解除のコールバック
      if (hadPoint && this.onPointHover) {
        this.onPointHover(null);
      }

      // ポインタイベントを無効化
      if (this.labelCanvas) {
        this.labelCanvas.style.pointerEvents = 'none';
        this.labelCanvas.style.cursor = 'default';
      }
      // ホバーエフェクトを解除するため再描画
      this.render();
    });
  }

  /**
   * 指定された座標にあるラベルを検索する
   * @param x X座標（ピクセル）
   * @param y Y座標（ピクセル）
   * @returns 見つかったラベル、またはnull
   */
  private getLabelAtPosition(x: number, y: number): Label | null {
    // 描画済みラベルのバウンディングボックスをチェック
    for (const bound of this.renderedLabelBounds) {
      // パディングを含めた範囲内かチェック
      if (
        x >= bound.x - this.hitPadding &&
        x <= bound.x + bound.width + this.hitPadding &&
        y >= bound.y - this.hitPadding &&
        y <= bound.y + bound.height + this.hitPadding
      ) {
        return bound.label;
      }
    }
    return null;
  }

  /**
   * ラベルキャンバスのサイズを変更する
   * @param width 新しい幅
   * @param height 新しい高さ
   */
  resize(width: number, height: number): void {
    if (this.labelCanvas) {
      // キャンバスサイズを更新
      this.labelCanvas.width = width;
      this.labelCanvas.height = height;
      // WebGPUキャンバスのCSSサイズをコピー（HiDPI対応）
      this.labelCanvas.style.width = this.canvas.style.width;
      this.labelCanvas.style.height = this.canvas.style.height;
    }
  }

  /**
   * ラベルレイヤーのオプションを更新する
   * @param options 更新するオプション
   */
  updateOptions(options: Partial<LabelLayerOptions>): void {
    // フォントサイズを更新
    if (options.labelFontSize !== undefined) {
      this.labelFontSize = options.labelFontSize;
    }
    // フィルタ関数を更新
    if (options.filterLambda !== undefined) {
      this.filterLambda = options.filterLambda;
    }
    // ラベルクリックコールバックを更新
    if (options.onLabelClick !== undefined) {
      this.onLabelClick = options.onLabelClick;
    }
    // ポイントホバーコールバックを更新
    if (options.onPointHover !== undefined) {
      this.onPointHover = options.onPointHover;
    }
    // ラベルホバーコールバックを更新
    if (options.onLabelHover !== undefined) {
      this.onLabelHover = options.onLabelHover;
    }
    // ホバーアウトラインオプションを更新
    if (options.hoverOutlineOptions !== undefined) {
      this.hoverOutlineOptions = {
        enabled: options.hoverOutlineOptions.enabled ?? this.hoverOutlineOptions.enabled,
        color: options.hoverOutlineOptions.color ?? this.hoverOutlineOptions.color,
        width: options.hoverOutlineOptions.width ?? this.hoverOutlineOptions.width,
        minimumHoverSize:
          options.hoverOutlineOptions.minimumHoverSize ?? this.hoverOutlineOptions.minimumHoverSize,
        outlinedPointAddition:
          options.hoverOutlineOptions.outlinedPointAddition ??
          this.hoverOutlineOptions.outlinedPointAddition,
      };
    }
  }

  /**
   * 現在のラベル配列を取得する
   * @returns ラベルの配列
   */
  getLabels(): Label[] {
    return this.labels;
  }

  /**
   * プログラム的にホバー中のポイントを設定する
   * @param data ホバーするポイントデータ、またはnullでクリア
   */
  setHoveredPoint(data: { row: any[]; columns: string[] } | null): void {
    // 同じデータなら何もしない
    if (data === this.hoveredPoint) {
      return;
    }
    // ホバーポイントを更新
    this.hoveredPoint = data;

    // コールバックを呼び出し
    if (this.onPointHover) {
      this.onPointHover(this.hoveredPoint);
    }

    // 再描画
    this.render();
  }

  /**
   * プログラム的にホバー中のラベルを設定する
   * @param label ホバーするラベル、またはnullでクリア
   */
  setHoveredLabel(label: Label | null): void {
    // 同じラベルなら何もしない
    if (label === this.hoveredLabel) {
      return;
    }
    // ホバーラベルを更新
    this.hoveredLabel = label;

    // コールバックを呼び出し
    if (this.onLabelHover) {
      this.onLabelHover(this.hoveredLabel);
    }

    // 再描画
    this.render();
  }

  /**
   * 識別子でラベルを検索する
   * @param identifier ラベル識別子（textまたはcluster）
   * @returns 見つかったラベル、またはnull
   */
  findLabel(identifier: LabelIdentifier): Label | null {
    // すべてのラベルをチェック
    for (const label of this.labels) {
      // テキストで一致するかチェック
      if (identifier.text !== undefined && label.text === identifier.text) {
        return label;
      }
      // クラスタIDで一致するかチェック
      if (identifier.cluster !== undefined && label.cluster === identifier.cluster) {
        return label;
      }
    }
    return null;
  }

  /**
   * 現在ホバー中のポイントを取得する
   * @returns ホバー中のポイント、またはnull
   */
  getHoveredPoint(): { row: any[]; columns: string[] } | null {
    return this.hoveredPoint;
  }

  /**
   * 現在ホバー中のラベルを取得する
   * @returns ホバー中のラベル、またはnull
   */
  getHoveredLabel(): Label | null {
    return this.hoveredLabel;
  }

  /**
   * リソースを解放してレイヤーを破棄する
   */
  destroy(): void {
    // ラベルキャンバスをDOMから削除
    if (this.labelCanvas && this.labelCanvas.parentElement) {
      this.labelCanvas.parentElement.removeChild(this.labelCanvas);
    }
  }
}
