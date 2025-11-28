'use client';

import { useState, useCallback } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function PointLimitSlider() {
  const [value, setValue] = useState(100000);
  const { updatePointLimit } = useScatterPlot();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseInt(e.target.value, 10);
      setValue(newValue);
      updatePointLimit(newValue);
    },
    [updatePointLimit]
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">
        Visible Points: {value.toLocaleString()}
      </label>
      <input
        type="range"
        min="1000"
        max="500000"
        step="1000"
        value={value}
        onChange={handleChange}
        className="w-full h-2 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
      />
      <div className="flex justify-between text-xs text-zinc-500">
        <span>1K</span>
        <span>500K</span>
      </div>
    </div>
  );
}
