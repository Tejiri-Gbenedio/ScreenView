"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** M3 collection lifecycle controls (accept / dismiss / rename / archive). */
export function CollectionActions({
  collectionId,
  state,
  allowRename = false,
}: {
  collectionId: string;
  state: string;
  allowRename?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/collections/${collectionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          json?.error === "name_taken"
            ? "That name is already used."
            : "Couldn't do that. Try again."
        );
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't do that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {state === "suggested" ? (
          <>
            <button
              onClick={() => act("accept")}
              disabled={busy}
              className="rounded-xl bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
            >
              Accept
            </button>
            <button
              onClick={() => act("dismiss")}
              disabled={busy}
              className="rounded-xl border border-neutral-300 px-3 py-2 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
            >
              Dismiss
            </button>
          </>
        ) : null}
        {state === "accepted" ? (
          <button
            onClick={() => act("archive")}
            disabled={busy}
            className="rounded-xl border border-neutral-300 px-3 py-2 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
          >
            Archive
          </button>
        ) : null}
      </div>
      {allowRename && state !== "dismissed" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) act("rename", { name: name.trim() });
          }}
          className="flex gap-2"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rename this collection…"
            className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-xs outline-none focus:border-neutral-900"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="shrink-0 rounded-xl border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 hover:border-neutral-500 disabled:opacity-40"
          >
            Save
          </button>
        </form>
      ) : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
