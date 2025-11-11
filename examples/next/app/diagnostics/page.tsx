'use client';

import { useEffect, useState } from 'react';
import { BrowserInfo } from './components/BrowserInfo';
import { ApiStatus } from './components/ApiStatus';
import { AdapterStatus } from './components/AdapterStatus';
import { AdapterFeatures } from './components/AdapterFeatures';
import { AdapterLimits } from './components/AdapterLimits';
import { TroubleshootingGuide } from './components/TroubleshootingGuide';

export default function DiagnosticsPage() {
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function runDiagnostics() {
      try {
        // Dynamic import to avoid SSR issues
        const { diagnoseWebGPU } = await import('../../../../dist/index.js');
        const result = await diagnoseWebGPU();
        console.log('=== WebGPU Diagnostics ===');
        console.log(result);
        setDiagnostics(result);
      } catch (err: any) {
        console.error('Diagnostics failed:', err);
        setError(err.message);
      }
    }

    runDiagnostics();
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-green-500 p-5 font-mono">
      <div className="max-w-4xl mx-auto">
        <div className="bg-black p-5 border-2 border-green-500 rounded-lg">
          <h1 className="text-green-500 text-center text-2xl mb-8">
            WebGPU Diagnostics Tool
          </h1>

          {error && (
            <div className="mb-5 p-5 bg-red-900/50 border-2 border-red-500 rounded">
              <h2 className="text-red-500 text-lg mb-2 mt-0">Fatal Error</h2>
              <pre className="text-red-400 text-sm whitespace-pre-wrap">{error}</pre>
            </div>
          )}

          <div className="space-y-5">
            <BrowserInfo />
            <ApiStatus diagnostics={diagnostics} />
            <AdapterStatus diagnostics={diagnostics} />
            <AdapterFeatures diagnostics={diagnostics} />
            <AdapterLimits diagnostics={diagnostics} />
            <TroubleshootingGuide />
          </div>
        </div>
      </div>
    </div>
  );
}
