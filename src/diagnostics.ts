/**
 * WebGPU diagnostics utility
 */
export interface WebGPUDiagnostics {
  supported: boolean;
  available: boolean;
  adapter: {
    available: boolean;
    features?: string[];
    limits?: Record<string, number>;
  };
  browser: string;
  error?: string;
}

/**
 * Run diagnostics to check WebGPU availability
 */
export async function diagnoseWebGPU(): Promise<WebGPUDiagnostics> {
  const result: WebGPUDiagnostics = {
    supported: false,
    available: false,
    adapter: {
      available: false,
    },
    browser: getBrowserInfo(),
  };

  // Check if WebGPU API exists
  if (!('gpu' in navigator)) {
    result.error = 'WebGPU API not found in navigator';
    return result;
  }

  result.supported = true;

  // Try to get adapter
  try {
    const adapter = await navigator.gpu.requestAdapter();

    if (!adapter) {
      result.error = 'GPU adapter is null - GPU may be blocklisted or WebGPU is disabled';
      return result;
    }

    result.adapter.available = true;
    result.adapter.features = Array.from(adapter.features);
    result.adapter.limits = {};

    // Collect some key limits
    const limitsToCheck = [
      'maxTextureDimension1D',
      'maxTextureDimension2D',
      'maxBufferSize',
      'maxVertexBuffers',
      'maxVertexAttributes',
    ];

    for (const limit of limitsToCheck) {
      if (limit in adapter.limits) {
        result.adapter.limits[limit] = (adapter.limits as any)[limit];
      }
    }

    result.available = true;
  } catch (e) {
    result.error = `Error requesting adapter: ${e}`;
    return result;
  }

  return result;
}

/**
 * Get browser information
 */
function getBrowserInfo(): string {
  const ua = navigator.userAgent;

  if (ua.includes('Chrome') && !ua.includes('Edg')) {
    const match = ua.match(/Chrome\/(\d+)/);
    return match ? `Chrome ${match[1]}` : 'Chrome (unknown version)';
  }

  if (ua.includes('Edg')) {
    const match = ua.match(/Edg\/(\d+)/);
    return match ? `Edge ${match[1]}` : 'Edge (unknown version)';
  }

  if (ua.includes('Safari') && !ua.includes('Chrome')) {
    const match = ua.match(/Version\/(\d+)/);
    return match ? `Safari ${match[1]}` : 'Safari (unknown version)';
  }

  if (ua.includes('Firefox')) {
    const match = ua.match(/Firefox\/(\d+)/);
    return match ? `Firefox ${match[1]}` : 'Firefox (unknown version)';
  }

  return 'Unknown browser';
}

/**
 * Print diagnostics to console
 */
export async function printDiagnostics(): Promise<void> {
  console.log('=== WebGPU Diagnostics ===');

  const diagnostics = await diagnoseWebGPU();

  console.log(`Browser: ${diagnostics.browser}`);
  console.log(`WebGPU API Supported: ${diagnostics.supported ? '✓' : '✗'}`);
  console.log(`WebGPU Available: ${diagnostics.available ? '✓' : '✗'}`);
  console.log(`GPU Adapter Available: ${diagnostics.adapter.available ? '✓' : '✗'}`);

  if (diagnostics.error) {
    console.error(`Error: ${diagnostics.error}`);
  }

  if (diagnostics.adapter.features) {
    console.log(`Adapter Features: ${diagnostics.adapter.features.join(', ') || 'none'}`);
  }

  if (diagnostics.adapter.limits) {
    console.log('Adapter Limits:', diagnostics.adapter.limits);
  }

  if (!diagnostics.available) {
    console.log('\nTroubleshooting:');
    console.log('1. Check chrome://gpu (Chrome/Edge) for WebGPU status');
    console.log('2. Update your GPU drivers');
    console.log('3. Ensure WebGPU is enabled in browser flags');
    console.log('4. Try a different browser (Chrome 113+, Edge 113+, Safari 18+)');
  }

  console.log('========================');
}
