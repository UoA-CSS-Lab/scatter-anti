export function TroubleshootingGuide() {
  return (
    <div className="mt-5 p-5 bg-cyan-950/30 border border-cyan-600 rounded">
      <h3 className="text-cyan-500 text-lg mb-3 mt-0">Troubleshooting Guide</h3>
      <ul className="text-cyan-500 text-sm space-y-2 list-disc pl-5">
        <li>
          <strong>Chrome/Edge:</strong> Visit <code className="bg-black px-1">chrome://gpu</code> to
          check WebGPU status
        </li>
        <li>
          <strong>Chrome/Edge:</strong> Ensure you're using version 113 or higher
        </li>
        <li>
          <strong>Safari:</strong> Requires macOS Sonoma 14.4+ and Safari 18+
        </li>
        <li>
          <strong>Firefox:</strong> WebGPU is behind a flag - visit{' '}
          <code className="bg-black px-1">about:config</code> and enable{' '}
          <code className="bg-black px-1">dom.webgpu.enabled</code>
        </li>
        <li>
          <strong>GPU Drivers:</strong> Update to the latest GPU drivers from your manufacturer
        </li>
        <li>
          <strong>Virtual Machines:</strong> WebGPU may not work in VMs without GPU passthrough
        </li>
        <li>
          <strong>Linux:</strong> Some configurations may require additional setup
        </li>
      </ul>
      <p className="mt-4 text-cyan-400 text-sm">
        For more information, visit:{' '}
        <a
          href="https://developer.chrome.com/blog/webgpu-release/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 underline"
        >
          WebGPU Chrome Blog
        </a>{' '}
        |{' '}
        <a
          href="https://caniuse.com/webgpu"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 underline"
        >
          Can I Use WebGPU?
        </a>
      </p>
    </div>
  );
}
