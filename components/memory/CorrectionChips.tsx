"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ACTION_LABELS,
  ACTION_OPTIONS,
  INTENT_HINTS,
  INTENT_LABELS,
  INTENT_OPTIONS,
  STATUS_LABELS,
  STATUS_OPTIONS,
} from "@/lib/labels";

type Field = "intent" | "topic" | "action" | "status";

export function CorrectionChips({
  memoryId,
  intent,
  topic,
  action,
  status,
}: {
  memoryId: string;
  intent: string | null;
  topic: string | null;
  action: string | null;
  status: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Field | null>(null);
  const [topicDraft, setTopicDraft] = useState(topic ?? "");
  const [saving, setSaving] = useState(false);

  async function apply(field: Field, value: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/memories/${memoryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, value }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        window.alert(payload?.message ?? "Couldn't save that — try again.");
      }
      setOpen(null);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const chipClass =
    "rounded-full border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:border-neutral-900";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button className={chipClass} onClick={() => setOpen("topic")}>
        About: {topic ?? "add topic"}
      </button>
      <button
        className="rounded-full bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700"
        onClick={() => setOpen("intent")}
      >
        Why: {INTENT_LABELS[intent ?? "unknown"] ?? intent ?? "Not sure yet"}
      </button>
      <button className={chipClass} onClick={() => setOpen("action")}>
        Next: {ACTION_LABELS[action ?? "none"] ?? action ?? "—"}
      </button>
      <button className={chipClass} onClick={() => setOpen("status")}>
        Status: {STATUS_LABELS[status] ?? status}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-neutral-900/30 p-4 sm:items-center">
          <div className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-2xl">
            <p className="text-sm font-medium">
              {open === "intent" && "Why did you save this?"}
              {open === "topic" && "What is this about?"}
              {open === "action" && "What's the next step?"}
              {open === "status" && "Where does this stand?"}
            </p>

            {open === "topic" ? (
              <div className="mt-3 space-y-3">
                <input
                  value={topicDraft}
                  onChange={(e) => setTopicDraft(e.target.value)}
                  placeholder="e.g. Fragrance"
                  className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
                />
                <button
                  disabled={saving || topicDraft.trim().length === 0}
                  onClick={() => apply("topic", topicDraft.trim())}
                  className="w-full rounded-xl bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            ) : (
              <ul className="mt-3 max-h-72 space-y-1 overflow-auto">
                {(open === "intent" ? INTENT_OPTIONS : open === "action" ? ACTION_OPTIONS : STATUS_OPTIONS).map(
                  (value) => {
                    const label =
                      open === "intent"
                        ? INTENT_LABELS[value]
                        : open === "action"
                          ? ACTION_LABELS[value]
                          : STATUS_LABELS[value];
                    const hint = open === "intent" ? INTENT_HINTS[value] : undefined;
                    return (
                      <li key={value}>
                        <button
                          disabled={saving}
                          onClick={() => apply(open, value)}
                          className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-neutral-100 disabled:opacity-40"
                        >
                          <span className="font-medium">{label}</span>
                          {hint ? <span className="block text-xs text-neutral-500">{hint}</span> : null}
                        </button>
                      </li>
                    );
                  }
                )}
              </ul>
            )}

            <button
              onClick={() => setOpen(null)}
              disabled={saving}
              className="mt-2 w-full rounded-xl px-3 py-2 text-sm text-neutral-500 hover:text-neutral-800"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
