export type ColorScheme = 'data' | 'rainbow' | 'heatmap' | 'blue';

// Point color SQL expression generators (returns ARGB 32-bit integer)
export function getColorSql(scheme: ColorScheme): string {
  switch (scheme) {
    case 'data':
      // Based on cluster, return a semi-transparent color
      // Alpha = 0x40 (25%), varying RGB based on cluster
      return `CAST(
        (CAST(64 AS BIGINT) << 24) |
        (((cluster * 37) % 256) << 16) |
        (((cluster * 73) % 256) << 8) |
        ((cluster * 113) % 256)
      AS INTEGER)`;

    case 'rainbow':
      // Rainbow based on position - simplified HSL-like calculation
      // This creates a rainbow effect based on x+y position
      return `CAST(
        (CAST(204 AS BIGINT) << 24) |
        (CAST(((SIN((x + y) * 3.14159) + 1) / 2 * 255) AS INTEGER) << 16) |
        (CAST(((SIN((x + y) * 3.14159 + 2.094) + 1) / 2 * 255) AS INTEGER) << 8) |
        CAST(((SIN((x + y) * 3.14159 + 4.189) + 1) / 2 * 255) AS INTEGER)
      AS INTEGER)`;

    case 'heatmap':
      // Blue -> Yellow -> Red based on favorite_count
      // t = normalized value 0-1
      return `CAST(
        CASE
          WHEN LN(COALESCE(favorite_count, 0) + 1) / LN(1000) < 0.5 THEN
            (CAST(204 AS BIGINT) << 24) |
            (CAST(LN(COALESCE(favorite_count, 0) + 1) / LN(1000) * 2 * 255 AS INTEGER) << 16) |
            (CAST(LN(COALESCE(favorite_count, 0) + 1) / LN(1000) * 2 * 255 AS INTEGER) << 8) |
            CAST((1 - LN(COALESCE(favorite_count, 0) + 1) / LN(1000) * 2) * 255 AS INTEGER)
          ELSE
            (CAST(204 AS BIGINT) << 24) |
            (255 << 16) |
            (CAST((1 - (LN(COALESCE(favorite_count, 0) + 1) / LN(1000) - 0.5) * 2) * 255 AS INTEGER) << 8) |
            0
        END
      AS INTEGER)`;

    case 'blue':
      // Varying blue intensity with some randomness
      return `CAST(
        (CAST(179 AS BIGINT) << 24) |
        (26 << 16) |
        (77 << 8) |
        CAST((0.3 + RANDOM() * 0.5) * 255 AS INTEGER)
      AS INTEGER)`;

    default:
      // Default: semi-transparent light blue
      return `CAST((CAST(179 AS BIGINT) << 24) | (128 << 16) | (128 << 8) | 204 AS INTEGER)`;
  }
}
