import type { Color4f } from '../types.js';

/**
 * 行データからポイントの色を取得する
 * @param row 行データ
 * @returns RGBAカラーオブジェクト
 */
export function getPointColor(row: Record<string, any>): Color4f {
  const argbRaw = row['__color__'];
  if (argbRaw == null) {
    return { r: 0.3, g: 0.3, b: 0.8, a: 0.3 };
  }
  const argb = typeof argbRaw === 'bigint' ? Number(argbRaw) : argbRaw;
  return {
    a: ((argb >>> 24) & 0xff) / 255,
    r: ((argb >>> 16) & 0xff) / 255,
    g: ((argb >>> 8) & 0xff) / 255,
    b: (argb & 0xff) / 255,
  };
}
