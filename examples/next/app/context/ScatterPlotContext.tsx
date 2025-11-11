'use client';

import { createContext, useContext, useState, useRef, type ReactNode } from 'react';

// Use any for the ScatterPlot type to avoid type mismatch between src and dist
interface ScatterPlotContextValue {
  scatterPlot: any;
  isInitialized: boolean;
  error: string | null;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  setScatterPlot: (plot: any) => void;
  setIsInitialized: (initialized: boolean) => void;
  setError: (error: string | null) => void;
}

const ScatterPlotContext = createContext<ScatterPlotContextValue | undefined>(undefined);

export function ScatterPlotProvider({ children }: { children: ReactNode }) {
  const [scatterPlot, setScatterPlot] = useState<any>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  return (
    <ScatterPlotContext.Provider
      value={{
        scatterPlot,
        isInitialized,
        error,
        canvasRef,
        setScatterPlot,
        setIsInitialized,
        setError,
      }}
    >
      {children}
    </ScatterPlotContext.Provider>
  );
}

export function useScatterPlot() {
  const context = useContext(ScatterPlotContext);
  if (context === undefined) {
    throw new Error('useScatterPlot must be used within a ScatterPlotProvider');
  }
  return context;
}
