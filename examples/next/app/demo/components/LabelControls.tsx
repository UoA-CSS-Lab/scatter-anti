'use client';

import { useState, useRef } from 'react';
import { useScatterPlot } from '../../context/ScatterPlotContext';

export function LabelControls() {
  const { scatterPlot, isInitialized } = useScatterPlot();
  const [fontSize, setFontSize] = useState(12);
  const selectedLabelRef = useRef<string | null>(null);

  const handleFontSizeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const size = parseInt(e.target.value);
    setFontSize(size);
    scatterPlot?.update({
      labels: {
        fontSize: size,
      },
    });
  };

  const handleShowAllLabels = () => {
    selectedLabelRef.current = null;
    scatterPlot?.update({
      labels: {
        filterLambda: (properties: any) => true,
      },
    });
  };

  return (
    <div className="fixed bottom-5 right-5 min-w-[280px] bg-zinc-900/95 backdrop-blur-md px-4 py-4 rounded-lg z-[100] shadow-xl">
      <div className="space-y-4">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide m-0">
          Label Options
        </h2>

        <div>
          <label className="flex items-center gap-2 text-sm text-white">
            <span className="whitespace-nowrap">Font Size:</span>
            <input
              type="range"
              value={fontSize}
              onChange={handleFontSizeChange}
              min="8"
              max="32"
              step="1"
              disabled={!isInitialized}
              className="flex-1"
            />
            <span className="min-w-[50px] text-right font-semibold text-blue-500">
              {fontSize}px
            </span>
          </label>
        </div>

        <div>
          <button
            onClick={handleShowAllLabels}
            disabled={!isInitialized}
            className="w-full px-4 py-2 bg-gray-700 text-white rounded text-sm transition-colors hover:bg-gray-600 disabled:bg-gray-600 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Show All Labels
          </button>
        </div>
      </div>
    </div>
  );
}
