'use client';

import { useState, useEffect } from 'react';
import { useScatterPlot } from '../../context/ScatterPlotContext';

export function useViewControls() {
  const { scatterPlot, isInitialized } = useScatterPlot();
  const [zoom, setZoom] = useState(1.0);

  useEffect(() => {
    if (isInitialized && scatterPlot) {
      const currentZoom = scatterPlot.getZoom();
      setZoom(currentZoom);
    }
  }, [isInitialized, scatterPlot]);

  const setZoomValue = (newZoom: number) => {
    if (!scatterPlot) return;
    scatterPlot.setZoom(newZoom);
    setZoom(newZoom);
  };

  return {
    zoom,
    setZoomValue,
  };
}
