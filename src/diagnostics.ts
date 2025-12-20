/**
 * WebGPU診断結果のインターフェース
 */
export interface WebGPUDiagnostics {
  /** WebGPU APIがサポートされているか */
  supported: boolean;
  /** WebGPUが利用可能か */
  available: boolean;
  /** GPUアダプター情報 */
  adapter: {
    /** アダプターが利用可能か */
    available: boolean;
    /** サポートされている機能の配列 */
    features?: string[];
    /** GPUの制限値 */
    limits?: Record<string, number>;
  };
  /** ブラウザ情報 */
  browser: string;
  /** エラーメッセージ（ある場合） */
  error?: string;
}

/**
 * WebGPUの利用可能性を診断する
 * @returns 診断結果のWebGPUDiagnosticsオブジェクト
 */
export async function diagnoseWebGPU(): Promise<WebGPUDiagnostics> {
  // 結果オブジェクトを初期化
  const result: WebGPUDiagnostics = {
    supported: false,
    available: false,
    adapter: {
      available: false,
    },
    browser: getBrowserInfo(),
  };

  // navigatorにWebGPU APIが存在するかチェック
  if (!('gpu' in navigator)) {
    result.error = 'WebGPU API not found in navigator';
    return result;
  }

  // WebGPU APIはサポートされている
  result.supported = true;

  // GPUアダプターの取得を試みる
  try {
    const adapter = await navigator.gpu.requestAdapter();

    // アダプターがnullの場合はエラー
    if (!adapter) {
      result.error = 'GPU adapter is null - GPU may be blocklisted or WebGPU is disabled';
      return result;
    }

    // アダプター情報を収集
    result.adapter.available = true;
    // サポートされている機能を配列に変換
    result.adapter.features = Array.from(adapter.features);
    result.adapter.limits = {};

    // 主要な制限値を収集
    const limitsToCheck = [
      'maxTextureDimension1D',
      'maxTextureDimension2D',
      'maxBufferSize',
      'maxVertexBuffers',
      'maxVertexAttributes',
    ];

    // 各制限値をチェックして結果に追加
    for (const limit of limitsToCheck) {
      if (limit in adapter.limits) {
        result.adapter.limits[limit] = (adapter.limits as any)[limit];
      }
    }

    // すべて成功
    result.available = true;
  } catch (e) {
    result.error = `Error requesting adapter: ${e}`;
    return result;
  }

  return result;
}

/**
 * ブラウザ情報を取得する
 * @returns ブラウザ名とバージョンの文字列
 */
function getBrowserInfo(): string {
  const ua = navigator.userAgent;

  // Chrome（Edgeを除く）をチェック
  if (ua.includes('Chrome') && !ua.includes('Edg')) {
    const match = ua.match(/Chrome\/(\d+)/);
    return match ? `Chrome ${match[1]}` : 'Chrome (unknown version)';
  }

  // Edgeをチェック
  if (ua.includes('Edg')) {
    const match = ua.match(/Edg\/(\d+)/);
    return match ? `Edge ${match[1]}` : 'Edge (unknown version)';
  }

  // Safari（Chromeを除く）をチェック
  if (ua.includes('Safari') && !ua.includes('Chrome')) {
    const match = ua.match(/Version\/(\d+)/);
    return match ? `Safari ${match[1]}` : 'Safari (unknown version)';
  }

  // Firefoxをチェック
  if (ua.includes('Firefox')) {
    const match = ua.match(/Firefox\/(\d+)/);
    return match ? `Firefox ${match[1]}` : 'Firefox (unknown version)';
  }

  return 'Unknown browser';
}
