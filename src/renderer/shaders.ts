/**
 * 散布図レンダリング用WGSLシェーダーコード
 */

/**
 * ビューポート境界とLODに基づいて可視ポイントをフィルタリングするコンピュートシェーダー
 * ワークグループローカルのアトミック操作を使用してグローバルアトミックの競合を軽減
 */
export const filterComputeShader = `
struct Point {
  x: f32,
  y: f32,
  color: u32,
  size: f32,
}

struct FilterUniforms {
  worldBoundsMin: vec2<f32>,
  worldBoundsMax: vec2<f32>,
  lodThreshold: u32,
  totalPoints: u32,
  activeFilterMask: u32,
  _padding: u32,
  filterRangeMin: vec4<f32>,
  filterRangeMax: vec4<f32>,
}

@group(0) @binding(0) var<storage, read> allPoints: array<Point>;
@group(0) @binding(1) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(2) var<storage, read_write> counter: atomic<u32>;
@group(0) @binding(3) var<uniform> uniforms: FilterUniforms;
@group(0) @binding(4) var<storage, read> filterColumns: array<vec4<f32>>;

// ワークグループローカルストレージ（グローバルアトミックの競合を軽減）
var<workgroup> localCount: atomic<u32>;
var<workgroup> localIndices: array<u32, 256>;
var<workgroup> globalOffset: u32;

// PCGハッシュ: 高速かつ高品質な整数ハッシュ
// http://www.pcg-random.org/
fn pcgHash(input: u32) -> u32 {
    let state = input * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

@compute @workgroup_size(256)
fn main(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>
) {
  let idx = globalId.x;
  let lid = localId.x;

  // ワークグループローカルカウンターを初期化
  if (lid == 0u) {
    atomicStore(&localCount, 0u);
  }
  workgroupBarrier();

  // 可視性をチェックしてローカルバッファに追加
  var myLocalSlot: u32 = 0xFFFFFFFFu;
  if (idx < uniforms.totalPoints) {
    // 1. LODフィルター（早期終了）
    // どうせフィルタリングされるポイントの場合、'allPoints'バッファへの
    // メモリアクセスを避けるため、インデックスのみからハッシュを計算
    let hash = pcgHash(idx);
    var isVisible = hash <= uniforms.lodThreshold;

    // 2. 境界チェック（LODテストを通過した場合のみ）
    if (isVisible) {
      // 必要な場合のみポイントデータをロード（帯域幅の最適化）
      let point = allPoints[idx];

      // ワールド空間で直接境界をチェック
      // すべてのポイントに対して行列乗算を行うことを回避
      isVisible = point.x >= uniforms.worldBoundsMin.x && point.x <= uniforms.worldBoundsMax.x &&
                  point.y >= uniforms.worldBoundsMin.y && point.y <= uniforms.worldBoundsMax.y;
    }

    // 3. GPUフィルター条件チェック（境界チェックを通過した場合のみ）
    if (isVisible && uniforms.activeFilterMask != 0u) {
      let filterData = filterColumns[idx];

      // カラム0
      if ((uniforms.activeFilterMask & 1u) != 0u) {
        isVisible = isVisible &&
                    filterData.x >= uniforms.filterRangeMin.x &&
                    filterData.x <= uniforms.filterRangeMax.x;
      }
      // カラム1
      if ((uniforms.activeFilterMask & 2u) != 0u) {
        isVisible = isVisible &&
                    filterData.y >= uniforms.filterRangeMin.y &&
                    filterData.y <= uniforms.filterRangeMax.y;
      }
      // カラム2
      if ((uniforms.activeFilterMask & 4u) != 0u) {
        isVisible = isVisible &&
                    filterData.z >= uniforms.filterRangeMin.z &&
                    filterData.z <= uniforms.filterRangeMax.z;
      }
      // カラム3
      if ((uniforms.activeFilterMask & 8u) != 0u) {
        isVisible = isVisible &&
                    filterData.w >= uniforms.filterRangeMin.w &&
                    filterData.w <= uniforms.filterRangeMax.w;
      }
    }

    if (isVisible) {
      myLocalSlot = atomicAdd(&localCount, 1u);
      localIndices[myLocalSlot] = idx;
    }
  }
  workgroupBarrier();

  // グローバルオフセットを取得（ワークグループごとに1回のみ）
  let count = atomicLoad(&localCount);
  if (lid == 0u && count > 0u) {
    globalOffset = atomicAdd(&counter, count);
  }
  workgroupBarrier();

  // グローバルバッファに書き込み
  if (lid < count) {
    visibleIndices[globalOffset + lid] = localIndices[lid];
  }
}
`;

/**
 * カウンターから間接描画バッファを更新するコンピュートシェーダー
 */
export const updateIndirectShader = `
struct DrawIndexedIndirect {
  indexCount: u32,
  instanceCount: u32,
  firstIndex: u32,
  baseVertex: u32,
  firstInstance: u32,
}

@group(0) @binding(0) var<storage, read> counter: u32;
@group(0) @binding(1) var<storage, read_write> indirect: DrawIndexedIndirect;

@compute @workgroup_size(1)
fn main() {
  indirect.indexCount = 6u;
  indirect.instanceCount = counter;
  indirect.firstIndex = 0u;
  indirect.baseVertex = 0u;
  indirect.firstInstance = 0u;
}
`;

export const scatterVertexShader = `
struct Point {
  x: f32,
  y: f32,
  color: u32,
  size: f32,
}

struct Uniforms {
  viewMatrix: mat4x4<f32>,
  zoomScale: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  pointAlpha: f32,
  pointSizeScale: f32,
  _padding1: f32,
  _padding2: f32,
  _padding3: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) pointCoord: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> allPoints: array<Point>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;

// ARGB u32をvec4<f32>にアンパック (RGBA, 0.0-1.0)
fn unpackColor(argb: u32) -> vec4<f32> {
  let a = f32((argb >> 24u) & 0xFFu) / 255.0;
  let r = f32((argb >> 16u) & 0xFFu) / 255.0;
  let g = f32((argb >> 8u) & 0xFFu) / 255.0;
  let b = f32(argb & 0xFFu) / 255.0;
  return vec4<f32>(r, g, b, a);
}

@vertex
fn vertexMain(
  @location(0) quadPosition: vec2<f32>,
  @builtin(instance_index) instanceIdx: u32
) -> VertexOutput {
  var output: VertexOutput;

  // 可視インデックス経由でポイントデータを取得
  let pointIdx = visibleIndices[instanceIdx];
  let point = allPoints[pointIdx];

  // ポイント位置をクリップ空間に変換
  let clipPos = uniforms.viewMatrix * vec4<f32>(point.x, point.y, 0.0, 1.0);

  // ポイントサイズをピクセルからクリップ空間に変換
  // zoom^0.3でスケーリング（固定スクリーンサイズと固定データサイズの妥協点）
  let pixelToClipX = 2.0 / uniforms.viewportWidth;
  let pixelToClipY = 2.0 / uniforms.viewportHeight;
  let zoomScale = uniforms.zoomScale;

  let scaledSize = point.size * uniforms.pointSizeScale;
  let offsetClip = vec2<f32>(
    quadPosition.x * scaledSize * pixelToClipX * zoomScale,
    quadPosition.y * scaledSize * pixelToClipY * zoomScale
  );

  output.position = clipPos + vec4<f32>(offsetClip, 0.0, 0.0);
  output.color = unpackColor(point.color);

  // クワッド位置(-1〜1)をテクスチャ座標(0〜1)にマッピング
  output.pointCoord = (quadPosition + 1.0) * 0.5;

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // 最適化: 高コストなsqrt()命令を避けるため距離の二乗を使用
  // 中心は(0.5, 0.5)
  let d = input.pointCoord - vec2<f32>(0.5);
  let distSq = dot(d, d);
  
  // 半径は0.5なので、半径の二乗は0.25
  if (distSq > 0.25) {
    discard;
  }

  // 距離の二乗を使用したアンチエイリアシング
  // sqrt()はエッジ上のピクセルのみで計算
  // または二乗空間でグラデーションを近似

  // 元: smoothstep(0.5, 0.5 - width, dist)
  // 二乗近似: smoothstep(0.25, 0.25 - widthAlloc, distSq)
  // widthAlloc ≈ width * 2 * radius = 0.02 * 2 * 0.5 = 0.02
  // 二乗空間での0.02幅は視覚的な外観にほぼ一致
  let alpha = smoothstep(0.25, 0.23, distSq);

  return vec4<f32>(input.color.rgb, input.color.a * alpha * uniforms.pointAlpha);
}
`;
