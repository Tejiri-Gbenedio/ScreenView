"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { INTENT_LABELS, relativeTime } from "@/lib/labels";

export type ListItem = {
  captureId: string;
  memoryId: string | null;
  signedUrl: string | null;
  note: string | null;
  status: string; // capture processing_status
  memoryStatus: string | null;
  title: string | null;
  topic: string | null;
  intent: string | null;
  createdAt: string;
  lastError: string | null;
};

type TrayItem = {
  key: string;
  file: File;
  previewUrl: string;
  state: "pending" | "uploading" | "done" | "failed";
  error?: string;
};

const TRANSIENT = ["upload_pending", "uploaded", "processing", "retrying"];
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 20 * 1024 * 1024;

export function MemoriesClient({ items }: { items: ListItem[] }) {
  const router = useRouter();
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeCount = items.filter((i) => TRANSIENT.includes(i.status)).length;

  useEffect(() => {
    if (activeCount === 0) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [activeCount, router]);

  useEffect(() => {
    const onDragover = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragleave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) addFiles(Array.from(e.dataTransfer.files));
    };
    window.addEventListener("dragover", onDragover);
    window.addEventListener("dragleave", onDragleave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragover);
      window.removeEventListener("dragleave", onDragleave);
      window.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(files: File[]) {
    const accepted: TrayItem[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (!ALLOWED.includes(file.type)) {
        rejected.push(`${file.name || "file"}: unsupported type`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        rejected.push(`${file.name}: over 20MB`);
        continue;
      }
      accepted.push({
        key: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        state: "pending",
      });
    }
    if (rejected.length) setNotice(rejected.join(" · "));
    if (accepted.length) setTray((prev) => [...prev, ...accepted]);
  }

  async function sha256HexFile(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function uploadOne(file: File, noteValue: string | null) {
    const initRes = await fetch("/api/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_name: file.name || "screenshot.png",
        mime_type: file.type,
        size: file.size,
        note: noteValue,
      }),
    });
    const init = await initRes.json();
    if (!initRes.ok) throw new Error(init?.message ?? init?.error ?? "Upload failed");

    const supabase = createClient();
    const { error: uploadError } = await supabase.storage
      .from("captures")
      .uploadToSignedUrl(init.path, init.upload.token, file);
    if (uploadError) throw new Error(uploadError.message);

    const hash = await sha256HexFile(file);
    const doneRes = await fetch(`/api/captures/${init.capture_id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_hash: hash }),
    });
    const done = await doneRes.json();
    if (!doneRes.ok) throw new Error(done?.message ?? "Finishing the upload failed");
  }

  async function saveAll() {
    setBusy(true);
    const noteValue = note.trim() ? note.trim() : null;
    for (const item of tray) {
      if (item.state !== "pending") continue;
      setTray((prev) => prev.map((t) => (t.key === item.key ? { ...t, state: "uploading" } : t)));
      try {
        await uploadOne(item.file, noteValue);
        setTray((prev) => prev.map((t) => (t.key === item.key ? { ...t, state: "done" } : t)));
      } catch (error) {
        setTray((prev) =>
          prev.map((t) =>
            t.key === item.key ? { ...t, state: "failed", error: (error as Error).message } : t
          )
        );
      }
    }
    setBusy(false);
    setNote("");
    setTray((prev) => prev.filter((t) => t.state === "failed"));
    router.refresh();
  }

  async function retryTrayItem(item: TrayItem) {
    setTray((prev) => prev.map((t) => (t.key === item.key ? { ...t, state: "uploading" } : t)));
    try {
      await uploadOne(item.file, null);
      setTray((prev) => prev.filter((t) => t.key !== item.key));
      router.refresh();
    } catch (error) {
      setTray((prev) =>
        prev.map((t) =>
          t.key === item.key ? { ...t, state: "failed", error: (error as Error).message } : t
        )
      );
    }
  }

  async function retryCapture(captureId: string) {
    await fetch(`/api/captures/${captureId}/retry`, { method: "POST" });
    router.refresh();
  }

  const pendingCount = tray.filter((t) => t.state === "pending").length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Memories</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Screenshot something you don&apos;t want to forget.
          </p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Add screenshots
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      {notice ? (
        <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="ml-3 shrink-0">
            ✕
          </button>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <p className="text-sm text-neutral-500">Nothing saved yet.</p>
          <p className="mt-1 text-xs text-neutral-400">
            Drop a screenshot here, paste one, or use the button above — then open the live site and try it.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.captureId}>
              <MemoryCard item={item} onRetry={retryCapture} />
            </li>
          ))}
        </ul>
      )}

      {dragOver ? (
        <div className="pointer-events-none fixed inset-0 z-30 m-4 rounded-2xl border-4 border-dashed border-neutral-400 bg-neutral-900/5">
          <p className="mt-10 text-center text-sm font-medium text-neutral-700">Drop screenshots to add them</p>
        </div>
      ) : null}

      {tray.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-40">
          <div className="mx-auto max-w-2xl rounded-t-2xl border border-b-0 border-neutral-200 bg-white p-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                New capture{tray.length > 1 ? "s" : ""}
              </p>
              <button
                onClick={() => setTray(tray.filter((t) => t.state === "failed"))}
                disabled={busy}
                className="text-neutral-400 hover:text-neutral-700 disabled:opacity-40"
              >
                ✕
              </button>
            </div>
            <ul className="mt-3 max-h-56 space-y-2 overflow-auto">
              {tray.map((t) => (
                <li key={t.key} className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.previewUrl} alt="" className="h-12 w-12 rounded-lg bg-neutral-100 object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{t.file.name || "screenshot"}</p>
                    <p className="text-[11px] text-neutral-500">
                      {t.state === "pending" && "Ready to save"}
                      {t.state === "uploading" && "Uploading…"}
                      {t.state === "done" && "Saved"}
                      {t.state === "failed" && `Failed — ${t.error ?? "try again"}`}
                    </p>
                  </div>
                  {t.state === "failed" ? (
                    <button onClick={() => retryTrayItem(t)} className="text-xs underline">
                      Retry
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Add a note (optional) — why are you saving this?"
              className="mt-3 w-full resize-none rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                onClick={() => setTray(tray.filter((t) => t.state === "failed"))}
                disabled={busy}
                className="rounded-xl px-3 py-2 text-sm text-neutral-500 hover:text-neutral-800 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={saveAll}
                disabled={busy || pendingCount === 0}
                className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
              >
                {busy ? "Saving…" : pendingCount > 1 ? `Save ${pendingCount} captures` : "Save capture"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MemoryCard({ item, onRetry }: { item: ListItem; onRetry: (captureId: string) => void }) {
  const thumbnail = (
    <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-neutral-100">
      {item.signedUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.signedUrl} alt="" className="h-full w-full object-cover" />
      ) : null}
    </div>
  );

  const body = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium">
          {item.title ?? (item.note ? item.note : "Screenshot")}
        </p>
        <span className="shrink-0 text-[11px] text-neutral-400">{relativeTime(item.createdAt)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {item.status === "completed" && item.intent ? (
          <span className="rounded-full bg-neutral-900 px-2.5 py-0.5 text-[11px] font-medium text-white">
            {INTENT_LABELS[item.intent] ?? item.intent}
          </span>
        ) : null}
        {item.status === "completed" && item.topic ? (
          <span className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-[11px] text-neutral-600">
            {item.topic}
          </span>
        ) : null}
        {TRANSIENT.includes(item.status) ? (
          <span className="text-[11px] text-neutral-500">
            {item.status === "processing" || item.status === "retrying" ? "Understanding…" : "Queued…"}
          </span>
        ) : null}
        {item.status === "failed" ? (
          <span className="text-[11px] text-red-600">
            Couldn&apos;t finish understanding this. Your screenshot is safe.
          </span>
        ) : null}
      </div>
    </div>
  );

  if (item.status === "completed" && item.memoryId) {
    return (
      <Link href={`/memories/${item.captureId}`} className="flex gap-3 rounded-2xl border border-neutral-200 bg-white p-3 hover:border-neutral-400">
        {thumbnail}
        {body}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-3">
      {thumbnail}
      {body}
      {item.status === "failed" ? (
        <button onClick={() => onRetry(item.captureId)} className="shrink-0 text-xs underline">
          Retry
        </button>
      ) : null}
    </div>
  );
}
