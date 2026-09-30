/**
 * M5 personal learning (Phase 6): structured signals + contextual reasoning.
 *
 * Everything is deterministic: cases are derived from existing user actions
 * (memory_events, connection/collection decisions, PA interactions), aggregated
 * into classes, and promoted to tentative/established patterns only past
 * configurable thresholds. Patterns decay, expire, and are capped in
 * confidence. AI inference contributes ZERO weight. Learning influences only
 * the GPT-OSS reasoning stage as a ≤6-line personal-context bundle — vision,
 * embeddings and retrieval stay objective. The user's current note always wins.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export const DAY_MS = 86400000;

/** All thresholds/weights/half-lives in one place (Phase 6: tunable defaults). */
export const LEARNING_CONFIG = {
  // promotion thresholds (weighted evidence; ≈³3/≈5 fresh cases — accommodates per-case decay)
  minTentativeWeight: Number(process.env.LEARNING_TENTATIVE_WEIGHT ?? 2.5),
  minEstablishedWeight: Number(process.env.LEARNING_ESTABLISHED_WEIGHT ?? 4.5),
  minDistinctDays: Number(process.env.LEARNING_MIN_DAYS ?? 2),
  minEstablishedDays: Number(process.env.LEARNING_MIN_ESTABLISHED_DAYS ?? 3),
  minDistinctMemories: 2,
  // confidence
  inferredCap: 0.9,
  expiryFloor: Number(process.env.LEARNING_EXPIRY_FLOOR ?? 0.2),
  // evidence weights (AI-origin is never evidence)
  weights: {
    user_correction: 1.0, // direct user action / statement
    accepted_ai_suggestion: 0.4, // accepting a suggestion is weaker than authorship
    ai_inference: 0.0,
  },
  // decay
  halfLifeDays: { intent: 120, topic: 120, action: 120, connection: 75, collection: 90, pa: 75 } as Record<string, number>,
  // negative (suppression) bars — negatives act faster but narrower
  negativeBars: { connection: 3, collection: 2, pa: 2 } as Record<string, number>,
  suppressionDays: { connection: 75, collection: 90, pa: 75 } as Record<string, number>,
  raisedConnectionFloor: 0.1, // after a suppression expires, suggestions resume with a raised floor
  // context bundle
  maxContextLines: Number(process.env.LEARNING_MAX_CONTEXT_LINES ?? 6),
} as const;

export type LearningScope = "intent" | "topic" | "action" | "connection" | "collection" | "pa";

export type LearningCase = {
  scope: LearningScope;
  condition: Record<string, unknown>;
  conclusion: Record<string, unknown>;
  polarity: "positive" | "negative";
  weight: number;
  memoryId: string;
  at: number; // ms epoch
};

export type EvidenceRef = { memory_id: string; at: string; weight: number };

export type PatternDraft = {
  scope: LearningScope;
  conditionKey: string;
  condition: Record<string, unknown>;
  conclusion: Record<string, unknown>;
  polarity: "positive" | "negative";
  weighted: number;
  evidenceCount: number;
  latestAt: number;
  distinctDays: number;
  distinctMemories: number;
  evidence: EvidenceRef[];
};

// --------------------------------------------------------------- helpers

export function normalizeTopic(topic: unknown): string {
  return typeof topic === "string" ? topic.trim().toLowerCase() : "";
}

/** Recency-decayed weight of one case (half-life by scope). */
export function decayedWeight(c: LearningCase, now: number, halfLifeDays?: number): number {
  const halfLife = halfLifeDays ?? LEARNING_CONFIG.halfLifeDays[c.scope] ?? 90;
  const ageDays = Math.max(0, (now - c.at) / DAY_MS);
  return c.weight * Math.pow(0.5, ageDays / halfLife);
}

/** Effective (decayed) confidence for an existing pattern row. */
export function effectiveConfidence(
  pattern: { confidence: number; half_life_days?: number | null; last_reinforced_at?: string | null; scope: string },
  now = Date.now()
): number {
  const halfLife = pattern.half_life_days ?? LEARNING_CONFIG.halfLifeDays[pattern.scope] ?? 90;
  const since = pattern.last_reinforced_at ? Math.max(0, (now - Date.parse(pattern.last_reinforced_at)) / DAY_MS) : 0;
  return pattern.confidence * Math.pow(0.5, since / halfLife);
}

export function conditionKeyOf(condition: Record<string, unknown>): string {
  const topic = normalizeTopic(condition.topic);
  const relation = typeof condition.relationship_type === "string" ? condition.relationship_type : "";
  const intent = typeof condition.intent === "string" ? condition.intent : "";
  const kind = typeof condition.kind === "string" ? condition.kind : "";
  return [topic || "*", relation, intent, kind].join("|");
}

// ------------------------------------------------------- case extraction

export type EventRow = {
  event_type: string;
  old_value: string | null;
  new_value: string;
  memory_id: string;
  actor: string;
  source: string;
  created_at: string;
};

export type MemoryLite = { id: string; topic: string | null; current_intent: string | null; created_at: string };

/** Corrections from memory_events — only genuine user actions count. */
export function casesFromEvents(events: EventRow[], memories: Map<string, MemoryLite>): LearningCase[] {
  const out: LearningCase[] = [];
  for (const event of events) {
    if (event.actor !== "user") continue; // AI/system actions are never evidence
    if (event.source !== "user_statement") continue;
    const memory = memories.get(event.memory_id);
    if (!memory) continue;
    const topic = normalizeTopic(memory.topic) || null;
    const at = Date.parse(event.created_at);
    const condition = topic ? { topic } : {};
    if (event.event_type === "intent_change") {
      out.push({ scope: "intent", condition, conclusion: { intent: event.new_value, from: event.old_value ?? null }, polarity: "positive", weight: LEARNING_CONFIG.weights.user_correction, memoryId: event.memory_id, at });
    } else if (event.event_type === "action_change") {
      out.push({ scope: "action", condition, conclusion: { action: event.new_value, from: event.old_value ?? null }, polarity: "positive", weight: LEARNING_CONFIG.weights.user_correction, memoryId: event.memory_id, at });
    } else if (event.event_type === "topic_change") {
      out.push({
        scope: "topic",
        condition: memory.current_intent ? { intent: memory.current_intent } : {},
        conclusion: { topic: normalizeTopic(event.new_value) },
        polarity: "positive",
        weight: LEARNING_CONFIG.weights.user_correction,
        memoryId: event.memory_id,
        at,
      });
    }
  }
  return out;
}

export type ConnectionRow = {
  state: string;
  relationship_type: string;
  basis: Record<string, unknown> | null;
  created_at: string;
  source_memory_id?: string;
  target_memory_id?: string;
};

export function casesFromConnections(rows: ConnectionRow[]): LearningCase[] {
  const out: LearningCase[] = [];
  for (const row of rows) {
    if (row.state !== "confirmed" && row.state !== "dismissed") continue;
    const at = Date.parse((row.basis?.user_action_at as string) ?? row.created_at);
    if (row.state === "confirmed") {
      out.push({ scope: "connection", condition: { relationship_type: row.relationship_type }, conclusion: { prefer: true }, polarity: "positive", weight: LEARNING_CONFIG.weights.accepted_ai_suggestion, memoryId: row.source_memory_id ?? "", at });
    } else {
      out.push({ scope: "connection", condition: { relationship_type: row.relationship_type }, conclusion: { suppress: true }, polarity: "negative", weight: LEARNING_CONFIG.weights.user_correction, memoryId: row.target_memory_id ?? "", at });
    }
  }
  return out;
}

export type CollectionRow = {
  state: string;
  kind: string;
  basis: Record<string, unknown> | null;
  updated_at: string;
};

export function dominantTopicOfIds(ids: string[], memories: Map<string, MemoryLite>): string | null {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const topic = normalizeTopic(memories.get(id)?.topic);
    if (topic) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 2 ? top[0] : null;
}

export function casesFromCollections(rows: CollectionRow[], memories: Map<string, MemoryLite>): LearningCase[] {
  const out: LearningCase[] = [];
  for (const row of rows) {
    if (row.state !== "accepted" && row.state !== "dismissed") continue;
    const basis = row.basis ?? {};
    const memberIds = Array.isArray(basis.member_ids) ? (basis.member_ids as string[]) : [];
    const topic = dominantTopicOfIds(memberIds, memories);
    if (!topic) continue; // unscoped mutes are too broad — skip
    const at = Date.parse(
      (row.state === "accepted" ? (basis.accepted_at as string) : (basis.dismissed_at as string)) ?? row.updated_at
    );
    out.push({
      scope: "collection",
      condition: { topic },
      conclusion: { mute: row.state === "dismissed" },
      polarity: row.state === "accepted" ? "positive" : "negative",
      weight:
        row.state === "accepted" ? LEARNING_CONFIG.weights.accepted_ai_suggestion : LEARNING_CONFIG.weights.user_correction,
      memoryId: memberIds[0] ?? "",
      at,
    });
  }
  return out;
}

export type PaItemRow = {
  kind: string;
  memory_ids: string[];
  interaction: { action: string; at: string } | null;
};

/** PA interactions: only explicit user actions count; ignored items are NOT rejection. */
export function casesFromPaInteractions(items: PaItemRow[], memories: Map<string, MemoryLite>): LearningCase[] {
  const out: LearningCase[] = [];
  for (const item of items) {
    if (!item.interaction) continue; // ignored ≠ rejected
    if (item.kind !== "reminder") continue;
    const memoryId = item.memory_ids?.[0] ?? "";
    const topic = normalizeTopic(memories.get(memoryId)?.topic);
    if (!topic) continue; // unscoped mutes are too broad — skip
    const action = item.interaction.action;
    const at = Date.parse(item.interaction.at);
    if (action === "dismiss" || action === "snooze") {
      out.push({ scope: "pa", condition: { kind: "reminder", topic }, conclusion: { mute: true }, polarity: "negative", weight: LEARNING_CONFIG.weights.user_correction, memoryId, at });
    } else if (action === "complete" || action === "keep_active") {
      out.push({ scope: "pa", condition: { kind: "reminder", topic }, conclusion: { mute: false }, polarity: "positive", weight: LEARNING_CONFIG.weights.accepted_ai_suggestion, memoryId, at });
    }
  }
  return out;
}

// ------------------------------------------------------------ aggregation

/** Group cases into classes (scope + condition + polarity + conclusion) with decayed weights. */
export function aggregateCases(cases: LearningCase[], memories: Map<string, MemoryLite>, now = Date.now()): PatternDraft[] {
  const groups = new Map<string, LearningCase[]>();
  for (const c of cases) {
    if (c.weight <= 0) continue; // AI-origin etc.
    const topic = normalizeTopic(c.condition.topic);
    const key = [
      c.scope,
      topic || "*",
      c.polarity,
      JSON.stringify(c.conclusion),
    ].join("::");
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  const drafts: PatternDraft[] = [];
  for (const [, group] of Array.from(groups.entries())) {
    let weighted = 0;
    let latestAt = 0;
    const days = new Set<string>();
    const mems = new Set<string>();
    const evidence: EvidenceRef[] = [];
    for (const c of group) {
      weighted += decayedWeight(c, now);
      latestAt = Math.max(latestAt, c.at);
      days.add(new Date(c.at).toISOString().slice(0, 10));
      if (c.memoryId) mems.add(c.memoryId);
      evidence.push({ memory_id: c.memoryId, at: new Date(c.at).toISOString(), weight: c.weight });
    }
    // enrich condition with topic (may have been derived) — keep raw condition of first case
    const first = group[0];
    drafts.push({
      scope: first.scope,
      conditionKey: conditionKeyOf({ ...first.condition }),
      condition: first.condition,
      conclusion: first.conclusion,
      polarity: first.polarity,
      weighted: Math.round(weighted * 1000) / 1000,
      evidenceCount: group.length,
      latestAt,
      distinctDays: days.size,
      distinctMemories: mems.size,
      evidence: evidence.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 20),
    });
  }
  return drafts;
}

/** Evaluate a draft into a level or null (observations don't influence). */
export function evaluateDraft(
  draft: PatternDraft
): { level: "observation" | "tentative" | "active" | "suppressed"; confidence: number } {
  const cfg = LEARNING_CONFIG;
  if (draft.polarity === "negative") {
    const bar = cfg.negativeBars[draft.scope] ?? 3;
    if (draft.evidenceCount >= bar && draft.distinctDays >= cfg.minDistinctDays) {
      const confidence = Math.min(cfg.inferredCap, draft.evidenceCount / 5);
      return { level: "suppressed", confidence: Math.round(confidence * 100) / 100 };
    }
    return { level: "observation", confidence: 0 };
  }
  const confidence = Math.min(cfg.inferredCap, draft.weighted / 6);
  if (
    draft.weighted >= cfg.minEstablishedWeight &&
    draft.distinctDays >= cfg.minEstablishedDays &&
    draft.distinctMemories >= cfg.minDistinctMemories
  ) {
    return { level: "active", confidence: Math.round(confidence * 100) / 100 };
  }
  if (
    draft.weighted >= cfg.minTentativeWeight &&
    draft.distinctDays >= cfg.minDistinctDays &&
    draft.distinctMemories >= cfg.minDistinctMemories
  ) {
    return { level: "tentative", confidence: Math.round(confidence * 100) / 100 };
  }
  return { level: "observation", confidence: 0 };
}

// ------------------------------------------------------------- injection

export type ActivePattern = {
  id: string;
  scope: string;
  origin: string;
  status: string;
  condition: Record<string, unknown>;
  conclusion: Record<string, unknown>;
  confidence: number;
  half_life_days: number | null;
  last_reinforced_at: string | null;
  evidence_count: number;
};

function describePattern(p: ActivePattern): string {
  const topic = typeof p.condition.topic === "string" ? p.condition.topic : null;
  const topicPhrase = topic ? `“${topic}” saves` : "saves like this";
  const cases = p.evidence_count;
  const label = p.origin === "explicit" ? "[explicit]" : `[learned, ${cases} case${cases === 1 ? "" : "s"}]`;
  if (p.scope === "intent" && typeof p.conclusion.intent === "string") {
    const from = typeof p.conclusion.from === "string" ? ` over “${p.conclusion.from}”` : "";
    return `${label} For ${topicPhrase}, the user usually prefers intent “${p.conclusion.intent}”${from}.`;
  }
  if (p.scope === "action" && typeof p.conclusion.action === "string") {
    return `${label} For ${topicPhrase}, the user usually wants the next step “${p.conclusion.action}”.`;
  }
  if (p.scope === "topic" && typeof p.conclusion.topic === "string") {
    return `${label} The user tends to file these under topic “${p.conclusion.topic}”.`;
  }
  return `${label} A learned preference applies to ${topicPhrase}.`;
}

/**
 * Compact personal-context bundle for the reasoning stage.
 * Relevant patterns only; explicit first; ≤ maxContextLines lines.
 */
export function selectContextLines(input: {
  patterns: ActivePattern[];
  note: string | null;
  contextText: string; // visual description + visible text + entities
  cardTopics: string[];
  now?: number;
}): { lines: string[]; patternIds: string[] } {
  const now = input.now ?? Date.now();
  const cfg = LEARNING_CONFIG;
  const haystack = `${input.note ?? ""} ${input.contextText}`.toLowerCase();
  const cardTopics = new Set(input.cardTopics.map((t) => normalizeTopic(t)).filter(Boolean));

  const usable = input.patterns
    .filter((p) => ["tentative", "active"].includes(p.status) || p.origin === "explicit")
    .filter((p) => p.status !== "expired" && p.status !== "suppressed" && p.status !== "retired" && p.status !== "superseded")
    .filter((p) => ["intent", "action", "topic"].includes(p.scope))
    .filter((p) => p.origin === "explicit" || effectiveConfidence(p, now) >= cfg.expiryFloor);

  const relevant = usable.filter((p) => {
    if (p.origin === "explicit") return true;
    const topic = normalizeTopic(p.condition.topic);
    if (!topic) return false; // unscoped inferred hints are too broad — skip
    return haystack.includes(topic) || cardTopics.has(topic);
  });

  relevant.sort((a, b) => {
    const aExplicit = a.origin === "explicit" ? 0 : 1;
    const bExplicit = b.origin === "explicit" ? 0 : 1;
    if (aExplicit !== bExplicit) return aExplicit - bExplicit;
    return effectiveConfidence(b, now) - effectiveConfidence(a, now);
  });

  const picked = relevant.slice(0, cfg.maxContextLines);
  return { lines: picked.map(describePattern), patternIds: picked.map((p) => p.id) };
}

// ------------------------------------------------------------------- IO

export type LearningDeps = { getClient?: () => Promise<any> };

async function defaultAdminClient(): Promise<any> {
  return createAdminClient();
}

/** Daily consolidation (Phase 6 §23): recompute evidence, promote, decay, expire. */
export async function consolidateLearning(
  userId: string,
  deps: LearningDeps = {}
): Promise<{ created: number; updated: number; expired: number; suppressed: number }> {
  const client = await (deps.getClient ?? defaultAdminClient)();
  const now = Date.now();
  const since = new Date(now - 180 * DAY_MS).toISOString();

  const { data: memRows } = await client
    .from("memories")
    .select("id, topic, current_intent, created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .limit(400);
  const memories: MemoryLite[] = memRows ?? [];
  const memoryMap = new Map(memories.map((m) => [m.id, m]));

  const { data: eventRows } = await client
    .from("memory_events")
    .select("event_type, old_value, new_value, memory_id, actor, source, created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .in("event_type", ["intent_change", "action_change", "topic_change"])
    .limit(1000);

  const { data: connRows } = await client
    .from("connections")
    .select("state, relationship_type, basis, created_at, source_memory_id, target_memory_id")
    .eq("user_id", userId)
    .in("state", ["confirmed", "dismissed"])
    .limit(500);

  const { data: colRows } = await client
    .from("collections")
    .select("state, kind, basis, updated_at")
    .eq("user_id", userId)
    .in("state", ["accepted", "dismissed"])
    .limit(200);

  const { data: reportRows } = await client
    .from("pa_reports")
    .select("content")
    .eq("user_id", userId)
    .gte("generated_at", new Date(now - 120 * DAY_MS).toISOString())
    .limit(100);
  const paItems: PaItemRow[] = [];
  for (const report of reportRows ?? []) {
    for (const item of ((report.content as any)?.items ?? []) as PaItemRow[]) {
      paItems.push(item);
    }
  }

  const cases: LearningCase[] = [
    ...casesFromEvents((eventRows ?? []) as EventRow[], memoryMap),
    ...casesFromConnections((connRows ?? []) as ConnectionRow[]),
    ...casesFromCollections((colRows ?? []) as CollectionRow[], memoryMap),
    ...casesFromPaInteractions(paItems, memoryMap),
  ];

  const drafts = aggregateCases(cases, memoryMap, now);

  const { data: existingRows } = await client
    .from("learned_patterns")
    .select("*")
    .eq("user_id", userId)
    .limit(300);
  const existing = existingRows ?? [];

  let created = 0;
  let updated = 0;
  let expired = 0;
  let suppressed = 0;
  const touchedIds = new Set<string>();

  for (const draft of drafts) {
    const evaluation = evaluateDraft(draft);
    if (evaluation.level === "observation") continue;

    const match = existing.find(
      (row: any) =>
        row.scope === draft.scope &&
        conditionKeyOf(row.condition ?? {}) === draft.conditionKey &&
        JSON.stringify(row.conclusion ?? {}) === JSON.stringify(draft.conclusion)
    );

    const status =
      evaluation.level === "suppressed" ? "suppressed" : evaluation.level === "active" ? "active" : "tentative";
    const suppressedUntil =
      evaluation.level === "suppressed"
        ? new Date(now + (LEARNING_CONFIG.suppressionDays[draft.scope] ?? 75) * DAY_MS).toISOString()
        : null;

    const rowPayload: Record<string, unknown> = {
      user_id: userId,
      scope: draft.scope,
      origin: "inferred",
      status,
      condition: draft.condition,
      conclusion: draft.conclusion,
      confidence: evaluation.confidence,
      half_life_days: LEARNING_CONFIG.halfLifeDays[draft.scope] ?? 90,
      evidence_count: draft.evidenceCount,
      positive_count: draft.polarity === "positive" ? draft.evidenceCount : 0,
      negative_count: draft.polarity === "negative" ? draft.evidenceCount : 0,
      evidence: draft.evidence,
      last_reinforced_at: new Date(Math.max(draft.latestAt, Date.parse(match?.last_reinforced_at ?? "0") || 0)).toISOString(),
      suppressed_until: suppressedUntil,
      updated_at: new Date(now).toISOString(),
    };

    if (match) {
      await client.from("learned_patterns").update(rowPayload).eq("id", match.id).eq("user_id", userId);
      touchedIds.add(match.id);
      updated += 1;
    } else {
      // supersede any existing pattern for the same condition with a different conclusion
      for (const other of existing) {
        if (
          other.scope === draft.scope &&
          conditionKeyOf(other.condition ?? {}) === draft.conditionKey &&
          JSON.stringify(other.conclusion ?? {}) !== JSON.stringify(draft.conclusion) &&
          ["tentative", "active"].includes(other.status) &&
          evaluation.confidence > (other.confidence ?? 0)
        ) {
          await client
            .from("learned_patterns")
            .update({ status: "superseded", updated_at: new Date(now).toISOString() })
            .eq("id", other.id)
            .eq("user_id", userId);
        }
      }
      await client.from("learned_patterns").insert(rowPayload);
      created += 1;
    }
    if (status === "suppressed") suppressed += 1;
  }

  // decay + expiry for untouched patterns (and expired suppressions)
  for (const row of existing) {
    if (touchedIds.has(row.id)) continue;
    if (["expired", "retired", "superseded"].includes(row.status)) continue;
    const effective = effectiveConfidence(row, now);
    const suppressionExpired =
      row.status === "suppressed" && row.suppressed_until && Date.parse(row.suppressed_until) <= now;
    if (suppressionExpired) {
      await client
        .from("learned_patterns")
        .update({ status: "expired", updated_at: new Date(now).toISOString() })
        .eq("id", row.id)
        .eq("user_id", userId);
      expired += 1;
      continue;
    }
    if (effective < LEARNING_CONFIG.expiryFloor) {
      await client
        .from("learned_patterns")
        .update({ status: "expired", updated_at: new Date(now).toISOString() })
        .eq("id", row.id)
        .eq("user_id", userId);
      expired += 1;
    }
  }

  return { created, updated, expired, suppressed };
}

/** Active suppression sets for downstream consumers (never makes anything louder). */
export async function loadSuppressions(
  userId: string,
  deps: LearningDeps = {}
): Promise<{
  connectionTypes: string[];
  mutedTopics: string[];
  raisedConnectionFloor: number;
}> {
  const client = await (deps.getClient ?? defaultAdminClient)();
  const now = Date.now();
  const { data: rows } = await client
    .from("learned_patterns")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["suppressed", "expired"])
    .limit(200);

  const connectionTypes: string[] = [];
  const mutedTopics: string[] = [];
  let raisedFloor = 0;

  for (const row of rows ?? []) {
    const until = row.suppressed_until ? Date.parse(row.suppressed_until) : 0;
    const active = row.status === "suppressed" && until > now;
    if (row.scope === "connection" && active && row.conclusion?.suppress && row.condition?.relationship_type) {
      connectionTypes.push(String(row.condition.relationship_type));
    }
    if (row.scope === "connection" && row.status === "expired") {
      raisedFloor = Math.max(raisedFloor, LEARNING_CONFIG.raisedConnectionFloor);
    }
    if ((row.scope === "collection" || row.scope === "pa") && active && row.conclusion?.mute) {
      // topics come from case evidence; use condition topic when present
      const topic = normalizeTopic(row.condition?.topic);
      if (topic) mutedTopics.push(topic);
    }
  }
  return { connectionTypes, mutedTopics, raisedConnectionFloor: raisedFloor };
}

/** Compact personal-context bundle for a capture (used by the reasoning step). */
export async function buildLearningContext(
  userId: string,
  input: { note: string | null; perceptionText: string; cardTopics: string[] },
  deps: LearningDeps = {}
): Promise<{ lines: string[]; patternIds: string[] }> {
  const client = await (deps.getClient ?? defaultAdminClient)();
  const { data: rows } = await client
    .from("learned_patterns")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["tentative", "active", "suppressed", "expired"])
    .limit(200);
  const patterns: ActivePattern[] = (rows ?? []).map((row: any) => ({
    id: row.id,
    scope: row.scope,
    origin: row.origin,
    status: row.status,
    condition: row.condition ?? {},
    conclusion: row.conclusion ?? {},
    confidence: row.confidence ?? 0,
    half_life_days: row.half_life_days ?? null,
    last_reinforced_at: row.last_reinforced_at ?? null,
    evidence_count: row.evidence_count ?? 0,
  }));
  return selectContextLines({
    patterns,
    note: input.note,
    contextText: input.perceptionText,
    cardTopics: input.cardTopics,
  });
}
