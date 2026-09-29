import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { runDiscovery } from "@/server/services/collections";
import { CollectionActions } from "@/components/collections/CollectionActions";
import { relativeTime } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Deterministic-first discovery runs on screen load; failure never breaks the page.
  try {
    await runDiscovery();
  } catch (error) {
    console.error("discovery failed:", (error as Error).message);
  }

  const { data: collections } = await supabase
    .from("collections")
    .select("id, name, description, origin, state, kind, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  const ids = (collections ?? []).map((c) => c.id);
  const { data: members } = ids.length
    ? await supabase.from("collection_members").select("collection_id").in("collection_id", ids)
    : { data: [] as never[] };
  const countByCollection = new Map<string, number>();
  for (const member of members ?? []) {
    countByCollection.set(
      member.collection_id,
      (countByCollection.get(member.collection_id) ?? 0) + 1
    );
  }

  const suggested = (collections ?? []).filter((c) => c.state === "suggested");
  const accepted = (collections ?? []).filter((c) => c.state === "accepted");
  const archived = (collections ?? []).filter((c) => c.state === "archived");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Collections</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Groups that emerged from your memories. A memory can belong to more than one.
        </p>
      </div>

      {suggested.length === 0 && accepted.length === 0 && archived.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <p className="text-sm text-neutral-500">No collections yet.</p>
          <p className="mt-1 text-xs text-neutral-400">
            As related memories add up, ScreenView will quietly suggest groups here.
          </p>
        </div>
      ) : null}

      {suggested.length > 0 ? (
        <section className="space-y-3">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">ScreenView noticed…</p>
          <ul className="space-y-3">
            {suggested.map((collection) => (
              <li key={collection.id} className="rounded-2xl border border-neutral-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {collection.name}
                      {collection.kind === "project" ? (
                        <span className="ml-2 rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] font-medium text-white">
                          Project
                        </span>
                      ) : null}
                    </p>
                    {collection.description ? (
                      <p className="mt-1 text-xs text-neutral-500">{collection.description}</p>
                    ) : null}
                    <p className="mt-1 text-[11px] text-neutral-400">
                      {countByCollection.get(collection.id) ?? 0} memories ·{" "}
                      {relativeTime(collection.updated_at)}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <Link
                    href={`/collections/${collection.id}`}
                    className="text-xs text-neutral-500 underline hover:text-neutral-800"
                  >
                    See why
                  </Link>
                  <CollectionActions collectionId={collection.id} state={collection.state} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {accepted.length > 0 ? (
        <section className="space-y-3">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">Your collections</p>
          <ul className="space-y-3">
            {accepted.map((collection) => (
              <li key={collection.id}>
                <Link
                  href={`/collections/${collection.id}`}
                  className="flex items-center justify-between rounded-2xl border border-neutral-200 bg-white p-4 hover:border-neutral-400"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {collection.name}
                      {collection.kind === "project" ? (
                        <span className="ml-2 rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] font-medium text-white">
                          Project
                        </span>
                      ) : null}
                    </span>
                    {collection.description ? (
                      <span className="mt-1 block truncate text-xs text-neutral-500">
                        {collection.description}
                      </span>
                    ) : null}
                  </span>
                  <span className="ml-3 shrink-0 text-[11px] text-neutral-400">
                    {countByCollection.get(collection.id) ?? 0} memories
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {archived.length > 0 ? (
        <section className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">Archived</p>
          <ul className="space-y-1">
            {archived.map((collection) => (
              <li key={collection.id}>
                <Link
                  href={`/collections/${collection.id}`}
                  className="text-xs text-neutral-400 hover:text-neutral-700"
                >
                  {collection.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
