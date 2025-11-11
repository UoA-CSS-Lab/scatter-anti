'use client';

import { useViewControls } from '../hooks/useViewControls';
import { useScatterPlot } from '../../context/ScatterPlotContext';

export function ViewControls() {
  const { isInitialized } = useScatterPlot();
  const { zoom, setZoomValue } = useViewControls();

  const handleZoomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newZoom = parseInt(e.target.value) / 100;
    setZoomValue(newZoom);
  };

  return (
    <div className="fixed top-5 right-5 min-w-[280px] bg-zinc-900/95 backdrop-blur-md px-4 py-4 rounded-lg z-[100] shadow-xl">
      <div className="space-y-4">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide m-0">
          View Controls
        </h2>
        <div className="flex items-center gap-2">
          <label className="flex-1 flex items-center gap-2 text-sm text-white">
            Zoom:
            <input
              type="range"
              min="10"
              max="1000"
              value={Math.round(zoom * 100)}
              step="10"
              onChange={handleZoomChange}
              disabled={!isInitialized}
              className="flex-1"
            />
            <span className="min-w-[50px] text-right font-semibold text-blue-500">
              {zoom.toFixed(1)}x
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
