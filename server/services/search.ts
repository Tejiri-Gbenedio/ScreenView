import { embedText, toVectorLiteral } from "@/server/ai/providers";
import { signedUrlMap } from "./storage";
import { ACTIONS, INTENTS, STATUSES } from "@/server/ai/contracts";
import { MAX_SEARCH_QUERY_LEN } from "@/lib/validation";

/**
 * M2 semantic search (Phase 3 §9 retrieval, read-only):
 * query embedding → pgvector KNN (top-10; top-25 when filters are active)
 * → exact-topic supplement → deterministic filters → rank → at most 12 cards.
 *
 * Deterministic-first (trust rule): no LLM calls — ranking and filtering are
 * deterministic, and every result is an existing DB row. Search can never
 * fabricate a memory.
 *
 * Ownership: all reads go through the caller's session client (RLS) AND the
 * validated session user id — another user's memory can never be returned.
 */

/** Cosine-similarity floor under which a KNN hit is not a match ("Nothing matched yet."). */
export const MIN_SIMILARITY = 0.2;
export const SEARCH_RESULT_CAP = 12;

export type SearchFilters = {
  intent?: string;
  topic?: string;
  action?: string;
  status?: string;
};

export type SearchResult = {
  memoryId: string;
  captureId: string;
  title: string | null;
  summary: string | null;
  topic: string | null;
  intent: string | null;
  action: string | null;
  status: string | null;
  note: string | null;
  createdAt: string;
  signedUrl: string | null;
  similarity?: number;
};

export class SearchError extends Error {
  code: "unauthorized" | "invalid_input" | "search_failed";
  constructor(code: SearchError["code"], message?: string) {
    super(message ?? code);
    this.name = "SearchError";
    this.code = code;
  }
}

export type Candidate = {
  memory_id: string;
  title: string | null;
  topic: string | null;
  current_intent: string | null;
  suggested_action: string | null;
  status: string | null;
  created_at: string;
  similarity?: number;
  source: "semantic" | "topic" | "recent";
};

// ------------------------------------------------------------- pure helpers

export function sanitizeQuery(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, MAX_SEARCH_QUERY_LEN) : "";
}

export function normalizeFilters(raw: {
  intent?: unknown;
  topic?: unknown;
  action?: unknown;
  status?: unknown;
}): SearchFilters {
  const filters: SearchFilters = {};
  if (typeof raw.intent === "string" && (INTENTS as readonly string[]).includes(raw.intent)) {
    filters.intent = raw.intent;
  }
  if (typeof raw.topic === "string") {
    const topic = raw.topic.trim().slice(0, 80);
    if (topic) filters.topic = topic;
  }
  if (typeof raw.action === "string" && (ACTIONS as readonly string[]).includes(raw.action)) {
    filters.action = raw.action;
  }
  if (typeof raw.status === "string" && (STATUSES as readonly string[]).includes(raw.status)) {
    filters.status = raw.status;
  }
  return filters;
}

export function hasFilters(filters: SearchFilters): boolean {
  return Boolean(filters.intent || filters.topic || filters.action || filters.status);
}

export function applyFilters(candidates: Candidate[], filters: SearchFilters): Candidate[] {
  return candidates.filter(
    (c) =>
      (!filters.intent || c.current_intent === filters.intent) &&
      (!filters.topic || (c.topic ?? "").toLowerCase() === filters.topic.toLowerCase()) &&
      (!filters.action || c.suggested_action === filters.action) &&
      (!filters.status || c.status === filters.status)
  );
}

/** Stable order (semantic similarity first, supplements after), dedupe by memory, cap. */
export function assembleResults(candidates: Candidate[], cap = SEARCH_RESULT_CAP): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.memory_id)) continue;
    seen.add(candidate.memory_id);
    out.push(candidate);
    if (out.length >= cap) break;
  }
  return out;
}

/** Case-insensitive containment of an existing topic in the query; longest topic wins. */
export function detectTopicInQuery(query: string, topics: string[]): string | null {
  const q = query.toLowerCase();
  let best: string | null = null;
  for (const raw of topics) {
    const topic = raw.trim().toLowerCase();
    if (!topic) continue;
    if (q.includes(topic) && (!best || topic.length > best.length)) best = topic;
  }
  return best;
}

// ------------------------------------------------------------------------ IO

export type SearchDeps = {
  getClient?: () => Promise<any>;
  embed?: (text: string) => Promise<number[]>;
  signUrls?: (paths: string[]) => Promise<Record<string, string>>;
};

async function defaultClient(): Promise<any> {
  // Lazy import keeps this module importable in unit tests.
  const { createClient } = await import("@/lib/supabase/server");
  return createClient();
}

function toCandidate(
  row: Record<string, any>,
  source: Candidate["source"],
  similarity?: number
): Candidate {
  return {
    memory_id: String(row.memory_id ?? row.id),
    title: (row.title as string) ?? null,
    topic: (row.topic as string) ?? null,
    current_intent: (row.current_intent as string) ?? null,
    suggested_action: (row.suggested_action as string) ?? null,
    status: (row.status as string) ?? null,
    created_at: String(row.created_at),
    ...(similarity !== undefined ? { similarity } : {}),
    source,
  };
}

async function listTopics(client: any, userId: string): Promise<string[]> {
  const { data } = await client
    .from("memories")
    .select("topic")
    .eq("user_id", userId)
    .not("topic", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);
  const seen = new Set<string>();
  for (const row of data ?? []) {
    const topic = String(row.topic ?? "").trim();
    if (topic) seen.add(topic);
  }
  return Array.from(seen);
}

export async function searchMemories(
  input: { query: string; filters?: SearchFilters },
  deps: SearchDeps = {}
): Promise<{ results: SearchResult[] }> {
  const getClient = deps.getClient ?? defaultClient;
  const embed = deps.embed ?? embedText;
  const signUrls = deps.signUrls ?? signedUrlMap;

  const client = await getClient();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new SearchError("unauthorized");

  const query = sanitizeQuery(input.query);
  const filters = normalizeFilters(input.filters ?? {});
  if (!query && !hasFilters(filters)) throw new SearchError("invalid_input", "empty query");

  const candidates: Candidate[] = [];

  try {
    if (query) {
      const embedding = await embed(query);
      const matchCount = hasFilters(filters) ? 25 : 10;
      const { data, error } = await client.rpc("match_memories", {
        p_user_id: user.id,
        query_embedding: toVectorLiteral(embedding),
        match_count: matchCount,
      });
      if (error) throw error;
      for (const row of (data ?? []) as Record<string, any>[]) {
        const similarity = typeof row.similarity === "number" ? row.similarity : 0;
        if (similarity < MIN_SIMILARITY) continue;
        candidates.push(toCandidate(row, "semantic", similarity));
      }

      // Exact-topic supplement: a query naming an existing topic pulls that topic's recent memories.
      const topics = await listTopics(client, user.id);
      const detectedTopic = detectTopicInQuery(query, topics);
      if (detectedTopic) {
        const { data: topicRows } = await client
          .from("memories")
          .select("id, title, topic, current_intent, suggested_action, status, created_at")
          .eq("user_id", user.id)
          .ilike("topic", detectedTopic)
          .order("created_at", { ascending: false })
          .limit(6);
        for (const row of topicRows ?? []) candidates.push(toCandidate(row, "topic"));
      }
    } else {
      // Filters-only browsing — deterministic, no embedding call.
      let listing = client
        .from("memories")
        .select("id, title, topic, current_intent, suggested_action, status, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(SEARCH_RESULT_CAP);
      if (filters.intent) listing = listing.eq("current_intent", filters.intent);
      if (filters.topic) listing = listing.ilike("topic", filters.topic);
      if (filters.action) listing = listing.eq("suggested_action", filters.action);
      if (filters.status) listing = listing.eq("status", filters.status);
      const { data } = await listing;
      for (const row of data ?? []) candidates.push(toCandidate(row, "recent"));
    }
  } catch (error) {
    console.error("search failed:", (error as Error).message);
    throw new SearchError("search_failed");
  }

  const picked = assembleResults(applyFilters(candidates, filters));
  if (picked.length === 0) return { results: [] };

  try {
    const memoryIds = picked.map((c) => c.memory_id);
    const { data: memoryRows } = await client
      .from("memories")
      .select("id, summary, capture_id")
      .in("id", memoryIds);
    const memoryById = new Map<string, any>((memoryRows ?? []).map((m: any) => [m.id, m]));

    const captureIds = Array.from(new Set((memoryRows ?? []).map((m: any) => m.capture_id as string)));
    const { data: captureRows } = captureIds.length
      ? await client.from("captures").select("id, storage_path, original_note").in("id", captureIds)
      : { data: [] as any[] };
    const captureById = new Map<string, any>((captureRows ?? []).map((c: any) => [c.id, c]));
    const urls = await signUrls((captureRows ?? []).map((c: any) => c.storage_path as string));

    const results: SearchResult[] = picked.map((candidate) => {
      const memory = memoryById.get(candidate.memory_id);
      const capture = memory ? captureById.get(memory.capture_id) : undefined;
      return {
        memoryId: candidate.memory_id,
        captureId: (memory?.capture_id as string) ?? "",
        title: candidate.title,
        summary: (memory?.summary as string) ?? null,
        topic: candidate.topic,
        intent: candidate.current_intent,
        action: candidate.suggested_action,
        status: candidate.status,
        note: (capture?.original_note as string | null) ?? null,
        createdAt: candidate.created_at,
        signedUrl: capture ? urls[capture.storage_path as string] ?? null : null,
        ...(candidate.similarity !== undefined ? { similarity: candidate.similarity } : {}),
      };
    });
    return { results };
  } catch (error) {
    console.error("search enrichment failed:", (error as Error).message);
    throw new SearchError("search_failed");
  }
}
