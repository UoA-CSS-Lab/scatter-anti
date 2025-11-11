'use client';

import { useScatterPlot } from '../../context/ScatterPlotContext';
import { useViewControls } from '../hooks/useViewControls';

export function StatusPanel() {
  const { isInitialized, error } = useScatterPlot();
  const { zoom } = useViewControls();

  const getStatus = () => {
    if (error) return 'Error';
    if (!isInitialized) return 'Initializing...';
    return `Zoom: ${zoom.toFixed(1)}x`;
  };

  return (
    <div className="fixed top-5 left-5 bg-zinc-900/95 backdrop-blur-md px-4 py-3 rounded-lg z-[100] shadow-xl">
      <strong className="text-white">Status:</strong>{' '}
      <span className="text-white">{getStatus()}</span>
    </div>
  );
}
