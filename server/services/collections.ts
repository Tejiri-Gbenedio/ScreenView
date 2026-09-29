import { synthesizeCollection } from "@/server/ai/providers";

/** Normalized topic label for grouping (case/space-insensitive). */
export function normalizeTopic(topic: string | null): string {
  return (topic ?? "").trim().toLowerCase();
}

/**
 * M3 collections (Phase 3 §13 / Phase 5 §11-13): deterministic detection first —
 * code does all selecting, counting, gating and validating; the reasoning model
 * is used ONLY to synthesize a name/description from already-selected evidence.
 * No evidence → no collection. Two related memories are never a collection.
 */

export const DETECTION_WINDOW_DAYS = 60;
export const MIN_MEMBERS = 3;
export const MIN_SIGNALS = 2;
export const DISMISS_COOLDOWN_DAYS = 90;
export const PROJECT_MIN_MEMBERS = 4;
export const PROJECT_MIN_BUILD_SIGNALS = 2;
export const PROJECT_MIN_SPREAD_DAYS = 7;
export const MAX_NEW_PER_RUN = 2;
export const MAX_UNRESOLVED_SUGGESTED = 3;
export const ACCEPTED_OVERLAP_SKIP = 0.7;

const DAY_MS = 86400000;

export type MemoryLite = {
  id: string;
  title: string | null;
  note: string | null;
  topic: string | null;
  current_intent: string | null;
  suggested_action: string | null;
  created_at: string;
};

export type ConnectionLite = {
  source_memory_id: string;
  target_memory_id: string;
  relationship_type: string;
  state: string;
};

export type Signal = {
  type: "topic_frequency" | "intent_pattern" | "connection_density" | "cadence";
  detail: string;
};

const BUILD_NOTE_RE =
  /\b(build|building|make (my|a|an) (own|version)|something like (this|that))\b/i;

export function isBuildFlavored(m: MemoryLite): boolean {
  return (
    m.current_intent === "build" ||
    m.suggested_action === "build" ||
    (m.note ? BUILD_NOTE_RE.test(m.note) : false)
  );
}

export function spanDays(members: MemoryLite[]): number {
  if (members.length < 2) return 0;
  const times = members.map((m) => Date.parse(m.created_at)).filter((t) => !Number.isNaN(t));
  if (times.length < 2) return 0;
  return (Math.max(...times) - Math.min(...times)) / DAY_MS;
}

function internalConnections(members: MemoryLite[], connections: ConnectionLite[]): number {
  const ids = new Set(members.map((m) => m.id));
  return connections.filter(
    (c) =>
      c.state !== "dismissed" &&
      ids.has(c.source_memory_id) &&
      ids.has(c.target_memory_id) &&
      (c.relationship_type === "same_subject" ||
        c.relationship_type === "thematic" ||
        c.relationship_type === "user_linked")
  ).length;
}

/** All signals for a candidate set; `primaries` excludes the supporting cadence signal. */
export function computeSignals(
  members: MemoryLite[],
  connections: ConnectionLite[],
  now = Date.now()
): { signals: Signal[]; primaries: number } {
  const signals: Signal[] = [];

  // 1. topic frequency — ≥3 members share a normalized topic
  const topicCounts = new Map<string, number>();
  for (const m of members) {
    const t = normalizeTopic(m.topic);
    if (t) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
  }
  const topTopic = Array.from(topicCounts.entries()).sort((a, b) => b[1] - a[1])[0];
  if (topTopic && topTopic[1] >= 3) {
    signals.push({ type: "topic_frequency", detail: `${topTopic[1]} memories about “${topTopic[0]}”` });
  }

  // 2. intent pattern — ≥3 members share the same (non-unknown) intent
  const intentCounts = new Map<string, number>();
  for (const m of members) {
    if (m.current_intent && m.current_intent !== "unknown") {
      intentCounts.set(m.current_intent, (intentCounts.get(m.current_intent) ?? 0) + 1);
    }
  }
  const topIntent = Array.from(intentCounts.entries()).sort((a, b) => b[1] - a[1])[0];
  if (topIntent && topIntent[1] >= 3) {
    signals.push({ type: "intent_pattern", detail: `${topIntent[1]} with intent “${topIntent[0]}”` });
  }

  // 3. connection density — ≥2 internal connections (same_subject/thematic/user_linked)
  const internal = internalConnections(members, connections);
  if (members.length >= 3 && internal >= 2) {
    signals.push({ type: "connection_density", detail: `${internal} connections between them` });
  }

  // 4. cadence (supporting only) — ≥2 captured in the last 14 days on top of older ones
  const recent = members.filter((m) => now - Date.parse(m.created_at) <= 14 * DAY_MS).length;
  if (recent >= 2 && members.length > recent) {
    signals.push({ type: "cadence", detail: `${recent} captured in the last two weeks` });
  }

  const primaries = signals.filter((s) => s.type !== "cadence").length;
  return { signals, primaries };
}

/** Gate (Phase 5 §11): ≥3 memories AND ≥2 signal types (cadence alone never qualifies). */
export function passesCollectionGate(
  members: MemoryLite[],
  connections: ConnectionLite[],
  now = Date.now()
): { ok: boolean; signals: Signal[] } {
  if (members.length < MIN_MEMBERS) return { ok: false, signals: [] };
  const { signals, primaries } = computeSignals(members, connections, now);
  return { ok: signals.length >= MIN_SIGNALS && primaries >= 1, signals };
}

/** Project criteria (Phase 5 §12): strict, never auto-upgraded. */
export function projectAssessment(
  members: MemoryLite[],
  connections: ConnectionLite[]
): { isProject: boolean; buildSignals: number; coherent: boolean; spreadDays: number } {
  const buildSignals = members.filter(isBuildFlavored).length;
  const spread = spanDays(members);

  const topicCounts = new Map<string, number>();
  for (const m of members) {
    const t = normalizeTopic(m.topic);
    if (t) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
  }
  const topShare =
    members.length > 0 ? Math.max(0, ...Array.from(topicCounts.values())) / members.length : 0;
  const possible = (members.length * (members.length - 1)) / 2;
  const density = possible > 0 ? internalConnections(members, connections) / possible : 0;
  const coherent = topShare >= 0.75 || density >= 0.4;

  const isProject =
    members.length >= PROJECT_MIN_MEMBERS &&
    buildSignals >= PROJECT_MIN_BUILD_SIGNALS &&
    spread >= PROJECT_MIN_SPREAD_DAYS &&
    coherent;

  return { isProject, buildSignals, coherent, spreadDays: spread };
}

export function signatureOf(memberIds: string[]): string {
  return [...memberIds].sort().join(",");
}

export type CandidateSet = {
  members: MemoryLite[];
  signals: Signal[];
  signature: string;
  latest: number;
  isProject: boolean;
};

/** Deterministic candidate sets: topic groups + connection clusters → gated. */
export function detectCandidateSets(
  memories: MemoryLite[],
  connections: ConnectionLite[],
  now = Date.now()
): CandidateSet[] {
  const recent = memories.filter((m) => now - Date.parse(m.created_at) <= DETECTION_WINDOW_DAYS * DAY_MS);
  const byId = new Map(recent.map((m) => [m.id, m]));
  const sets = new Map<string, string[]>();

  const addSet = (memberIds: string[]) => {
    const unique = Array.from(new Set(memberIds)).filter((id) => byId.has(id));
    if (unique.length < MIN_MEMBERS) return;
    const sig = signatureOf(unique);
    if (!sets.has(sig)) sets.set(sig, unique);
  };

  // (a) topic groups
  const byTopic = new Map<string, string[]>();
  for (const m of recent) {
    const t = normalizeTopic(m.topic);
    if (!t) continue;
    byTopic.set(t, [...(byTopic.get(t) ?? []), m.id]);
  }
  for (const ids of Array.from(byTopic.values())) addSet(ids);

  // (b) connection clusters (connected components over non-dismissed connections)
  const adjacency = new Map<string, Set<string>>();
  for (const c of connections) {
    if (c.state === "dismissed") continue;
    if (!byId.has(c.source_memory_id) || !byId.has(c.target_memory_id)) continue;
    if (!adjacency.has(c.source_memory_id)) adjacency.set(c.source_memory_id, new Set());
    if (!adjacency.has(c.target_memory_id)) adjacency.set(c.target_memory_id, new Set());
    adjacency.get(c.source_memory_id)!.add(c.target_memory_id);
    adjacency.get(c.target_memory_id)!.add(c.source_memory_id);
  }
  const visited = new Set<string>();
  for (const start of Array.from(adjacency.keys())) {
    if (visited.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    while (stack.length) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const next of Array.from(adjacency.get(current) ?? [])) stack.push(next);
    }
    addSet(component);
  }

  const out: CandidateSet[] = [];
  for (const [sig, ids] of Array.from(sets.entries())) {
    const members = ids.map((id) => byId.get(id)!).filter(Boolean);
    const { ok, signals } = passesCollectionGate(members, connections, now);
    if (!ok) continue;
    const { isProject } = projectAssessment(members, connections);
    const latest = Math.max(...members.map((m) => Date.parse(m.created_at)));
    out.push({ members, signals, signature: sig, latest, isProject });
  }

  // strength: memory count → signals → recency
  return out.sort(
    (a, b) =>
      b.members.length - a.members.length || b.signals.length - a.signals.length || b.latest - a.latest
  );
}

// ------------------------------------------------------------------------ IO

export type CollectionsDeps = {
  getClient?: () => Promise<any>;
  synthesize?: (input: {
    members: Array<{ title: string | null; topic: string | null; intent: string | null; action: string | null }>;
    signals: string[];
    isProject: boolean;
  }) => Promise<{ name: string; description: string }>;
};

async function defaultUserClient(): Promise<any> {
  const { createClient } = await import("@/lib/supabase/server");
  return createClient();
}

export type DiscoveryResult = {
  created: Array<{ id: string; name: string; kind: string }>;
  skipped: string | null;
};

/**
 * Detect + suggest collections. Runs on the Collections screen (and via the
 * discover API). Conservative: unresolved suggestions cap, dismissed 90-day
 * cooldown, no duplicates, ≤2 new suggestions per run, ≤1 synthesis call per
 * created suggestion (deterministic fallback name if the model is unavailable).
 */
export async function runDiscovery(deps: CollectionsDeps = {}): Promise<DiscoveryResult> {
  const client = await (deps.getClient ?? defaultUserClient)();
  const synthesize = deps.synthesize ?? synthesizeCollection;
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { created: [], skipped: "unauthorized" };

  const now = Date.now();
  const since = new Date(now - DETECTION_WINDOW_DAYS * DAY_MS).toISOString();

  const { data: memRows } = await client
    .from("memories")
    .select("id, capture_id, title, topic, current_intent, suggested_action, created_at")
    .eq("user_id", user.id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(300);

  const memories: MemoryLite[] = [];
  const memoriesRaw = memRows ?? [];
  if (memoriesRaw.length) {
    const captureIds = Array.from(new Set(memoriesRaw.map((m: any) => m.capture_id as string)));
    const { data: notes } = await client
      .from("captures")
      .select("id, original_note")
      .in("id", captureIds);
    const noteById = new Map<string, string | null>(
      (notes ?? []).map((n: any) => [n.id, n.original_note ?? null])
    );
    for (const m of memoriesRaw) {
      memories.push({
        id: m.id,
        title: m.title ?? null,
        note: noteById.get(m.capture_id) ?? null,
        topic: m.topic ?? null,
        current_intent: m.current_intent ?? null,
        suggested_action: m.suggested_action ?? null,
        created_at: m.created_at,
      });
    }
  }

  const { data: connRows } = await client
    .from("connections")
    .select("source_memory_id, target_memory_id, relationship_type, state")
    .eq("user_id", user.id)
    .limit(500);
  const connections: ConnectionLite[] = (connRows ?? []) as ConnectionLite[];

  const { data: existing } = await client
    .from("collections")
    .select("id, name, state, kind, basis, updated_at")
    .eq("user_id", user.id)
    .limit(200);
  const existingCollections = existing ?? [];

  const unresolvedSuggested = existingCollections.filter((c: any) => c.state === "suggested").length;
  if (unresolvedSuggested >= MAX_UNRESOLVED_SUGGESTED) {
    return { created: [], skipped: "unresolved_cap" };
  }

  const existingSignatures = new Set<string>();
  const dismissedSignatures = new Map<string, number>(); // signature -> dismissed/archived at ms
  for (const c of existingCollections) {
    const sig = (c.basis as any)?.signature;
    if (typeof sig !== "string") continue;
    if (c.state === "dismissed" || c.state === "archived") {
      const at = Date.parse((c.basis as any)?.dismissed_at ?? c.updated_at ?? 0);
      dismissedSignatures.set(sig, Number.isNaN(at) ? 0 : at);
    }
    existingSignatures.add(sig);
  }

  // member lists per collection for overlap checks against accepted collections
  const acceptedMembers: string[][] = [];
  const acceptedIds = existingCollections.filter((c: any) => c.state === "accepted").map((c: any) => c.id);
  if (acceptedIds.length) {
    const { data: memberRows } = await client
      .from("collection_members")
      .select("collection_id, memory_id")
      .in("collection_id", acceptedIds);
    const byCollection = new Map<string, string[]>();
    for (const row of memberRows ?? []) {
      byCollection.set(row.collection_id, [...(byCollection.get(row.collection_id) ?? []), row.memory_id]);
    }
    for (const ids of Array.from(byCollection.values())) acceptedMembers.push(ids);
  }

  const candidates = detectCandidateSets(memories, connections, now);
  const created: DiscoveryResult["created"] = [];
  let newCount = 0;

  for (const candidate of candidates) {
    if (newCount >= MAX_NEW_PER_RUN) break;

    const sig = candidate.signature;

    // Already covered (any state) — unless a dismissal is older than the cooldown.
    if (existingSignatures.has(sig)) {
      const dismissedAt = dismissedSignatures.get(sig);
      if (dismissedAt === undefined || now - dismissedAt < DISMISS_COOLDOWN_DAYS * DAY_MS) continue;
    }
    if (dismissedSignatures.has(sig) && now - (dismissedSignatures.get(sig) ?? 0) < DISMISS_COOLDOWN_DAYS * DAY_MS) {
      continue;
    }

    // Not already covered by an accepted collection (≥70% member overlap).
    const memberIds = new Set(candidate.members.map((m) => m.id));
    const covered = acceptedMembers.some((members) => {
      if (members.length === 0) return false;
      const overlap = members.filter((id) => memberIds.has(id)).length;
      return overlap / memberIds.size >= ACCEPTED_OVERLAP_SKIP;
    });
    if (covered) continue;

    // Synthesize name/description (deterministic fallback keeps the feature alive).
    const { isProject } = projectAssessment(candidate.members, connections);
    let name = "";
    let description = "";
    try {
      const synth = await synthesize({
        members: candidate.members.map((m) => ({
          title: m.title,
          topic: m.topic,
          intent: m.current_intent,
          action: m.suggested_action,
        })),
        signals: candidate.signals.map((s) => `${s.type}: ${s.detail}`),
        isProject,
      });
      name = synth.name;
      description = synth.description;
    } catch (error) {
      console.error("collection synthesis failed:", (error as Error).message);
      const topic = candidate.members.find((m) => normalizeTopic(m.topic))?.topic ?? null;
      name = isProject ? `Something to build: ${topic ?? "new project"}` : topic ? `${topic}` : "A set of related saves";
      description = `These ${candidate.members.length} saves look related.`;
    }

    // Name conflicts (unique per user) — retry with a numeric suffix.
    let inserted: any = null;
    let insertError: any = null;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      const attemptName = attempt === 0 ? name : `${name} (${attempt + 1})`;
      const res = await client
        .from("collections")
        .insert({
          user_id: user.id,
          name: attemptName,
          description,
          origin: "ai_suggested",
          state: "suggested",
          kind: isProject ? "project" : "collection",
          basis: {
            detector: "m3-v1",
            signature: sig,
            signals: candidate.signals,
            member_ids: candidate.members.map((m) => m.id),
          },
        })
        .select("id, name, kind")
        .single();
      if (!res.error && res.data) {
        inserted = res.data;
      } else {
        insertError = res.error;
        if (res.error?.code !== "23505") break; // only retry on unique-name conflicts
      }
    }
    if (!inserted) {
      console.error("collection insert failed:", insertError?.message);
      continue;
    }

    const { error: memberError } = await client.from("collection_members").insert(
      candidate.members.map((m) => ({
        user_id: user.id,
        collection_id: inserted.id,
        memory_id: m.id,
        state: "suggested",
      }))
    );
    if (memberError) {
      console.error("collection members insert failed:", memberError.message);
    }

    created.push({ id: inserted.id, name: inserted.name, kind: inserted.kind });
    newCount += 1;
  }

  return { created, skipped: null };
}

// ------------------------------------------------------------- lifecycle

export type CollectionAction = "accept" | "dismiss" | "archive" | "rename";

export async function actOnCollection(
  collectionId: string,
  action: CollectionAction,
  payload: { name?: string } = {},
  deps: CollectionsDeps = {}
): Promise<{ ok: true; state: string } | { ok: false; reason: string }> {
  const client = await (deps.getClient ?? defaultUserClient)();
  const { data: row } = await client
    .from("collections")
    .select("id, state, basis")
    .eq("id", collectionId)
    .maybeSingle();
  if (!row) return { ok: false, reason: "not_found" };

  const nowIso = new Date().toISOString();

  if (action === "rename") {
    const name = (payload.name ?? "").trim().slice(0, 80);
    if (!name) return { ok: false, reason: "invalid_name" };
    if (row.state === "dismissed") return { ok: false, reason: "invalid_state" };
    const { error } = await client.from("collections").update({ name, updated_at: nowIso }).eq("id", collectionId);
    if (error) {
      return { ok: false, reason: error.code === "23505" ? "name_taken" : "update_failed" };
    }
    return { ok: true, state: row.state };
  }

  if (action === "accept") {
    if (row.state !== "suggested") return { ok: false, reason: "invalid_state" };
    const basis = { ...((row.basis as any) ?? {}), accepted_at: nowIso };
    const { error } = await client
      .from("collections")
      .update({ state: "accepted", basis, updated_at: nowIso })
      .eq("id", collectionId);
    if (error) return { ok: false, reason: "update_failed" };
    // membership becomes active
    await client
      .from("collection_members")
      .update({ state: "confirmed" })
      .eq("collection_id", collectionId);
    return { ok: true, state: "accepted" };
  }

  if (action === "dismiss") {
    if (row.state === "dismissed") return { ok: true, state: "dismissed" };
    const basis = { ...((row.basis as any) ?? {}), dismissed_at: nowIso };
    const { error } = await client
      .from("collections")
      .update({ state: "dismissed", basis, updated_at: nowIso })
      .eq("id", collectionId);
    if (error) return { ok: false, reason: "update_failed" };
    return { ok: true, state: "dismissed" };
  }

  // archive
  if (row.state !== "accepted") return { ok: false, reason: "invalid_state" };
  const { error } = await client
    .from("collections")
    .update({ state: "archived", updated_at: nowIso })
    .eq("id", collectionId);
  if (error) return { ok: false, reason: "update_failed" };
  return { ok: true, state: "archived" };
}

/** Accepted collections a memory belongs to (Memory Detail chips). */
export async function collectionsForMemory(
  memoryId: string,
  deps: CollectionsDeps = {}
): Promise<Array<{ id: string; name: string; kind: string }>> {
  const client = await (deps.getClient ?? defaultUserClient)();
  const { data: rows } = await client
    .from("collection_members")
    .select("collection_id, collections!inner(id, name, kind, state)")
    .eq("memory_id", memoryId);
  return (rows ?? [])
    .map((row: any) => row.collections)
    .filter((c: any) => c && c.state === "accepted")
    .map((c: any) => ({ id: c.id, name: c.name, kind: c.kind }));
}
