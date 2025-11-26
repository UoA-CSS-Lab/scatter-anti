'use client';

import { useState, useRef, useEffect } from 'react';
import { ScatterPlotProvider } from '../context/ScatterPlotContext';
import { useScatterPlotInit } from './hooks/useScatterPlotInit';
import { useInteractions } from './hooks/useInteractions';
import { ScatterCanvas } from './components/ScatterCanvas';
import { StatusPanel } from './components/StatusPanel';
import { LabelInfoPanel } from './components/LabelInfoPanel';
import { PointTooltip } from './components/PointTooltip';
import { ViewControls } from './components/ViewControls';
import { PointControls } from './components/PointControls';
import { HoverOutlineControls } from './components/HoverOutlineControls';
import { LabelControls } from './components/LabelControls';
import { ErrorDisplay } from './components/ErrorDisplay';
import { getPointSizeLambda } from './utils/sizeStrategies';
import { getPointColorLambda } from './utils/colorSchemes';
import type { Label } from '../../../../src/types';

function DemoContent() {
  const [pointHover, setPointHover] = useState<{
    row: any[];
    columns: string[];
  } | null>(null);
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
  const selectedLabelTextRef = useRef<string | null>(null);

  // Track mouse position for tooltip
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  // Initialize ScatterPlot
  useScatterPlotInit({
    dataUrl: '/caGW6XbYcH7HBWRdNlHk.parquet',
    gpu: {
      backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
    },
    data: {
      visiblePointLimit: 100000,
      pointSizeLambda: getPointSizeLambda('data'),
      pointColorLambda: getPointColorLambda('data', null),
    },
    labels: {
      url: '/caGW6XbYcH7HBWRdNlHk.geojson',
      filterLambda: (properties) => {
        if (selectedLabelTextRef.current === null) {
          return true;
        }
        return properties.cluster_label === selectedLabelTextRef.current;
      },
      onClick: (label) => {
        console.log('Label clicked:', label);
        selectedLabelTextRef.current = label.text;
        setSelectedLabel(label);
      },
      hoverOutlineOptions: {
        enabled: true,
        color: 'white',
        width: 2,
      },
    },
    interaction: {
      onPointHover: (data) => {
        setPointHover(data);
      },
    },
  });

  // Setup interactions (drag, wheel, etc.)
  useInteractions();

  return (
    <>
      <ScatterCanvas />
      <StatusPanel />
      {selectedLabel && <LabelInfoPanel />}
      {pointHover && <PointTooltip data={pointHover} mousePosition={mousePosition} />}
      <ViewControls />
      <PointControls />
      <HoverOutlineControls />
      <LabelControls />
      <ErrorDisplay />
    </>
  );
}

export default function DemoPage() {
  return (
    <ScatterPlotProvider>
      <div className="relative w-full h-screen overflow-hidden bg-zinc-950">
        <DemoContent />
      </div>
    </ScatterPlotProvider>
  );
}
