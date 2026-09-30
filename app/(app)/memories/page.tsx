import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { signedUrlMap } from "@/server/services/storage";
import {
  searchMemories,
  sanitizeQuery,
  normalizeFilters,
  hasFilters,
  SearchError,
  type SearchResult,
} from "@/server/services/search";
import { MemoriesClient, type ListItem } from "@/components/memories/MemoriesClient";
import { SearchResults } from "@/components/memories/SearchResults";
import {
  ACTION_LABELS,
  ACTION_OPTIONS,
  INTENT_LABELS,
  INTENT_OPTIONS,
  STATUS_LABELS,
  STATUS_OPTIONS,
} from "@/lib/labels";

export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

export default async function MemoriesPage({ searchParams }: { searchParams?: SearchParams }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const query = sanitizeQuery(first(searchParams?.q));
  const filters = normalizeFilters({
    intent: first(searchParams?.intent),
    topic: first(searchParams?.topic),
    action: first(searchParams?.action),
    status: first(searchParams?.status),
  });
  const searching = query.length > 0 || hasFilters(filters);

  if (searching) {
    let results: SearchResult[] = [];
    let failed = false;
    try {
      ({ results } = await searchMemories({ query, filters }));
    } catch (error) {
      if (error instanceof SearchError && error.code === "unauthorized") redirect("/login");
      failed = true;
    }

    const { data: topicRows } = await supabase
      .from("memories")
      .select("topic")
      .eq("user_id", user.id)
      .not("topic", "is", null)
      .order("created_at", { ascending: false })
      .limit(200);
    const topics = Array.from(
      new Set((topicRows ?? []).map((row) => String(row.topic ?? "").trim()).filter(Boolean))
    ).sort();

    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Memories</h1>
          <p className="mt-1 text-sm text-neutral-500">Search your memories in your own words.</p>
        </div>

        <form method="get" action="/memories" className="space-y-3">
          <div className="flex gap-2">
            <input
              type="search"
              name="q"
              defaultValue={query}
              aria-label="Search memories"
              placeholder="Describe what you're looking for…"
              className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
            />
            <button
              type="submit"
              className="shrink-0 rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            >
              Search
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              name="intent"
              defaultValue={filters.intent ?? ""}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700"
            >
              <option value="">Any intent</option>
              {INTENT_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {INTENT_LABELS[value] ?? value}
                </option>
              ))}
            </select>
            <select
              name="topic"
              defaultValue={filters.topic ?? ""}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700"
            >
              <option value="">Any topic</option>
              {topics.map((topic) => (
                <option key={topic} value={topic}>
                  {topic}
                </option>
              ))}
            </select>
            <select
              name="action"
              defaultValue={filters.action ?? ""}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700"
            >
              <option value="">Any next step</option>
              {ACTION_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {ACTION_LABELS[value] ?? value}
                </option>
              ))}
            </select>
            <select
              name="status"
              defaultValue={filters.status ?? ""}
              className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700"
            >
              <option value="">Any status</option>
              {STATUS_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value] ?? value}
                </option>
              ))}
            </select>
            <Link href="/memories" className="text-xs text-neutral-500 hover:text-neutral-800">
              Clear
            </Link>
          </div>
        </form>

        {failed ? (
          <div className="rounded-2xl border border-neutral-200 bg-white p-8 text-center">
            <p className="text-sm text-neutral-600">Search couldn&apos;t load. Try again.</p>
          </div>
        ) : results.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
            <p className="text-sm text-neutral-600">Nothing matched yet.</p>
            <p className="mt-1 text-xs text-neutral-400">
              Try different words or clear the filters.
            </p>
          </div>
        ) : (
          <SearchResults results={results} />
        )}

        <p className="text-center text-xs text-neutral-400">
          <Link href="/memories" className="underline">
            ← Back to all memories
          </Link>
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------- normal browsing
  const { data: captures } = await supabase
    .from("captures")
    .select("id, processing_status, original_note, storage_path, created_at, last_error")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(60);

  const captureIds = (captures ?? []).map((c) => c.id);
  const { data: memories } = captureIds.length
    ? await supabase
        .from("memories")
        .select("id, capture_id, title, topic, current_intent, status")
        .in("capture_id", captureIds)
    : { data: [] as never[] };

  const memoryByCapture = new Map((memories ?? []).map((m) => [m.capture_id as string, m]));
  const urls = await signedUrlMap((captures ?? []).map((c) => c.storage_path), 3600);

  const items: ListItem[] = (captures ?? []).map((c) => {
    const memory = memoryByCapture.get(c.id);
    return {
      captureId: c.id,
      memoryId: memory?.id ?? null,
      signedUrl: urls[c.storage_path] ?? null,
      note: c.original_note,
      status: c.processing_status,
      memoryStatus: memory?.status ?? null,
      title: memory?.title ?? null,
      topic: memory?.topic ?? null,
      intent: memory?.current_intent ?? null,
      createdAt: c.created_at,
      lastError: c.last_error,
    };
  });

  return <MemoriesClient items={items} />;
}
