import type { PointSizeLambda } from '../../../../../src/types';

export type SizeStrategy = 'data' | 'uniform' | 'random';

// Point size lambda generators
export function getPointSizeLambda(strategy: SizeStrategy): PointSizeLambda {
  switch (strategy) {
    case 'data':
      // Use favorite_count column to scale point sizes
      return (point, columns) => {
        const favoriteCountIdx = columns.indexOf('favorite_count');
        if (favoriteCountIdx === -1) return 4;

        // Convert BigInt to number if needed
        const rawValue = point[favoriteCountIdx];
        const favoriteCount = typeof rawValue === 'bigint' ? Number(rawValue) : rawValue || 0;

        // Scale logarithmically for better visualization: size range 2-8 pixels
        const size = 2 + Math.min(6, (Math.log(favoriteCount + 1) / Math.log(1000)) * 6);
        return size;
      };

    case 'uniform':
      return (point, columns) => 4;

    case 'random':
      return (point, columns) => 2 + Math.random() * 6;

    default:
      return (point, columns) => 4;
  }
}
