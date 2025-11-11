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

interface ApiStatusProps {
  diagnostics: WebGPUDiagnostics | null;
}

export function ApiStatus({ diagnostics }: ApiStatusProps) {
  if (!diagnostics) {
    return (
      <div className="bg-zinc-950 p-5 border border-green-500 rounded">
        <h2 className="text-green-500 text-lg mb-3 mt-0">WebGPU API Status</h2>
        <div className="text-green-500">Checking...</div>
      </div>
    );
  }

  return (
    <div className="bg-zinc-950 p-5 border border-green-500 rounded">
      <h2 className="text-green-500 text-lg mb-3 mt-0">WebGPU API Status</h2>
      {diagnostics.supported ? (
        <div>
          <div className="p-3 my-3 rounded bg-green-950 text-green-500 border border-green-500 font-bold">
            ✓ WebGPU API is available in navigator
          </div>
          <p className="text-green-500 text-sm">
            Browser: <strong>{diagnostics.browser}</strong>
          </p>
        </div>
      ) : (
        <div>
          <div className="p-3 my-3 rounded bg-red-950 text-red-500 border border-red-500 font-bold">
            ✗ WebGPU API is NOT available
          </div>
          <p className="text-red-500 text-sm">
            Browser: <strong>{diagnostics.browser}</strong>
          </p>
          <p className="text-red-500 text-sm">
            Your browser does not support WebGPU. Please upgrade or switch browsers.
          </p>
        </div>
      )}
    </div>
  );
}
