'use client';

import { useMemo } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function HoverInfoDisplay() {
  const { state } = useScatterPlot();

  const formattedData = useMemo(() => {
    if (!state.hoveredPoint) return null;

    const { row, columns } = state.hoveredPoint;
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      const val = row[i];
      obj[col] = typeof val === 'bigint' ? Number(val) : val;
    });
    return JSON.stringify(obj, null, 2);
  }, [state.hoveredPoint]);

  return (
    <div className="flex flex-col gap-2 mt-auto">
      <label className="text-sm font-medium text-zinc-700">Hovered Point</label>
      <pre className="p-2 bg-white border border-zinc-300 rounded text-zinc-700 text-xs overflow-auto max-h-40 min-h-[80px]">
        {formattedData || 'Hover over a point to see details'}
      </pre>
    </div>
  );
}
