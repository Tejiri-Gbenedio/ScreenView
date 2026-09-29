import { createAdminClient } from "@/lib/supabase/admin";

/**
 * M3 connections (Phase 3 §12): candidates come from the reasoning call's
 * `candidate_connections` (retrieval proposed them; the brain judged them).
 * Cosine similarity alone never creates a connection — a candidate must carry
 * a justified basis and clear the confidence floor to be persisted.
 * Persisted rows are `suggested` + `origin='ai'` until the user confirms or
 * dismisses them. Dismissed rows are never re-created (negative signal kept).
 */

export const RELATIONSHIP_TYPES = ["same_subject", "complementary", "thematic", "user_linked"] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** Phase 3 §12: candidates below this confidence are not even suggested. */
export const MIN_CONNECTION_CONFIDENCE = 0.6;

export type CandidateInput = {
  memory_id?: unknown;
  relationship_type?: unknown;
  confidence?: unknown;
  basis?: unknown;
};

export type ValidatedCandidate = {
  otherMemoryId: string;
  relationshipType: RelationshipType;
  confidence: number;
  basis: string;
};

/** Canonical undirected ordering (DB check constraint: source < target). */
export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Deterministic validation of the model's candidate_connections (Phase 3 §12
 * noise filter): only retrieved memories, no self, no AI-authored user links,
 * confidence floor, and a real basis (a connection must be *justified*).
 */
export function validateCandidates(input: {
  newMemoryId: string;
  allowedMemoryIds: string[];
  candidates: CandidateInput[];
}): ValidatedCandidate[] {
  const allowed = new Set(input.allowedMemoryIds);
  const seen = new Set<string>();
  const out: ValidatedCandidate[] = [];

  for (const raw of input.candidates ?? []) {
    if (!raw || typeof raw.memory_id !== "string") continue;
    const other = raw.memory_id.trim();
    if (!other || other === input.newMemoryId) continue; // no self-connections
    if (!allowed.has(other) || seen.has(other)) continue; // only retrieved candidates
    const type = raw.relationship_type;
    if (typeof type !== "string" || !(RELATIONSHIP_TYPES as readonly string[]).includes(type)) continue;
    if (type === "user_linked") continue; // AI never creates user links
    const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
    if (confidence < MIN_CONNECTION_CONFIDENCE) continue;
    const basis = typeof raw.basis === "string" ? raw.basis.trim() : "";
    if (basis.length < 8) continue; // must carry a meaningful basis, not just similarity
    seen.add(other);
    out.push({ otherMemoryId: other, relationshipType: type as RelationshipType, confidence, basis });
  }
  return out.slice(0, 5); // safety cap per capture
}

export type ConnectionsDeps = { getClient?: () => Promise<any> };

async function defaultAdminClient(): Promise<any> {
  return createAdminClient();
}

async function defaultUserClient(): Promise<any> {
  const { createClient } = await import("@/lib/supabase/server");
  return createClient();
}

/**
 * Persist validated candidates as `suggested` AI connections (called from the
 * capture pipeline, non-fatal). Duplicate pairs are skipped in *any* state —
 * this is what keeps dismissed suggestions from reappearing.
 */
export async function persistConnectionCandidates(
  input: {
    userId: string;
    newMemoryId: string;
    allowedMemoryIds: string[];
    candidates: CandidateInput[];
  },
  deps: ConnectionsDeps = {}
): Promise<{ created: number; skipped: number }> {
  const valid = validateCandidates({
    newMemoryId: input.newMemoryId,
    allowedMemoryIds: input.allowedMemoryIds,
    candidates: input.candidates,
  });
  if (valid.length === 0) return { created: 0, skipped: 0 };

  const client = await (deps.getClient ?? defaultAdminClient)();

  // Defence in depth: only the user's own memories may be linked.
  const { data: owned } = await client
    .from("memories")
    .select("id")
    .eq("user_id", input.userId)
    .in(
      "id",
      valid.map((v) => v.otherMemoryId)
    );
  const ownedIds = new Set<string>((owned ?? []).map((row: any) => String(row.id)));

  let created = 0;
  let skipped = 0;

  for (const candidate of valid) {
    if (!ownedIds.has(candidate.otherMemoryId)) {
      skipped += 1;
      continue;
    }
    const [source, target] = orderPair(input.newMemoryId, candidate.otherMemoryId);

    const { data: existing } = await client
      .from("connections")
      .select("id")
      .eq("source_memory_id", source)
      .eq("target_memory_id", target)
      .limit(1)
      .maybeSingle();
    if (existing) {
      skipped += 1; // pair already known (any state — including dismissed)
      continue;
    }

    const { error } = await client.from("connections").insert({
      user_id: input.userId,
      source_memory_id: source,
      target_memory_id: target,
      relationship_type: candidate.relationshipType,
      state: "suggested",
      origin: "ai",
      confidence: candidate.confidence,
      basis: {
        signals: ["reasoning_candidate"],
        reasoning: candidate.basis,
        prompt_version: "connections-v1",
      },
    });
    if (error) {
      skipped += 1; // unique constraint or transient error — never fatal
      continue;
    }
    created += 1;
  }

  return { created, skipped };
}

export type ConnectionAction = "confirm" | "dismiss";

/** User decision on a suggested connection (only the owner can see/act — RLS). */
export async function actOnConnection(
  connectionId: string,
  action: ConnectionAction,
  deps: ConnectionsDeps = {}
): Promise<{ ok: true; state: "confirmed" | "dismissed" } | { ok: false; reason: "not_found" | "invalid_state" }> {
  const client = await (deps.getClient ?? defaultUserClient)();
  const { data: row } = await client
    .from("connections")
    .select("id, state")
    .eq("id", connectionId)
    .maybeSingle();
  if (!row) return { ok: false, reason: "not_found" }; // other users' rows are invisible → not_found
  if (row.state !== "suggested") return { ok: false, reason: "invalid_state" };

  const state = action === "confirm" ? "confirmed" : "dismissed";
  const { error } = await client.from("connections").update({ state }).eq("id", connectionId);
  if (error) return { ok: false, reason: "invalid_state" };
  return { ok: true, state };
}

export type MemoryConnection = {
  connectionId: string;
  state: string;
  origin: string;
  relationshipType: string;
  basis: string | null;
  partnerMemoryId: string;
  partnerCaptureId: string;
  partnerTitle: string | null;
  partnerTopic: string | null;
  partnerIntent: string | null;
  partnerCreatedAt: string;
  partnerSignedUrl: string | null;
};

/** Non-dismissed connections touching a memory (for Memory Detail). */
export async function listConnectionsForMemory(
  memoryId: string,
  deps: ConnectionsDeps = {}
): Promise<MemoryConnection[]> {
  const client = await (deps.getClient ?? defaultUserClient)();

  const { data: rows } = await client
    .from("connections")
    .select("id, source_memory_id, target_memory_id, relationship_type, state, origin, basis")
    .or(`source_memory_id.eq.${memoryId},target_memory_id.eq.${memoryId}`)
    .neq("state", "dismissed")
    .order("created_at", { ascending: false })
    .limit(20);
  if (!rows?.length) return [];

  const partnerIds = rows.map((row: any) =>
    row.source_memory_id === memoryId ? row.target_memory_id : row.source_memory_id
  );
  const { data: partners } = await client
    .from("memories")
    .select("id, capture_id, title, topic, current_intent, created_at")
    .in("id", partnerIds);
  const partnerById = new Map<string, any>((partners ?? []).map((p: any) => [p.id, p]));

  const captureIds = Array.from(new Set((partners ?? []).map((p: any) => p.capture_id as string)));
  const { data: captures } = captureIds.length
    ? await client.from("captures").select("id, storage_path").in("id", captureIds)
    : { data: [] as any[] };
  const captureById = new Map<string, any>((captures ?? []).map((c: any) => [c.id, c]));

  const { signedUrlMap } = await import("@/server/services/storage");
  const urls = await signedUrlMap((captures ?? []).map((c: any) => c.storage_path as string), 3600);

  const out: MemoryConnection[] = [];
  for (const row of rows) {
    const partnerId = row.source_memory_id === memoryId ? row.target_memory_id : row.source_memory_id;
    const partner = partnerById.get(partnerId);
    if (!partner) continue;
    const capture = captureById.get(partner.capture_id);
    out.push({
      connectionId: row.id,
      state: row.state,
      origin: row.origin,
      relationshipType: row.relationship_type,
      basis: (row.basis as any)?.reasoning ?? null,
      partnerMemoryId: partner.id,
      partnerCaptureId: partner.capture_id,
      partnerTitle: partner.title ?? null,
      partnerTopic: partner.topic ?? null,
      partnerIntent: partner.current_intent ?? null,
      partnerCreatedAt: partner.created_at,
      partnerSignedUrl: capture ? urls[capture.storage_path] ?? null : null,
    });
  }
  return out;
}
