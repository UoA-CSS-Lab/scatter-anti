'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import type { ScatterPlot, WhereCondition } from 'scatter-anti';

interface ScatterPlotState {
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  hoveredPoint: { row: unknown[]; columns: string[] } | null;
  pointCount: number | null;
}

interface ScatterPlotContextValue {
  plot: ScatterPlot | null;
  state: ScatterPlotState;
  initializePlot: (canvas: HTMLCanvasElement) => Promise<void>;
  updateSize: (sizeSql: string) => Promise<void>;
  updateColor: (colorSql: string) => Promise<void>;
  updateSearch: (searchText: string) => Promise<void>;
  updatePointLimit: (limit: number) => Promise<void>;
}

const ScatterPlotContext = createContext<ScatterPlotContextValue | null>(null);

export function ScatterPlotProvider({ children }: { children: ReactNode }) {
  const plotRef = useRef<ScatterPlot | null>(null);
  const [state, setState] = useState<ScatterPlotState>({
    isInitialized: false,
    isLoading: false,
    error: null,
    hoveredPoint: null,
    pointCount: null,
  });

  const filtersRef = useRef<{
    searchText: string;
    sizeSql: string;
    colorSql: string;
    visiblePointLimit: number;
  }>({
    searchText: '',
    sizeSql: '5',
    colorSql: '(CAST(255 AS BIGINT) * 16777216 + 59 * 65536 + 130 * 256 + 246 - CASE WHEN (CAST(255 AS BIGINT) * 16777216 + 59 * 65536 + 130 * 256 + 246) > 2147483647 THEN 4294967296 ELSE 0 END)::INTEGER',
    visiblePointLimit: 100000,
  });

  const buildWhereConditions = useCallback((): WhereCondition[] => {
    const conditions: WhereCondition[] = [];
    if (filtersRef.current.searchText) {
      conditions.push({
        type: 'string',
        column: 'token',
        operator: 'contains',
        value: filtersRef.current.searchText,
      });
    }
    return conditions;
  }, []);

  const initializePlot = useCallback(
    async (canvas: HTMLCanvasElement) => {
      const { ScatterPlot } = await import('scatter-anti');

      setState((s) => ({ ...s, isLoading: true, error: null }));

      const plot = new ScatterPlot({
        canvas,
        dataUrl: '/output.parquet',
        data: {
          idColumn: '__index_level_0__',
          sizeSql: filtersRef.current.sizeSql,
          colorSql: filtersRef.current.colorSql,
        },
        gpu: {
          backgroundColor: { r: 0.85, g: 0.85, b: 0.85, a: 1.0 },
        },
        labels: {
          url: 'label.geojson',
          onClick: (label) => {
            console.log('Label clicked:', label);
          },
          hoverOutlineOptions: {
            enabled: true,
            color: '#ffffff',
            width: 2,
          },
        },
        interaction: {
          onPointHover: (data) => {
            setState((s) => ({ ...s, hoveredPoint: data }));
          },
        },
      });

      plot.on('error', (error) => {
        setState((s) => ({ ...s, error: error.message }));
      });

      try {
        await plot.initialize();
        plotRef.current = plot;
        plot.render();

        // Get point count
        const result = await plot.runQuery('SELECT COUNT(*) as count FROM parquet_data');
        let pointCount = 0;
        if (result && result.rowCount > 0) {
          const countCol = result.columnData.get('count');
          if (countCol) {
            pointCount = Number(countCol[0]);
          }
        }

        setState((s) => ({ ...s, isInitialized: true, isLoading: false, pointCount }));
      } catch (e) {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: e instanceof Error ? e.message : 'Failed to initialize',
        }));
      }
    },
    [buildWhereConditions]
  );

  const updateSize = useCallback(
    async (sizeSql: string) => {
      if (!plotRef.current) return;
      filtersRef.current.sizeSql = sizeSql;
      await plotRef.current.update({
        data: {
          idColumn: '__index_level_0__',
          sizeSql,
          colorSql: filtersRef.current.colorSql,
          whereConditions: buildWhereConditions(),
        },
      });
      plotRef.current.render();
    },
    [buildWhereConditions]
  );

  const updateColor = useCallback(
    async (colorSql: string) => {
      if (!plotRef.current) return;
      filtersRef.current.colorSql = colorSql;
      await plotRef.current.update({
        data: {
          idColumn: '__index_level_0__',
          sizeSql: filtersRef.current.sizeSql,
          colorSql,
          whereConditions: buildWhereConditions(),
        },
      });
      plotRef.current.render();
    },
    [buildWhereConditions]
  );

  const updateSearch = useCallback(
    async (searchText: string) => {
      if (!plotRef.current) return;
      filtersRef.current.searchText = searchText;
      await plotRef.current.update({
        data: {
          idColumn: '__index_level_0__',
          sizeSql: filtersRef.current.sizeSql,
          colorSql: filtersRef.current.colorSql,
          whereConditions: buildWhereConditions(),
        },
      });
      plotRef.current.render();
    },
    [buildWhereConditions]
  );

  const updatePointLimit = useCallback(
    async (limit: number) => {
      if (!plotRef.current) return;
      filtersRef.current.visiblePointLimit = limit;
      await plotRef.current.update({
        data: {
          idColumn: '__index_level_0__',
          sizeSql: filtersRef.current.sizeSql,
          colorSql: filtersRef.current.colorSql,
          visiblePointLimit: limit,
          whereConditions: buildWhereConditions(),
        },
      });
      plotRef.current.render();
    },
    [buildWhereConditions]
  );

  useEffect(() => {
    return () => {
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
    };
  }, []);

  return (
    <ScatterPlotContext.Provider
      value={{
        plot: plotRef.current,
        state,
        initializePlot,
        updateSize,
        updateColor,
        updateSearch,
        updatePointLimit,
      }}
    >
      {children}
    </ScatterPlotContext.Provider>
  );
}

export function useScatterPlot() {
  const context = useContext(ScatterPlotContext);
  if (!context) {
    throw new Error('useScatterPlot must be used within ScatterPlotProvider');
  }
  return context;
}
