import { WebGPUContext } from '../webgpu-context.js';
import { scatterVertexShader } from '../shaders.js';
import type { ColorRGBA } from '../types.js';
import type { ProcessedData } from './data-layer.js';

export interface GpuLayerOptions {
  canvas: HTMLCanvasElement;
  backgroundColor?: ColorRGBA;
}

/**
 * GpuLayer handles WebGPU rendering
 * Responsibilities:
 * - Manage WebGPU context and pipeline
 * - Create and manage GPU buffers
 * - Handle view matrix transformations (zoom/pan)
 * - Execute render passes
 */
export class GpuLayer {
  private context: WebGPUContext;
  private readonly canvas: HTMLCanvasElement;
  private pipeline: GPURenderPipeline | null = null;
  private quadVertexBuffer: GPUBuffer | null = null; // Quad vertices (stepMode: 'vertex')
  private instanceBuffer: GPUBuffer | null = null; // Instance data: position + color (stepMode: 'instance')
  private indexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private rowCount: number = 0;
  private backgroundColor: ColorRGBA = { r: 0, g: 0, b: 0, a: 0 };
  private instanceBufferCapacity: number = 0; // Current buffer capacity in number of points

  // Zoom and pan state
  private zoom: number = 1.0;
  private panX: number = 0.0;
  private panY: number = 0.0;

  private indexCount: number = 0;

  // Point hover state
  private hoveredPointIndex: number | null = null;
  private hoverScaleFactor: number = 1.3;
  private baseInstanceData: Float32Array | null = null; // Original data without hover scaling
  private currentInstanceData: Float32Array | null = null; // Data with hover scaling applied

  constructor(options: GpuLayerOptions) {
    this.canvas = options.canvas;
    this.context = new WebGPUContext();
    this.backgroundColor = options.backgroundColor ?? { r: 0, g: 0, b: 0, a: 0 };
  }

  /**
   * Initialize WebGPU and create rendering resources
   */
  async initialize(initialData: ProcessedData): Promise<void> {
    await this.context.initialize(this.canvas);
    this.createPipeline();
    await this.createBuffers(initialData);
    this.createBindGroup();
  }

  /**
   * Create the render pipeline
   */
  private createPipeline(): void {
    if (!this.context.device) {
      throw new Error('WebGPU device not initialized');
    }

    const shaderModule = this.context.device.createShaderModule({
      code: scatterVertexShader,
    });

    // Quad vertex buffer layout (stepMode: 'vertex')
    const quadVertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 8, // 2 floats * 4 bytes
      stepMode: 'vertex',
      attributes: [
        {
          // quad position
          format: 'float32x2',
          offset: 0,
          shaderLocation: 0,
        },
      ],
    };

    // Instance buffer layout (stepMode: 'instance')
    const instanceBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 28, // 2 floats (position) + 4 floats (color) + 1 float (size) = 7 floats * 4 bytes
      stepMode: 'instance',
      attributes: [
        {
          // point position
          format: 'float32x2',
          offset: 0,
          shaderLocation: 1,
        },
        {
          // color
          format: 'float32x4',
          offset: 8,
          shaderLocation: 2,
        },
        {
          // size
          format: 'float32',
          offset: 24,
          shaderLocation: 3,
        },
      ],
    };

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
   * Create vertex and uniform buffers
   */
  private async createBuffers(data: ProcessedData): Promise<void> {
    if (!this.context.device) return;

    // Create quad vertex buffer (only once, shared by all instances)
    // Quad vertices: (-1,-1), (1,-1), (-1,1), (1,1)
    const quadVertices = new Float32Array([
      -1.0,
      -1.0, // bottom-left
      1.0,
      -1.0, // bottom-right
      -1.0,
      1.0, // top-left
      1.0,
      1.0, // top-right
    ]);

    this.quadVertexBuffer = this.context.device.createBuffer({
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.quadVertexBuffer, 0, quadVertices);

    // Create instance buffer with the provided data
    this.updateInstanceBuffer(data);

    // Create index buffer for a single quad (used for all instances)
    // Two triangles forming a quad: (0,1,2) and (2,1,3)
    const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);

    this.indexBuffer = this.context.device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.context.device.queue.writeBuffer(this.indexBuffer, 0, indices);
    this.indexCount = indices.length;

    // Create uniform buffer (view matrix + zoom + viewport dimensions + padding)
    // WebGPU requires uniform buffer size to be multiple of 16 bytes
    // mat4x4 (64 bytes) + zoom (4) + viewportWidth (4) + viewportHeight (4) + padding (4) = 80 bytes
    // Rounded up to 96 bytes for alignment (24 floats)
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
   * Update instance buffer with new data
   */
  updateInstanceBuffer(data: ProcessedData): void {
    if (!this.context.device) return;

    this.rowCount = data.rowCount;

    // Store base copy of the instance data (without hover scaling)
    this.baseInstanceData = new Float32Array(data.instanceData);

    // Create working copy for hover scaling
    this.currentInstanceData = new Float32Array(data.instanceData);

    // Apply hover scaling if there's a hovered point
    this.applyHoverScaling();

    // Only reallocate buffer if visiblePointLimit has changed
    if (this.instanceBufferCapacity !== data.visiblePointLimit) {
      // Keep old buffer until new one is ready
      const oldBuffer = this.instanceBuffer;

      // Allocate buffer for the full visiblePointLimit, not just actual rowCount
      const bufferSize = data.visiblePointLimit * 7 * 4; // 7 floats per point * 4 bytes per float

      this.instanceBuffer = this.context.device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });

      this.instanceBufferCapacity = data.visiblePointLimit;

      // Destroy old buffer after new one is created
      if (oldBuffer) {
        oldBuffer.destroy();
      }
    }

    // Write data to buffer (reusing existing buffer if capacity unchanged)
    if (this.instanceBuffer && this.currentInstanceData) {
      this.context.device.queue.writeBuffer(
        this.instanceBuffer,
        0,
        this.currentInstanceData as BufferSource
      );
    }
  }

  /**
   * Create bind group for uniforms
   */
  private createBindGroup(): void {
    if (!this.context.device || !this.pipeline || !this.uniformBuffer) return;

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
   * Create view matrix with zoom and pan transformations
   */
  private createViewMatrix(): Float32Array {
    // Calculate aspect ratio correction to maintain 1:1 world space
    const aspectRatio = this.canvas.width / this.canvas.height;

    // Create a combined scale + translation matrix with aspect ratio correction
    // Scale matrix:    [zoom/aspect, 0, 0, 0]  <- X scaled by aspect ratio
    //                  [0, zoom, 0, 0]
    //                  [0, 0, 1, 0]
    //                  [0, 0, 0, 1]
    // Translation:     [1, 0, 0, 0]
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
   * Update uniforms only
   */
  updateUniforms(): void {
    if (!this.context.device || !this.uniformBuffer) return;

    // Must match buffer size from createBuffers (96 bytes = 24 floats)
    const uniformData = new Float32Array(24);
    const viewMatrix = this.createViewMatrix();
    uniformData.set(viewMatrix, 0);
    uniformData[16] = this.zoom;
    uniformData[17] = this.canvas.width;
    uniformData[18] = this.canvas.height;

    this.context.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  /**
   * Apply hover scaling to the hovered point in the instance data
   */
  private applyHoverScaling(): void {
    if (!this.currentInstanceData || this.hoveredPointIndex === null) {
      return;
    }

    // Check if index is valid
    if (this.hoveredPointIndex < 0 || this.hoveredPointIndex >= this.rowCount) {
      return;
    }

    // Scale the size of the hovered point (index 6 in the 7-float instance data)
    const sizeIndex = this.hoveredPointIndex * 7 + 6;
    this.currentInstanceData[sizeIndex] *= this.hoverScaleFactor;
  }

  /**
   * Set the hovered point index and scale factor
   */
  setHoveredPoint(index: number | null, scaleFactor: number = 1.3): void {
    this.hoveredPointIndex = index;
    this.hoverScaleFactor = scaleFactor;

    // Re-apply instance data with new hover scaling
    if (this.baseInstanceData && this.context.device && this.instanceBuffer) {
      // Restore from base data (unscaled)
      this.currentInstanceData = new Float32Array(this.baseInstanceData);

      // Apply scaling to the new hovered point
      this.applyHoverScaling();

      // Update GPU buffer
      this.context.device.queue.writeBuffer(
        this.instanceBuffer,
        0,
        this.currentInstanceData as BufferSource
      );
    }
  }

  /**
   * Render the scatter plot
   */
  render(): void {
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

    const commandEncoder = this.context.device.createCommandEncoder();
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

    renderPass.setPipeline(this.pipeline);
    renderPass.setVertexBuffer(0, this.quadVertexBuffer); // Quad vertices
    renderPass.setVertexBuffer(1, this.instanceBuffer); // Instance data
    renderPass.setIndexBuffer(this.indexBuffer!, 'uint16');
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.drawIndexed(this.indexCount, this.rowCount, 0, 0, 0);
    renderPass.end();

    this.context.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Resize canvas and update viewport
   */
  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.updateUniforms(); // Update viewport dimensions in shader
  }

  /**
   * Set zoom level
   */
  setZoom(zoom: number): void {
    this.zoom = Math.max(0.1, Math.min(10, zoom)); // Clamp between 0.1x and 10x
    this.updateUniforms();
  }

  /**
   * Get current zoom level
   */
  getZoom(): number {
    return this.zoom;
  }

  /**
   * Set pan offset
   */
  setPan(x: number, y: number): void {
    this.panX = x;
    this.panY = y;
    this.updateUniforms();
  }

  /**
   * Get current pan offset
   */
  getPan(): { x: number; y: number } {
    return { x: this.panX, y: this.panY };
  }

  /**
   * Get canvas aspect ratio (width / height)
   */
  getAspectRatio(): number {
    return this.canvas.width / this.canvas.height;
  }

  /**
   * Zoom to a specific point (zoom centered on a screen coordinate)
   */
  zoomToPoint(newZoom: number, screenX: number, screenY: number): void {
    // Clamp the new zoom level
    const clampedZoom = Math.max(0.1, Math.min(10, newZoom));

    // Calculate aspect ratio for coordinate transformations
    const aspectRatio = this.canvas.width / this.canvas.height;

    // Convert screen coordinates to normalized device coordinates (-1 to 1)
    const ndcX = (screenX / this.canvas.width) * 2 - 1;
    const ndcY = -((screenY / this.canvas.height) * 2 - 1); // Flip Y axis

    // Convert NDC to world coordinates before zoom (accounting for aspect ratio)
    const worldXBefore = ((ndcX - this.panX) * aspectRatio) / this.zoom;
    const worldYBefore = (ndcY - this.panY) / this.zoom;

    // Update zoom
    this.zoom = clampedZoom;

    // Calculate new pan to keep the world point at the same screen position
    this.panX = ndcX - (worldXBefore * this.zoom) / aspectRatio;
    this.panY = ndcY - worldYBefore * this.zoom;

    this.updateUniforms();
  }

  /**
   * Update GPU layer options
   */
  updateOptions(options: Partial<GpuLayerOptions>): void {
    if (options.backgroundColor !== undefined) {
      this.backgroundColor = options.backgroundColor;
    }
  }

  /**
   * Destroy resources
   */
  destroy(): void {
    if (this.quadVertexBuffer) {
      this.quadVertexBuffer.destroy();
    }
    if (this.instanceBuffer) {
      this.instanceBuffer.destroy();
    }
    if (this.indexBuffer) {
      this.indexBuffer.destroy();
    }
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
    }

    this.context.destroy();
  }
}
