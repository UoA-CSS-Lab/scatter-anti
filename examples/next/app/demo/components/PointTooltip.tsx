'use client';

import { useState, useEffect } from 'react';

interface TooltipData {
  x: string;
  y: string;
  color: string;
  screenX: number;
  screenY: number;
}

export function PointTooltip() {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  // This will be managed by the parent component or context
  // For now, we'll just render if data is available
  if (!tooltip) return null;

  return (
    <div
      className="fixed bg-zinc-800/95 backdrop-blur-md px-4 py-2.5 rounded z-[101] text-xs pointer-events-none border-2 border-blue-500"
      style={{
        left: tooltip.screenX + 15,
        top: tooltip.screenY + 15,
      }}
    >
      <div className="text-white font-semibold mb-1">Point Hovered</div>
      <div className="text-white space-y-0.5">
        <div>
          <strong>X:</strong> {tooltip.x}
        </div>
        <div>
          <strong>Y:</strong> {tooltip.y}
        </div>
        <div>
          <strong>Color:</strong> {tooltip.color}
        </div>
      </div>
    </div>
  );
}
