import Link from "next/link";
import { ACTION_LABELS, INTENT_LABELS, STATUS_LABELS, relativeTime } from "@/lib/labels";
import type { SearchResult } from "@/server/services/search";

/** M2 search results — server-rendered memory cards (no client JS needed). */
export function SearchResults({ results }: { results: SearchResult[] }) {
  return (
    <ul className="space-y-3">
      {results.map((result) => (
        <li key={result.memoryId}>
          <Link
            href={`/memories/${result.captureId}`}
            className="flex gap-3 rounded-2xl border border-neutral-200 bg-white p-3 hover:border-neutral-400"
          >
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-neutral-100">
              {result.signedUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result.signedUrl} alt="" className="h-full w-full object-cover" />
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">
                  {result.title ?? result.note ?? "Screenshot"}
                </p>
                <span className="shrink-0 text-[11px] text-neutral-400">
                  {relativeTime(result.createdAt)}
                </span>
              </div>
              {result.summary ? (
                <p className="mt-0.5 line-clamp-2 text-xs text-neutral-500">{result.summary}</p>
              ) : null}
              {result.note ? (
                <p className="mt-1 line-clamp-1 text-xs text-neutral-400">
                  You said: “{result.note}”
                </p>
              ) : null}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {result.intent ? (
                  <span className="rounded-full bg-neutral-900 px-2.5 py-0.5 text-[11px] font-medium text-white">
                    {INTENT_LABELS[result.intent] ?? result.intent}
                  </span>
                ) : null}
                {result.topic ? (
                  <span className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-[11px] text-neutral-600">
                    {result.topic}
                  </span>
                ) : null}
                {result.action && result.action !== "none" ? (
                  <span className="text-[11px] text-neutral-400">
                    Next: {ACTION_LABELS[result.action] ?? result.action}
                  </span>
                ) : null}
                {result.status && result.status !== "active" && result.status !== "new" ? (
                  <span className="text-[11px] text-neutral-400">
                    {STATUS_LABELS[result.status] ?? result.status}
                  </span>
                ) : null}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
