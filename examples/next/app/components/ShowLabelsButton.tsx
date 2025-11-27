'use client';

export function ShowLabelsButton() {
  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => console.log('Show All Labels clicked (placeholder)')}
        className="px-3 py-2 bg-zinc-300 hover:bg-zinc-400 rounded text-zinc-600 text-sm disabled:opacity-50"
        disabled
      >
        Show All Labels (Coming Soon)
      </button>
      <p className="text-zinc-500 text-xs">
        Label visibility feature is planned for a future release.
      </p>
    </div>
  );
}
