import { ScatterPlot } from '../../../../../dist';
import type { ColorRGBA, PointColorLambda } from '../../../../../src/types';

// Helper: Viridis colormap approximation
function viridis(t: number): ColorRGBA {
  // t should be in [0, 1]
  t = Math.max(0, Math.min(1, t));

  // Viridis colormap approximation using piecewise linear interpolation
  const r = Math.pow(0.282 + 0.277 * t + 0.390 * Math.pow(t, 2), 1 / 2.2);
  const g = Math.pow(0.004 + 0.536 * t - 0.143 * Math.pow(t, 2), 1 / 2.2);
  const b = Math.pow(0.333 + 0.455 * t - 1.010 * Math.pow(t, 2), 1 / 2.2);

  return { r, g, b, a: 0.8 };
}

// Helper: HSL to RGB conversion
function hslToRgb(h: number, s: number, l: number): ColorRGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;

  let r: number, g: number, b: number;
  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }

  return {
    r: r + m,
    g: g + m,
    b: b + m,
    a: 0.8,
  };
}

export type ColorScheme = 'data' | 'rainbow' | 'heatmap' | 'blue';

// Point color lambda generators
export function getPointColorLambda(scheme: ColorScheme, scatterPlot: ScatterPlot | null): PointColorLambda {
  switch (scheme) {
    case 'data':
      // Use favorite_count with viridis colormap
      return (point, columns) => {
        const favoriteCountIdx = columns.indexOf('cluster');

        if (favoriteCountIdx === -1) return { r: 0.5, g: 0.5, b: 0.8, a: 0.7 };

        // Convert BigInt to number if needed
        const rawValue = point[favoriteCountIdx];
        const label = scatterPlot?.getLabels().find((l) => l.cluster == rawValue);
        const color = label?.properties?.color;
        return color ? { r: color[0] / 255, g: color[1] / 255, b: color[2] / 255, a: 0.25 } : { r: 0.5, g: 0.5, b: 0.8, a: 0 };
      };

    case 'rainbow':
      // Rainbow colors based on position
      return (point, columns) => {
        const xIdx = columns.indexOf('x');
        const yIdx = columns.indexOf('y');
        if (xIdx === -1 || yIdx === -1)
          return { r: 0.5, g: 0.5, b: 0.8, a: 0.7 };

        // Convert BigInt to number if needed (x/y are likely floats but be safe)
        const rawX = point[xIdx];
        const rawY = point[yIdx];
        const x = typeof rawX === 'bigint' ? Number(rawX) : rawX;
        const y = typeof rawY === 'bigint' ? Number(rawY) : rawY;

        // Use position to generate hue (0-360)
        const hue = ((x + y) * 180) % 360;
        return hslToRgb(hue, 0.8, 0.6);
      };

    case 'heatmap':
      // Heatmap: blue (cold) -> yellow -> red (hot)
      return (point, columns) => {
        const favoriteCountIdx = columns.indexOf('favorite_count');
        if (favoriteCountIdx === -1) return { r: 0.5, g: 0.5, b: 0.8, a: 0.7 };

        // Convert BigInt to number if needed
        const rawValue = point[favoriteCountIdx];
        const favoriteCount =
          typeof rawValue === 'bigint' ? Number(rawValue) : rawValue || 0;

        const t = Math.min(1, Math.log(favoriteCount + 1) / Math.log(1000));

        if (t < 0.5) {
          // Blue to yellow
          const t2 = t * 2;
          return { r: t2, g: t2, b: 1 - t2, a: 0.8 };
        } else {
          // Yellow to red
          const t2 = (t - 0.5) * 2;
          return { r: 1, g: 1 - t2, b: 0, a: 0.8 };
        }
      };

    case 'blue':
      return (point, columns) => {
        const intensity = 0.3 + Math.random() * 0.5;
        return { r: 0.1, g: 0.3, b: intensity, a: 0.7 };
      };

    default:
      return (point, columns) => ({ r: 0.5, g: 0.5, b: 0.8, a: 0.7 });
  }
}
