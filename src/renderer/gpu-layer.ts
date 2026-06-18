import { WebGPUContext } from './webgpu-context.js';
import {
  scatterVertexShader,
  filterComputeShader,
  updateIndirectShader,
  brushSelectionShader,
  countSelectionShader,
} from './shaders.js';
import type {
  Color4f,
  FilteredPointDisplayMode,
  SelectionStyle,
  SelectionBrushMode,
  BrushBounds,
  ScreenBrushRect,
  BrushOptions,
} from '../types.js';

/** render uniform buffer サイズ（selection style フィールドを含む, byte） */
const RENDER_UNIFORM_SIZE = 176;
/** brush compute uniform buffer サイズ（byte） */
const BRUSH_UNIFORM_SIZE = 80;
/** count compute uniform buffer サイズ（byte） */
const COUNT_UNIFORM_SIZE = 16;
/** SelectionBrushMode → shader 内合成コード */
const BRUSH_MODE_CODE: Record<SelectionBrushMode, number> = {
  replace: 0,
  add: 1,
  subtract: 2,
  toggle: 3,
};
/** 既定の selection 描画スタイル（黄系の強調色） */
const DEFAULT_SELECTION_STYLE: Required<SelectionStyle> = {
  selectedColor: { r: 1.0, g: 0.85, b: 0.2, a: 1.0 },
  unselectedAlpha: 0.25,
  selectedSizeScale: 1.35,
};

/**
 * GPU用に処理されたポイントデータ
 */
export interface AllPointsData {
  /** インスタンスデータ (x, y, color, size) の Float32Array */
  instanceData: Float32Array;
  /** 全ポイント数 */
  totalCount: number;
}

/**
 * GpuLayerの設定オプション
 */
export interface GpuLayerOptions {
  /** 描画対象のHTMLCanvasElement */
  canvas: HTMLCanvasElement;
  /** 背景色（デフォルト: 透明な黒） */
  backgroundColor?: Color4f;
  /** 表示可能なポイントの最大数（デフォルト: 5000000） */
  visiblePointLimit?: number;
  /** グローバル透明度 (0.0-1.0, デフォルト: 1.0) */
  pointAlpha?: number;
  /** グローバルサイズスケール (デフォルト: 1.0) */
  pointSizeScale?: number;
  /** selection mask の描画スタイル */
  selectionStyle?: SelectionStyle;
}

// ビューポート境界のマージン（クリップ空間）
const VIEWPORT_MARGIN = 0.1;

/**
 * WebGPUレンダリングを担当するレイヤー
 * 責務:
 * - WebGPUコンテキストとパイプラインの管理
 * - GPUバッファの作成と管理
 * - コンピュートシェーダーによるLODフィルタリング
 * - Indirect Drawingによるレンダリング
 */
export class GpuLayer {
  /** WebGPUコンテキスト */
  private context: WebGPUContext;
  /** 描画対象のキャンバス */
  private readonly canvas: HTMLCanvasElement;

  /** レンダーパイプライン */
  private renderPipeline: GPURenderPipeline | null = null;
  /** フィルタリング用コンピュートパイプライン */
  private filterPipeline: GPUComputePipeline | null = null;
  /** Indirect Buffer更新用コンピュートパイプライン */
  private updateIndirectPipeline: GPUComputePipeline | null = null;
  /** brush selection 用コンピュートパイプライン */
  private brushSelectionPipeline: GPUComputePipeline | null = null;
  /** selection 集計用コンピュートパイプライン */
  private countSelectionPipeline: GPUComputePipeline | null = null;

  /** クワッド頂点バッファ（stepMode: 'vertex'） */
  private quadVertexBuffer: GPUBuffer | null = null;
  /** 全ポイントデータバッファ (Storage) */
  private allPointsBuffer: GPUBuffer | null = null;
  /** 可視ポイントインデックスバッファ (Storage) */
  private visibleIndicesBuffer: GPUBuffer | null = null;
  /** アトミックカウンターバッファ (Storage) */
  private atomicCounterBuffer: GPUBuffer | null = null;
  /** Indirect Drawingパラメータバッファ */
  private indirectBuffer: GPUBuffer | null = null;
  /** インデックスバッファ */
  private indexBuffer: GPUBuffer | null = null;
  /** レンダリング用ユニフォームバッファ */
  private renderUniformBuffer: GPUBuffer | null = null;
  /** コンピュート用ユニフォームバッファ */
  private computeUniformBuffer: GPUBuffer | null = null;
  /** GPUフィルターカラムデータバッファ */
  private filterColumnsBuffer: GPUBuffer | null = null;
  /** WHERE条件による可視/非可視ビットマップバッファ */
  private visibilityFlagsBuffer: GPUBuffer | null = null;
  /** GPU 常駐 selection bitset（1bit/point, brush で atomic 更新） */
  private selectionFlagsBuffer: GPUBuffer | null = null;
  /** selection bit 数（render の強調/減衰ゲート用, u32×1） */
  private selectionCountBuffer: GPUBuffer | null = null;
  /** brush compute 用 uniform バッファ */
  private brushUniformBuffer: GPUBuffer | null = null;
  /** count compute 用 uniform バッファ */
  private countUniformBuffer: GPUBuffer | null = null;

  /** フィルター済みポイントインデックスバッファ (Storage) */
  private filteredIndicesBuffer: GPUBuffer | null = null;
  /** フィルター済みポイント用アトミックカウンターバッファ (Storage) */
  private filteredCounterBuffer: GPUBuffer | null = null;
  /** フィルター済みポイント用Indirect Drawingパラメータバッファ */
  private filteredIndirectBuffer: GPUBuffer | null = null;
  /** フィルター済みポイント用レンダリングユニフォームバッファ */
  private filteredRenderUniformBuffer: GPUBuffer | null = null;

  /** GPUフィルター条件（range + optional soft-edge fade） */
  private gpuFilterConditions: {
    columnIndex: number;
    min: number;
    max: number;
    fade?: { width: number; edges: 'both' | 'min' | 'max' };
  }[] = [];
  /** WHERE条件フィルタが有効かどうか */
  private whereFilterEnabled: boolean = false;

  /** レンダリング用バインドグループ */
  private renderBindGroup: GPUBindGroup | null = null;
  /** フィルタリング用バインドグループ */
  private filterBindGroup: GPUBindGroup | null = null;
  /** Indirect更新用バインドグループ */
  private updateIndirectBindGroup: GPUBindGroup | null = null;
  /** フィルター済みポイント用レンダリングバインドグループ */
  private filteredRenderBindGroup: GPUBindGroup | null = null;
  /** フィルター済みポイント用Indirect更新バインドグループ */
  private filteredUpdateIndirectBindGroup: GPUBindGroup | null = null;
  /** brush selection 用バインドグループ */
  private brushSelectionBindGroup: GPUBindGroup | null = null;
  /** selection 集計用バインドグループ */
  private countSelectionBindGroup: GPUBindGroup | null = null;

  /** フィルターされたポイントの表示モード */
  private filteredPointDisplayMode: FilteredPointDisplayMode = 'hidden';

  /** 全ポイント数 */
  private totalPointCount: number = 0;
  /** 背景色 */
  private backgroundColor: Color4f = { r: 0, g: 0, b: 0, a: 0 };
  /** 表示可能なポイントの最大数 */
  private visiblePointLimit: number = 5000000;
  /** フィルタリング結果が有効かどうか */
  private filterResultValid: boolean = false;

  /** 現在のズームレベル */
  private zoom: number = 1.0;
  /** 現在のX方向パンオフセット */
  private panX: number = 0.0;
  /** 現在のY方向パンオフセット */
  private panY: number = 0.0;
  /** グローバル透明度 (0.0-1.0) */
  private pointAlpha: number = 1.0;
  /** グローバルサイズスケール */
  private pointSizeScale: number = 1.0;
  /** selection 描画スタイル */
  private selectionStyle: Required<SelectionStyle> = DEFAULT_SELECTION_STYLE;

  /**
   * GpuLayerインスタンスを作成する
   * @param options 設定オプション
   */
  constructor(options: GpuLayerOptions) {
    this.canvas = options.canvas;
    this.context = new WebGPUContext();
    this.backgroundColor = options.backgroundColor ?? { r: 0, g: 0, b: 0, a: 0 };
    this.visiblePointLimit = options.visiblePointLimit ?? 5000000;
    this.pointAlpha = Math.max(0, Math.min(1, options.pointAlpha ?? 1.0));
    this.pointSizeScale = Math.max(0.01, options.pointSizeScale ?? 1.0);
    this.selectionStyle = this.resolveSelectionStyle(options.selectionStyle);
  }

  /** 部分指定の SelectionStyle を既定値で埋める */
  private resolveSelectionStyle(style?: SelectionStyle): Required<SelectionStyle> {
    return {
      selectedColor: style?.selectedColor ?? DEFAULT_SELECTION_STYLE.selectedColor,
      unselectedAlpha: style?.unselectedAlpha ?? DEFAULT_SELECTION_STYLE.unselectedAlpha,
      selectedSizeScale: style?.selectedSizeScale ?? DEFAULT_SELECTION_STYLE.selectedSizeScale,
    };
  }

  /**
   * WebGPUを初期化し、レンダリングリソースを作成する
   * @param initialData 初期データ
   */
  async initialize(initialData: AllPointsData): Promise<void> {
    await this.context.initialize(this.canvas);
    this.createPipelines();
    await this.createBuffers(initialData);
    this.createBindGroups();
  }

  /**
   * パイプラインを作成する
   */
  private createPipelines(): void {
    if (!this.context.device) {
      throw new Error('WebGPU device not initialized');
    }

    const filterShaderModule = this.context.device.createShaderModule({
      code: filterComputeShader,
    });
    this.filterPipeline = this.context.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: filterShaderModule,
        entryPoint: 'main',
      },
    });

    const updateIndirectShaderModule = this.context.device.createShaderModule({
      code: updateIndirectShader,
    });
    this.updateIndirectPipeline = this.context.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: updateIndirectShaderModule,
        entryPoint: 'main',
      },
    });

    const renderShaderModule = this.context.device.createShaderModule({
      code: scatterVertexShader,
    });

    const quadVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 8,
      stepMode: 'vertex',
      attributes: [
        {
          format: 'float32x2',
          offset: 0,
          shaderLocation: 0,
        },
      ],
    };

    this.renderPipeline = this.context.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: renderShaderModule,
        entryPoint: 'vertexMain',
        buffers: [quadVertexBufferLayout],
      },
      fragment: {
        module: renderShaderModule,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format: this.context.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    const brushShaderModule = this.context.device.createShaderModule({
      code: brushSelectionShader,
    });
    this.brushSelectionPipeline = this.context.device.createComputePipeline({
      layout: 'auto',
      compute: { module: brushShaderModule, entryPoint: 'main' },
    });

    const countShaderModule = this.context.device.createShaderModule({
      code: countSelectionShader,
    });
    this.countSelectionPipeline = this.context.device.createComputePipeline({
      layout: 'auto',
      compute: { module: countShaderModule, entryPoint: 'main' },
    });
  }

  /**
   * バッファを作成する
   * @param data 初期データ
   */
  private async createBuffers(data: AllPointsData): Promise<void> {
    if (!this.context.device) return;

    this.totalPointCount = data.totalCount;

    const quadVertices = new Float32Array([-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0]);
    this.quadVertexBuffer = this.context.device.createBuffer({
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.quadVertexBuffer, 0, quadVertices);

    const pointsBufferSize = data.totalCount * 16;
    this.allPointsBuffer = this.context.device.createBuffer({
      size: pointsBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(
      this.allPointsBuffer,
      0,
      data.instanceData.buffer,
      data.instanceData.byteOffset,
      data.instanceData.byteLength
    );

    const indicesBufferSize = data.totalCount * 4;
    this.visibleIndicesBuffer = this.context.device.createBuffer({
      size: indicesBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });

    this.atomicCounterBuffer = this.context.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.indirectBuffer = this.context.device.createBuffer({
      size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
    this.indexBuffer = this.context.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.indexBuffer, 0, indices);

    this.renderUniformBuffer = this.context.device.createBuffer({
      size: RENDER_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.computeUniformBuffer = this.context.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // フィルター済みポイント用バッファ
    this.filteredIndicesBuffer = this.context.device.createBuffer({
      size: indicesBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });

    this.filteredCounterBuffer = this.context.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.filteredIndirectBuffer = this.context.device.createBuffer({
      size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.filteredRenderUniformBuffer = this.context.device.createBuffer({
      size: RENDER_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const filterColumnsBufferSize = Math.max(16, data.totalCount * 16);
    this.filterColumnsBuffer = this.context.device.createBuffer({
      size: filterColumnsBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Visibility flags buffer: ceil(totalCount / 32) * 4 bytes (1 bit per point)
    const visibilityFlagsSize = Math.max(4, Math.ceil(data.totalCount / 32) * 4);
    this.visibilityFlagsBuffer = this.context.device.createBuffer({
      size: visibilityFlagsSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Initialize all bits to 1 (all visible)
    const initialFlags = new Uint32Array(Math.ceil(data.totalCount / 32));
    initialFlags.fill(0xffffffff);
    this.context.device.queue.writeBuffer(this.visibilityFlagsBuffer, 0, initialFlags);

    // selection 用バッファ（bitset + count + brush/count uniform）
    this.createSelectionBuffers(data.totalCount);

    this.updateUniforms();
  }

  /**
   * selection 用 GPU バッファ群を（再）生成し初期化する。
   * selectionFlags（bitset）はサイズが totalCount に依存するため毎回作り直す。
   * count/brush/count-uniform は固定サイズなので未生成時のみ作る。
   */
  private createSelectionBuffers(totalCount: number): void {
    if (!this.context.device) return;

    const wordCount = Math.max(1, Math.ceil(totalCount / 32));

    this.selectionFlagsBuffer?.destroy();
    this.selectionFlagsBuffer = this.context.device.createBuffer({
      size: wordCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // 初期状態は全 bit 0（未選択）
    this.context.device.queue.writeBuffer(this.selectionFlagsBuffer, 0, new Uint32Array(wordCount));

    if (!this.selectionCountBuffer) {
      this.selectionCountBuffer = this.context.device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
    }
    this.context.device.queue.writeBuffer(this.selectionCountBuffer, 0, new Uint32Array([0]));

    if (!this.brushUniformBuffer) {
      this.brushUniformBuffer = this.context.device.createBuffer({
        size: BRUSH_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    if (!this.countUniformBuffer) {
      this.countUniformBuffer = this.context.device.createBuffer({
        size: COUNT_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    // count uniform は wordCount のみ保持（N 変化時に更新）
    this.context.device.queue.writeBuffer(
      this.countUniformBuffer,
      0,
      new Uint32Array([wordCount, 0, 0, 0])
    );
  }

  /**
   * バインドグループを作成する
   */
  private createBindGroups(): void {
    if (
      !this.context.device ||
      !this.filterPipeline ||
      !this.updateIndirectPipeline ||
      !this.renderPipeline ||
      !this.allPointsBuffer ||
      !this.visibleIndicesBuffer ||
      !this.atomicCounterBuffer ||
      !this.indirectBuffer ||
      !this.computeUniformBuffer ||
      !this.renderUniformBuffer ||
      !this.filterColumnsBuffer ||
      !this.visibilityFlagsBuffer ||
      !this.filteredIndicesBuffer ||
      !this.filteredCounterBuffer ||
      !this.filteredIndirectBuffer ||
      !this.filteredRenderUniformBuffer ||
      !this.brushSelectionPipeline ||
      !this.countSelectionPipeline ||
      !this.selectionFlagsBuffer ||
      !this.selectionCountBuffer ||
      !this.brushUniformBuffer ||
      !this.countUniformBuffer
    ) {
      return;
    }

    this.filterBindGroup = this.context.device.createBindGroup({
      layout: this.filterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.allPointsBuffer } },
        { binding: 1, resource: { buffer: this.visibleIndicesBuffer } },
        { binding: 2, resource: { buffer: this.atomicCounterBuffer } },
        { binding: 3, resource: { buffer: this.computeUniformBuffer } },
        { binding: 4, resource: { buffer: this.filterColumnsBuffer } },
        { binding: 5, resource: { buffer: this.visibilityFlagsBuffer } },
        { binding: 6, resource: { buffer: this.filteredIndicesBuffer } },
        { binding: 7, resource: { buffer: this.filteredCounterBuffer } },
      ],
    });

    this.updateIndirectBindGroup = this.context.device.createBindGroup({
      layout: this.updateIndirectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.atomicCounterBuffer } },
        { binding: 1, resource: { buffer: this.indirectBuffer } },
      ],
    });

    this.filteredUpdateIndirectBindGroup = this.context.device.createBindGroup({
      layout: this.updateIndirectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.filteredCounterBuffer } },
        { binding: 1, resource: { buffer: this.filteredIndirectBuffer } },
      ],
    });

    this.renderBindGroup = this.context.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.allPointsBuffer } },
        { binding: 2, resource: { buffer: this.visibleIndicesBuffer } },
        { binding: 3, resource: { buffer: this.filterColumnsBuffer } },
        { binding: 4, resource: { buffer: this.selectionFlagsBuffer } },
        { binding: 5, resource: { buffer: this.selectionCountBuffer } },
      ],
    });

    this.filteredRenderBindGroup = this.context.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.filteredRenderUniformBuffer } },
        { binding: 1, resource: { buffer: this.allPointsBuffer } },
        { binding: 2, resource: { buffer: this.filteredIndicesBuffer } },
        { binding: 3, resource: { buffer: this.filterColumnsBuffer } },
        { binding: 4, resource: { buffer: this.selectionFlagsBuffer } },
        { binding: 5, resource: { buffer: this.selectionCountBuffer } },
      ],
    });

    this.brushSelectionBindGroup = this.context.device.createBindGroup({
      layout: this.brushSelectionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.allPointsBuffer } },
        { binding: 1, resource: { buffer: this.selectionFlagsBuffer } },
        { binding: 2, resource: { buffer: this.brushUniformBuffer } },
        { binding: 3, resource: { buffer: this.filterColumnsBuffer } },
        { binding: 4, resource: { buffer: this.visibilityFlagsBuffer } },
      ],
    });

    this.countSelectionBindGroup = this.context.device.createBindGroup({
      layout: this.countSelectionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.selectionFlagsBuffer } },
        { binding: 1, resource: { buffer: this.selectionCountBuffer } },
        { binding: 2, resource: { buffer: this.countUniformBuffer } },
      ],
    });
  }

  /**
   * 全ポイントデータをアップロードする
   * @param data 新しいポイントデータ
   */
  uploadAllPoints(data: AllPointsData): void {
    if (!this.context.device) return;

    const newTotalCount = data.totalCount;

    if (newTotalCount > this.totalPointCount) {
      this.allPointsBuffer?.destroy();
      this.visibleIndicesBuffer?.destroy();
      this.visibilityFlagsBuffer?.destroy();
      this.filteredIndicesBuffer?.destroy();

      const pointsBufferSize = newTotalCount * 16;
      this.allPointsBuffer = this.context.device.createBuffer({
        size: pointsBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      const indicesBufferSize = newTotalCount * 4;
      this.visibleIndicesBuffer = this.context.device.createBuffer({
        size: indicesBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
      });

      this.filteredIndicesBuffer = this.context.device.createBuffer({
        size: indicesBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
      });

      // Recreate visibility flags buffer
      const visibilityFlagsSize = Math.max(4, Math.ceil(newTotalCount / 32) * 4);
      this.visibilityFlagsBuffer = this.context.device.createBuffer({
        size: visibilityFlagsSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      // Initialize all bits to 1 (all visible)
      const initialFlags = new Uint32Array(Math.ceil(newTotalCount / 32));
      initialFlags.fill(0xffffffff);
      this.context.device.queue.writeBuffer(this.visibilityFlagsBuffer, 0, initialFlags);
      this.whereFilterEnabled = false;

      // selection も新サイズで作り直す（選択はクリアされる）
      this.createSelectionBuffers(newTotalCount);

      this.createBindGroups();
    }

    this.totalPointCount = newTotalCount;
    this.filterResultValid = false;

    if (this.allPointsBuffer) {
      this.context.device.queue.writeBuffer(
        this.allPointsBuffer,
        0,
        data.instanceData.buffer,
        data.instanceData.byteOffset,
        data.instanceData.byteLength
      );
    }
  }

  /**
   * ビュー行列を作成する
   */
  private createViewMatrix(): Float32Array {
    const aspectRatio = this.canvas.width / this.canvas.height;
    return new Float32Array([
      this.zoom / aspectRatio,
      0,
      0,
      0,
      0,
      this.zoom,
      0,
      0,
      0,
      0,
      1,
      0,
      this.panX,
      this.panY,
      0,
      1,
    ]);
  }

  /**
   * LOD閾値を計算する
   * ズームレベルに応じて表示するポイント数を制限する
   */
  private calculateLodThreshold(): number {
    // 画面上に表示する最大ポイント数の目標値
    let targetPoints = this.visiblePointLimit;

    // ズームアウト（zoom < 1.0）時は、画面内に大量の点が密集するため、
    // 重なり合いによるフラグメントシェーダーの過負荷を防ぐため目標点数を減らす。
    if (this.zoom < 1.0) {
      targetPoints = Math.floor(this.visiblePointLimit * Math.pow(this.zoom, 0.6));
      // 最低限の分布が見えるライン（visiblePointLimitの10%）
      targetPoints = Math.max(Math.floor(this.visiblePointLimit * 0.1), targetPoints);
    }

    // 全ポイント数が目標以下なら常に全表示（フィルタリング不要）
    if (this.totalPointCount <= targetPoints) {
      return 0xffffffff;
    }

    // ズームレベルに基づく表示領域の割合（概算）
    // zoom=1.0を一単位として、ズームするほど表示範囲は狭くなる
    const visibleAreaFraction = 1.0 / (this.zoom * this.zoom);

    // その領域に含まれると予想されるポイント数
    const expectedPointsInView = Math.min(
      this.totalPointCount,
      this.totalPointCount * visibleAreaFraction
    );

    // 目標内なら間引きなし
    if (expectedPointsInView <= targetPoints) {
      return 0xffffffff;
    }

    // 目標点数に抑えるための維持率 (Keep Ratio)
    let keepRatio = targetPoints / expectedPointsInView;

    // 1.0（全表示）を超えないようにクランプ
    keepRatio = Math.min(1.0, keepRatio);

    // u32の最大値に対する閾値を計算
    return Math.floor(0xffffffff * keepRatio);
  }

  /**
   * ユニフォームを更新する
   */
  updateUniforms(): void {
    if (!this.context.device || !this.renderUniformBuffer || !this.computeUniformBuffer) {
      return;
    }

    this.filterResultValid = false;

    const viewMatrix = this.createViewMatrix();

    // GPUフィルタ条件から、フィルタ範囲（compute/render 共用）と
    // per-column soft-edge フェード（render 専用）をまとめて構築する。
    let activeFilterMask = 0;
    const filterRangeMin = [-Infinity, -Infinity, -Infinity, -Infinity];
    const filterRangeMax = [Infinity, Infinity, Infinity, Infinity];
    const fadeWidth = [0, 0, 0, 0];
    // 2bit/列: bit(2c)=min端をフェード, bit(2c+1)=max端をフェード
    let fadeEdgeFlags = 0;
    for (const condition of this.gpuFilterConditions) {
      const c = condition.columnIndex;
      if (c >= 0 && c < 4) {
        activeFilterMask |= 1 << c;
        filterRangeMin[c] = condition.min;
        filterRangeMax[c] = condition.max;
        if (condition.fade && condition.fade.width > 0) {
          fadeWidth[c] = condition.fade.width;
          const edges = condition.fade.edges;
          if (edges !== 'max') fadeEdgeFlags |= 1 << (2 * c); // min端
          if (edges !== 'min') fadeEdgeFlags |= 1 << (2 * c + 1); // max端
        }
      }
    }

    // render uniform: f32 と u32 が混在するため ArrayBuffer に2つのビューを張る
    const renderUniformData = new ArrayBuffer(RENDER_UNIFORM_SIZE);
    const renderFloatView = new Float32Array(renderUniformData);
    const renderUint32View = new Uint32Array(renderUniformData);
    renderFloatView.set(viewMatrix, 0);
    // Vertex Shaderで pow(zoom, 0.3) を計算するコストを避けるため、CPUで事前に計算して渡す
    renderFloatView[16] = Math.pow(this.zoom, 0.3);
    renderFloatView[17] = this.canvas.width;
    renderFloatView[18] = this.canvas.height;
    renderFloatView[19] = this.pointAlpha;
    renderFloatView[20] = this.pointSizeScale;
    // grayedMode: 0.0 (通常ポイント用)
    renderFloatView[21] = 0.0;
    // per-column soft-edge フェード（gpuWhereConditions.fade）
    renderUint32View[22] = fadeEdgeFlags >>> 0;
    // [23] = padding(u32)
    renderFloatView[24] = filterRangeMin[0]; // filterRangeMin: vec4 @ byte 96
    renderFloatView[25] = filterRangeMin[1];
    renderFloatView[26] = filterRangeMin[2];
    renderFloatView[27] = filterRangeMin[3];
    renderFloatView[28] = filterRangeMax[0]; // filterRangeMax: vec4 @ byte 112
    renderFloatView[29] = filterRangeMax[1];
    renderFloatView[30] = filterRangeMax[2];
    renderFloatView[31] = filterRangeMax[3];
    renderFloatView[32] = fadeWidth[0]; // fadeWidth: vec4 @ byte 128
    renderFloatView[33] = fadeWidth[1];
    renderFloatView[34] = fadeWidth[2];
    renderFloatView[35] = fadeWidth[3];
    // selection style: selectionColor vec4 @ byte 144, unselectedAlpha @160, selectedSizeScale @164
    renderFloatView[36] = this.selectionStyle.selectedColor.r;
    renderFloatView[37] = this.selectionStyle.selectedColor.g;
    renderFloatView[38] = this.selectionStyle.selectedColor.b;
    renderFloatView[39] = this.selectionStyle.selectedColor.a;
    renderFloatView[40] = this.selectionStyle.unselectedAlpha;
    renderFloatView[41] = this.selectionStyle.selectedSizeScale;
    // [42], [43] = padding
    this.context.device.queue.writeBuffer(this.renderUniformBuffer, 0, renderUniformData);

    // フィルター済みポイント用ユニフォーム（grayedMode = 1.0）
    if (this.filteredRenderUniformBuffer) {
      const filteredRenderUniformData = renderUniformData.slice(0);
      new Float32Array(filteredRenderUniformData)[21] = 1.0; // grayedMode = 1.0
      // grayed パスはフィルタ範囲 [min,max] の外側の点を描画するため、フェードを
      // 適用すると computeFadeAlpha が 0 になり点が消えてしまう（gray 表示にならない）。
      // fadeEdgeFlags を 0 にしてフェードを無効化し、常に gray で表示する。
      new Uint32Array(filteredRenderUniformData)[22] = 0;
      this.context.device.queue.writeBuffer(
        this.filteredRenderUniformBuffer,
        0,
        filteredRenderUniformData
      );
    }

    // 逆変換を行ってワールド空間での境界を計算し、シェーダー内での行列演算を削除する
    const aspectRatio = this.canvas.width / this.canvas.height;
    const clipMinX = -1 - VIEWPORT_MARGIN;
    const clipMinY = -1 - VIEWPORT_MARGIN;
    const clipMaxX = 1 + VIEWPORT_MARGIN;
    const clipMaxY = 1 + VIEWPORT_MARGIN;

    const scaleX = this.zoom / aspectRatio;
    const scaleY = this.zoom;

    const worldMinX = (clipMinX - this.panX) / scaleX;
    const worldMaxX = (clipMaxX - this.panX) / scaleX;
    const worldMinY = (clipMinY - this.panY) / scaleY;
    const worldMaxY = (clipMaxY - this.panY) / scaleY;

    const computeUniformData = new ArrayBuffer(80);
    const computeFloatView = new Float32Array(computeUniformData);
    const computeUint32View = new Uint32Array(computeUniformData);

    computeFloatView[0] = worldMinX;
    computeFloatView[1] = worldMinY;
    computeFloatView[2] = worldMaxX;
    computeFloatView[3] = worldMaxY;
    computeUint32View[4] = this.calculateLodThreshold();
    computeUint32View[5] = this.totalPointCount;

    // activeFilterMask / filterRangeMin / filterRangeMax は上で構築済み
    computeUint32View[6] = activeFilterMask;
    computeUint32View[7] = this.whereFilterEnabled ? 1 : 0;

    computeFloatView[8] = filterRangeMin[0];
    computeFloatView[9] = filterRangeMin[1];
    computeFloatView[10] = filterRangeMin[2];
    computeFloatView[11] = filterRangeMin[3];

    computeFloatView[12] = filterRangeMax[0];
    computeFloatView[13] = filterRangeMax[1];
    computeFloatView[14] = filterRangeMax[2];
    computeFloatView[15] = filterRangeMax[3];

    // filteredDisplayMode: 0=hidden, 1=grayed
    computeUint32View[16] = this.filteredPointDisplayMode === 'grayed' ? 1 : 0;

    this.context.device.queue.writeBuffer(this.computeUniformBuffer, 0, computeUniformData);
  }

  /**
   * 散布図をレンダリングする
   */
  render(): void {
    if (
      !this.context.device ||
      !this.context.context ||
      !this.filterPipeline ||
      !this.updateIndirectPipeline ||
      !this.renderPipeline ||
      !this.quadVertexBuffer ||
      !this.filterBindGroup ||
      !this.updateIndirectBindGroup ||
      !this.renderBindGroup ||
      !this.atomicCounterBuffer ||
      !this.indirectBuffer ||
      !this.filteredCounterBuffer ||
      !this.filteredIndirectBuffer ||
      !this.filteredUpdateIndirectBindGroup ||
      !this.filteredRenderBindGroup
    ) {
      return;
    }

    const isGrayed = this.filteredPointDisplayMode === 'grayed';
    const commandEncoder = this.context.device.createCommandEncoder();

    if (!this.filterResultValid) {
      this.context.device.queue.writeBuffer(this.atomicCounterBuffer, 0, new Uint32Array([0]));
      this.context.device.queue.writeBuffer(this.filteredCounterBuffer, 0, new Uint32Array([0]));

      {
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.filterPipeline);
        computePass.setBindGroup(0, this.filterBindGroup);
        const workgroupCount = Math.ceil(this.totalPointCount / 256);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();
      }

      // 可視ポイント用Indirect Buffer更新
      {
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.updateIndirectPipeline);
        computePass.setBindGroup(0, this.updateIndirectBindGroup);
        computePass.dispatchWorkgroups(1);
        computePass.end();
      }

      // フィルター済みポイント用Indirect Buffer更新
      if (isGrayed) {
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.updateIndirectPipeline);
        computePass.setBindGroup(0, this.filteredUpdateIndirectBindGroup);
        computePass.dispatchWorkgroups(1);
        computePass.end();
      }

      this.filterResultValid = true;
    }

    {
      const textureView = this.context.context.getCurrentTexture().createView();
      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: textureView,
            clearValue: {
              r: this.backgroundColor.r,
              g: this.backgroundColor.g,
              b: this.backgroundColor.b,
              a: this.backgroundColor.a,
            },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });

      renderPass.setPipeline(this.renderPipeline);
      renderPass.setVertexBuffer(0, this.quadVertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer!, 'uint16');

      // フィルター済みポイント（灰色）を先に描画（背面）
      if (isGrayed) {
        renderPass.setBindGroup(0, this.filteredRenderBindGroup);
        renderPass.drawIndexedIndirect(this.filteredIndirectBuffer, 0);
      }

      // 通常ポイントを描画（前面）
      renderPass.setBindGroup(0, this.renderBindGroup);
      renderPass.drawIndexedIndirect(this.indirectBuffer, 0);
      renderPass.end();
    }

    this.context.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * キャンバスをリサイズし、ビューポートを更新する
   */
  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.updateUniforms();
  }

  /**
   * ズームレベルを設定する
   */
  setZoom(zoom: number): void {
    this.zoom = Math.max(0.01, Math.min(100, zoom));
    this.updateUniforms();
  }

  /**
   * 現在のズームレベルを取得する
   */
  getZoom(): number {
    return this.zoom;
  }

  /**
   * パンオフセットを設定する
   */
  setPan(x: number, y: number): void {
    this.panX = x;
    this.panY = y;
    this.updateUniforms();
  }

  /**
   * 現在のパンオフセットを取得する
   */
  getPan(): { x: number; y: number } {
    return { x: this.panX, y: this.panY };
  }

  /**
   * 指定した画面座標を中心にズームする
   */
  zoomToPoint(newZoom: number, screenX: number, screenY: number): void {
    const clampedZoom = Math.max(0.01, Math.min(100, newZoom));
    const aspectRatio = this.canvas.width / this.canvas.height;

    const ndcX = (screenX / this.canvas.width) * 2 - 1;
    const ndcY = -((screenY / this.canvas.height) * 2 - 1);

    const worldXBefore = ((ndcX - this.panX) * aspectRatio) / this.zoom;
    const worldYBefore = (ndcY - this.panY) / this.zoom;

    this.zoom = clampedZoom;

    this.panX = ndcX - (worldXBefore * this.zoom) / aspectRatio;
    this.panY = ndcY - worldYBefore * this.zoom;

    this.updateUniforms();
  }

  /**
   * GPUレイヤーの設定オプションを更新する
   */
  updateOptions(options: Partial<GpuLayerOptions>): void {
    let needsUniformUpdate = false;

    if (options.backgroundColor !== undefined) {
      this.backgroundColor = options.backgroundColor;
    }
    if (options.visiblePointLimit !== undefined) {
      this.visiblePointLimit = options.visiblePointLimit;
      // LOD閾値が変わるのでフィルタ結果を無効化
      this.filterResultValid = false;
      needsUniformUpdate = true;
    }
    if (options.pointAlpha !== undefined) {
      this.pointAlpha = Math.max(0, Math.min(1, options.pointAlpha));
      needsUniformUpdate = true;
    }
    if (options.pointSizeScale !== undefined) {
      this.pointSizeScale = Math.max(0.01, options.pointSizeScale);
      needsUniformUpdate = true;
    }

    if (needsUniformUpdate) {
      this.updateUniforms();
    }
  }

  /**
   * GPUフィルターカラムデータをアップロードする
   * @param data フィルターカラムデータ（各ポイントに4カラム分のf32、totalPoints * 4 floats）
   * @param columnCount 有効なカラム数（0-4）
   */
  uploadFilterColumns(data: Float32Array): void {
    if (!this.context.device) return;

    const requiredSize = this.totalPointCount * 16;

    if (!this.filterColumnsBuffer || data.byteLength > requiredSize) {
      this.filterColumnsBuffer?.destroy();
      this.filterColumnsBuffer = this.context.device.createBuffer({
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.createBindGroups();
    }

    this.context.device.queue.writeBuffer(
      this.filterColumnsBuffer,
      0,
      data.buffer,
      data.byteOffset,
      data.byteLength
    );
    this.filterResultValid = false;
  }

  /**
   * GPUフィルター条件を設定する
   * @param conditions フィルター条件の配列
   */
  setGpuFilterConditions(
    conditions: {
      columnIndex: number;
      min: number;
      max: number;
      fade?: { width: number; edges: 'both' | 'min' | 'max' };
    }[]
  ): void {
    this.gpuFilterConditions = conditions;
    this.filterResultValid = false;
    this.updateUniforms();
  }

  /**
   * WHERE条件によるビットフラグ配列をアップロードする
   * @param flags ビットマップ配列（各u32に32ポイント分のフラグ）
   * @param enabled フラグフィルタを有効にするか
   */
  uploadVisibilityFlags(flags: Uint32Array, enabled: boolean): void {
    if (!this.context.device || !this.visibilityFlagsBuffer) return;

    const requiredSize = flags.byteLength;
    const currentSize = Math.max(4, Math.ceil(this.totalPointCount / 32) * 4);

    if (requiredSize > currentSize) {
      this.visibilityFlagsBuffer.destroy();
      this.visibilityFlagsBuffer = this.context.device.createBuffer({
        size: requiredSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.createBindGroups();
    }

    this.context.device.queue.writeBuffer(
      this.visibilityFlagsBuffer,
      0,
      flags.buffer,
      flags.byteOffset,
      flags.byteLength
    );
    this.whereFilterEnabled = enabled;
    this.filterResultValid = false;
    this.updateUniforms();
  }

  /**
   * WHERE条件フラグをクリア（全ポイント可視）
   */
  clearVisibilityFlags(): void {
    if (!this.context.device || !this.visibilityFlagsBuffer) return;

    const clearFlags = new Uint32Array(Math.ceil(this.totalPointCount / 32));
    clearFlags.fill(0xffffffff);
    this.context.device.queue.writeBuffer(this.visibilityFlagsBuffer, 0, clearFlags);
    this.whereFilterEnabled = false;
    this.filterResultValid = false;
    this.updateUniforms();
  }

  /**
   * グローバル透明度を設定する
   * @param alpha 透明度 (0.0-1.0)
   */
  setPointAlpha(alpha: number): void {
    this.pointAlpha = Math.max(0, Math.min(1, alpha));
    this.updateUniforms();
  }

  /**
   * 現在のグローバル透明度を取得する
   */
  getPointAlpha(): number {
    return this.pointAlpha;
  }

  /**
   * グローバルサイズスケールを設定する
   * @param scale サイズスケール (0.01以上)
   */
  setPointSizeScale(scale: number): void {
    this.pointSizeScale = Math.max(0.01, scale);
    this.updateUniforms();
  }

  /**
   * 現在のグローバルサイズスケールを取得する
   */
  getPointSizeScale(): number {
    return this.pointSizeScale;
  }

  /**
   * フィルターされたポイントの表示モードを設定する
   */
  setFilteredPointDisplayMode(mode: FilteredPointDisplayMode): void {
    this.filteredPointDisplayMode = mode;
    this.filterResultValid = false;
    this.updateUniforms();
  }

  /**
   * 現在のフィルター表示モードを取得する
   */
  getFilteredPointDisplayMode(): FilteredPointDisplayMode {
    return this.filteredPointDisplayMode;
  }

  /**
   * selection の描画スタイルを更新する（部分指定可）。次回 render() に反映される。
   */
  setSelectionStyle(style: SelectionStyle): void {
    this.selectionStyle = this.resolveSelectionStyle({ ...this.selectionStyle, ...style });
    this.updateUniforms();
  }

  /**
   * データ空間矩形で selection bitset を更新する（GPU 常駐, CPU 読み戻しなし）。
   * brush pass で bit を更新し、続く count pass で選択数を集計する。
   * @param bounds データ空間の矩形（順不同で可、内部で min/max 正規化）
   * @param options 合成モード（既定 'replace'）/ 対象集合（既定 'filtered-data'）
   */
  brushSelect(bounds: BrushBounds, options?: BrushOptions): void {
    if (
      !this.context.device ||
      !this.brushUniformBuffer ||
      !this.brushSelectionBindGroup ||
      this.totalPointCount === 0
    ) {
      return;
    }

    const mode = options?.mode ?? 'replace';
    const target = options?.target ?? 'filtered-data';
    const { minX, maxX, minY, maxY } = this.normalizeBrushBounds(bounds);

    // filterRange / activeFilterMask は updateUniforms と同じ規約で構築する。
    let activeFilterMask = 0;
    const filterRangeMin = [-Infinity, -Infinity, -Infinity, -Infinity];
    const filterRangeMax = [Infinity, Infinity, Infinity, Infinity];
    for (const condition of this.gpuFilterConditions) {
      const c = condition.columnIndex;
      if (c >= 0 && c < 4) {
        activeFilterMask |= 1 << c;
        filterRangeMin[c] = condition.min;
        filterRangeMax[c] = condition.max;
      }
    }

    const brushData = new ArrayBuffer(BRUSH_UNIFORM_SIZE);
    const f = new Float32Array(brushData);
    const u = new Uint32Array(brushData);
    f[0] = minX; // brushMin.x
    f[1] = minY; // brushMin.y
    f[2] = maxX; // brushMax.x
    f[3] = maxY; // brushMax.y
    f[4] = filterRangeMin[0]; // filterRangeMin: vec4 @ byte 16
    f[5] = filterRangeMin[1];
    f[6] = filterRangeMin[2];
    f[7] = filterRangeMin[3];
    f[8] = filterRangeMax[0]; // filterRangeMax: vec4 @ byte 32
    f[9] = filterRangeMax[1];
    f[10] = filterRangeMax[2];
    f[11] = filterRangeMax[3];
    u[12] = this.totalPointCount; // totalPoints @48
    u[13] = BRUSH_MODE_CODE[mode]; // mode @52
    u[14] = target === 'filtered-data' ? 1 : 0; // applyFilter @56
    u[15] = activeFilterMask; // @60
    u[16] = this.whereFilterEnabled ? 1 : 0; // whereFilterEnabled @64
    this.context.device.queue.writeBuffer(this.brushUniformBuffer, 0, brushData);

    this.dispatchBrushAndCount();
  }

  /**
   * キャンバス画面座標（物理ピクセル）の矩形で selection を更新する。
   * 現在の zoom / pan を使ってデータ空間へ変換してから brushSelect する。
   */
  brushSelectScreenRect(rect: ScreenBrushRect, options?: BrushOptions): void {
    const a = this.screenToWorld(rect.x0, rect.y0);
    const b = this.screenToWorld(rect.x1, rect.y1);
    this.brushSelect({ minX: a.x, maxX: b.x, minY: a.y, maxY: b.y }, options);
  }

  /**
   * ポイント ID（= rowid = バッファ index）集合で selection を直接設定する。
   * GPU で brush せず CPU 側で bitset を構築してアップロードする。
   */
  setSelectedPointIds(ids: Iterable<number>): void {
    if (!this.context.device || !this.selectionFlagsBuffer || !this.selectionCountBuffer) return;

    const wordCount = Math.max(1, Math.ceil(this.totalPointCount / 32));
    const bitset = new Uint32Array(wordCount);
    let count = 0;
    for (const id of ids) {
      if (id >= 0 && id < this.totalPointCount) {
        const w = id >>> 5;
        const mask = 1 << (id & 31);
        if ((bitset[w] & mask) === 0) {
          bitset[w] |= mask;
          count++;
        }
      }
    }
    this.context.device.queue.writeBuffer(this.selectionFlagsBuffer, 0, bitset);
    this.context.device.queue.writeBuffer(this.selectionCountBuffer, 0, new Uint32Array([count]));
  }

  /**
   * selection を全クリアする。
   */
  clearSelection(): void {
    if (!this.context.device || !this.selectionFlagsBuffer || !this.selectionCountBuffer) return;
    const wordCount = Math.max(1, Math.ceil(this.totalPointCount / 32));
    this.context.device.queue.writeBuffer(this.selectionFlagsBuffer, 0, new Uint32Array(wordCount));
    this.context.device.queue.writeBuffer(this.selectionCountBuffer, 0, new Uint32Array([0]));
  }

  /**
   * 現在の selection 数を取得する（GPU からの非同期読み戻し）。
   */
  async getSelectionCount(): Promise<number> {
    if (!this.context.device || !this.selectionCountBuffer) return 0;
    const staging = this.context.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.context.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.selectionCountBuffer, 0, staging, 0, 4);
    this.context.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const count = new Uint32Array(staging.getMappedRange().slice(0))[0];
    staging.unmap();
    staging.destroy();
    return count;
  }

  /** brush pass → count pass を1回の submit で実行する */
  private dispatchBrushAndCount(): void {
    if (
      !this.context.device ||
      !this.brushSelectionPipeline ||
      !this.brushSelectionBindGroup ||
      !this.countSelectionPipeline ||
      !this.countSelectionBindGroup ||
      !this.selectionCountBuffer
    ) {
      return;
    }
    // count を 0 にリセットしてから popcount で積算する（submit より前に queue 投入）
    this.context.device.queue.writeBuffer(this.selectionCountBuffer, 0, new Uint32Array([0]));

    const encoder = this.context.device.createCommandEncoder();
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.brushSelectionPipeline);
      pass.setBindGroup(0, this.brushSelectionBindGroup);
      pass.dispatchWorkgroups(Math.ceil(this.totalPointCount / 256));
      pass.end();
    }
    {
      const wordCount = Math.max(1, Math.ceil(this.totalPointCount / 32));
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.countSelectionPipeline);
      pass.setBindGroup(0, this.countSelectionBindGroup);
      pass.dispatchWorkgroups(Math.ceil(wordCount / 256));
      pass.end();
    }
    this.context.device.queue.submit([encoder.finish()]);
  }

  /** 画面座標（物理ピクセル, y 下向き）→ データ空間座標 */
  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const aspectRatio = this.canvas.width / this.canvas.height;
    const ndcX = (screenX / this.canvas.width) * 2 - 1;
    const ndcY = -((screenY / this.canvas.height) * 2 - 1);
    const scaleX = this.zoom / aspectRatio;
    const scaleY = this.zoom;
    return {
      x: (ndcX - this.panX) / scaleX,
      y: (ndcY - this.panY) / scaleY,
    };
  }

  /** BrushBounds を min <= max に正規化する */
  private normalizeBrushBounds(b: BrushBounds): BrushBounds {
    return {
      minX: Math.min(b.minX, b.maxX),
      maxX: Math.max(b.minX, b.maxX),
      minY: Math.min(b.minY, b.maxY),
      maxY: Math.max(b.minY, b.maxY),
    };
  }

  /**
   * リソースを破棄する
   */
  destroy(): void {
    this.quadVertexBuffer?.destroy();
    this.allPointsBuffer?.destroy();
    this.visibleIndicesBuffer?.destroy();
    this.atomicCounterBuffer?.destroy();
    this.indirectBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.renderUniformBuffer?.destroy();
    this.computeUniformBuffer?.destroy();
    this.filterColumnsBuffer?.destroy();
    this.visibilityFlagsBuffer?.destroy();
    this.filteredIndicesBuffer?.destroy();
    this.filteredCounterBuffer?.destroy();
    this.filteredIndirectBuffer?.destroy();
    this.filteredRenderUniformBuffer?.destroy();
    this.selectionFlagsBuffer?.destroy();
    this.selectionCountBuffer?.destroy();
    this.brushUniformBuffer?.destroy();
    this.countUniformBuffer?.destroy();
    this.context.destroy();
  }
}
