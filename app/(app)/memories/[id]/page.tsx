import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signedUrlMap } from "@/server/services/storage";
import { CorrectionChips } from "@/components/memory/CorrectionChips";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ConnectionActions } from "@/components/memory/ConnectionActions";
import { DeleteMemoryButton } from "@/components/memory/DeleteMemoryButton";
import { listConnectionsForMemory } from "@/server/services/connections";
import { collectionsForMemory } from "@/server/services/collections";
import { RELATIONSHIP_LABELS, relativeTime } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function MemoryDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: capture } = await supabase
    .from("captures")
    .select("*")
    .eq("id", params.id)
    .single();
  if (!capture) notFound();

  const { data: memory } = await supabase
    .from("memories")
    .select("*")
    .eq("capture_id", params.id)
    .maybeSingle();

  const { data: events } = memory
    ? await supabase
        .from("memory_events")
        .select("id, event_type, old_value, new_value, actor, reason, created_at")
        .eq("memory_id", memory.id)
        .order("created_at", { ascending: true })
    : { data: [] as never[] };

  const urls = await signedUrlMap([capture.storage_path], 3600);

  const connections = memory ? await listConnectionsForMemory(memory.id) : [];
  const collectionChips = memory ? await collectionsForMemory(memory.id) : [];

  return (
    <div className="space-y-8 pb-16">
      <AutoRefresh active={!memory} />
      <div>
        <Link href="/memories" className="text-xs text-neutral-500 hover:text-neutral-800">
          ← Memories
        </Link>
      </div>

      <section className="space-y-3">
        <h1 className="text-lg font-semibold tracking-tight">
          {memory?.title ?? "Processing…"}
        </h1>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={urls[capture.storage_path]}
          alt=""
          className="w-full rounded-2xl border border-neutral-200 bg-white"
        />
        <div className="rounded-2xl border border-neutral-200 bg-white p-4">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">You said</p>
          <p className="mt-1 text-sm">
            {capture.original_note ? (
              `“${capture.original_note}”`
            ) : (
              <span className="text-neutral-400">No note</span>
            )}
          </p>
          <p className="mt-2 text-xs text-neutral-400">{relativeTime(capture.created_at)}</p>
        </div>
      </section>

      {memory ? (
        <section className="space-y-3">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">ScreenView thinks</p>
          <div className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-4">
            <p className="text-sm">{memory.summary}</p>
            <CorrectionChips
              memoryId={memory.id}
              intent={memory.current_intent}
              topic={memory.topic}
              action={memory.suggested_action}
              status={memory.status}
            />
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-500">
          {capture.processing_status === "failed"
            ? "Couldn't finish understanding this. Your screenshot and note are safe."
            : "Understanding…"}
        </section>
      )}

      {connections.length > 0 ? (
        <section className="space-y-3">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">Related memories</p>
          <ul className="space-y-2">
            {connections.map((connection) => (
              <li
                key={connection.connectionId}
                className="rounded-2xl border border-neutral-200 bg-white p-3"
              >
                <div className="flex gap-3">
                  <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-neutral-100">
                    {connection.partnerSignedUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={connection.partnerSignedUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/memories/${connection.partnerCaptureId}`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {connection.partnerTitle ?? "Screenshot"}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-neutral-500">
                      {RELATIONSHIP_LABELS[connection.relationshipType] ?? connection.relationshipType}
                      {connection.state === "suggested" ? " · ScreenView suggested" : " · Confirmed"}
                    </p>
                    {connection.basis ? (
                      <p className="mt-1 text-xs text-neutral-500">{connection.basis}</p>
                    ) : null}
                    {connection.state === "suggested" ? (
                      <div className="mt-2">
                        <ConnectionActions connectionId={connection.connectionId} />
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {collectionChips.length > 0 ? (
        <section className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">In collections</p>
          <div className="flex flex-wrap gap-2">
            {collectionChips.map((chip) => (
              <Link
                key={chip.id}
                href={`/collections/${chip.id}`}
                className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-700 hover:border-neutral-500"
              >
                {chip.name}
                {chip.kind === "project" ? " · project" : ""}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {(events ?? []).length > 0 ? (
        <section className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">History</p>
          <ul className="space-y-1 text-xs text-neutral-600">
            {(events ?? []).map((event) => (
              <li key={event.id}>{eventLine(event)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="pt-2">
        <DeleteMemoryButton captureId={capture.id} />
      </section>
    </div>
  );
}

function eventLine(event: {
  event_type: string;
  old_value: string | null;
  new_value: string;
  actor: string;
  reason: string | null;
  created_at: string;
}): string {
  const when = new Date(event.created_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const who = event.actor === "user" ? "You" : "ScreenView";
  const reason = event.reason ? ` — ${event.reason}` : "";
  switch (event.event_type) {
    case "intent_change":
      return `${when} — ${who}: intent ${
        event.old_value ? `changed from “${event.old_value}” to ` : "set to "
      }“${event.new_value}”${reason}`;
    case "status_change":
      return `${when} — ${who}: status → ${event.new_value}${reason}`;
    case "topic_change":
      return `${when} — ${who}: topic → ${event.new_value}${reason}`;
    case "action_change":
      return `${when} — ${who}: next step → ${event.new_value}${reason}`;
    case "note_change":
      return `${when} — ${who}: note edited`;
    default:
      return `${when} — ${when ? who : "Update"}: ${event.event_type}`;
  }
}
