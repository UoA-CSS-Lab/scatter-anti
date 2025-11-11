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

interface AdapterStatusProps {
  diagnostics: WebGPUDiagnostics | null;
}

export function AdapterStatus({ diagnostics }: AdapterStatusProps) {
  if (!diagnostics) {
    return (
      <div className="bg-zinc-950 p-5 border border-green-500 rounded">
        <h2 className="text-green-500 text-lg mb-3 mt-0">GPU Adapter Status</h2>
        <div className="text-green-500">Checking...</div>
      </div>
    );
  }

  return (
    <div className="bg-zinc-950 p-5 border border-green-500 rounded">
      <h2 className="text-green-500 text-lg mb-3 mt-0">GPU Adapter Status</h2>
      {diagnostics.adapter.available ? (
        <div>
          <div className="p-3 my-3 rounded bg-green-950 text-green-500 border border-green-500 font-bold">
            ✓ GPU Adapter successfully obtained
          </div>
          <p className="text-green-500 text-sm">
            WebGPU is fully functional on your system!
          </p>
        </div>
      ) : diagnostics.supported ? (
        <div>
          <div className="p-3 my-3 rounded bg-red-950 text-red-500 border border-red-500 font-bold">
            ✗ Failed to obtain GPU Adapter
          </div>
          <p className="text-red-500 text-sm mb-2">
            <strong>Error:</strong> {diagnostics.error || 'Unknown error'}
          </p>
          <p className="text-red-500 text-sm">Possible causes:</p>
          <ul className="text-red-500 text-sm list-disc pl-5">
            <li>GPU is blocklisted or unsupported</li>
            <li>WebGPU is disabled in browser flags</li>
            <li>GPU drivers are outdated</li>
            <li>Running in a virtual machine</li>
          </ul>
        </div>
      ) : (
        <div className="p-3 my-3 rounded bg-yellow-950 text-yellow-500 border border-yellow-500 font-bold">
          N/A - WebGPU API not available
        </div>
      )}
    </div>
  );
}
