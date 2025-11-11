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

interface AdapterLimitsProps {
  diagnostics: WebGPUDiagnostics | null;
}

export function AdapterLimits({ diagnostics }: AdapterLimitsProps) {
  const limits = diagnostics?.adapter.limits;

  return (
    <div className="bg-zinc-950 p-5 border border-green-500 rounded">
      <h2 className="text-green-500 text-lg mb-3 mt-0">Adapter Limits</h2>
      {limits ? (
        <pre className="bg-black p-3 border-l-4 border-green-600 overflow-x-auto whitespace-pre-wrap text-green-500 text-sm">
          {JSON.stringify(limits, null, 2)}
        </pre>
      ) : (
        <p className="text-green-500 text-sm">
          No limits available or adapter not obtained
        </p>
      )}
    </div>
  );
}
