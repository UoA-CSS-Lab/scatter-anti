/**
 * Internal/public constants that define duckscatter's current fast GPU path.
 */

/** Number of numeric columns packed into the GPU filter vec4 buffer. */
export const MAX_GPU_FILTER_COLUMNS = 4;

/** Number of f32 components stored per point in the GPU filter column buffer. */
export const GPU_FILTER_COLUMN_COMPONENTS = 4;

/** Default maximum number of points that the WebGPU LOD pass tries to keep visible. */
export const DEFAULT_VISIBLE_POINT_LIMIT = 5_000_000;
