'use client';

import { useState, useMemo, useEffect } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function ColorExpressionInput() {
  const [r, setR] = useState('59');
  const [g, setG] = useState('130');
  const [b, setB] = useState('246');
  const [a, setA] = useState('255');
  const [error, setError] = useState<string | null>(null);
  const { updateColor } = useScatterPlot();

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        setError(null);
        const calc = `(CAST(${a} AS BIGINT) * 16777216 + (${r}) * 65536 + (${g}) * 256 + (${b}))`;
        const colorSql = `(${calc} - CASE WHEN ${calc} > 2147483647 THEN 4294967296 ELSE 0 END)::INTEGER`;
        await updateColor(colorSql);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Invalid expression');
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [r, g, b, a, updateColor]);

  const previewColor = useMemo(() => {
    const rNum = parseInt(r, 10);
    const gNum = parseInt(g, 10);
    const bNum = parseInt(b, 10);
    const aNum = parseInt(a, 10);
    if ([rNum, gNum, bNum, aNum].some(isNaN)) return null;
    return `rgba(${rNum}, ${gNum}, ${bNum}, ${aNum / 255})`;
  }, [r, g, b, a]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">
        Point Color (RGBA, 0-255 or SQL)
      </label>
      <div className="grid grid-cols-4 gap-2">
        <div>
          <label className="text-xs text-zinc-500">R</label>
          <input
            type="text"
            value={r}
            onChange={(e) => setR(e.target.value)}
            className="w-full px-2 py-1 bg-white border border-zinc-300 rounded text-zinc-800 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-zinc-500">G</label>
          <input
            type="text"
            value={g}
            onChange={(e) => setG(e.target.value)}
            className="w-full px-2 py-1 bg-white border border-zinc-300 rounded text-zinc-800 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-zinc-500">B</label>
          <input
            type="text"
            value={b}
            onChange={(e) => setB(e.target.value)}
            className="w-full px-2 py-1 bg-white border border-zinc-300 rounded text-zinc-800 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-zinc-500">A</label>
          <input
            type="text"
            value={a}
            onChange={(e) => setA(e.target.value)}
            className="w-full px-2 py-1 bg-white border border-zinc-300 rounded text-zinc-800 text-sm"
          />
        </div>
      </div>
      {previewColor && (
        <div
          className="w-8 h-8 rounded border border-zinc-300"
          style={{ backgroundColor: previewColor }}
        />
      )}
      {error && <p className="text-red-500 text-xs">{error}</p>}
    </div>
  );
}
