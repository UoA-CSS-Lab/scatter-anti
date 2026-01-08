'use client';

import { useState, useCallback } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function PointSizeScaleSlider() {
  const [value, setValue] = useState(1.0);
  const { updatePointSizeScale } = useScatterPlot();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseFloat(e.target.value);
      setValue(newValue);
      updatePointSizeScale(newValue);
    },
    [updatePointSizeScale]
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">
        Size Scale: {value.toFixed(2)}x
      </label>
      <input
        type="range"
        min="0.1"
        max="3"
        step="0.05"
        value={value}
        onChange={handleChange}
        className="w-full h-2 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
      />
      <div className="flex justify-between text-xs text-zinc-500">
        <span>0.1x</span>
        <span>3x</span>
      </div>
    </div>
  );
}
