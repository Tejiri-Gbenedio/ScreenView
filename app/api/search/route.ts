import { NextResponse } from "next/server";
import { SearchRequestSchema } from "@/lib/validation";
import { searchMemories, SearchError } from "@/server/services/search";

/** M2 search API — natural-language query + deterministic filters. User-scoped (RLS). */
export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = SearchRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const { results } = await searchMemories({
      query: parsed.data.query,
      filters: {
        intent: parsed.data.intent,
        topic: parsed.data.topic,
        action: parsed.data.action,
        status: parsed.data.status,
      },
    });
    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof SearchError && error.code === "unauthorized") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Never leak provider/DB details — the user sees a generic message.
    return NextResponse.json(
      { error: "search_failed", message: "Search couldn't load. Try again." },
      { status: 500 }
    );
  }
}
