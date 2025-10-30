/**
 * WGSL Shader code for scatter plot rendering
 */

export const scatterVertexShader = `
struct Uniforms {
  viewMatrix: mat4x4<f32>,
  zoom: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  padding: f32,
}

// Quad vertex position (stepMode: 'vertex')
struct VertexInput {
  @location(0) quadPosition: vec2<f32>,
}

// Instance data: point position, color, and size (stepMode: 'instance')
struct InstanceInput {
  @location(1) pointPosition: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) size: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) pointCoord: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(vertex: VertexInput, instance: InstanceInput) -> VertexOutput {
  var output: VertexOutput;

  // Transform point position to clip space
  let clipPos = uniforms.viewMatrix * vec4<f32>(instance.pointPosition, 0.0, 1.0);

  // Convert point size from pixels to clip space
  // Scale by zoom^0.3 for very gentle scaling (compromise between constant screen/data size)
  let pixelToClipX = 2.0 / uniforms.viewportWidth;
  let pixelToClipY = 2.0 / uniforms.viewportHeight;
  let zoomScale = pow(uniforms.zoom, 0.3);

  let offsetClip = vec2<f32>(
    vertex.quadPosition.x * instance.size * pixelToClipX * zoomScale,
    vertex.quadPosition.y * instance.size * pixelToClipY * zoomScale
  );

  output.position = clipPos + vec4<f32>(offsetClip, 0.0, 0.0);
  output.color = instance.color;

  // Map quad position (-1 to 1) to texture coordinates (0 to 1)
  output.pointCoord = (vertex.quadPosition + 1.0) * 0.5;

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Create circular points with sharp edges
  let dist = distance(input.pointCoord, vec2<f32>(0.5, 0.5));
  if (dist > 0.5) {
    discard;
  }

  // Anti-aliasing with tighter gradient for sharper edges
  let edgeWidth = 0.02; // Smaller value = sharper edges
  let alpha = smoothstep(0.5, 0.5 - edgeWidth, dist);

  return vec4<f32>(input.color.rgb, input.color.a * alpha);
}
`;
