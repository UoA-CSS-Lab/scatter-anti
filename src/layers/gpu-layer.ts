import { WebGPUContext } from '../webgpu-context.js';
import { scatterVertexShader } from '../shaders.js';
import type { ColorRGBA } from '../types.js';
import type { ProcessedData } from './data-layer.js';

/**
 * GpuLayerの設定オプション
 */
export interface GpuLayerOptions {
  /** 描画対象のHTMLCanvasElement */
  canvas: HTMLCanvasElement;
  /** 背景色（デフォルト: 透明な黒） */
  backgroundColor?: ColorRGBA;
}

/**
 * WebGPUレンダリングを担当するレイヤー
 * 責務:
 * - WebGPUコンテキストとパイプラインの管理
 * - GPUバッファの作成と管理
 * - ビュー行列変換（ズーム/パン）の処理
 * - レンダーパスの実行
 */
export class GpuLayer {
  /** WebGPUコンテキスト */
  private context: WebGPUContext;
  /** 描画対象のキャンバス */
  private readonly canvas: HTMLCanvasElement;
  /** レンダーパイプライン */
  private pipeline: GPURenderPipeline | null = null;
  /** クワッド頂点バッファ（stepMode: 'vertex'） */
  private quadVertexBuffer: GPUBuffer | null = null;
  /** インスタンスデータバッファ（位置+色、stepMode: 'instance'） */
  private instanceBuffer: GPUBuffer | null = null;
  /** インデックスバッファ */
  private indexBuffer: GPUBuffer | null = null;
  /** ユニフォームバッファ */
  private uniformBuffer: GPUBuffer | null = null;
  /** バインドグループ */
  private bindGroup: GPUBindGroup | null = null;

  /** 現在の行数 */
  private rowCount: number = 0;
  /** 背景色 */
  private backgroundColor: ColorRGBA = { r: 0, g: 0, b: 0, a: 0 };
  /** インスタンスバッファの現在の容量（ポイント数） */
  private instanceBufferCapacity: number = 0;

  // ズームとパンの状態
  /** 現在のズームレベル */
  private zoom: number = 1.0;
  /** 現在のX方向パンオフセット */
  private panX: number = 0.0;
  /** 現在のY方向パンオフセット */
  private panY: number = 0.0;

  /** インデックス数 */
  private indexCount: number = 0;

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
  }

  /**
   * WebGPUを初期化し、レンダリングリソースを作成する
   * @param initialData 初期データ
   */
  async initialize(initialData: ProcessedData): Promise<void> {
    // WebGPUコンテキストを初期化
    await this.context.initialize(this.canvas);
    // レンダーパイプラインを作成
    this.createPipeline();
    // バッファを作成
    await this.createBuffers(initialData);
    // バインドグループを作成
    this.createBindGroup();
  }

  /**
   * レンダーパイプラインを作成する
   */
  private createPipeline(): void {
    // デバイスがない場合はエラー
    if (!this.context.device) {
      throw new Error('WebGPU device not initialized');
    }

    // シェーダーモジュールを作成
    const shaderModule = this.context.device.createShaderModule({
      code: scatterVertexShader,
    });

    // クワッド頂点バッファレイアウト（stepMode: 'vertex'）
    const quadVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 8, // 2 floats * 4 bytes
      stepMode: 'vertex',
      attributes: [
        {
          // クワッド位置
          format: 'float32x2',
          offset: 0,
          shaderLocation: 0,
        },
      ],
    };

    // インスタンスバッファレイアウト（stepMode: 'instance'）
    const instanceBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 16, // 2 floats (位置) + 1 u32 (色) + 1 float (サイズ) = 4 * 4 bytes
      stepMode: 'instance',
      attributes: [
        {
          // ポイント位置
          format: 'float32x2',
          offset: 0,
          shaderLocation: 1,
        },
        {
          // 色 (ARGB packed as u32)
          format: 'uint32',
          offset: 8,
          shaderLocation: 2,
        },
        {
          // サイズ
          format: 'float32',
          offset: 12,
          shaderLocation: 3,
        },
      ],
    };

    // レンダーパイプラインを作成
    this.pipeline = this.context.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vertexMain',
        buffers: [quadVertexBufferLayout, instanceBufferLayout],
      },
      fragment: {
        module: shaderModule,
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
   * 頂点バッファとユニフォームバッファを作成する
   * @param data 初期データ
   */
  private async createBuffers(data: ProcessedData): Promise<void> {
    // デバイスがない場合は終了
    if (!this.context.device) return;

    // クワッド頂点バッファを作成（全インスタンスで共有、一度だけ作成）
    // クワッド頂点: (-1,-1), (1,-1), (-1,1), (1,1)
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

    // クワッド頂点バッファを作成
    this.quadVertexBuffer = this.context.device.createBuffer({
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    // データを書き込み
    this.context.device.queue.writeBuffer(this.quadVertexBuffer, 0, quadVertices);

    // 提供されたデータでインスタンスバッファを作成
    this.updateInstanceBuffer(data);

    // 単一クワッド用のインデックスバッファを作成（全インスタンスで使用）
    // クワッドを形成する2つの三角形: (0,1,2) と (2,1,3)
    const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);

    this.indexBuffer = this.context.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.indexBuffer, 0, indices);
    this.indexCount = indices.length;

    // ユニフォームバッファを作成（ビュー行列 + ズーム + ビューポートサイズ + パディング）
    // WebGPUはユニフォームバッファサイズが16バイトの倍数であることを要求
    // mat4x4 (64 bytes) + zoom (4) + viewportWidth (4) + viewportHeight (4) + padding (4) = 80 bytes
    // アライメントのため96バイトに切り上げ（24 floats）
    const uniformData = new Float32Array(24);
    const viewMatrix = this.createViewMatrix();
    uniformData.set(viewMatrix, 0);
    uniformData[16] = this.zoom;
    uniformData[17] = this.canvas.width;
    uniformData[18] = this.canvas.height;

    this.uniformBuffer = this.context.device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  /**
   * 新しいデータでインスタンスバッファを更新する
   * @param data 処理済みデータ
   */
  updateInstanceBuffer(data: ProcessedData): void {
    // デバイスがない場合は終了
    if (!this.context.device) return;

    // 行数を更新
    this.rowCount = data.rowCount;

    // インスタンスデータのベースコピーを保存（ホバースケーリングなし）
    const baseInstanceData = new Float32Array(data.instanceData);

    // visiblePointLimitが変更された場合のみバッファを再割り当て
    if (this.instanceBufferCapacity !== data.visiblePointLimit) {
      // 新しいバッファの準備ができるまで古いバッファを保持
      const oldBuffer = this.instanceBuffer;

      // 実際のrowCountではなく、全visiblePointLimit用にバッファを割り当て
      const bufferSize = data.visiblePointLimit * 4 * 4; // ポイントあたり4 values (2 floats + 1 u32 + 1 float) * 4 bytes

      this.instanceBuffer = this.context.device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });

      this.instanceBufferCapacity = data.visiblePointLimit;

      // 新しいバッファ作成後に古いバッファを破棄
      if (oldBuffer) {
        oldBuffer.destroy();
      }
    }

    // バッファにデータを書き込み（容量が変更されていない場合は既存バッファを再利用）
    if (this.instanceBuffer && baseInstanceData) {
      this.context.device.queue.writeBuffer(
        this.instanceBuffer,
        0,
        baseInstanceData as BufferSource
      );
    }
  }

  /**
   * ユニフォーム用のバインドグループを作成する
   */
  private createBindGroup(): void {
    // 必要なリソースがない場合は終了
    if (!this.context.device || !this.pipeline || !this.uniformBuffer) return;

    // バインドグループを作成
    this.bindGroup = this.context.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.uniformBuffer,
          },
        },
      ],
    });
  }

  /**
   * ズームとパン変換を含むビュー行列を作成する
   * @returns ビュー行列のFloat32Array
   */
  private createViewMatrix(): Float32Array {
    // 1:1のワールド空間を維持するためにアスペクト比補正を計算
    const aspectRatio = this.canvas.width / this.canvas.height;

    // アスペクト比補正を含むスケール+平行移動の結合行列を作成
    // スケール行列:    [zoom/aspect, 0, 0, 0]  <- Xはアスペクト比でスケール
    //                  [0, zoom, 0, 0]
    //                  [0, 0, 1, 0]
    //                  [0, 0, 0, 1]
    // 平行移動:        [1, 0, 0, 0]
    //                  [0, 1, 0, 0]
    //                  [0, 0, 1, 0]
    //                  [panX, panY, 0, 1]

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
   * ユニフォームのみを更新する
   */
  updateUniforms(): void {
    // 必要なリソースがない場合は終了
    if (!this.context.device || !this.uniformBuffer) return;

    // createBuffersのバッファサイズと一致させる必要がある（96 bytes = 24 floats）
    const uniformData = new Float32Array(24);
    const viewMatrix = this.createViewMatrix();
    uniformData.set(viewMatrix, 0);
    uniformData[16] = this.zoom;
    uniformData[17] = this.canvas.width;
    uniformData[18] = this.canvas.height;

    // ユニフォームバッファにデータを書き込み
    this.context.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  /**
   * 散布図をレンダリングする
   */
  render(): void {
    // 必要なリソースがすべてあるかチェック
    if (
      !this.context.device ||
      !this.context.context ||
      !this.pipeline ||
      !this.quadVertexBuffer ||
      !this.instanceBuffer ||
      !this.bindGroup
    ) {
      return;
    }

    // コマンドエンコーダを作成
    const commandEncoder = this.context.device.createCommandEncoder();
    // 現在のテクスチャのビューを取得
    const textureView = this.context.context.getCurrentTexture().createView();

    // レンダーパスを開始
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

    // パイプラインを設定
    renderPass.setPipeline(this.pipeline);
    // 頂点バッファを設定（スロット0: クワッド頂点）
    renderPass.setVertexBuffer(0, this.quadVertexBuffer);
    // 頂点バッファを設定（スロット1: インスタンスデータ）
    renderPass.setVertexBuffer(1, this.instanceBuffer);
    // インデックスバッファを設定
    renderPass.setIndexBuffer(this.indexBuffer!, 'uint16');
    // バインドグループを設定
    renderPass.setBindGroup(0, this.bindGroup);
    // インデックス付き描画を実行
    renderPass.drawIndexed(this.indexCount, this.rowCount, 0, 0, 0);
    // レンダーパスを終了
    renderPass.end();

    // コマンドバッファをGPUキューに送信
    this.context.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * キャンバスをリサイズし、ビューポートを更新する
   * @param width 新しい幅
   * @param height 新しい高さ
   */
  resize(width: number, height: number): void {
    // キャンバスサイズを更新
    this.canvas.width = width;
    this.canvas.height = height;
    // シェーダー内のビューポートサイズを更新
    this.updateUniforms();
  }

  /**
   * ズームレベルを設定する
   * @param zoom ズームレベル
   */
  setZoom(zoom: number): void {
    // 0.01xから100xの間にクランプ
    this.zoom = Math.max(0.01, Math.min(100, zoom));
    // ユニフォームを更新
    this.updateUniforms();
  }

  /**
   * 現在のズームレベルを取得する
   * @returns 現在のズームレベル
   */
  getZoom(): number {
    return this.zoom;
  }

  /**
   * パンオフセットを設定する
   * @param x X方向のパンオフセット
   * @param y Y方向のパンオフセット
   */
  setPan(x: number, y: number): void {
    this.panX = x;
    this.panY = y;
    // ユニフォームを更新
    this.updateUniforms();
  }

  /**
   * 現在のパンオフセットを取得する
   * @returns x, y座標を含むオブジェクト
   */
  getPan(): { x: number; y: number } {
    return { x: this.panX, y: this.panY };
  }

  /**
   * キャンバスのアスペクト比（幅/高さ）を取得する
   * @returns アスペクト比
   */
  getAspectRatio(): number {
    return this.canvas.width / this.canvas.height;
  }

  /**
   * 指定した画面座標を中心にズームする
   * @param newZoom 新しいズームレベル
   * @param screenX 画面X座標
   * @param screenY 画面Y座標
   */
  zoomToPoint(newZoom: number, screenX: number, screenY: number): void {
    // 新しいズームレベルをクランプ
    const clampedZoom = Math.max(0.01, Math.min(100, newZoom));

    // 座標変換用のアスペクト比を計算
    const aspectRatio = this.canvas.width / this.canvas.height;

    // スクリーン座標を正規化デバイス座標（-1から1）に変換
    const ndcX = (screenX / this.canvas.width) * 2 - 1;
    const ndcY = -((screenY / this.canvas.height) * 2 - 1); // Y軸を反転

    // ズーム前のNDCをワールド座標に変換（アスペクト比を考慮）
    const worldXBefore = ((ndcX - this.panX) * aspectRatio) / this.zoom;
    const worldYBefore = (ndcY - this.panY) / this.zoom;

    // ズームを更新
    this.zoom = clampedZoom;

    // ワールドポイントが同じスクリーン位置に保たれるように新しいパンを計算
    this.panX = ndcX - (worldXBefore * this.zoom) / aspectRatio;
    this.panY = ndcY - worldYBefore * this.zoom;

    // ユニフォームを更新
    this.updateUniforms();
  }

  /**
   * GPUレイヤーの設定オプションを更新する
   * @param options 更新する設定オプション
   */
  updateOptions(options: Partial<GpuLayerOptions>): void {
    // 背景色が指定されていれば更新
    if (options.backgroundColor !== undefined) {
      this.backgroundColor = options.backgroundColor;
    }
  }

  /**
   * リソースを破棄する
   */
  destroy(): void {
    // クワッド頂点バッファを破棄
    if (this.quadVertexBuffer) {
      this.quadVertexBuffer.destroy();
    }
    // インスタンスバッファを破棄
    if (this.instanceBuffer) {
      this.instanceBuffer.destroy();
    }
    // インデックスバッファを破棄
    if (this.indexBuffer) {
      this.indexBuffer.destroy();
    }
    // ユニフォームバッファを破棄
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
    }

    // WebGPUコンテキストを破棄
    this.context.destroy();
  }
}
