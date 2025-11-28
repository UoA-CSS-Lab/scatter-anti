'use client';

import { useState, useCallback } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function PointSizeSlider() {
  const [value, setValue] = useState(5);
  const { updateSize } = useScatterPlot();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseFloat(e.target.value);
      setValue(newValue);
      updateSize(newValue.toString());
    },
    [updateSize]
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-zinc-700">
        Point Size: {value}
      </label>
      <input
        type="range"
        min="1"
        max="20"
        step="0.5"
        value={value}
        onChange={handleChange}
        className="w-full h-2 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
      />
      <div className="flex justify-between text-xs text-zinc-500">
        <span>1</span>
        <span>20</span>
      </div>
    </div>
  );
}
