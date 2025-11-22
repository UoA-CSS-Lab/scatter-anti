'use client';

import { useEffect, useRef } from 'react';
import { useScatterPlot } from '../../context/ScatterPlotContext';

export function useInteractions() {
  const { scatterPlot, canvasRef } = useScatterPlot();
  const isDraggingRef = useRef(false);
  const lastPositionRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !scatterPlot) return;

    // Mouse wheel zoom
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = scatterPlot.getZoom() * zoomFactor;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      scatterPlot.zoomToPoint(newZoom, mouseX, mouseY);
    };

    // Pan with mouse drag
    const handleMouseDown = (e: MouseEvent) => {
      isDraggingRef.current = true;
      lastPositionRef.current = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;

      const dx = ((e.clientX - lastPositionRef.current.x) / canvas.width) * 2;
      const dy = (-(e.clientY - lastPositionRef.current.y) / canvas.height) * 2;

      scatterPlot.pan(dx, dy);

      lastPositionRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      canvas.style.cursor = 'grab';
    };

    const handleMouseLeave = () => {
      isDraggingRef.current = false;
      canvas.style.cursor = 'grab';
    };

    // Set initial cursor
    canvas.style.cursor = 'grab';

    // Attach event listeners
    canvas.addEventListener('wheel', handleWheel);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [scatterPlot, canvasRef]);
}
