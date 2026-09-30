"use client";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center">
      <p className="text-sm text-neutral-600">Something went wrong loading this screen.</p>
      <button
        onClick={reset}
        className="mt-4 rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
      >
        Try again
      </button>
    </div>
  );
}
