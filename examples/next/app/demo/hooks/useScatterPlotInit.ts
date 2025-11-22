'use client';

import { useEffect } from 'react';
import { useScatterPlot } from '../../context/ScatterPlotContext';
import type { ScatterPlotOptions } from '../../../../../src/types';

export function useScatterPlotInit(options: Omit<ScatterPlotOptions, 'canvas'>) {
  const { canvasRef, setScatterPlot, setIsInitialized, setError } = useScatterPlot();

  useEffect(() => {
    let mounted = true;

    async function initScatterPlot() {
      if (!canvasRef.current) return;

      try {
        // Dynamic import to avoid SSR issues
        const { ScatterPlot, isWebGPUSupported } = await import('../../../../../dist/index.js');

        if (!mounted) return;

        // Run diagnostics
        console.log('Running WebGPU diagnostics...');

        // Check WebGPU support
        if (!isWebGPUSupported()) {
          setError(
            'WebGPU is not supported in your browser. Please use Chrome/Edge 113+ or Safari 18+. Check the console for detailed diagnostics.'
          );
          return;
        }

        // Set canvas size
        if (canvasRef.current) {
          canvasRef.current.width = window.innerWidth;
          canvasRef.current.height = window.innerHeight;
        }

        // Create scatter plot instance
        const plot = new ScatterPlot({
          ...options,
          canvas: canvasRef.current,
        });

        await plot.initialize();
        plot.render();

        if (mounted) {
          setScatterPlot(plot);
          setIsInitialized(true);
        }
      } catch (error: any) {
        console.error('Initialization error:', error);
        if (mounted) {
          setError(error.message || 'Failed to initialize ScatterPlot');
        }
      }
    }

    initScatterPlot();

    return () => {
      mounted = false;
    };
  }, []);
}
