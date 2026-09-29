import { describe, it, expect } from "vitest";
import {
  reminderEligibility,
  selectReminders,
  computeEscalations,
  escalationUpdate,
  pickRecall,
  assemblePlan,
  validateWording,
  fallbackWording,
  buildSections,
  generatePaReportForUser,
  applyPaInteraction,
  MAX_REPORT_ITEMS,
  MAX_EVIDENCE_CANDIDATES,
  SUPPRESS_INDEFINITE,
  type PaMemory,
  type PlanItem,
} from "@/server/services/pa";

const DAY = 864e5;
const iso = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const isoFuture = (d: number) => new Date(Date.now() + d * DAY).toISOString();

const mem = (id: string, over: Partial<PaMemory> = {}): PaMemory => ({
  id,
  capture_id: `cap-${id}`,
  title: `T-${id}`,
  note: "I want to buy this thing",
  topic: "Stuff",
  current_intent: "buy",
  intent_source: "user_statement",
  suggested_action: "buy",
  status: "new",
  created_at: iso(15),
  pa_state: {},
  last_user_event_at: null,
  ...over,
});

// ---------------------------------------------------------- eligibility

describe("reminderEligibility", () => {
  it("enforces per-intent minimum ages (14 / 21 / 30)", () => {
    expect(reminderEligibility(mem("a", { created_at: iso(13), current_intent: "buy" })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { created_at: iso(15), current_intent: "buy" })).eligible).toBe(true);
    expect(reminderEligibility(mem("a", { created_at: iso(20), current_intent: "research" })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { created_at: iso(22), current_intent: "research" })).eligible).toBe(true);
    expect(reminderEligibility(mem("a", { created_at: iso(29), current_intent: "read" })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { created_at: iso(31), current_intent: "watch" })).eligible).toBe(true);
    expect(reminderEligibility(mem("a", { created_at: iso(29), current_intent: "save_for_later" })).eligible).toBe(false);
  });

  it("requires an actionable, user-grounded intent and an open status", () => {
    expect(reminderEligibility(mem("a", { current_intent: "inspiration" })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { current_intent: "unknown" })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { intent_source: "ai_inference" })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { intent_source: "strong_context" })).eligible).toBe(true);
    expect(reminderEligibility(mem("a", { status: "completed" })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { status: "dismissed" })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { status: "archived" })).eligible).toBe(false);
  });

  it("applies cooldown, doubling, snooze and suppression", () => {
    expect(reminderEligibility(mem("a", { pa_state: { last_reminded_at: iso(5) } })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { pa_state: { last_reminded_at: iso(22) } })).eligible).toBe(true);
    expect(reminderEligibility(mem("a", { pa_state: { last_reminded_at: iso(30), ignore_count: 1 } })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { pa_state: { last_reminded_at: iso(43), ignore_count: 1 } })).eligible).toBe(true);
    expect(reminderEligibility(mem("a", { pa_state: { snoozed_until: isoFuture(3) } })).eligible).toBe(false);
    expect(reminderEligibility(mem("a", { pa_state: { suppressed_until: isoFuture(30) } })).eligible).toBe(false);
    expect(
      reminderEligibility(
        mem("a", { pa_state: { ignore_count: 3, suppressed_until: SUPPRESS_INDEFINITE, suppressed_at: iso(10) } })
      ).eligible
    ).toBe(false);
  });

  it("lifts indefinite suppression after a user action", () => {
    const lifted = reminderEligibility(
      mem("a", {
        pa_state: { ignore_count: 3, suppressed_until: SUPPRESS_INDEFINITE, suppressed_at: iso(10) },
        last_user_event_at: iso(1),
      })
    );
    expect(lifted.eligible).toBe(true);
  });
});

describe("selectReminders", () => {
  it("caps at 2, user-stated first, then most overdue", () => {
    const memories = [
      mem("old-buy", { created_at: iso(40) }),
      mem("mid-try", { created_at: iso(25), current_intent: "try", suggested_action: "test" }),
      mem("strong", { created_at: iso(50), intent_source: "strong_context" }),
      mem("young", { created_at: iso(3) }),
    ];
    const { selected, eligibleCount } = selectReminders(memories);
    expect(eligibleCount).toBe(3);
    expect(selected.map((m) => m.id)).toEqual(["old-buy", "mid-try"]);
  });
});

// ------------------------------------------------------------ escalation

describe("ignore escalation", () => {
  it("counts only untouchd reminders from a fully elapsed period", () => {
    const content = {
      items: [
        { kind: "reminder", memory_ids: ["m1"], interaction: null },
        { kind: "reminder", memory_ids: ["m2"], interaction: { action: "open", at: iso(3) } },
        { kind: "recall", memory_ids: ["m3"], interaction: null },
      ],
    };
    expect(computeEscalations({ generated_at: iso(4), content })).toEqual(["m1"]);
    expect(computeEscalations({ generated_at: iso(1), content })).toEqual([]);
  });

  it("escalates: cooldown doubles, 2nd ignore → 90 days, 3rd → indefinite", () => {
    const s1 = escalationUpdate({ ignore_count: 0 });
    expect(s1.ignore_count).toBe(1);
    expect(s1.suppressed_until).toBeUndefined();
    const s2 = escalationUpdate({ ignore_count: 1 });
    expect(s2.ignore_count).toBe(2);
    expect(Date.parse(s2.suppressed_until!)).toBeGreaterThan(Date.now() + 80 * DAY);
    const s3 = escalationUpdate({ ignore_count: 2 });
    expect(s3.suppressed_until).toBe(SUPPRESS_INDEFINITE);
  });
});

// ---------------------------------------------------------------- recall

describe("pickRecall", () => {
  it("path (a): an old memory connected to something saved this week", () => {
    const oldMemory = mem("old", { created_at: iso(70), current_intent: "save_for_later", status: "active" });
    const fresh = mem("fresh", { created_at: iso(2) });
    const result = pickRecall({
      memories: [oldMemory, fresh],
      connections: [{ source_memory_id: "old", target_memory_id: "fresh", state: "suggested" }],
      usedIds: new Set(),
    });
    expect(result?.memory.id).toBe("old");
    expect(result?.reason).toBe("connected_recent");
    expect((result as any).partnerId).toBe("fresh");
  });

  it("path (b): save_for_later aged ≥30 days", () => {
    const result = pickRecall({
      memories: [mem("sfl", { created_at: iso(35), current_intent: "save_for_later", status: "active" })],
      connections: [],
      usedIds: new Set(),
    });
    expect(result?.reason).toBe("saved_for_later");
  });

  it("respects 90-day dedup, exclusions and used ids", () => {
    const recent = mem("sfl", {
      created_at: iso(35),
      current_intent: "save_for_later",
      status: "active",
      pa_state: { last_recall_at: iso(10) },
    });
    expect(pickRecall({ memories: [recent], connections: [], usedIds: new Set() })).toBeNull();

    const completed = mem("sfl2", { created_at: iso(35), current_intent: "save_for_later", status: "completed" });
    expect(pickRecall({ memories: [completed], connections: [], usedIds: new Set() })).toBeNull();

    const usable = mem("sfl3", { created_at: iso(35), current_intent: "save_for_later" });
    expect(pickRecall({ memories: [usable], connections: [], usedIds: new Set(["sfl3"]) })).toBeNull();
    expect(pickRecall({ memories: [usable], connections: [], usedIds: new Set() })).not.toBeNull();
  });
});

// ------------------------------------------------------------------ plan

describe("assemblePlan", () => {
  it("caps at 5 items and keeps evidence ≤12", () => {
    const plan = assemblePlan({
      reminderMemories: [mem("r1"), mem("r2")],
      emerging: [
        { collectionId: "c1", kind: "project", name: "Proj", memberIds: ["e1", "e2", "e3", "e4"], signals: ["s"] },
        { collectionId: "c2", kind: "collection", name: "Pat", memberIds: ["p1", "p2", "p3"], signals: ["s2"] },
      ],
      recall: { memory: mem("rc", { current_intent: "save_for_later" }), reason: "saved_for_later" },
    });
    expect(plan.items.length).toBe(MAX_REPORT_ITEMS);
    expect(plan.items.filter((i) => i.kind === "reminder")).toHaveLength(2);
    expect(plan.items.filter((i) => i.kind === "project_candidate")).toHaveLength(1);
    expect(plan.items.filter((i) => i.kind === "pattern")).toHaveLength(1);
    expect(plan.items.filter((i) => i.kind === "recall")).toHaveLength(1);
    expect(plan.evidenceIds.length).toBeLessThanOrEqual(MAX_EVIDENCE_CANDIDATES);
  });

  it("trims low-priority items when the evidence bundle overflows", () => {
    const plan = assemblePlan({
      reminderMemories: [mem("r1"), mem("r2")],
      emerging: [
        { collectionId: "c1", kind: "project", name: "P", memberIds: ["a1", "a2", "a3", "a4", "a5", "a6"], signals: [] },
        { collectionId: "c2", kind: "collection", name: "C", memberIds: ["b1", "b2", "b3", "b4", "b5", "b6"], signals: [] },
      ],
      recall: { memory: mem("rc"), reason: "saved_for_later" },
    });
    expect(plan.items.length).toBe(3);
    expect(plan.droppedRecall).toBe(true);
    expect(plan.evidenceIds.length).toBeLessThanOrEqual(MAX_EVIDENCE_CANDIDATES);
  });
});

// -------------------------------------------------------------- wording

describe("wording validation", () => {
  const item: PlanItem = {
    id: "i1",
    kind: "reminder",
    claim_type: "fact",
    memoryIds: ["m1"],
    meta: {},
    actions: ["open", "complete", "dismiss"],
  };
  const byId = new Map([["m1", mem("m1", { note: "I want to buy this keyboard" })]]);

  it("accepts note-grounded quotes", () => {
    const v = validateWording(item, "You said: “I want to buy this keyboard” — still interested?", byId);
    expect(v.ok).toBe(true);
  });

  it("rejects misquotes and banned inference-as-fact phrasing", () => {
    expect(validateWording(item, "You said: “I want to buy this monitor” — still?", byId).ok).toBe(false);
    expect(validateWording(item, "You want to buy a keyboard soon.", byId).ok).toBe(false);
    expect(validateWording(item, "", byId).ok).toBe(false);
  });

  it("offers grounded fallbacks per kind", () => {
    expect(fallbackWording(item, byId)).toContain("I want to buy this keyboard");
    const recallItem: PlanItem = { ...item, kind: "recall", meta: { reason: "saved_for_later" } };
    expect(fallbackWording(recallItem, byId)).toContain("Saved for later");
    const patternItem: PlanItem = { ...item, kind: "pattern", meta: { name: "Cooking" } };
    expect(fallbackWording(patternItem, byId)).toContain("ScreenView noticed");
  });
});

describe("buildSections", () => {
  it("maps kinds to the three sections and omits empty ones", () => {
    const sections = buildSections([
      { id: "1", kind: "reminder" },
      { id: "2", kind: "pattern" },
      { id: "3", kind: "recall" },
    ]);
    expect(sections.map((s) => s.key)).toEqual(["needs_attention", "emerging", "everything_else"]);
    expect(buildSections([{ id: "1", kind: "reminder" }])).toHaveLength(1);
  });
});

// ------------------------------------------------------- generation (IO)

type Ops = Array<[string, any[]]>;

function makePaClient(config: {
  memories?: any[];
  notes?: any[];
  events?: any[];
  connections?: any[];
  reports?: any[];
  collections?: Record<string, any>;
  onInsertReport?: (payload: any) => { data: any; error: any };
}) {
  const inserts: any[] = [];
  const updates: Array<{ table: string; payload: any }> = [];
  const client: any = {
    from: (table: string) => {
      const ops: Ops = [];
      const builder: any = {};
      for (const method of ["select", "eq", "neq", "in", "gte", "order", "limit", "not", "ilike"]) {
        builder[method] = (...args: any[]) => {
          ops.push([method, args]);
          return builder;
        };
      }
      const resolve = () => {
        const insertOp = ops.find(([m]) => m === "insert");
        if (insertOp) {
          inserts.push({ table, payload: insertOp[1][0] });
          if (table === "pa_reports") {
            return config.onInsertReport
              ? config.onInsertReport(insertOp[1][0])
              : { data: { id: "rep-new" }, error: null };
          }
          return { data: null, error: null };
        }
        const updateOp = ops.find(([m]) => m === "update");
        if (updateOp) {
          updates.push({ table, payload: updateOp[1][0] });
          return { error: null };
        }
        switch (table) {
          case "memories":
            return { data: config.memories ?? [] };
          case "captures":
            return { data: config.notes ?? [] };
          case "memory_events":
            return { data: config.events ?? [] };
          case "connections":
            return { data: config.connections ?? [] };
          case "pa_reports":
            return { data: config.reports ?? [] };
          case "collections": {
            const idEq = ops.find(([m, a]) => m === "eq" && a[0] === "id");
            const id = idEq?.[1]?.[1];
            return { data: id && config.collections?.[id] ? config.collections[id] : null };
          }
          default:
            return { data: null };
        }
      };
      builder.single = async () => resolve();
      builder.maybeSingle = async () => resolve();
      builder.insert = (payload: any) => {
        ops.push(["insert", [payload]]);
        return builder;
      };
      builder.update = (payload: any) => {
        ops.push(["update", [payload]]);
        return builder;
      };
      builder.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej);
      builder.rpc = undefined;
      return builder;
    },
    rpc: async (name: string, args: any) => {
      updates.push({ table: `rpc:${name}`, payload: args });
      return { data: null, error: null };
    },
  };
  return { client, inserts, updates };
}

describe("generatePaReportForUser", () => {
  it("quiet period: no items → quiet report with ZERO LLM calls", async () => {
    let composeCalled = 0;
    const { client, inserts } = makePaClient({
      memories: [mem("m1", { created_at: iso(2) })],
      reports: [],
    });
    const result = await generatePaReportForUser("u1", {
      getClient: async () => client,
      compose: async () => {
        composeCalled += 1;
        return { items: [] };
      },
      discover: async () => ({ created: [], skipped: null }),
    });
    expect(composeCalled).toBe(0);
    expect(result.is_empty).toBe(true);
    expect(result.llmCalls).toBe(0);
    const report = inserts.find((i) => i.table === "pa_reports")!.payload;
    expect(report.is_empty).toBe(true);
    expect(report.generation_meta.llm_calls).toBe(0);
  });

  it("populated report: one wording call, grounded items, bookkeeping updated", async () => {
    let composeCalled = 0;
    let composeInput: any = null;
    const reminder = mem("m1", { created_at: iso(16), note: "I want to buy this keyboard" });
    const patternMembers = ["m2", "m3", "m4"].map((id) => mem(id, { created_at: iso(5), current_intent: "try" }));
    const recallMemory = mem("m5", {
      created_at: iso(40),
      current_intent: "save_for_later",
      intent_source: "ai_inference",
      status: "active",
    });
    const { client, inserts, updates } = makePaClient({
      memories: [reminder, ...patternMembers, recallMemory],
      notes: [{ id: "cap-m1", original_note: "I want to buy this keyboard" }],
      reports: [],
      collections: {
        c1: { id: "c1", name: "Cooking", kind: "collection", basis: { member_ids: ["m2", "m3", "m4"], signals: [{ type: "topic_frequency", detail: "3 memories about cooking" }] } },
      },
    });
    const result = await generatePaReportForUser("u1", {
      getClient: async () => client,
      compose: async (input) => {
        composeCalled += 1;
        composeInput = input;
        return {
          items: input.items.map((i: any) => ({
            id: i.id,
            wording:
              i.kind === "reminder"
                ? "You said: “I want to buy this keyboard” — still interested?"
                : "", // empty → fallback for the rest
          })),
        };
      },
      discover: async () => ({ created: [{ id: "c1", name: "Cooking", kind: "collection" }], skipped: null }),
    });

    expect(composeCalled).toBe(1);
    expect(result.llmCalls).toBe(1);
    expect(result.is_empty).toBe(false);

    const report = inserts.find((i) => i.table === "pa_reports")!.payload;
    const items = report.content.items;
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(MAX_REPORT_ITEMS);

    const reminderItem = items.find((i: any) => i.kind === "reminder");
    expect(reminderItem.wording).toContain("still interested");
    const patternItem = items.find((i: any) => i.kind === "pattern");
    expect(patternItem.wording).toContain("ScreenView noticed");
    const recallItem = items.find((i: any) => i.kind === "recall");
    expect(recallItem).toBeTruthy();

    // evidence included for chips
    expect(reminderItem.evidence[0].note).toBe("I want to buy this keyboard");

    // bookkeeping
    const reminded = updates.find((u) => u.table === "memories" && u.payload.pa_state?.last_reminded_at);
    expect(reminded).toBeTruthy();
    const recalled = updates.find((u) => u.table === "memories" && u.payload.pa_state?.last_recall_at);
    expect(recalled).toBeTruthy();
    expect(composeInput.items.length).toBe(items.length);
  });

  it("falls back to deterministic wording when the model fails (still ONE attempt)", async () => {
    let calls = 0;
    const { client, inserts } = makePaClient({
      memories: [mem("m1", { created_at: iso(16) })],
      reports: [],
    });
    const result = await generatePaReportForUser("u1", {
      getClient: async () => client,
      compose: async () => {
        calls += 1;
        throw new Error("provider down");
      },
      discover: async () => ({ created: [], skipped: null }),
    });
    expect(calls).toBe(1);
    const report = inserts.find((i) => i.table === "pa_reports")!.payload;
    expect(report.content.items[0].wording.length).toBeGreaterThan(0);
    expect(report.generation_meta.llm_failed).toBe(true);
    expect(result.llmCalls).toBe(1);
  });

  it("escalates ignored reminders before selecting new ones", async () => {
    const { client, updates, inserts } = makePaClient({
      memories: [mem("m1", { created_at: iso(16), pa_state: { last_reminded_at: iso(5) } })],
      reports: [
        {
          id: "old",
          generated_at: iso(4),
          content: { items: [{ kind: "reminder", memory_ids: ["m1"], interaction: null }] },
        },
      ],
    });
    const result = await generatePaReportForUser("u1", {
      getClient: async () => client,
      compose: async () => ({ items: [] }),
      discover: async () => ({ created: [], skipped: null }),
    });
    const escalated = updates.find((u) => u.table === "memories" && u.payload.pa_state?.ignore_count === 1);
    expect(escalated).toBeTruthy();
    // ignored + still in cooldown → nothing to remind → quiet
    expect(result.is_empty).toBe(true);
  });
});

// ---------------------------------------------------------- interactions

describe("applyPaInteraction", () => {
  const reminderItem = {
    id: "i1",
    kind: "reminder",
    claim_type: "fact",
    memory_ids: ["m1"],
    wording: "You said: “x” — still interested?",
    actions: ["open", "keep_active", "snooze", "complete", "dismiss"],
    meta: { memory_id: "m1", capture_id: "cap-m1" },
    evidence: [],
    interaction: null,
  };

  function makeInteractionClient(options: { report?: any; memory?: any } = {}) {
    const updates: Array<{ table: string; payload: any }> = [];
    const rpcs: Array<{ name: string; args: any }> = [];
    const client: any = {
      from: (table: string) => {
        const ops: Ops = [];
        const builder: any = {};
        for (const method of ["select", "eq", "neq", "in", "order", "limit"]) {
          builder[method] = (...args: any[]) => {
            ops.push([method, args]);
            return builder;
          };
        }
        const resolve = () => {
          const updateOp = ops.find(([m]) => m === "update");
          if (updateOp) {
            updates.push({ table, payload: updateOp[1][0] });
            return { error: null };
          }
          if (table === "pa_reports") {
            const hasIdEq = ops.some(([m]) => m === "eq");
            return { data: hasIdEq ? options.report ?? null : null, error: null };
          }
          if (table === "memories") {
            return { data: options.memory ?? { pa_state: {}, status: "new" }, error: null };
          }
          if (table === "collections") {
            return { data: { id: "col1", state: "suggested", basis: { signature: "s" } }, error: null };
          }
          return { data: null, error: null };
        };
        builder.maybeSingle = async () => resolve();
        builder.single = async () => resolve();
        builder.update = (payload: any) => {
          ops.push(["update", [payload]]);
          return builder;
        };
        builder.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej);
        return builder;
      },
      rpc: async (name: string, args: any) => {
        rpcs.push({ name, args });
        return { data: null, error: null };
      },
    };
    return { client, updates, rpcs };
  }

  it("completes a memory via the correction flow and records the interaction", async () => {
    const { client, updates, rpcs } = makeInteractionClient({
      report: { id: "r1", user_id: "u1", content: { items: [reminderItem] } },
      memory: { pa_state: {}, status: "new" },
    });
    const result = await applyPaInteraction(
      { reportId: "r1", itemId: "i1", action: "complete" },
      { getClient: async () => client }
    );
    expect(result).toEqual({ ok: true, state: "complete" });
    expect(rpcs[0].name).toBe("apply_correction");
    expect(rpcs[0].args.p_value).toBe("completed");
    const reportUpdate = updates.find((u) => u.table === "pa_reports");
    expect(reportUpdate?.payload.content.items[0].interaction.action).toBe("complete");
  });

  it("dismisses a memory via the correction flow", async () => {
    const { client, rpcs } = makeInteractionClient({
      report: { id: "r1", user_id: "u1", content: { items: [reminderItem] } },
    });
    await applyPaInteraction({ reportId: "r1", itemId: "i1", action: "dismiss" }, { getClient: async () => client });
    expect(rpcs[0].args.p_value).toBe("dismissed");
  });

  it("snoozes via pa_state only (never touches the memory record)", async () => {
    const { client, updates, rpcs } = makeInteractionClient({
      report: { id: "r1", user_id: "u1", content: { items: [reminderItem] } },
    });
    await applyPaInteraction({ reportId: "r1", itemId: "i1", action: "snooze" }, { getClient: async () => client });
    expect(rpcs).toHaveLength(0);
    const memoryUpdate = updates.find((u) => u.table === "memories");
    expect(memoryUpdate?.payload.pa_state.snoozed_until).toBeTruthy();
    expect(memoryUpdate?.payload.status).toBeUndefined();
  });

  it("keep_active resets the cooldown and activates a 'new' memory", async () => {
    const { client, updates, rpcs } = makeInteractionClient({
      report: { id: "r1", user_id: "u1", content: { items: [reminderItem] } },
      memory: { pa_state: { ignore_count: 1 }, status: "new" },
    });
    await applyPaInteraction({ reportId: "r1", itemId: "i1", action: "keep_active" }, { getClient: async () => client });
    const memoryUpdate = updates.find((u) => u.table === "memories" && u.payload.pa_state);
    expect(memoryUpdate?.payload.pa_state.ignore_count).toBe(0);
    expect(memoryUpdate?.payload.pa_state.snoozed_until).toBeTruthy();
    expect(rpcs[0].args.p_value).toBe("active");
  });

  it("dismissing a pattern dismisses the underlying collection suggestion", async () => {
    const patternItem = {
      ...reminderItem,
      id: "i2",
      kind: "pattern",
      actions: ["open", "dismiss"],
      meta: { collection_id: "col1" },
    };
    const { client, updates } = makeInteractionClient({
      report: { id: "r1", user_id: "u1", content: { items: [patternItem] } },
    });
    const result = await applyPaInteraction(
      { reportId: "r1", itemId: "i2", action: "dismiss" },
      { getClient: async () => client }
    );
    expect(result.ok).toBe(true);
    const collectionUpdate = updates.find((u) => u.table === "collections");
    expect(collectionUpdate?.payload.state).toBe("dismissed");
  });

  it("rejects invalid, repeated and foreign interactions", async () => {
    const { client } = makeInteractionClient({
      report: { id: "r1", user_id: "u1", content: { items: [reminderItem] } },
    });
    expect(
      await applyPaInteraction({ reportId: "r1", itemId: "i1", action: "explode" }, { getClient: async () => client })
    ).toEqual({ ok: false, reason: "invalid_action" });

    const handled = makeInteractionClient({
      report: {
        id: "r1",
        user_id: "u1",
        content: { items: [{ ...reminderItem, interaction: { action: "complete", at: "x" } }] },
      },
    });
    expect(
      await applyPaInteraction({ reportId: "r1", itemId: "i1", action: "dismiss" }, { getClient: async () => handled.client })
    ).toEqual({ ok: false, reason: "already_handled" });

    const foreign = makeInteractionClient({ report: null });
    expect(
      await applyPaInteraction({ reportId: "r-other", itemId: "i1", action: "open" }, { getClient: async () => foreign.client })
    ).toEqual({ ok: false, reason: "not_found" });
  });
});
