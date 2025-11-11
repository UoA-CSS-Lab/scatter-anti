'use client';

import { useEffect } from 'react';
import { useScatterPlot } from '../../context/ScatterPlotContext';

export function ScatterCanvas() {
  const { canvasRef, scatterPlot } = useScatterPlot();

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current && scatterPlot) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
        scatterPlot.resize(window.innerWidth, window.innerHeight);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [scatterPlot, canvasRef]);

  return (
    <div className="fixed top-0 left-0 w-full h-full bg-black">
      <canvas ref={canvasRef} className="block w-full h-full bg-black" />
    </div>
  );
}
