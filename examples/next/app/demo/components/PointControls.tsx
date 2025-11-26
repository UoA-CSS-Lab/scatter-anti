'use client';

import { useState } from 'react';
import { useScatterPlot } from '../../context/ScatterPlotContext';
import { getSizeSql, type SizeStrategy } from '../utils/sizeStrategies';
import { getColorSql, type ColorScheme } from '../utils/colorSchemes';

export function PointControls() {
  const { scatterPlot, isInitialized } = useScatterPlot();
  const [sizeStrategy, setSizeStrategy] = useState<SizeStrategy>('data');
  const [colorScheme, setColorScheme] = useState<ColorScheme>('data');
  const [visibleLimit, setVisibleLimit] = useState(100000);
  const [hoverScale, setHoverScale] = useState(15);

  const handleSizeStrategyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const strategy = e.target.value as SizeStrategy;
    setSizeStrategy(strategy);
    scatterPlot?.update({
      data: {
        sizeSql: getSizeSql(strategy),
      },
    });
  };

  const handleColorSchemeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const scheme = e.target.value as ColorScheme;
    setColorScheme(scheme);
    scatterPlot?.update({
      data: {
        colorSql: getColorSql(scheme),
      },
    });
  };

  const handleVisibleLimitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value);
    if (value > 0) {
      setVisibleLimit(value);
      scatterPlot?.update({
        data: {
          visiblePointLimit: value,
        },
      });
    }
  };

  return (
    <div className="fixed top-60 right-5 min-w-[280px] bg-zinc-900/95 backdrop-blur-md px-4 py-4 rounded-lg z-[100] shadow-xl">
      <div className="space-y-4">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide m-0">
          Point Options
        </h2>

        <div>
          <label className="flex flex-col gap-1.5 text-sm text-white">
            <span>Size Strategy:</span>
            <select
              value={sizeStrategy}
              onChange={handleSizeStrategyChange}
              disabled={!isInitialized}
              className="px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-white text-sm cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <option value="data">Data-based (favorite_count)</option>
              <option value="uniform">Uniform</option>
              <option value="random">Random</option>
            </select>
          </label>
        </div>

        <div>
          <label className="flex flex-col gap-1.5 text-sm text-white">
            <span>Color Scheme:</span>
            <select
              value={colorScheme}
              onChange={handleColorSchemeChange}
              disabled={!isInitialized}
              className="px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-white text-sm cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <option value="data">Data-based (viridis)</option>
              <option value="rainbow">Rainbow</option>
              <option value="heatmap">Heatmap</option>
              <option value="blue">Blue Monochrome</option>
            </select>
          </label>
        </div>

        <div>
          <label className="flex flex-col gap-1.5 text-sm text-white">
            <span>Visible Limit:</span>
            <input
              type="number"
              value={visibleLimit}
              onChange={handleVisibleLimitChange}
              min="1000"
              max="1000000"
              step="1000"
              disabled={!isInitialized}
              className="px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-white text-sm disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </label>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm text-white">
            <span className="whitespace-nowrap">Hover Scale:</span>
            <input
              type="range"
              value={hoverScale}
              onChange={(e) => setHoverScale(parseInt(e.target.value))}
              min="10"
              max="30"
              step="1"
              disabled={!isInitialized}
              className="flex-1"
            />
            <span className="min-w-[50px] text-right font-semibold text-blue-500">
              {(hoverScale / 10).toFixed(1)}x
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
