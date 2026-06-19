import type {
  Label,
  LabelFilterLambda,
  PointHoverCallback,
  HoverOutlineOptions,
  LabelIdentifier,
  LabelHoverCallback,
} from '../types.js';
import type { DataLayer } from '../data/data-layer.js';
import { getPointColor, getPointSize } from '../util/point.js';

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
  /**
   * filterLambda が false を返した「非マッチ」ラベルの不透明度（0-1）。指定すると非マッチ
   * ラベルをグレー化せず、元のクラスタ色のまま opacity だけ下げて描画する（dim-only）。
   * 未指定時は従来どおりグレー表示。
   */
  unmatchedLabelOpacity?: number;
  /** ラベルクリック時のコールバック */
  onLabelClick?: (label: Label, event?: MouseEvent) => void;
  /** ポイントホバー時のコールバック */
  onPointHover?: PointHoverCallback;
  /** ラベルホバー時のコールバック */
  onLabelHover?: LabelHoverCallback;
  /** ホバー時のアウトラインオプション */
  hoverOutlineOptions?: HoverOutlineOptions;
  /** データレイヤー参照 */
  dataLayer?: DataLayer;
}

/**
 * ラベル描画用の2Dキャンバスオーバーレイを管理するクラス
 * テキストラベルの描画、衝突検出、座標変換を担当する
 */
export class LabelLayer {
  /** WebGPUキャンバス（位置決めに使用） */
  private canvas: HTMLCanvasElement;
  /** ラベル描画用の2Dキャンバス */
  private labelCanvas!: HTMLCanvasElement;
  /** 2Dキャンバスの描画コンテキスト */
  private labelContext!: CanvasRenderingContext2D;
  /** 表示するラベルの配列 */
  private labels: Label[] = [];
  /** ラベル間の最小距離（ピクセル） */
  private readonly minLabelDistance: number = 40;
  /** ラベルのフォントサイズ（ピクセル） */
  private labelFontSize: number = 12;
  /** ラベルフィルタリング関数 */
  private filterLambda?: LabelFilterLambda;
  /** 非マッチラベルの dim opacity（指定時は元色を保持して減衰、未指定はグレー表示） */
  private unmatchedLabelOpacity?: number;

  /** 現在のズーム倍率 */
  private zoom: number = 1.0;
  /** X方向のパン量 */
  private panX: number = 0.0;
  /** Y方向のパン量 */
  private panY: number = 0.0;

  /** ラベルクリック時のコールバック */
  private onLabelClick?: (label: Label, event?: MouseEvent) => void;
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
  private hoveredPoint: Record<string, any> | null = null;
  /** 直近に hover した点の rowid（mousemove ごとの再クエリ抑制用。null=点上に無い） */
  private hoveredRowid: number | null = null;
  /** hover データ取得（findPointById）の世代カウンタ（古い非同期結果の破棄=stale guard 用） */
  private hoverQuerySeq = 0;
  /** ホバーアウトラインのオプション */
  private hoverOutlineOptions: HoverOutlineOptions;
  /** データレイヤー参照 */
  private readonly dataLayer: DataLayer | null = null;

  /**
   * LabelLayerを初期化する
   * @param options 初期化オプション
   */
  constructor(options: LabelLayerOptions) {
    this.canvas = options.canvas;
    this.minLabelDistance = options.minLabelDistance ?? this.minLabelDistance;
    this.labelFontSize = options.labelFontSize ?? this.labelFontSize;
    this.filterLambda = options.filterLambda;
    this.unmatchedLabelOpacity = options.unmatchedLabelOpacity;
    this.onLabelClick = options.onLabelClick;
    this.onPointHover = options.onPointHover;
    this.onLabelHover = options.onLabelHover;
    this.dataLayer = options.dataLayer ?? null;
    this.hoverOutlineOptions = {
      enabled: options.hoverOutlineOptions?.enabled ?? true,
      color: options.hoverOutlineOptions?.color ?? 'white',
      width: options.hoverOutlineOptions?.width ?? 2,
      minimumHoverSize: options.hoverOutlineOptions?.minimumHoverSize ?? 10,
      outlinedPointAddition: options.hoverOutlineOptions?.outlinedPointAddition ?? 3,
    };

    this.createLabelCanvas();
  }

  /**
   * ラベル描画用の2Dキャンバスを作成してDOMに追加する
   */
  private createLabelCanvas(): void {
    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = this.canvas.width;
    this.labelCanvas.height = this.canvas.height;
    this.labelCanvas.style.position = 'absolute';
    this.labelCanvas.style.pointerEvents = 'none';
    this.labelCanvas.style.top = '0';
    this.labelCanvas.style.left = '0';
    this.labelCanvas.style.width = this.canvas.style.width || `${this.canvas.width}px`;
    this.labelCanvas.style.height = this.canvas.style.height || `${this.canvas.height}px`;

    const parent = this.canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }

      this.labelCanvas.style.top = `${this.canvas.offsetTop}px`;
      this.labelCanvas.style.left = `${this.canvas.offsetLeft}px`;

      parent.appendChild(this.labelCanvas);
    }

    this.labelContext = this.labelCanvas.getContext('2d')!;

    this.setupEventListeners();
  }

  /**
   * ビュー変換の状態を更新する
   * @param zoom ズーム倍率
   * @param panX X方向のパン量
   * @param panY Y方向のパン量
   */
  updateViewTransform(zoom: number, panX: number, panY: number): void {
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
  }

  /**
   * ラベルを2Dキャンバスに描画する
   */
  render(): void {
    this.labelContext.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height);
    this.renderedLabelBounds = [];

    if (this.labels.length === 0) {
      return;
    }

    const fontSize = this.labelFontSize;
    this.labelContext.fillStyle = 'white';
    this.labelContext.strokeStyle = 'black';
    this.labelContext.lineWidth = 2;
    this.labelContext.textAlign = 'center';
    this.labelContext.textBaseline = 'middle';

    const renderedPositions: Array<{ x: number; y: number }> = [];

    const labelsWithFilter = this.labels.map((label) => ({
      label,
      passedFilter:
        this.filterLambda && label.properties ? this.filterLambda(label.properties) : true,
    }));

    labelsWithFilter.sort((a, b) => {
      if (a.passedFilter !== b.passedFilter) {
        return a.passedFilter ? -1 : 1;
      }
      return 0;
    });

    for (const { label, passedFilter } of labelsWithFilter) {
      const { x: screenX, y: screenY } = this.worldToScreenCoords(label.x, label.y);

      if (
        screenX >= 0 &&
        screenX <= this.labelCanvas.width &&
        screenY >= 0 &&
        screenY <= this.labelCanvas.height
      ) {
        const effectiveMinDistance = this.minLabelDistance * (this.labelFontSize / 12);
        const tooClose = renderedPositions.some((pos) => {
          const dx = pos.x - screenX;
          const dy = pos.y - screenY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          return distance < effectiveMinDistance;
        });

        if (!tooClose) {
          const isHovered = this.hoveredLabel === label;
          const scale = isHovered ? this.hoverScale : this.normalScale;
          const scaledFontSize = fontSize * scale;

          this.labelContext.font = `bold ${scaledFontSize}px sans-serif`;

          const textMetrics = this.labelContext.measureText(label.text);
          const textWidth = textMetrics.width;
          const textHeight = scaledFontSize;

          if (passedFilter) {
            this.labelContext.shadowColor = 'rgba(0, 0, 0, 0.4)';
            this.labelContext.shadowBlur = 6;
            this.labelContext.shadowOffsetX = 2;
            this.labelContext.shadowOffsetY = 2;

            this.labelContext.fillStyle = 'white';

            if (
              label.properties?.color &&
              Array.isArray(label.properties.color) &&
              label.properties.color.length === 3
            ) {
              const [r, g, b] = label.properties.color;
              this.labelContext.strokeStyle = `rgb(${r}, ${g}, ${b})`;
            } else {
              this.labelContext.strokeStyle = 'white';
            }
            this.labelContext.lineWidth = 2;
          } else if (this.unmatchedLabelOpacity !== undefined) {
            // dim-only: グレー化や非表示ではなく opacity だけ下げる（ノードの dim-only 選択と
            // 視覚を揃える）。色を持つラベルは元のクラスタ色を保持し、color 配列を持たない
            // 標準ラベル（generate_labels.py の cluster_label/cluster/count のみ）でも要求 opacity
            // を尊重する（中立グレーを同じ opacity で適用）。
            const a = this.unmatchedLabelOpacity;
            const col = label.properties?.color;
            const hasColor = Array.isArray(col) && col.length === 3;
            this.labelContext.shadowColor = 'transparent';
            this.labelContext.shadowBlur = 0;
            this.labelContext.fillStyle = `rgba(255, 255, 255, ${a})`;
            this.labelContext.strokeStyle = hasColor
              ? `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${a})`
              : `rgba(100, 100, 100, ${a})`;
            this.labelContext.lineWidth = 2;
          } else {
            this.labelContext.shadowColor = 'rgba(0, 0, 0, 0.3)';
            this.labelContext.shadowBlur = 4;
            this.labelContext.shadowOffsetX = 2;
            this.labelContext.shadowOffsetY = 2;

            this.labelContext.fillStyle = 'rgba(180, 180, 180, 0.6)';
            this.labelContext.strokeStyle = 'rgba(100, 100, 100, 0.6)';
            this.labelContext.lineWidth = 1.5;
          }

          this.labelContext.strokeText(label.text, screenX, screenY);
          this.labelContext.fillText(label.text, screenX, screenY);

          this.labelContext.shadowColor = 'transparent';
          this.labelContext.shadowBlur = 0;
          this.labelContext.shadowOffsetX = 0;
          this.labelContext.shadowOffsetY = 0;

          this.renderedLabelBounds.push({
            label,
            x: screenX - textWidth / 2,
            y: screenY - textHeight / 2,
            width: textWidth,
            height: textHeight,
          });

          renderedPositions.push({ x: screenX, y: screenY });
        }
      }
    }

    this.renderPointOutline();
  }

  /**
   * ホバー中のポイントにアウトラインを描画する
   */
  private renderPointOutline(): void {
    if (!this.hoveredPoint || !this.dataLayer) {
      return;
    }

    if (!this.hoverOutlineOptions.enabled) {
      return;
    }

    const pointX = this.hoveredPoint['x'];
    const pointY = this.hoveredPoint['y'];

    if (pointX == null || pointY == null) {
      return;
    }

    const { x: screenX, y: screenY } = this.worldToScreenCoords(pointX, pointY);

    const baseSize = getPointSize(this.hoveredPoint);
    const zoomScaledSize = Math.max(
      baseSize * Math.pow(this.zoom, 0.3) + (this.hoverOutlineOptions.outlinedPointAddition ?? 3),
      this.hoverOutlineOptions.minimumHoverSize ?? 10
    );

    const screenRadius = zoomScaledSize;

    this.labelContext.beginPath();
    this.labelContext.arc(screenX, screenY, screenRadius, 0, Math.PI * 2);

    const color = getPointColor(this.hoveredPoint);
    this.labelContext.fillStyle = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${Math.round(color.a * 255)})`;
    this.labelContext.fill();

    this.labelContext.strokeStyle = this.hoverOutlineOptions.color ?? 'black';
    this.labelContext.lineWidth = this.hoverOutlineOptions.width ?? 2;
    this.labelContext.stroke();
  }

  /**
   * GeoJSONデータからラベルを読み込む
   * @param geojsonData GeoJSON形式のデータ
   */
  loadLabels(geojsonData: any): void {
    if (!geojsonData || !geojsonData.features) {
      return;
    }

    const allLabels = geojsonData.features.map((feature: any) => ({
      text: feature.properties?.cluster_label || '',
      x: feature.geometry?.coordinates?.[0] || 0,
      y: feature.geometry?.coordinates?.[1] || 0,
      cluster: feature.properties?.cluster,
      count: feature.properties?.count || 0,
      properties: feature.properties || {},
    }));

    this.labels = allLabels.sort((a: Label, b: Label) => (b.count || 0) - (a.count || 0));
  }

  /**
   * ホバーとクリック操作用のイベントリスナーを設定する
   */
  private setupEventListeners(): void {
    const parent = this.labelCanvas.parentElement;
    if (!parent) return;

    parent.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.labelCanvas.getBoundingClientRect();
      const scaleX = this.labelCanvas.width / rect.width;
      const scaleY = this.labelCanvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      const labelAtPosition = this.getLabelAtPosition(x, y);

      // 点の hit-test は spatial index だけで rowid を引く（DuckDB クエリは発行しない）。
      let nearestRowid: number | null = null;
      if (!labelAtPosition && this.dataLayer) {
        const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;
        nearestRowid = this.dataLayer.findNearestPointId(
          x,
          y,
          this.labelCanvas.width,
          this.labelCanvas.height,
          this.zoom,
          this.panX,
          this.panY,
          aspectRatio,
          10
        );
      }

      if (labelAtPosition) {
        this.labelCanvas.style.pointerEvents = 'auto';
        this.labelCanvas.style.cursor = 'pointer';
      } else {
        this.labelCanvas.style.pointerEvents = 'none';
        this.labelCanvas.style.cursor = nearestRowid != null ? 'pointer' : 'default';
      }

      if (labelAtPosition !== this.hoveredLabel) {
        this.hoveredLabel = labelAtPosition;
        if (this.onLabelHover) {
          this.onLabelHover(this.hoveredLabel);
        }
        this.render();
      }

      // hover 中の点が変わらなければ何もしない（同じ点での再クエリ・再 render を防ぐ）。
      if (nearestRowid === this.hoveredRowid) {
        return;
      }
      this.hoveredRowid = nearestRowid;
      // 進行中の hover クエリを無効化（古い結果が新しい hover を上書きしないように）。
      const seq = ++this.hoverQuerySeq;

      if (nearestRowid == null) {
        if (this.hoveredPoint !== null) {
          this.hoveredPoint = null;
          if (this.onPointHover) {
            this.onPointHover(null);
          }
          this.render();
        }
        return;
      }

      // rowid が変わったときだけ点データ本体（SELECT *）を取得する。
      // 非同期結果は seq で検証し、古いものは破棄する（stale guard）。
      void this.dataLayer!.findPointById(nearestRowid)
        .then((data) => {
          if (seq !== this.hoverQuerySeq) {
            return;
          }
          this.hoveredPoint = data;
          if (this.onPointHover) {
            this.onPointHover(this.hoveredPoint);
          }
          this.render();
        })
        .catch(() => {
          /* hover query failure: keep previous hovered point */
        });
    });

    this.labelCanvas.addEventListener('click', (e: MouseEvent) => {
      const rect = this.labelCanvas.getBoundingClientRect();
      const scaleX = this.labelCanvas.width / rect.width;
      const scaleY = this.labelCanvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      const labelAtPosition = this.getLabelAtPosition(x, y);

      if (labelAtPosition && this.onLabelClick) {
        // クリックの MouseEvent を渡す（Ctrl/Meta 等の修飾キー判定を呼び出し側で行えるように）
        this.onLabelClick(labelAtPosition, e);
        e.stopPropagation();
      }
    });

    this.labelCanvas.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        const newEvent = new WheelEvent('wheel', e);
        this.canvas.dispatchEvent(newEvent);
      },
      { passive: false }
    );

    this.labelCanvas.addEventListener('mousedown', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mousedown', e);
      this.canvas.dispatchEvent(newEvent);
    });

    this.labelCanvas.addEventListener('mousemove', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mousemove', e);
      this.canvas.dispatchEvent(newEvent);
    });

    this.labelCanvas.addEventListener('mouseup', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mouseup', e);
      this.canvas.dispatchEvent(newEvent);
    });

    this.labelCanvas.addEventListener('mouseleave', (e: MouseEvent) => {
      const newEvent = new MouseEvent('mouseleave', e);
      this.canvas.dispatchEvent(newEvent);
    });

    parent.addEventListener('mouseleave', () => {
      const hadLabel = this.hoveredLabel !== null;
      const hadPoint = this.hoveredPoint !== null;

      this.hoveredLabel = null;
      this.hoveredPoint = null;
      this.hoveredRowid = null;
      this.hoverQuerySeq++;

      if (hadLabel && this.onLabelHover) {
        this.onLabelHover(null);
      }

      if (hadPoint && this.onPointHover) {
        this.onPointHover(null);
      }

      this.labelCanvas.style.pointerEvents = 'none';
      this.labelCanvas.style.cursor = 'default';
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
    for (const bound of this.renderedLabelBounds) {
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
    this.labelCanvas.width = width;
    this.labelCanvas.height = height;
    this.labelCanvas.style.width = this.canvas.style.width;
    this.labelCanvas.style.height = this.canvas.style.height;
  }

  /**
   * ラベルレイヤーのオプションを更新する
   * @param options 更新するオプション
   */
  updateOptions(options: Partial<LabelLayerOptions>): void {
    if (options.labelFontSize !== undefined) {
      this.labelFontSize = options.labelFontSize;
    }
    if (options.filterLambda !== undefined) {
      this.filterLambda = options.filterLambda;
    }
    if (options.unmatchedLabelOpacity !== undefined) {
      this.unmatchedLabelOpacity = options.unmatchedLabelOpacity;
    }
    if (options.onLabelClick !== undefined) {
      this.onLabelClick = options.onLabelClick;
    }
    if (options.onPointHover !== undefined) {
      this.onPointHover = options.onPointHover;
    }
    if (options.onLabelHover !== undefined) {
      this.onLabelHover = options.onLabelHover;
    }
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
  setHoveredPoint(data: Record<string, any> | null): void {
    if (data === this.hoveredPoint) {
      return;
    }
    // 進行中の mousemove hover クエリを無効化し、その結果がこの明示設定を上書きしないようにする。
    // hoveredRowid もリセットする: これをしないと、cursor が同じ点上にあるまま null クリア
    // された場合、次の mousemove が `nearestRowid === this.hoveredRowid` 早期 return に当たり、
    // 点を再取得できず onPointHover も発火しなくなる（別の点/空白へ動くまで復帰しない）。
    this.hoverQuerySeq++;
    this.hoveredRowid = null;
    this.hoveredPoint = data;

    if (this.onPointHover) {
      this.onPointHover(this.hoveredPoint);
    }

    this.render();
  }

  /**
   * プログラム的にホバー中のラベルを設定する
   * @param label ホバーするラベル、またはnullでクリア
   */
  setHoveredLabel(label: Label | null): void {
    if (label === this.hoveredLabel) {
      return;
    }
    this.hoveredLabel = label;

    if (this.onLabelHover) {
      this.onLabelHover(this.hoveredLabel);
    }

    this.render();
  }

  /**
   * 識別子でラベルを検索する
   * @param identifier ラベル識別子（textまたはcluster）
   * @returns 見つかったラベル、またはnull
   */
  findLabel(identifier: LabelIdentifier): Label | null {
    for (const label of this.labels) {
      if (identifier.text !== undefined && label.text === identifier.text) {
        return label;
      }
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
  getHoveredPoint(): Record<string, any> | null {
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
   * ワールド座標をスクリーン座標に変換する
   * @param worldX ワールドX座標
   * @param worldY ワールドY座標
   * @returns スクリーン座標
   */
  private worldToScreenCoords(worldX: number, worldY: number): { x: number; y: number } {
    const aspectRatio = this.labelCanvas.width / this.labelCanvas.height;
    const clipX = worldX * (this.zoom / aspectRatio) + this.panX;
    const clipY = worldY * this.zoom + this.panY;
    const screenX = (clipX + 1) * 0.5 * this.labelCanvas.width;
    const screenY = (1 - clipY) * 0.5 * this.labelCanvas.height;
    return { x: screenX, y: screenY };
  }

  /**
   * リソースを解放してレイヤーを破棄する
   */
  destroy(): void {
    if (this.labelCanvas.parentElement) {
      this.labelCanvas.parentElement.removeChild(this.labelCanvas);
    }
  }
}
