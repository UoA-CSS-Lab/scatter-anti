'use client';

import { useScatterPlot } from '../../context/ScatterPlotContext';

export function ErrorDisplay() {
  const { error } = useScatterPlot();

  if (!error) return null;

  return (
    <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-red-900/95 text-white px-6 py-5 rounded-lg z-[200] max-w-lg backdrop-blur-md shadow-2xl">
      <strong className="text-lg block mb-2">Error:</strong>
      <p className="whitespace-pre-line">{error}</p>
      <p className="mt-3 text-sm text-red-200">
        Check the browser console for detailed diagnostics.
      </p>
    </div>
  );
}
