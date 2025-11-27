'use client';

import { useRef, useEffect, useCallback } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';

export function ScatterPlotCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { initializePlot, plot, state } = useScatterPlot();
  const initializedRef = useRef(false);
  const isDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (canvasRef.current && !initializedRef.current) {
      initializedRef.current = true;
      initializePlot(canvasRef.current);
    }
  }, [initializePlot]);

  const handleResize = useCallback(() => {
    if (!containerRef.current || !canvasRef.current || !plot) return;

    const { width, height } = containerRef.current.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    canvasRef.current.width = width * dpr;
    canvasRef.current.height = height * dpr;
    canvasRef.current.style.width = `${width}px`;
    canvasRef.current.style.height = `${height}px`;

    plot.resize(width * dpr, height * dpr);
  }, [plot]);

  useEffect(() => {
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  // Zoom with wheel
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !plot) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const dpr = window.devicePixelRatio || 1;

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = plot.getZoom() * zoomFactor;
      plot.zoomToPoint(newZoom, x * dpr, y * dpr);
      plot.render();
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [plot]);

  // Pan with mouse drag
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !plot) return;

    const handleMouseDown = (e: MouseEvent) => {
      isDraggingRef.current = true;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };

      const rect = canvas.getBoundingClientRect();
      // Convert pixel delta to clip space delta (-1 to 1)
      const clipDx = (dx / rect.width) * 2;
      const clipDy = -(dy / rect.height) * 2; // Y is inverted
      plot.pan(clipDx, clipDy);
      plot.render();
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      canvas.style.cursor = 'grab';
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    canvas.style.cursor = 'grab';

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [plot]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <canvas ref={canvasRef} className="block w-full h-full" />
      {state.isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <span className="text-white">Loading...</span>
        </div>
      )}
      {state.error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-red-500 p-4 max-w-md text-center">
            <p className="font-bold">Error</p>
            <p>{state.error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
