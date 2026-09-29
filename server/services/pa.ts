import crypto from "node:crypto";
import { composePaReport } from "@/server/ai/providers";
import { createAdminClient } from "@/lib/supabase/admin";
import { actOnCollection, runDiscovery, type DiscoveryResult } from "./collections";

/**
 * M4 Personal Assistant (Phase 5): quiet, scheduled, deterministic-first.
 *
 * Everything that selects, counts, gates, filters, validates or suppresses is
 * deterministic (this file). The reasoning model is used ONLY to word already
 * selected items — one call per populated report, zero calls on quiet periods.
 * The model never searches the database, never invents memories, never creates
 * tasks, and never writes state. Reminders never modify memories; user actions do.
 */

export const DAY_MS = 86400000;

export const REMINDER_MIN_AGE: Record<string, number> = {
  buy: 14,
  compare: 14,
  contact: 14,
  research: 21,
  try: 21,
  build: 21,
  read: 30,
  watch: 30,
  save_for_later: 30,
};
export const REMINDER_COOLDOWN_DAYS = 21;
export const REMINDER_MAX_PER_REPORT = 2;
export const SUPPRESS_DAYS_AFTER_2_IGNORES = 90;
export const SUPPRESS_INDEFINITE = "9999-12-31T00:00:00.000Z";
export const RECALL_OLD_DAYS = 60;
export const RECALL_SAVED_FOR_LATER_DAYS = 30;
export const RECALL_RECENT_DAYS = 7;
export const RECALL_DEDUP_DAYS = 90;
export const MAX_REPORT_ITEMS = 5;
export const MAX_EVIDENCE_CANDIDATES = 12;
export const MAX_EMERGING_ITEMS = 2;
export const PA_PERIOD_GRACE_MS = 3 * DAY_MS; // one full Mon/Thu period

export type PaState = {
  last_reminded_at?: string;
  snoozed_until?: string;
  suppressed_until?: string;
  suppressed_at?: string;
  ignore_count?: number;
  last_recall_at?: string;
  recall_dismissed_at?: string;
};

export type PaMemory = {
  id: string;
  capture_id: string;
  title: string;
  note: string | null;
  topic: string | null;
  current_intent: string | null;
  intent_source: string | null;
  suggested_action: string | null;
  status: string;
  created_at: string;
  pa_state: PaState;
  last_user_event_at?: string | null;
};

export type PlanItem = {
  id: string;
  kind: "reminder" | "pattern" | "project_candidate" | "recall";
  claim_type: "fact" | "inference" | "suggestion";
  memoryIds: string[];
  meta: Record<string, unknown>;
  actions: string[];
};

export type PaItem = {
  id: string;
  kind: PlanItem["kind"];
  claim_type: PlanItem["claim_type"];
  memory_ids: string[];
  wording: string;
  actions: string[];
  meta: Record<string, unknown>;
  evidence: Array<{ memory_id: string; title: string; note: string | null; age_days: number }>;
  interaction: null | { action: string; at: string };
};

export const ITEM_ACTIONS: Record<PlanItem["kind"], string[]> = {
  reminder: ["open", "keep_active", "snooze", "complete", "dismiss"],
  pattern: ["open", "dismiss"],
  project_candidate: ["open", "dismiss"],
  recall: ["open", "dismiss"],
};

const OPEN_STATUSES = ["new", "active"];
const ACTIONABLE = Object.keys(REMINDER_MIN_AGE);

// ------------------------------------------------------------ reminders

export function reminderEligibility(
  m: PaMemory,
  now = Date.now()
): { eligible: boolean; reason: string; minAgeDays: number } {
  const minAgeDays = m.current_intent ? REMINDER_MIN_AGE[m.current_intent] ?? 0 : 0;
  if (!m.current_intent || !ACTIONABLE.includes(m.current_intent)) {
    return { eligible: false, reason: "intent_not_actionable", minAgeDays: 0 };
  }
  if (m.intent_source !== "user_statement" && m.intent_source !== "strong_context") {
    return { eligible: false, reason: "intent_source", minAgeDays };
  }
  if (!OPEN_STATUSES.includes(m.status)) {
    return { eligible: false, reason: "status", minAgeDays };
  }
  const ageDays = (now - Date.parse(m.created_at)) / DAY_MS;
  if (ageDays < minAgeDays) {
    return { eligible: false, reason: "too_young", minAgeDays };
  }
  const state = m.pa_state ?? {};
  if (state.snoozed_until && Date.parse(state.snoozed_until) > now) {
    return { eligible: false, reason: "snoozed", minAgeDays };
  }
  const ignoreCount = state.ignore_count ?? 0;
  // Indefinite suppression lifts once the user opens the memory or changes it.
  const liftedIndefinite =
    ignoreCount >= 3 &&
    Boolean(state.suppressed_at) &&
    Boolean(m.last_user_event_at) &&
    Date.parse(m.last_user_event_at as string) > Date.parse(state.suppressed_at as string);
  if (state.suppressed_until) {
    const suppressedUntil = Date.parse(state.suppressed_until);
    if (suppressedUntil > now && !liftedIndefinite) {
      return { eligible: false, reason: "suppressed", minAgeDays };
    }
  }
  if (ignoreCount >= 3 && !liftedIndefinite) {
    return { eligible: false, reason: "suppressed_indefinite", minAgeDays };
  }
  if (state.last_reminded_at) {
    const cooldownDays = REMINDER_COOLDOWN_DAYS * Math.pow(2, Math.min(ignoreCount, 1));
    if (now - Date.parse(state.last_reminded_at) < cooldownDays * DAY_MS) {
      return { eligible: false, reason: "cooldown", minAgeDays };
    }
  }
  return { eligible: true, reason: "ok", minAgeDays };
}

/** Top reminders: user-stated first, then most overdue. Deterministic. */
export function selectReminders(
  memories: PaMemory[],
  now = Date.now(),
  cap = REMINDER_MAX_PER_REPORT
): { selected: PaMemory[]; eligibleCount: number } {
  const eligible = memories.filter((m) => reminderEligibility(m, now).eligible);
  eligible.sort((a, b) => {
    const aUser = a.intent_source === "user_statement" ? 0 : 1;
    const bUser = b.intent_source === "user_statement" ? 0 : 1;
    if (aUser !== bUser) return aUser - bUser;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
  return { selected: eligible.slice(0, cap), eligibleCount: eligible.length };
}

/**
 * Ignore escalation: a reminder shown in a report that is now one full period
 * old and was never interacted with counts as ignored (Phase 5 §8).
 */
export function computeEscalations(
  lastReport: { generated_at: string; content: any } | null,
  now = Date.now(),
  graceMs = PA_PERIOD_GRACE_MS
): string[] {
  if (!lastReport) return [];
  if (now - Date.parse(lastReport.generated_at) < graceMs) return [];
  const out: string[] = [];
  for (const item of lastReport.content?.items ?? []) {
    if (item?.kind !== "reminder") continue;
    if (item.interaction) continue;
    const memoryId = item.memory_ids?.[0];
    if (memoryId) out.push(String(memoryId));
  }
  return out;
}

export function escalationUpdate(current: PaState, now = Date.now()): PaState {
  const ignoreCount = (current.ignore_count ?? 0) + 1;
  const next: PaState = { ...current, ignore_count: ignoreCount };
  if (ignoreCount === 2) {
    next.suppressed_until = new Date(now + SUPPRESS_DAYS_AFTER_2_IGNORES * DAY_MS).toISOString();
  }
  if (ignoreCount >= 3) {
    next.suppressed_until = SUPPRESS_INDEFINITE;
    next.suppressed_at = new Date(now).toISOString();
  }
  return next;
}

// ---------------------------------------------------------------- recall

export function pickRecall(input: {
  memories: PaMemory[];
  connections: Array<{ source_memory_id: string; target_memory_id: string; state: string }>;
  usedIds: Set<string>;
  now?: number;
}):
  | { memory: PaMemory; reason: "connected_recent"; partnerId: string }
  | { memory: PaMemory; reason: "saved_for_later" }
  | null {
  const now = input.now ?? Date.now();
  const excluded = ["completed", "dismissed", "archived"];

  const recallEligible = (m: PaMemory) => {
    if (excluded.includes(m.status)) return false;
    if (input.usedIds.has(m.id)) return false;
    const state = m.pa_state ?? {};
    if (state.last_recall_at && now - Date.parse(state.last_recall_at) < RECALL_DEDUP_DAYS * DAY_MS)
      return false;
    if (
      state.recall_dismissed_at &&
      now - Date.parse(state.recall_dismissed_at) < RECALL_DEDUP_DAYS * DAY_MS
    )
      return false;
    return true;
  };

  const byId = new Map(input.memories.map((m) => [m.id, m]));
  const freshCut = now - RECALL_RECENT_DAYS * DAY_MS;

  // (a) old memory (≥60d) connected to something saved in the last 7 days
  const oldOnes = input.memories
    .filter(
      (m) => recallEligible(m) && now - Date.parse(m.created_at) >= RECALL_OLD_DAYS * DAY_MS
    )
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const m of oldOnes) {
    const connection = input.connections.find(
      (c) => c.state !== "dismissed" && (c.source_memory_id === m.id || c.target_memory_id === m.id)
    );
    if (!connection) continue;
    const partnerId =
      connection.source_memory_id === m.id ? connection.target_memory_id : connection.source_memory_id;
    const partner = byId.get(partnerId);
    if (partner && !excluded.includes(partner.status) && Date.parse(partner.created_at) >= freshCut) {
      return { memory: m, reason: "connected_recent", partnerId };
    }
  }

  // (b) save_for_later ≥30 days as a quiet line
  const savedForLater = input.memories
    .filter(
      (m) =>
        recallEligible(m) &&
        m.current_intent === "save_for_later" &&
        now - Date.parse(m.created_at) >= RECALL_SAVED_FOR_LATER_DAYS * DAY_MS
    )
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (savedForLater[0]) return { memory: savedForLater[0], reason: "saved_for_later" };

  return null;
}

// ------------------------------------------------------------------ plan

export function assemblePlan(input: {
  reminderMemories: PaMemory[];
  emerging: Array<{
    collectionId: string;
    kind: string;
    name: string;
    memberIds: string[];
    signals: string[];
  }>;
  recall: { memory: PaMemory; reason: string; partnerId?: string } | null;
  now?: number;
}): {
  items: PlanItem[];
  evidenceIds: string[];
  droppedRecall: boolean;
  droppedEmerging: number;
} {
  const items: PlanItem[] = [];

  for (const m of input.reminderMemories) {
    items.push({
      id: crypto.randomUUID(),
      kind: "reminder",
      claim_type: "fact",
      memoryIds: [m.id],
      meta: {
        memory_id: m.id,
        capture_id: m.capture_id,
        age_days: Math.floor((Date.now() - Date.parse(m.created_at)) / DAY_MS),
      },
      actions: ITEM_ACTIONS.reminder,
    });
  }

  const emerging = [...input.emerging].sort((a, b) => {
    const aP = a.kind === "project" ? 0 : 1;
    const bP = b.kind === "project" ? 0 : 1;
    if (aP !== bP) return aP - bP;
    return (b.memberIds?.length ?? 0) - (a.memberIds?.length ?? 0);
  });
  let droppedEmerging = 0;
  for (const e of emerging) {
    if (items.filter((i) => i.kind === "pattern" || i.kind === "project_candidate").length >= MAX_EMERGING_ITEMS) {
      droppedEmerging += 1;
      continue;
    }
    items.push({
      id: crypto.randomUUID(),
      kind: e.kind === "project" ? "project_candidate" : "pattern",
      claim_type: "suggestion",
      memoryIds: e.memberIds,
      meta: { collection_id: e.collectionId, name: e.name, signals: e.signals },
      actions: ITEM_ACTIONS[e.kind === "project" ? "project_candidate" : "pattern"],
    });
  }

  let droppedRecall = false;
  if (input.recall) {
    items.push({
      id: crypto.randomUUID(),
      kind: "recall",
      claim_type: input.recall.reason === "connected_recent" ? "inference" : "fact",
      memoryIds: [input.recall.memory.id],
      meta: {
        memory_id: input.recall.memory.id,
        capture_id: input.recall.memory.capture_id,
        reason: input.recall.reason,
        partner_id: input.recall.partnerId ?? null,
      },
      actions: ITEM_ACTIONS.recall,
    });
  }

  // global cap (reminders → emerging → recall priority)
  while (items.length > MAX_REPORT_ITEMS) {
    const last = items.pop();
    if (last?.kind === "recall") droppedRecall = true;
  }

  // evidence bundle cap — trim lowest-priority items until it fits
  const evidenceOf = (i: PlanItem) => i.memoryIds;
  let evidenceIds = items.flatMap(evidenceOf);
  while (evidenceIds.length > MAX_EVIDENCE_CANDIDATES && items.length > 0) {
    const last = items.pop();
    if (last?.kind === "recall") droppedRecall = true;
    evidenceIds = items.flatMap(evidenceOf);
  }

  return { items, evidenceIds, droppedRecall, droppedEmerging };
}

// -------------------------------------------------------------- wording

const BANNED_PHRASES = ["you want", "you plan", "you're interested", "you are interested", "you need"];

export function validateWording(
  item: PlanItem,
  wording: string,
  memoryById: Map<string, PaMemory>
): { ok: boolean; wording: string } {
  const w = (wording ?? "").trim().slice(0, 220);
  if (!w) return { ok: false, wording: "" };
  const lower = w.toLowerCase();
  if (BANNED_PHRASES.some((phrase) => lower.includes(phrase))) return { ok: false, wording: "" };
  const quoted = w.match(/[“"]([^”"]{4,})[”"]/g) ?? [];
  for (const q of quoted) {
    const inner = q.slice(1, -1);
    const notes = item.memoryIds
      .map((id) => memoryById.get(id)?.note ?? "")
      .join("\u0000");
    if (!notes.includes(inner)) return { ok: false, wording: "" };
  }
  return { ok: true, wording: w };
}

export function fallbackWording(item: PlanItem, memoryById: Map<string, PaMemory>): string {
  const memory = memoryById.get(item.memoryIds[0]);
  const ageDays = memory ? Math.floor((Date.now() - Date.parse(memory.created_at)) / DAY_MS) : 0;
  switch (item.kind) {
    case "reminder":
      return memory?.note
        ? `You said: “${memory.note.slice(0, 140)}” — still interested?`
        : `You saved this ${ageDays} days ago — still on your list?`;
    case "pattern":
      return `ScreenView noticed ${item.memoryIds.length} saves around “${
        (item.meta?.name as string) ?? "one theme"
      }” lately — want to group them?`;
    case "project_candidate":
      return `ScreenView noticed these ${item.memoryIds.length} saves may be converging on something to build — want to make it a project?`;
    case "recall":
      return item.meta?.reason === "connected_recent"
        ? `You saved this a while ago — it connects to something you saved this week.`
        : `Saved for later ${ageDays} days ago — still worth a look?`;
    default:
      return "ScreenView has something for you.";
  }
}

export function buildSections(items: Array<{ id: string; kind: string }>) {
  const groups: Array<[string, string[]]> = [
    ["needs_attention", []],
    ["emerging", []],
    ["everything_else", []],
  ];
  for (const item of items) {
    if (item.kind === "reminder") groups[0][1].push(item.id);
    else if (item.kind === "pattern" || item.kind === "project_candidate") groups[1][1].push(item.id);
    else groups[2][1].push(item.id);
  }
  return groups.filter(([, ids]) => ids.length > 0).map(([key, item_ids]) => ({ key, item_ids }));
}

// -------------------------------------------------------------------- IO

export type PaDeps = {
  getClient?: () => Promise<any>;
  compose?: typeof composePaReport;
  discover?: (deps: { getClient: () => Promise<any>; userId: string }) => Promise<DiscoveryResult>;
};

async function defaultAdminClient(): Promise<any> {
  return createAdminClient();
}

async function defaultUserClient(): Promise<any> {
  const { createClient } = await import("@/lib/supabase/server");
  return createClient();
}

export async function generatePaReportForUser(
  userId: string,
  deps: PaDeps = {}
): Promise<{ reportId: string; is_empty: boolean; items: number; llmCalls: number }> {
  const client = await (deps.getClient ?? defaultAdminClient)();
  const compose = deps.compose ?? composePaReport;
  const discover = deps.discover ?? ((d) => runDiscovery(d));
  const now = Date.now();

  // ---- load data (scoped to this user) ----
  const since = new Date(now - 180 * DAY_MS).toISOString();
  const { data: memRows } = await client
    .from("memories")
    .select("id, capture_id, title, topic, current_intent, intent_source, suggested_action, status, created_at, pa_state")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(300);
  const memoriesRaw: any[] = memRows ?? [];

  const captureIds = Array.from(new Set(memoriesRaw.map((m) => m.capture_id)));
  const { data: caps } = captureIds.length
    ? await client.from("captures").select("id, original_note").in("id", captureIds)
    : { data: [] as any[] };
  const noteById = new Map<string, string | null>(
    (caps ?? []).map((c: any) => [c.id, c.original_note ?? null])
  );

  const { data: eventRows } = await client
    .from("memory_events")
    .select("memory_id, created_at")
    .eq("user_id", userId)
    .eq("actor", "user")
    .order("created_at", { ascending: false })
    .limit(700);
  const lastUserEvent = new Map<string, string>();
  for (const e of eventRows ?? []) {
    if (!lastUserEvent.has(e.memory_id)) lastUserEvent.set(e.memory_id, e.created_at);
  }

  const memories: PaMemory[] = memoriesRaw.map((m) => ({
    id: m.id,
    capture_id: m.capture_id,
    title: m.title,
    note: noteById.get(m.capture_id) ?? null,
    topic: m.topic ?? null,
    current_intent: m.current_intent ?? null,
    intent_source: m.intent_source ?? null,
    suggested_action: m.suggested_action ?? null,
    status: m.status,
    created_at: m.created_at,
    pa_state: (m.pa_state ?? {}) as PaState,
    last_user_event_at: lastUserEvent.get(m.id) ?? null,
  }));
  const memoryById = new Map(memories.map((m) => [m.id, m]));

  const { data: connRows } = await client
    .from("connections")
    .select("source_memory_id, target_memory_id, state")
    .eq("user_id", userId)
    .limit(500);
  const connections = connRows ?? [];

  // ---- ignore escalation from a fully elapsed previous report ----
  const { data: lastReports } = await client
    .from("pa_reports")
    .select("id, generated_at, content")
    .eq("user_id", userId)
    .order("generated_at", { ascending: false })
    .limit(1);
  const lastReport = lastReports?.[0] ?? null;
  for (const memoryId of computeEscalations(lastReport, now)) {
    const memory = memoryById.get(memoryId);
    if (!memory) continue;
    const updated = escalationUpdate(memory.pa_state ?? {}, now);
    await client.from("memories").update({ pa_state: updated }).eq("id", memory.id).eq("user_id", userId);
    memory.pa_state = updated;
  }

  // ---- deterministic selections ----
  const { selected: reminderMemories } = selectReminders(memories, now);
  const usedIds = new Set(reminderMemories.map((m) => m.id));
  const recall = pickRecall({ memories, connections, usedIds, now });

  // ---- emerging (reuses collection discovery: creates suggestions only past thresholds) ----
  const discovery = await discover({ getClient: async () => client, userId });
  const emerging: Array<{
    collectionId: string;
    kind: string;
    name: string;
    memberIds: string[];
    signals: string[];
  }> = [];
  for (const created of (discovery.created ?? []).slice(0, MAX_EMERGING_ITEMS)) {
    const { data: row } = await client
      .from("collections")
      .select("id, name, kind, basis")
      .eq("id", created.id)
      .single();
    if (!row) continue;
    emerging.push({
      collectionId: row.id,
      kind: row.kind,
      name: row.name,
      memberIds: ((row.basis as any)?.member_ids ?? []) as string[],
      signals: (((row.basis as any)?.signals ?? []) as any[]).map((s) => String(s?.detail ?? "")),
    });
  }

  const plan = assemblePlan({ reminderMemories, emerging, recall, now });

  const periodEnd = new Date(now).toISOString();
  const periodStart = lastReport
    ? new Date(Date.parse(lastReport.generated_at)).toISOString()
    : new Date(now - 3.5 * DAY_MS).toISOString();

  // ---- quiet period: no LLM call, calm report ----
  if (plan.items.length === 0) {
    const { data: inserted, error } = await client
      .from("pa_reports")
      .insert({
        user_id: userId,
        period_start: periodStart,
        period_end: periodEnd,
        is_empty: true,
        content: { items: [], sections: [] },
        generation_meta: {
          prompt_version: "pa-v1",
          llm_calls: 0,
          quiet: true,
          candidates: 0,
        },
      })
      .select("id")
      .single();
    if (error) throw new Error("pa report insert failed: " + error.message);
    return { reportId: inserted.id, is_empty: true, items: 0, llmCalls: 0 };
  }

  // ---- ONE synthesis call (wording only) ----
  let llmCalls = 0;
  let llmFailed = false;
  const wordings = new Map<string, string>();
  try {
    llmCalls = 1;
    const out = await compose({
      items: plan.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        claim_type: item.claim_type,
        evidence: item.memoryIds.map((id) => {
          const m = memoryById.get(id);
          return {
            title: m?.title ?? null,
            note: m?.note ?? null,
            age_days: m ? Math.floor((now - Date.parse(m.created_at)) / DAY_MS) : 0,
            topic: m?.topic ?? null,
          };
        }),
        context: item.meta,
      })),
    });
    for (const o of out.items) wordings.set(o.id, o.wording);
  } catch (error) {
    llmFailed = true;
    console.error("PA wording failed:", (error as Error).message);
  }

  // ---- validate + merge (reject/repair rather than display unsupported claims) ----
  const items: PaItem[] = [];
  for (const planned of plan.items) {
    let wording = wordings.get(planned.id) ?? "";
    const validated = validateWording(planned, wording, memoryById);
    if (!validated.ok) wording = fallbackWording(planned, memoryById);
    items.push({
      id: planned.id,
      kind: planned.kind,
      claim_type: planned.claim_type,
      memory_ids: planned.memoryIds,
      wording,
      actions: planned.actions,
      meta: planned.meta,
      evidence: planned.memoryIds.map((id) => {
        const m = memoryById.get(id);
        return {
          memory_id: id,
          title: m?.title ?? "",
          note: m?.note ?? null,
          age_days: m ? Math.floor((now - Date.parse(m.created_at)) / DAY_MS) : 0,
        };
      }),
      interaction: null,
    });
  }

  const { data: report, error: reportError } = await client
    .from("pa_reports")
    .insert({
      user_id: userId,
      period_start: periodStart,
      period_end: periodEnd,
      is_empty: false,
      content: { items, sections: buildSections(items) },
      generation_meta: {
        prompt_version: "pa-v1",
        llm_calls: llmCalls,
        llm_failed: llmFailed,
        candidates: plan.evidenceIds.length,
        dropped_recall: plan.droppedRecall,
        dropped_emerging: plan.droppedEmerging,
      },
    })
    .select("id")
    .single();
  if (reportError) throw new Error("pa report insert failed: " + reportError.message);

  // ---- bookkeeping for shown items ----
  const nowIso = new Date(now).toISOString();
  for (const planned of plan.items) {
    if (planned.kind === "reminder") {
      const memory = memoryById.get(planned.memoryIds[0]);
      if (memory) {
        await client
          .from("memories")
          .update({ pa_state: { ...memory.pa_state, last_reminded_at: nowIso } })
          .eq("id", memory.id)
          .eq("user_id", userId);
      }
    }
    if (planned.kind === "recall") {
      const memory = memoryById.get(planned.memoryIds[0]);
      if (memory) {
        await client
          .from("memories")
          .update({ pa_state: { ...memory.pa_state, last_recall_at: nowIso } })
          .eq("id", memory.id)
          .eq("user_id", userId);
      }
    }
  }

  return { reportId: report.id, is_empty: false, items: items.length, llmCalls };
}

// ------------------------------------------------------- interactions

export type InteractionAction = "open" | "keep_active" | "snooze" | "complete" | "dismiss";

export async function applyPaInteraction(
  input: { reportId: string; itemId: string; action: string },
  deps: { getClient?: () => Promise<any> } = {}
): Promise<{ ok: true; state: string } | { ok: false; reason: string }> {
  const client = await (deps.getClient ?? defaultUserClient)();
  const { data: report } = await client
    .from("pa_reports")
    .select("id, user_id, content")
    .eq("id", input.reportId)
    .maybeSingle();
  if (!report) return { ok: false, reason: "not_found" }; // RLS makes other users' reports invisible

  const content = (report.content ?? {}) as any;
  const items: any[] = Array.isArray(content.items) ? [...content.items] : [];
  const index = items.findIndex((i) => i?.id === input.itemId);
  if (index === -1) return { ok: false, reason: "not_found" };
  const item = items[index];
  if (!Array.isArray(item.actions) || !item.actions.includes(input.action)) {
    return { ok: false, reason: "invalid_action" };
  }
  if (item.interaction && input.action !== "open") return { ok: false, reason: "already_handled" };

  const nowIso = new Date().toISOString();
  const memoryId: string | undefined = item.memory_ids?.[0];

  if (item.kind === "reminder" && memoryId) {
    const { data: memory } = await client
      .from("memories")
      .select("pa_state, status")
      .eq("id", memoryId)
      .maybeSingle();
    const state = (memory?.pa_state ?? {}) as PaState;

    if (input.action === "keep_active") {
      await client
        .from("memories")
        .update({
          pa_state: {
            ...state,
            snoozed_until: new Date(Date.now() + 30 * DAY_MS).toISOString(),
            last_reminded_at: nowIso,
            ignore_count: 0,
          },
        })
        .eq("id", memoryId);
      if (memory?.status === "new") {
        await client.rpc("apply_correction", {
          p_memory_id: memoryId,
          p_field: "status",
          p_value: "active",
          p_reason: "from PA (kept active)",
        });
      }
    } else if (input.action === "snooze") {
      await client
        .from("memories")
        .update({ pa_state: { ...state, snoozed_until: new Date(Date.now() + 30 * DAY_MS).toISOString() } })
        .eq("id", memoryId);
    } else if (input.action === "complete") {
      await client.rpc("apply_correction", {
        p_memory_id: memoryId,
        p_field: "status",
        p_value: "completed",
        p_reason: "from PA",
      });
    } else if (input.action === "dismiss") {
      await client.rpc("apply_correction", {
        p_memory_id: memoryId,
        p_field: "status",
        p_value: "dismissed",
        p_reason: "from PA",
      });
    } else if (input.action === "open") {
      if ((state.ignore_count ?? 0) >= 3) {
        await client
          .from("memories")
          .update({ pa_state: { ...state, ignore_count: 0, suppressed_until: null, suppressed_at: null } })
          .eq("id", memoryId);
      }
    }
  } else if ((item.kind === "pattern" || item.kind === "project_candidate") && input.action === "dismiss") {
    const collectionId = item.meta?.collection_id;
    if (collectionId) {
      await actOnCollection(String(collectionId), "dismiss", {}, { getClient: async () => client });
    }
  } else if (item.kind === "recall" && input.action === "dismiss" && memoryId) {
    const { data: memory } = await client
      .from("memories")
      .select("pa_state")
      .eq("id", memoryId)
      .maybeSingle();
    const state = (memory?.pa_state ?? {}) as PaState;
    await client
      .from("memories")
      .update({ pa_state: { ...state, recall_dismissed_at: nowIso } })
      .eq("id", memoryId);
  }

  items[index] = { ...item, interaction: { action: input.action, at: nowIso } };
  const { error } = await client
    .from("pa_reports")
    .update({ content: { ...content, items } })
    .eq("id", report.id);
  if (error) return { ok: false, reason: "update_failed" };

  return { ok: true, state: input.action };
}
