'use client';

import { ScatterPlotCanvas } from './components/ScatterPlotCanvas';
import { ControlPanel } from './components/ControlPanel';

export default function Home() {
  return (
    <div className="h-screen w-screen flex overflow-hidden">
      <ControlPanel />
      <main className="flex-1 relative">
        <ScatterPlotCanvas />
      </main>
    </div>
  );
}
