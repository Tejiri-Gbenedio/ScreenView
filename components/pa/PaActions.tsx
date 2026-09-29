"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const LABELS: Record<string, string> = {
  open: "Open",
  keep_active: "Keep active",
  snooze: "Snooze",
  complete: "Complete",
  dismiss: "Dismiss",
};

/** M4 PA item actions: Open / Keep active / Snooze / Complete / Dismiss. */
export function PaActions({
  reportId,
  itemId,
  actions,
  interaction,
  captureId,
  collectionId,
}: {
  reportId: string;
  itemId: string;
  actions: string[];
  interaction: { action: string; at: string } | null;
  captureId?: string | null;
  collectionId?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  if (interaction) {
    return (
      <p className="text-[11px] text-neutral-400">✓ {LABELS[interaction.action] ?? interaction.action}</p>
    );
  }

  async function post(action: string) {
    const res = await fetch("/api/pa/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportId, itemId, action }),
    });
    return res.ok;
  }

  async function onOpen() {
    const target = collectionId
      ? `/collections/${collectionId}`
      : captureId
        ? `/memories/${captureId}`
        : null;
    try {
      await post("open");
    } catch {
      /* navigation is the priority */
    }
    if (target) router.push(target);
    else router.refresh();
  }

  async function onAct(action: string) {
    setBusy(true);
    setError(false);
    try {
      const ok = await post(action);
      if (!ok) {
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
    <div className="flex flex-wrap items-center gap-2">
      {actions.includes("open") ? (
        <button
          onClick={onOpen}
          className="rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-neutral-700"
        >
          Open
        </button>
      ) : null}
      {actions
        .filter((a) => a !== "open")
        .map((action) => (
          <button
            key={action}
            onClick={() => onAct(action)}
            disabled={busy}
            className="rounded-lg border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
          >
            {LABELS[action] ?? action}
          </button>
        ))}
      {error ? <span className="text-[11px] text-red-600">Try again</span> : null}
    </div>
  );
}
