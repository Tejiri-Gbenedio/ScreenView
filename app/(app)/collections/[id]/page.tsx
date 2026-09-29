import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signedUrlMap } from "@/server/services/storage";
import { CollectionActions } from "@/components/collections/CollectionActions";
import { INTENT_LABELS, relativeTime } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function CollectionDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: collection } = await supabase
    .from("collections")
    .select("*")
    .eq("id", params.id)
    .single();
  if (!collection) notFound();

  const { data: memberRows } = await supabase
    .from("collection_members")
    .select("memory_id, state, memories!inner(id, capture_id, title, topic, current_intent, created_at)")
    .eq("collection_id", collection.id);
  const members = (memberRows ?? [])
    .map((row: any) => row.memories)
    .filter(Boolean) as Array<{
    id: string;
    capture_id: string;
    title: string | null;
    topic: string | null;
    current_intent: string | null;
    created_at: string;
  }>;

  let items: Array<{
    memoryId: string;
    captureId: string;
    title: string | null;
    topic: string | null;
    intent: string | null;
    createdAt: string;
    signedUrl: string | null;
  }> = [];

  if (members.length) {
    const captureIds = members.map((m) => m.capture_id);
    const { data: captures } = await supabase
      .from("captures")
      .select("id, storage_path")
      .in("id", captureIds);
    const captureById = new Map((captures ?? []).map((c: any) => [c.id, c]));
    const urls = await signedUrlMap(
      (captures ?? []).map((c: any) => c.storage_path as string),
      3600
    );
    items = members.map((m) => {
      const capture = captureById.get(m.capture_id);
      return {
        memoryId: m.id,
        captureId: m.capture_id,
        title: m.title,
        topic: m.topic,
        intent: m.current_intent,
        createdAt: m.created_at,
        signedUrl: capture ? urls[capture.storage_path] ?? null : null,
      };
    });
  }

  const signals = (((collection.basis as any)?.signals ?? []) as Array<{
    type: string;
    detail: string;
  }>).filter((s) => s && typeof s.detail === "string");

  return (
    <div className="space-y-8 pb-16">
      <div>
        <Link href="/collections" className="text-xs text-neutral-500 hover:text-neutral-800">
          ← Collections
        </Link>
      </div>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">{collection.name}</h1>
          {collection.kind === "project" ? (
            <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] font-medium text-white">
              Project
            </span>
          ) : null}
          {collection.state !== "accepted" ? (
            <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-500">
              {collection.state}
            </span>
          ) : null}
        </div>
        {collection.description ? (
          <p className="text-sm text-neutral-600">{collection.description}</p>
        ) : null}
        <p className="text-xs text-neutral-400">
          {collection.origin === "ai_suggested"
            ? "ScreenView noticed these memories keep showing up together."
            : "You created this collection."}{" "}
          · {relativeTime(collection.updated_at)}
        </p>
      </section>

      <section className="rounded-2xl border border-neutral-200 bg-white p-4">
        <p className="text-[11px] uppercase tracking-wide text-neutral-400">
          {collection.origin === "ai_suggested" ? "Why ScreenView grouped these" : "Why these memories"}
        </p>
        <ul className="mt-2 space-y-1 text-xs text-neutral-600">
          {signals.length ? (
            signals.map((signal, index) => <li key={index}>• {signal.detail}</li>)
          ) : (
            <li>• {collection.origin === "user_created" ? "Added by you" : "Based on your saves"}</li>
          )}
        </ul>
      </section>

      <section className="space-y-3">
        <p className="text-[11px] uppercase tracking-wide text-neutral-400">
          Memories in this collection
        </p>
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.memoryId}>
              <Link
                href={`/memories/${item.captureId}`}
                className="flex gap-3 rounded-2xl border border-neutral-200 bg-white p-3 hover:border-neutral-400"
              >
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-neutral-100">
                  {item.signedUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.signedUrl} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title ?? "Screenshot"}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {item.intent ? (
                      <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] font-medium text-white">
                        {INTENT_LABELS[item.intent] ?? item.intent}
                      </span>
                    ) : null}
                    {item.topic ? (
                      <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-600">
                        {item.topic}
                      </span>
                    ) : null}
                    <span className="text-[10px] text-neutral-400">
                      {relativeTime(item.createdAt)}
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <CollectionActions
          collectionId={collection.id}
          state={collection.state}
          allowRename={collection.state !== "dismissed"}
        />
      </section>
    </div>
  );
}
