'use client';

import { useState, useCallback } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function PointAlphaSlider() {
  const [value, setValue] = useState(1.0);
  const { updatePointAlpha } = useScatterPlot();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseFloat(e.target.value);
      setValue(newValue);
      updatePointAlpha(newValue);
    },
    [updatePointAlpha]
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">
        Point Alpha: {value.toFixed(2)}
      </label>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value}
        onChange={handleChange}
        className="w-full h-2 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
      />
      <div className="flex justify-between text-xs text-zinc-500">
        <span>0</span>
        <span>1</span>
      </div>
    </div>
  );
}
