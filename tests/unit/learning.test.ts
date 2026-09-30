import { describe, it, expect } from "vitest";
import {
  LEARNING_CONFIG,
  decayedWeight,
  effectiveConfidence,
  casesFromEvents,
  casesFromConnections,
  casesFromCollections,
  casesFromPaInteractions,
  aggregateCases,
  evaluateDraft,
  selectContextLines,
  consolidateLearning,
  loadSuppressions,
  buildLearningContext,
  type LearningCase,
  type MemoryLite,
  type ActivePattern,
} from "@/server/services/learning";

const DAY = 864e5;
const iso = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const isoFuture = (d: number) => new Date(Date.now() + d * DAY).toISOString();

const memory = (id: string, over: Partial<MemoryLite> = {}): MemoryLite => ({
  id,
  topic: "Fragrance",
  current_intent: "research",
  created_at: iso(10),
  ...over,
});

const memMap = (list: MemoryLite[]) => new Map(list.map((m) => [m.id, m]));

const eventCase = (over: Partial<LearningCase> = {}): LearningCase => ({
  scope: "intent",
  condition: { topic: "fragrance" },
  conclusion: { intent: "research", from: "buy" },
  polarity: "positive",
  weight: 1,
  memoryId: "m1",
  at: Date.now() - 2 * DAY,
  ...over,
});

// ----------------------------------------------------------------- cases

describe("casesFromEvents", () => {
  const memories = memMap([memory("m1"), memory("m2")]);

  it("maps user corrections to cases; AI/system origins are never evidence", () => {
    const cases = casesFromEvents(
      [
        { event_type: "intent_change", old_value: "buy", new_value: "research", memory_id: "m1", actor: "user", source: "user_statement", created_at: iso(2) },
        { event_type: "intent_change", old_value: "buy", new_value: "research", memory_id: "m2", actor: "system", source: "ai_inference", created_at: iso(2) },
        { event_type: "action_change", old_value: "buy", new_value: "evaluate", memory_id: "m1", actor: "user", source: "user_statement", created_at: iso(1) },
      ],
      memories
    );
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({ scope: "intent", weight: 1, polarity: "positive" });
    expect(cases[0].condition).toEqual({ topic: "fragrance" });
    expect(cases[1].scope).toBe("action");
  });

  it("one correction stays a single case (observation only)", () => {
    const cases = casesFromEvents(
      [{ event_type: "intent_change", old_value: "buy", new_value: "research", memory_id: "m1", actor: "user", source: "user_statement", created_at: iso(1) }],
      memories
    );
    const drafts = aggregateCases(cases, memories);
    expect(drafts).toHaveLength(1);
    expect(evaluateDraft(drafts[0]).level).toBe("observation");
  });
});

describe("casesFromConnections / collections / PA", () => {
  it("confirms are discounted accepts; dismissals are full-weight negatives", () => {
    const cases = casesFromConnections([
      { state: "confirmed", relationship_type: "same_subject", basis: { user_action_at: iso(3) }, created_at: iso(5) },
      { state: "dismissed", relationship_type: "thematic", basis: { user_action_at: iso(2) }, created_at: iso(5) },
    ]);
    expect(cases[0]).toMatchObject({ polarity: "positive", weight: LEARNING_CONFIG.weights.accepted_ai_suggestion });
    expect(cases[1]).toMatchObject({ polarity: "negative", weight: 1 });
  });

  it("collection cases need a dominant topic (no global mutes)", () => {
    const memories = memMap([memory("c1"), memory("c2"), memory("c3", { topic: "Gardening" })]);
    const cases = casesFromCollections(
      [
        { state: "dismissed", kind: "collection", basis: { member_ids: ["c1", "c2"], dismissed_at: iso(2) }, updated_at: iso(2) },
        { state: "dismissed", kind: "collection", basis: { member_ids: ["c1", "c3"], dismissed_at: iso(2) }, updated_at: iso(2) },
      ],
      memories
    );
    expect(cases).toHaveLength(1); // second set has no dominant topic
    expect(cases[0].condition).toEqual({ topic: "fragrance" });
  });

  it("PA cases: explicit actions only — ignored items are NOT rejection", () => {
    const memories = memMap([memory("m1")]);
    const cases = casesFromPaInteractions(
      [
        { kind: "reminder", memory_ids: ["m1"], interaction: null }, // ignored → no case
        { kind: "reminder", memory_ids: ["m1"], interaction: { action: "dismiss", at: iso(1) } },
        { kind: "recall", memory_ids: ["m1"], interaction: { action: "dismiss", at: iso(1) } }, // not a reminder
      ],
      memories
    );
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ scope: "pa", polarity: "negative" });
    expect(cases[0].condition).toEqual({ kind: "reminder", topic: "fragrance" });
  });
});

// ------------------------------------------------------------ aggregation

describe("aggregateCases / evaluateDraft", () => {
  it("weights decay by half-life", () => {
    const c = eventCase({ at: Date.now() - 120 * DAY });
    expect(decayedWeight(c, Date.now())).toBeCloseTo(0.5, 2);
  });

  it("needs diverse evidence: same day / same memory is insufficient", () => {
    const sameDay = [
      eventCase({ memoryId: "m1", at: Date.now() - DAY }),
      eventCase({ memoryId: "m1", at: Date.now() - DAY }),
      eventCase({ memoryId: "m1", at: Date.now() - DAY }),
      eventCase({ memoryId: "m1", at: Date.now() - DAY }),
    ];
    const draft = aggregateCases(sameDay, memMap([memory("m1")]))[0];
    expect(draft.distinctDays).toBe(1);
    expect(evaluateDraft(draft).level).toBe("observation");
  });

  it("repeated corrections across days/memories become tentative", () => {
    const cases = [
      eventCase({ memoryId: "m1", at: Date.now() - 6 * DAY }),
      eventCase({ memoryId: "m2", at: Date.now() - 4 * DAY }),
      eventCase({ memoryId: "m3", at: Date.now() - 2 * DAY }),
    ];
    const draft = aggregateCases(cases, memMap([memory("m1"), memory("m2"), memory("m3")]))[0];
    expect(draft.distinctDays).toBe(3);
    expect(draft.distinctMemories).toBe(3);
    const evaluation = evaluateDraft(draft);
    expect(evaluation.level).toBe("tentative");
    expect(evaluation.confidence).toBeGreaterThan(0.3);
    expect(evaluation.confidence).toBeLessThanOrEqual(0.9);
  });

  it("sufficient evidence establishes (active), capped at 0.9", () => {
    const cases = Array.from({ length: 5 }, (_, i) =>
      eventCase({ memoryId: `m${i}`, at: Date.now() - (i + 1) * DAY })
    );
    const draft = aggregateCases(cases, memMap(cases.map((c) => memory(c.memoryId))))[0];
    const evaluation = evaluateDraft(draft);
    expect(evaluation.level).toBe("active");
    expect(evaluation.confidence).toBeLessThanOrEqual(0.9);
  });

  it("negative classes: connections need ≈³3 dismissals, collections ≈²2", () => {
    const dismissals = [1, 2, 3].map((i) => ({
      scope: "connection" as const,
      condition: { relationship_type: "thematic" },
      conclusion: { suppress: true },
      polarity: "negative" as const,
      weight: 1,
      memoryId: `m${i}`,
      at: Date.now() - i * DAY,
    }));
    const draft = aggregateCases(dismissals, memMap([]))[0];
    expect(evaluateDraft(draft).level).toBe("suppressed");
    expect(evaluateDraft(aggregateCases(dismissals.slice(0, 2), memMap([]))[0]).level).toBe("observation");

    const colDismissals = [1, 2].map((i) => ({
      scope: "collection" as const,
      condition: { topic: "cooking" },
      conclusion: { mute: true },
      polarity: "negative" as const,
      weight: 1,
      memoryId: `c${i}`,
      at: Date.now() - i * DAY,
    }));
    expect(evaluateDraft(aggregateCases(colDismissals, memMap([]))[0]).level).toBe("suppressed");
  });
});

// --------------------------------------------------------------- context

describe("selectContextLines / buildLearningContext", () => {
  const pattern = (over: Partial<ActivePattern> = {}): ActivePattern => ({
    id: "p1",
    scope: "intent",
    origin: "inferred",
    status: "tentative",
    condition: { topic: "fragrance" },
    conclusion: { intent: "research", from: "buy" },
    confidence: 0.5,
    half_life_days: 120,
    last_reinforced_at: new Date().toISOString(),
    evidence_count: 3,
    ...over,
  });

  it("cold start: no patterns → no lines (behavior unchanged)", () => {
    const result = selectContextLines({ patterns: [], note: "anything", contextText: "", cardTopics: [] });
    expect(result.lines).toEqual([]);
  });

  it("includes relevant patterns only (topic match in note/cards)", () => {
    const patterns = [
      pattern(),
      pattern({ id: "p2", condition: { topic: "gardening" }, conclusion: { intent: "save_for_later" } }),
    ];
    const match = selectContextLines({ patterns, note: "another fragrance for the collection", contextText: "", cardTopics: [] });
    expect(match.patternIds).toEqual(["p1"]);
    const viaCards = selectContextLines({ patterns, note: "saw this", contextText: "", cardTopics: ["Fragrance"] });
    expect(viaCards.patternIds).toEqual(["p1"]);
    const unrelated = selectContextLines({ patterns, note: "saw this", contextText: "", cardTopics: [] });
    expect(unrelated.lines).toEqual([]);
  });

  it("unscoped inferred hints are never injected; explicit ones always are and come first", () => {
    const patterns = [
      pattern({ id: "p1", condition: {} }),
      pattern({ id: "pex", origin: "explicit", condition: { topic: "anything" }, evidence_count: 1 }),
      pattern({ id: "p3", condition: { topic: "fragrance" } }),
    ];
    const result = selectContextLines({ patterns, note: "fragrance", contextText: "", cardTopics: [] });
    expect(result.patternIds).toEqual(["pex", "p3"]);
  });

  it("caps at ~6 lines and labels are clear ([learned, N cases] / [explicit])", () => {
    const patterns = Array.from({ length: 9 }, (_, i) =>
      pattern({ id: `p${i}`, condition: { topic: `topic${i}` } })
    );
    const note = Array.from({ length: 9 }, (_, i) => `topic${i}`).join(" ");
    const result = selectContextLines({ patterns, note, contextText: "", cardTopics: [] });
    expect(result.lines.length).toBeLessThanOrEqual(LEARNING_CONFIG.maxContextLines);
    expect(result.lines[0]).toContain("[learned, 3 cases]");
    const explicitResult = selectContextLines({
      patterns: [pattern({ origin: "explicit" })],
      note: "x",
      contextText: "",
      cardTopics: [],
    });
    expect(explicitResult.lines[0]).toContain("[explicit]");
  });

  it("expired / decayed-below-floor / suppressed patterns stop influencing", () => {
    const expired = pattern({ id: "p1", status: "expired" });
    const decayed = pattern({ id: "p2", confidence: 0.3, last_reinforced_at: iso(400) });
    const suppressed = pattern({ id: "p3", status: "suppressed" });
    const result = selectContextLines({ patterns: [expired, decayed, suppressed], note: "fragrance", contextText: "", cardTopics: [] });
    expect(result.lines).toEqual([]);
  });

  it("effectiveConfidence halves over a half-life", () => {
    const p = { confidence: 0.8, half_life_days: 120, last_reinforced_at: new Date(Date.now() - 120 * DAY).toISOString(), scope: "intent" };
    expect(effectiveConfidence(p, Date.now())).toBeCloseTo(0.4, 2);
  });
});

// ------------------------------------------------------------------- IO

type Ops = Array<[string, any[]]>;

function makeLearningClient(config: {
  memories?: any[];
  events?: any[];
  connections?: any[];
  collections?: any[];
  reports?: any[];
  patterns?: any[];
}) {
  const inserts: any[] = [];
  const updates: Array<{ table: string; payload: any }> = [];
  const filters: Array<[string, any[]]> = [];
  const client: any = {
    from: (table: string) => {
      const ops: Ops = [];
      const builder: any = {};
      for (const method of ["select", "eq", "neq", "in", "gte", "order", "limit", "not"]) {
        builder[method] = (...args: any[]) => {
          ops.push([method, args]);
          if (method === "eq") filters.push([table, args]);
          return builder;
        };
      }
      const resolve = () => {
        const insertOp = ops.find(([m]) => m === "insert");
        if (insertOp) {
          inserts.push({ table, payload: insertOp[1][0] });
          return { data: null, error: null };
        }
        const updateOp = ops.find(([m]) => m === "update");
        if (updateOp) {
          updates.push({ table, payload: updateOp[1][0] });
          return { data: null, error: null };
        }
        switch (table) {
          case "memories":
            return { data: config.memories ?? [] };
          case "memory_events":
            return { data: config.events ?? [] };
          case "connections":
            return { data: config.connections ?? [] };
          case "collections":
            return { data: config.collections ?? [] };
          case "pa_reports":
            return { data: config.reports ?? [] };
          case "learned_patterns":
            return { data: config.patterns ?? [] };
          default:
            return { data: [] };
        }
      };
      builder.maybeSingle = async () => resolve();
      builder.single = async () => resolve();
      builder.insert = (payload: any) => {
        ops.push(["insert", [payload]]);
        return builder;
      };
      builder.update = (payload: any) => {
        ops.push(["update", [payload]]);
        return builder;
      };
      builder.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej);
      return builder;
    },
  };
  return { client, inserts, updates, filters };
}

const fragranceMemories = [
  { id: "m1", topic: "Fragrance", current_intent: "research", created_at: iso(12) },
  { id: "m2", topic: "Fragrance", current_intent: "research", created_at: iso(10) },
  { id: "m3", topic: "Fragrance", current_intent: "research", created_at: iso(8) },
  { id: "m4", topic: "Fragrance", current_intent: "research", created_at: iso(6) },
  { id: "m5", topic: "Fragrance", current_intent: "research", created_at: iso(4) },
];
const correction = (id: string, daysAgo: number) => ({
  event_type: "intent_change",
  old_value: "buy",
  new_value: "research",
  memory_id: id,
  actor: "user",
  source: "user_statement",
  created_at: iso(daysAgo),
});

describe("consolidateLearning", () => {
  it("creates a tentative pattern from ≈³3 diverse corrections; scoped to the user", async () => {
    const { client, inserts, filters } = makeLearningClient({
      memories: fragranceMemories,
      events: [correction("m1", 6), correction("m2", 4), correction("m3", 2)],
      patterns: [],
    });
    const result = await consolidateLearning("u1", { getClient: async () => client });
    expect(result.created).toBe(1);
    const row = inserts.find((i) => i.table === "learned_patterns")!.payload;
    expect(row).toMatchObject({
      user_id: "u1",
      scope: "intent",
      origin: "inferred",
      status: "tentative",
      half_life_days: 120,
      evidence_count: 3,
    });
    expect(row.condition).toEqual({ topic: "fragrance" });
    expect(row.conclusion).toEqual({ intent: "research", from: "buy" });
    expect(Array.isArray(row.evidence)).toBe(true);
    // ownership: every read is scoped to the user
    expect(filters.filter(([t]) => t === "memory_events").every(([, a]) => a[0] === "user_id" && a[1] === "u1")).toBe(true);
  });

  it("stays observation below the bar (2 corrections)", async () => {
    const { client, inserts } = makeLearningClient({
      memories: fragranceMemories,
      events: [correction("m1", 4), correction("m2", 2)],
      patterns: [],
    });
    const result = await consolidateLearning("u1", { getClient: async () => client });
    expect(result.created).toBe(0);
    expect(inserts.filter((i) => i.table === "learned_patterns")).toHaveLength(0);
  });

  it("reinforces an existing tentative pattern into active with more evidence", async () => {
    const existing = {
      id: "p1",
      scope: "intent",
      origin: "inferred",
      status: "tentative",
      condition: { topic: "fragrance" },
      conclusion: { intent: "research", from: "buy" },
      confidence: 0.4,
      half_life_days: 120,
      last_reinforced_at: iso(5),
      evidence_count: 3,
    };
    const { client, updates } = makeLearningClient({
      memories: fragranceMemories,
      events: [1, 2, 3, 4, 5].map((i) => correction(`m${i}`, i * 2)),
      patterns: [existing],
    });
    const result = await consolidateLearning("u1", { getClient: async () => client });
    expect(result.updated).toBe(1);
    const update = updates.find((u) => u.table === "learned_patterns")!;
    expect(update.payload.status).toBe("active");
    expect(update.payload.evidence_count).toBe(5);
  });

  it("expires stale patterns that fell below the floor", async () => {
    const stale = {
      id: "p2",
      scope: "intent",
      origin: "inferred",
      status: "tentative",
      condition: { topic: "gardening" },
      conclusion: { intent: "research" },
      confidence: 0.3,
      half_life_days: 120,
      last_reinforced_at: iso(400),
      evidence_count: 3,
    };
    const { client, updates } = makeLearningClient({ memories: [], events: [], patterns: [stale] });
    const result = await consolidateLearning("u1", { getClient: async () => client });
    expect(result.expired).toBe(1);
    const update = updates.find((u) => u.table === "learned_patterns")!;
    expect(update.payload.status).toBe("expired");
  });

  it("suppresses repeatedly dismissed connection types (decaying)", async () => {
    const dismissals = [6, 4, 2].map((days) => ({
      state: "dismissed",
      relationship_type: "thematic",
      basis: { user_action_at: iso(days) },
      created_at: iso(days + 2),
    }));
    const { client, inserts } = makeLearningClient({ memories: [], events: [], connections: dismissals, patterns: [] });
    const result = await consolidateLearning("u1", { getClient: async () => client });
    expect(result.suppressed).toBe(1);
    const row = inserts.find((i) => i.table === "learned_patterns")!.payload;
    expect(row).toMatchObject({ scope: "connection", status: "suppressed" });
    expect(row.conclusion).toEqual({ suppress: true });
    expect(typeof row.suppressed_until).toBe("string");
  });
});

describe("loadSuppressions / buildLearningContext", () => {
  it("returns scoped suppressions and the raised floor after expiry", async () => {
    const { client } = makeLearningClient({
      patterns: [
        { id: "s1", scope: "connection", status: "suppressed", condition: { relationship_type: "thematic" }, conclusion: { suppress: true }, suppressed_until: isoFuture(30) },
        { id: "s2", scope: "collection", status: "suppressed", condition: { topic: "gardening" }, conclusion: { mute: true }, suppressed_until: isoFuture(30) },
        { id: "s3", scope: "connection", status: "expired", condition: { relationship_type: "complementary" }, conclusion: { suppress: true } },
      ],
    });
    const result = await loadSuppressions("u1", { getClient: async () => client });
    expect(result.connectionTypes).toEqual(["thematic"]);
    expect(result.mutedTopics).toEqual(["gardening"]);
    expect(result.raisedConnectionFloor).toBe(LEARNING_CONFIG.raisedConnectionFloor);
  });

  it("buildLearningContext is cold-start safe", async () => {
    const { client } = makeLearningClient({ patterns: [] });
    const result = await buildLearningContext("u1", { note: "x", perceptionText: "", cardTopics: [] }, { getClient: async () => client });
    expect(result.lines).toEqual([]);
  });
});
