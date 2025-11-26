export type SizeStrategy = 'data' | 'uniform' | 'random';

// Point size SQL expression generators
export function getSizeSql(strategy: SizeStrategy): string {
  switch (strategy) {
    case 'data':
      // Use favorite_count column to scale point sizes
      // LOG(favorite_count + 1) / LOG(1000) * 6 + 2, clamped to max 8
      return 'LEAST(8, 2 + (LN(COALESCE(favorite_count, 0) + 1) / LN(1000)) * 6)';

    case 'uniform':
      return '4';

    case 'random':
      // DuckDB random() returns 0-1, so: 2 + random() * 6
      return '2 + RANDOM() * 6';

    default:
      return '4';
  }
}
