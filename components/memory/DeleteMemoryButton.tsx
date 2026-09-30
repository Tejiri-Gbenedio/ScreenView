"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Delete a capture (screenshot + memory + derived rows). Two-step confirm. */
export function DeleteMemoryButton({ captureId }: { captureId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function onDelete() {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/captures/${captureId}`, { method: "DELETE" });
      if (!res.ok) {
        setError(true);
        return;
      }
      router.push("/memories");
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="text-xs text-neutral-400 underline-offset-2 hover:text-red-600 hover:underline"
      >
        Delete this screenshot
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
      <p className="text-sm text-red-800">
        Delete this screenshot and its memory? This can&apos;t be undone.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={onDelete}
          disabled={busy}
          className="rounded-xl bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
        >
          {busy ? "Deleting…" : "Yes, delete"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="rounded-xl border border-neutral-300 px-3 py-2 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
        >
          Cancel
        </button>
        {error ? <span className="text-xs text-red-600">Couldn&apos;t delete — try again.</span> : null}
      </div>
    </div>
  );
}
