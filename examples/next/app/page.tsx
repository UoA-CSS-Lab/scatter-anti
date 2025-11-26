'use client';

import { useState, useRef, useEffect } from 'react';
import { ScatterPlotProvider } from './context/ScatterPlotContext';
import { useScatterPlotInit } from './demo/hooks/useScatterPlotInit';
import { useInteractions } from './demo/hooks/useInteractions';
import { ScatterCanvas } from './demo/components/ScatterCanvas';
import { StatusPanel } from './demo/components/StatusPanel';
import { LabelInfoPanel } from './demo/components/LabelInfoPanel';
import { PointTooltip } from './demo/components/PointTooltip';
import { ViewControls } from './demo/components/ViewControls';
import { PointControls } from './demo/components/PointControls';
import { HoverOutlineControls } from './demo/components/HoverOutlineControls';
import { LabelControls } from './demo/components/LabelControls';
import { ErrorDisplay } from './demo/components/ErrorDisplay';
import { getPointSizeLambda } from './demo/utils/sizeStrategies';
import { getPointColorLambda } from './demo/utils/colorSchemes';

function DemoContent() {
  const [pointHover, setPointHover] = useState<{
    row: any[];
    columns: string[];
  } | null>(null);
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [selectedLabel, setSelectedLabel] = useState<any>(null);
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
      idColumn: 'tid',
    },
    labels: {
      url: '/caGW6XbYcH7HBWRdNlHk.geojson',
      filterLambda: (properties: any) => {
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

export default function Home() {
  return (
    <ScatterPlotProvider>
      <div className="relative w-full h-screen overflow-hidden bg-zinc-950">
        <DemoContent />
      </div>
    </ScatterPlotProvider>
  );
}
