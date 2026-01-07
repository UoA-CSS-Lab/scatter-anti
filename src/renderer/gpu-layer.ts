import { WebGPUContext } from './webgpu-context.js';
import { scatterVertexShader, filterComputeShader, updateIndirectShader } from './shaders.js';
import type { ColorRGBA } from '../types.js';

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
  backgroundColor?: ColorRGBA;
  /** 表示可能なポイントの最大数（デフォルト: 5000000） */
  visiblePointLimit?: number;
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

  // パイプライン
  /** レンダーパイプライン */
  private renderPipeline: GPURenderPipeline | null = null;
  /** フィルタリング用コンピュートパイプライン */
  private filterPipeline: GPUComputePipeline | null = null;
  /** Indirect Buffer更新用コンピュートパイプライン */
  private updateIndirectPipeline: GPUComputePipeline | null = null;

  // バッファ
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

  // バインドグループ
  /** レンダリング用バインドグループ */
  private renderBindGroup: GPUBindGroup | null = null;
  /** フィルタリング用バインドグループ */
  private filterBindGroup: GPUBindGroup | null = null;
  /** Indirect更新用バインドグループ */
  private updateIndirectBindGroup: GPUBindGroup | null = null;

  /** 全ポイント数 */
  private totalPointCount: number = 0;
  /** 背景色 */
  private backgroundColor: ColorRGBA = { r: 0, g: 0, b: 0, a: 0 };
  /** 表示可能なポイントの最大数 */
  private visiblePointLimit: number = 5000000;
  /** フィルタリング結果が有効かどうか */
  private filterResultValid: boolean = false;

  // ズームとパンの状態
  /** 現在のズームレベル */
  private zoom: number = 1.0;
  /** 現在のX方向パンオフセット */
  private panX: number = 0.0;
  /** 現在のY方向パンオフセット */
  private panY: number = 0.0;

  /**
   * GpuLayerインスタンスを作成する
   * @param options 設定オプション
   */
  constructor(options: GpuLayerOptions) {
    this.canvas = options.canvas;
    // WebGPUコンテキストを作成
    this.context = new WebGPUContext();
    // 背景色を設定（デフォルト: 透明な黒）
    this.backgroundColor = options.backgroundColor ?? { r: 0, g: 0, b: 0, a: 0 };
    // 表示可能なポイントの最大数を設定（デフォルト: 500万）
    this.visiblePointLimit = options.visiblePointLimit ?? 5000000;
  }

  /**
   * WebGPUを初期化し、レンダリングリソースを作成する
   * @param initialData 初期データ
   */
  async initialize(initialData: AllPointsData): Promise<void> {
    // WebGPUコンテキストを初期化
    await this.context.initialize(this.canvas);
    // パイプラインを作成
    this.createPipelines();
    // バッファを作成
    await this.createBuffers(initialData);
    // バインドグループを作成
    this.createBindGroups();
  }

  /**
   * パイプラインを作成する
   */
  private createPipelines(): void {
    if (!this.context.device) {
      throw new Error('WebGPU device not initialized');
    }

    // フィルタリング用コンピュートパイプライン
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

    // Indirect Buffer更新用コンピュートパイプライン
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

    // レンダーパイプライン
    const renderShaderModule = this.context.device.createShaderModule({
      code: scatterVertexShader,
    });

    // クワッド頂点バッファレイアウト（stepMode: 'vertex'）
    const quadVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 8, // 2 floats * 4 bytes
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
  }

  /**
   * バッファを作成する
   * @param data 初期データ
   */
  private async createBuffers(data: AllPointsData): Promise<void> {
    if (!this.context.device) return;

    this.totalPointCount = data.totalCount;

    // クワッド頂点バッファ
    const quadVertices = new Float32Array([
      -1.0,
      -1.0, // 左下
      1.0,
      -1.0, // 右下
      -1.0,
      1.0, // 左上
      1.0,
      1.0, // 右上
    ]);
    this.quadVertexBuffer = this.context.device.createBuffer({
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.quadVertexBuffer, 0, quadVertices);

    // 全ポイントデータバッファ (Storage)
    const pointsBufferSize = data.totalCount * 16; // 16 bytes per point
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

    // 可視インデックスバッファ (Storage)
    const indicesBufferSize = data.totalCount * 4; // 4 bytes per index
    this.visibleIndicesBuffer = this.context.device.createBuffer({
      size: indicesBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });

    // アトミックカウンターバッファ
    this.atomicCounterBuffer = this.context.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Indirect Drawingパラメータバッファ (20 bytes for DrawIndexedIndirect)
    this.indirectBuffer = this.context.device.createBuffer({
      size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // インデックスバッファ
    const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
    this.indexBuffer = this.context.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.indexBuffer, 0, indices);

    // レンダリング用ユニフォームバッファ (96 bytes)
    this.renderUniformBuffer = this.context.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // コンピュート用ユニフォームバッファ
    // worldBoundsMin (8) + worldBoundsMax (8) + lodThreshold (4) + totalPoints (4) + padding (8) = 32 bytes
    this.computeUniformBuffer = this.context.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 初期ユニフォームを更新
    this.updateUniforms();
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
      !this.renderUniformBuffer
    ) {
      return;
    }

    // フィルタリング用バインドグループ
    this.filterBindGroup = this.context.device.createBindGroup({
      layout: this.filterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.allPointsBuffer } },
        { binding: 1, resource: { buffer: this.visibleIndicesBuffer } },
        { binding: 2, resource: { buffer: this.atomicCounterBuffer } },
        { binding: 3, resource: { buffer: this.computeUniformBuffer } },
      ],
    });

    // Indirect更新用バインドグループ
    this.updateIndirectBindGroup = this.context.device.createBindGroup({
      layout: this.updateIndirectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.atomicCounterBuffer } },
        { binding: 1, resource: { buffer: this.indirectBuffer } },
      ],
    });

    // レンダリング用バインドグループ
    this.renderBindGroup = this.context.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUniformBuffer } },
        { binding: 1, resource: { buffer: this.allPointsBuffer } },
        { binding: 2, resource: { buffer: this.visibleIndicesBuffer } },
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

    // バッファサイズが足りない場合は再作成
    if (newTotalCount > this.totalPointCount) {
      // 古いバッファを破棄
      this.allPointsBuffer?.destroy();
      this.visibleIndicesBuffer?.destroy();

      // 新しいバッファを作成
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

      // バインドグループを再作成
      this.createBindGroups();
    }

    this.totalPointCount = newTotalCount;
    // データが変わったのでフィルタ結果を無効化
    this.filterResultValid = false;

    // データをアップロード
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

    // ビューが変わったのでフィルタ結果を無効化
    this.filterResultValid = false;

    const viewMatrix = this.createViewMatrix();

    // レンダリング用ユニフォーム
    const renderUniformData = new Float32Array(24);
    renderUniformData.set(viewMatrix, 0);
    // Vertex Shaderで pow(zoom, 0.3) を計算するコストを避けるため、CPUで事前に計算して渡す
    // シェーダー側では zoomScale として受け取る
    renderUniformData[16] = Math.pow(this.zoom, 0.3);
    renderUniformData[17] = this.canvas.width;
    renderUniformData[18] = this.canvas.height;
    this.context.device.queue.writeBuffer(this.renderUniformBuffer, 0, renderUniformData);

    // コンピュート用ユニフォーム
    // 逆変換を行ってワールド空間での境界を計算し、シェーダー内での行列演算を削除する
    const aspectRatio = this.canvas.width / this.canvas.height;
    const clipMinX = -1 - VIEWPORT_MARGIN;
    const clipMinY = -1 - VIEWPORT_MARGIN;
    const clipMaxX = 1 + VIEWPORT_MARGIN;
    const clipMaxY = 1 + VIEWPORT_MARGIN;

    // clip = world * scale + pan
    // world = (clip - pan) / scale
    const scaleX = this.zoom / aspectRatio;
    const scaleY = this.zoom;

    const worldMinX = (clipMinX - this.panX) / scaleX;
    const worldMaxX = (clipMaxX - this.panX) / scaleX;
    const worldMinY = (clipMinY - this.panY) / scaleY;
    const worldMaxY = (clipMaxY - this.panY) / scaleY;

    const computeUniformData = new ArrayBuffer(32);
    const computeFloatView = new Float32Array(computeUniformData);
    const computeUint32View = new Uint32Array(computeUniformData);

    computeFloatView[0] = worldMinX;
    computeFloatView[1] = worldMinY;
    computeFloatView[2] = worldMaxX;
    computeFloatView[3] = worldMaxY;
    computeUint32View[4] = this.calculateLodThreshold(); // lodThreshold
    computeUint32View[5] = this.totalPointCount; // totalPoints
    // padding: [6], [7]

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
      !this.indirectBuffer
    ) {
      return;
    }

    const commandEncoder = this.context.device.createCommandEncoder();

    // ビューが変わった時だけフィルタリングを再計算
    if (!this.filterResultValid) {
      // カウンターをリセット
      this.context.device.queue.writeBuffer(this.atomicCounterBuffer, 0, new Uint32Array([0]));

      // コンピュートパス: フィルタリング
      {
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.filterPipeline);
        computePass.setBindGroup(0, this.filterBindGroup);
        const workgroupCount = Math.ceil(this.totalPointCount / 256);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();
      }

      // コンピュートパス: Indirect Buffer更新
      {
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.updateIndirectPipeline);
        computePass.setBindGroup(0, this.updateIndirectBindGroup);
        computePass.dispatchWorkgroups(1);
        computePass.end();
      }

      this.filterResultValid = true;
    }

    // レンダーパス
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
   * キャンバスのアスペクト比（幅/高さ）を取得する
   */
  getAspectRatio(): number {
    return this.canvas.width / this.canvas.height;
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
    if (options.backgroundColor !== undefined) {
      this.backgroundColor = options.backgroundColor;
    }
    if (options.visiblePointLimit !== undefined) {
      this.visiblePointLimit = options.visiblePointLimit;
      // LOD閾値が変わるのでフィルタ結果を無効化
      this.filterResultValid = false;
    }
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
    this.context.destroy();
  }
}
