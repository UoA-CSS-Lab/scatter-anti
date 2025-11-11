export function BrowserInfo() {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown';

  return (
    <div className="bg-zinc-950 p-5 border border-green-500 rounded">
      <h2 className="text-green-500 text-lg mb-3 mt-0">Browser Information</h2>
      <pre className="bg-black p-3 border-l-4 border-green-600 overflow-x-auto whitespace-pre-wrap text-green-500 text-sm">
        {userAgent}
      </pre>
    </div>
  );
}
