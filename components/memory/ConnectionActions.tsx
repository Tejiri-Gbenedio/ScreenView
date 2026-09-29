"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** M3 connection decision buttons (suggested connections only). */
export function ConnectionActions({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function act(action: "confirm" | "dismiss") {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/connections/${connectionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        setError(true);
        return;
      }
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => act("confirm")}
        disabled={busy}
        className="rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
      >
        Confirm
      </button>
      <button
        onClick={() => act("dismiss")}
        disabled={busy}
        className="rounded-lg border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-500 hover:border-neutral-500 disabled:opacity-40"
      >
        Dismiss
      </button>
      {error ? <span className="text-[11px] text-red-600">Try again</span> : null}
    </div>
  );
}
