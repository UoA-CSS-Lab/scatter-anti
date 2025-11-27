'use client';

import { useState, useEffect } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function SizeExpressionInput() {
  const [value, setValue] = useState('5');
  const [error, setError] = useState<string | null>(null);
  const { updateSize } = useScatterPlot();

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        setError(null);
        await updateSize(value);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Invalid expression');
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [value, updateSize]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">
        Point Size Expression (SQL)
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder='e.g., LOG(x+1)*2+3'
        className="px-3 py-2 bg-white border border-zinc-300 rounded text-zinc-800 text-sm"
      />
      {error && <p className="text-red-500 text-xs">{error}</p>}
      <p className="text-zinc-500 text-xs">
        Examples: &quot;5&quot;, &quot;LOG(x+1)*2+3&quot;, &quot;ABS(y)*10&quot;
      </p>
    </div>
  );
}
