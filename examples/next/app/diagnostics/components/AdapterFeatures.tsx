// WebGPUDiagnostics type imported from diagnostics
interface WebGPUDiagnostics {
  supported: boolean;
  browser: string;
  adapter: {
    available: boolean;
    features: string[];
    limits: Record<string, any> | null;
  };
  error?: string;
}

interface AdapterFeaturesProps {
  diagnostics: WebGPUDiagnostics | null;
}

export function AdapterFeatures({ diagnostics }: AdapterFeaturesProps) {
  const features = diagnostics?.adapter.features;

  return (
    <div className="bg-zinc-950 p-5 border border-green-500 rounded">
      <h2 className="text-green-500 text-lg mb-3 mt-0">Adapter Features</h2>
      {features && features.length > 0 ? (
        <div>
          <pre className="bg-black p-3 border-l-4 border-green-600 overflow-x-auto whitespace-pre-wrap text-green-500 text-sm">
            {features.join('\n')}
          </pre>
          <p className="text-green-500 text-xs mt-2">Total: {features.length} feature(s)</p>
        </div>
      ) : (
        <p className="text-green-500 text-sm">No features available or adapter not obtained</p>
      )}
    </div>
  );
}
