'use client';

import { useState } from 'react';

interface LabelInfo {
  text: string;
  cluster: string;
  count: string;
}

export function LabelInfoPanel() {
  const [labelInfo, setLabelInfo] = useState<LabelInfo | null>(null);

  // This will be called from the label onClick callback
  // We'll expose this via a ref or context if needed
  if (!labelInfo) return null;

  return (
    <div className="fixed top-20 left-5 max-w-xs bg-zinc-800/95 backdrop-blur-md px-4 py-3 rounded-lg z-[100] shadow-xl">
      <div className="text-white text-sm space-y-1">
        <div>
          <strong>Selected Label:</strong> {labelInfo.text}
        </div>
        <div>
          <strong>Cluster:</strong> {labelInfo.cluster}
        </div>
        <div>
          <strong>Count:</strong> {labelInfo.count}
        </div>
      </div>
    </div>
  );
}
