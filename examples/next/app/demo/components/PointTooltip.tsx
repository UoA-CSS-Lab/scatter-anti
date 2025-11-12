'use client';

import { useMemo } from 'react';

interface PointTooltipProps {
  data: {
    row: any[];
    columns: string[];
  };
  mousePosition: {
    x: number;
    y: number;
  };
}

export function PointTooltip({ data, mousePosition }: PointTooltipProps) {
  // Convert row array to object for better JSON display
  const pointData = useMemo(() => {
    const obj: Record<string, any> = {};
    data.columns.forEach((col, idx) => {
      obj[col] = data.row[idx];
    });
    return obj;
  }, [data]);

  // Custom JSON stringifier that handles BigInt
  const jsonString = useMemo(() => {
    return JSON.stringify(pointData, (key, value) => {
      // Convert BigInt to string with "n" suffix to indicate it's a BigInt
      if (typeof value === 'bigint') {
        return value.toString() + 'n';
      }
      return value;
    }, 2);
  }, [pointData]);

  return (
    <div
      className="fixed bg-zinc-900/95 backdrop-blur-md px-4 py-3 rounded-lg z-[101] text-xs pointer-events-none border border-blue-500/50 shadow-xl max-w-md"
      style={{
        left: mousePosition.x + 15,
        top: mousePosition.y + 15,
      }}
    >
      <div className="text-blue-400 font-semibold mb-2 text-sm">Point Data</div>
      <pre className="text-gray-300 font-mono text-xs overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
        {jsonString}
      </pre>
    </div>
  );
}
