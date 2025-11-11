'use client';

import { useState } from 'react';
import { useScatterPlot } from '../../context/ScatterPlotContext';

export function HoverOutlineControls() {
  const { scatterPlot, isInitialized } = useScatterPlot();
  const [enabled, setEnabled] = useState(true);
  const [color, setColor] = useState('#ffffff');
  const [width, setWidth] = useState(2);

  const updateHoverOutline = (
    newEnabled?: boolean,
    newColor?: string,
    newWidth?: number
  ) => {
    scatterPlot?.update({
      labels: {
        hoverOutlineOptions: {
          enabled: newEnabled ?? enabled,
          color: newColor ?? color,
          width: newWidth ?? width,
        },
      },
    });
  };

  const handleEnabledChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newEnabled = e.target.checked;
    setEnabled(newEnabled);
    updateHoverOutline(newEnabled, undefined, undefined);
  };

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value;
    setColor(newColor);
    updateHoverOutline(undefined, newColor, undefined);
  };

  const handleWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newWidth = parseFloat(e.target.value);
    setWidth(newWidth);
    updateHoverOutline(undefined, undefined, newWidth);
  };

  return (
    <div className="fixed top-[460px] right-5 min-w-[280px] bg-zinc-900/95 backdrop-blur-md px-4 py-4 rounded-lg z-[100] shadow-xl">
      <div className="space-y-4">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide m-0">
          Hover Outline
        </h2>

        <div>
          <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={handleEnabledChange}
              disabled={!isInitialized}
              className="w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
            />
            <span>Enable Hover Outline</span>
          </label>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm text-white">
            <span className="whitespace-nowrap">Outline Color:</span>
            <input
              type="color"
              value={color}
              onChange={handleColorChange}
              disabled={!isInitialized}
              className="flex-1 h-8 rounded cursor-pointer disabled:cursor-not-allowed"
            />
          </label>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm text-white">
            <span className="whitespace-nowrap">Outline Width:</span>
            <input
              type="range"
              value={width}
              onChange={handleWidthChange}
              min="1"
              max="5"
              step="0.5"
              disabled={!isInitialized}
              className="flex-1"
            />
            <span className="min-w-[50px] text-right font-semibold text-blue-500">
              {width}px
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
