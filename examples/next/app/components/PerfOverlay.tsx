'use client';

import { useEffect, useRef, useState } from 'react';
import { useScatterPlot } from '../context/ScatterPlotContext';
import type { FrameStats } from '@uoa-css-lab/duckscatter';

/**
 * フレーム計測オーバーレイ（Phase 0 計測基盤・dev 用）。
 * plot.setInstrumentation(true) を有効化し、getFrameStats() を 250ms 間隔でポーリングして表示する。
 * pan/zoom 中に compute=ran のフレームの gpu/cpu 時間と処理点数・fps を読み、タイル化前のベースラインを取る。
 */
export function PerfOverlay() {
  const { plot, state } = useScatterPlot();
  const [stats, setStats] = useState<FrameStats | null>(null);
  const enabledRef = useRef(false);

  useEffect(() => {
    if (!plot || !state.isInitialized) return;
    // 旧 duckscatter（計測 API なし）では何もしない
    if (
      typeof (plot as { setInstrumentation?: unknown }).setInstrumentation !== 'function' ||
      typeof (plot as { getFrameStats?: unknown }).getFrameStats !== 'function'
    ) {
      return;
    }
    plot.setInstrumentation(true);
    enabledRef.current = true;
    const id = setInterval(() => setStats(plot.getFrameStats()), 250);
    return () => {
      clearInterval(id);
      if (enabledRef.current) {
        plot.setInstrumentation(false);
        enabledRef.current = false;
      }
    };
  }, [plot, state.isInitialized]);

  if (!stats) return null;

  const pct =
    stats.totalPointCount > 0
      ? Math.round((stats.drawnCount / stats.totalPointCount) * 1000) / 10
      : 0;

  const Row = ({ k, v }: { k: string; v: string }) => (
    <div className="flex justify-between gap-4">
      <span className="text-gray-400">{k}</span>
      <span className="font-mono tabular-nums text-gray-100">{v}</span>
    </div>
  );

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-50 select-none rounded-lg bg-black/80 px-3 py-2 text-xs text-gray-100 shadow-lg backdrop-blur-sm">
      <div className="mb-1 font-semibold text-emerald-400">perf (Phase 0)</div>
      <Row k="fps" v={String(stats.fps)} />
      <Row k="compute" v={stats.computeRan ? 'ran' : 'skip'} />
      <Row k="processed" v={stats.processedCount.toLocaleString()} />
      <Row k="drawn" v={`${stats.drawnCount.toLocaleString()} (${pct}%)`} />
      <Row k="total" v={stats.totalPointCount.toLocaleString()} />
      <Row k="cpu enc" v={`${stats.cpuEncodeMs.toFixed(2)} ms`} />
      <Row k="gpu" v={`${stats.gpuTotalMs.toFixed(2)} ms`} />
      <Row k="zoom" v={stats.zoom.toFixed(2)} />
    </div>
  );
}
