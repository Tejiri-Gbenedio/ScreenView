import { describe, it, expect } from "vitest";
import {
  normalizeTopic,
  isBuildFlavored,
  spanDays,
  computeSignals,
  passesCollectionGate,
  projectAssessment,
  signatureOf,
  detectCandidateSets,
  runDiscovery,
  actOnCollection,
  MAX_NEW_PER_RUN,
  type MemoryLite,
  type ConnectionLite,
} from "@/server/services/collections";

// ---------------------------------------------------------------- fixtures

const DAY = 864e5;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

const memo = (id: string, over: Partial<MemoryLite> = {}): MemoryLite => ({
  id,
  title: `T-${id}`,
  note: null,
  topic: "Travel",
  current_intent: "try",
  suggested_action: "none",
  created_at: iso(5),
  ...over,
});

const conn = (a: string, b: string, over: Partial<ConnectionLite> = {}): ConnectionLite => ({
  source_memory_id: a < b ? a : b,
  target_memory_id: a < b ? b : a,
  relationship_type: "same_subject",
  state: "suggested",
  ...over,
});

// ------------------------------------------------------------------ fakes

type Ops = Array<[string, any[]]>;

function makeClient(config: {
  singleRow?: any;
  memories?: any[];
  notes?: any[];
  connections?: any[];
  collections?: any[];
  members?: any[];
  synth?: any;
  insertCollectionError?: any;
  updateError?: any;
}) {
  const insertedCollections: any[] = [];
  const insertedMembers: any[] = [];
  const updates: Array<{ table: string; payload: any }> = [];

  const client: any = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
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
        if (table === "collections" && insertOp) {
          insertedCollections.push(insertOp[1][0]);
          if (config.insertCollectionError) return { data: null, error: config.insertCollectionError };
          return {
            data: { id: "col-new", name: insertOp[1][0].name, kind: insertOp[1][0].kind },
            error: null,
          };
        }
        if (table === "collection_members" && insertOp) {
          insertedMembers.push(insertOp[1][0]);
          return { error: null };
        }
        const updateOp = ops.find(([m]) => m === "update");
        if (updateOp) {
          updates.push({ table, payload: updateOp[1][0] });
          if (config.updateError) return { error: config.updateError };
          return { error: null };
        }
        switch (table) {
          case "memories":
            return { data: config.memories ?? [] };
          case "captures":
            return { data: config.notes ?? [] };
          case "connections":
            return { data: config.connections ?? [] };
          case "collections":
            return { data: config.collections ?? [] };
          case "collection_members":
            return { data: config.members ?? [] };
          default:
            return { data: [] };
        }
      };
      builder.single = async () => resolve();
      builder.maybeSingle = async () =>
        ops.some(([m]) => m === "insert" || m === "update") ? resolve() : { data: config.singleRow ?? null };
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
  return { client, insertedCollections, insertedMembers, updates };
}

// ---------------------------------------------------------------- signals

describe("normalizeTopic / isBuildFlavored / spanDays", () => {
  it("normalizes topics", () => {
    expect(normalizeTopic("  Travel ")).toBe("travel");
    expect(normalizeTopic(null)).toBe("");
  });

  it("detects build-flavored signals deterministically", () => {
    expect(isBuildFlavored(memo("a", { current_intent: "build" }))).toBe(true);
    expect(isBuildFlavored(memo("a", { suggested_action: "build" }))).toBe(true);
    expect(isBuildFlavored(memo("a", { note: "I want something like this for my site" }))).toBe(true);
    expect(isBuildFlavored(memo("a", { note: "just a nice photo" }))).toBe(false);
  });

  it("computes day spread", () => {
    expect(spanDays([memo("a", { created_at: iso(10) }), memo("b", { created_at: iso(3) })])).toBeCloseTo(7, 5);
    expect(spanDays([memo("a")])).toBe(0);
  });
});

describe("computeSignals / gate", () => {
  it("topic frequency requires 3 sharing a normalized topic", () => {
    const three = [memo("a"), memo("b"), memo("c")];
    expect(computeSignals(three, []).signals.some((s) => s.type === "topic_frequency")).toBe(true);
    expect(computeSignals(three.slice(0, 2), []).signals.some((s) => s.type === "topic_frequency")).toBe(false);
  });

  it("intent pattern requires 3 with the same non-unknown intent", () => {
    const three = [memo("a"), memo("b"), memo("c")];
    expect(computeSignals(three, []).signals.some((s) => s.type === "intent_pattern")).toBe(true);
    const unknown = [memo("a", { current_intent: "unknown" }), memo("b", { current_intent: "unknown" }), memo("c", { current_intent: "unknown" })];
    expect(computeSignals(unknown, []).signals.some((s) => s.type === "intent_pattern")).toBe(false);
  });

  it("connection density needs ≥2 internal non-dismissed connections", () => {
    const members = [memo("a"), memo("b"), memo("c")];
    const two = [conn("a", "b"), conn("b", "c")];
    expect(computeSignals(members, two).signals.some((s) => s.type === "connection_density")).toBe(true);
    expect(computeSignals(members, [conn("a", "b")]).signals.some((s) => s.type === "connection_density")).toBe(false);
    const dismissed = [conn("a", "b", { state: "dismissed" }), conn("b", "c", { state: "dismissed" })];
    expect(computeSignals(members, dismissed).signals.some((s) => s.type === "connection_density")).toBe(false);
  });

  it("cadence is supporting only: it can never qualify a set alone", () => {
    const members = [
      memo("a", { topic: "Alpha", created_at: iso(1) }),
      memo("b", { topic: "Beta", created_at: iso(2) }),
      memo("c", { topic: "Gamma", created_at: iso(20), current_intent: "research" }),
    ];
    const { signals, primaries } = computeSignals(members, []);
    expect(signals.some((s) => s.type === "cadence")).toBe(true);
    expect(primaries).toBe(0);
    expect(passesCollectionGate(members, []).ok).toBe(false);
  });

  it("two related memories are never a pattern", () => {
    const two = [memo("a"), memo("b")];
    expect(detectCandidateSets(two, [conn("a", "b"), conn("a", "b")])).toHaveLength(0);
    expect(passesCollectionGate(two, [conn("a", "b")]).ok).toBe(false);
  });

  it("needs ≥2 signals: one signal alone does not qualify", () => {
    const mixed = [
      memo("a", { topic: "Travel" }),
      memo("b", { topic: "Money" }),
      memo("c", { topic: "Cooking", current_intent: "research" }),
    ];
    // no shared topic/intent/connections → 0 signals
    expect(passesCollectionGate(mixed, []).ok).toBe(false);
  });
});

describe("detectCandidateSets", () => {
  it("finds a gated topic group and skips below-threshold groups", () => {
    const memories = [
      memo("m1", { topic: "Travel" }),
      memo("m2", { topic: "travel " }), // normalization
      memo("m3", { topic: "Travel" }),
      memo("g1", { topic: "Gardening" }),
      memo("g2", { topic: "Gardening" }), // only 2 → no set
    ];
    const sets = detectCandidateSets(memories, []);
    expect(sets).toHaveLength(1);
    expect(sets[0].members.map((m) => m.id).sort()).toEqual(["m1", "m2", "m3"]);
    expect(sets[0].signature).toBe(signatureOf(["m1", "m2", "m3"]));
  });

  it("finds connection clusters across topics and excludes old memories", () => {
    const memories = [
      memo("a", { topic: "One" }),
      memo("b", { topic: "Two" }),
      memo("c", { topic: "Three" }),
      memo("old", { topic: "One", created_at: iso(70) }),
    ];
    const connections = [conn("a", "b"), conn("b", "c")];
    const sets = detectCandidateSets(memories, connections);
    expect(sets).toHaveLength(1);
    expect(sets[0].members.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
    expect(sets[0].signals.some((s) => s.type === "connection_density")).toBe(true);
  });

  it("sorts by strength: member count → signals → recency", () => {
    const memories = [
      memo("t1", { topic: "Travel" }),
      memo("t2", { topic: "Travel" }),
      memo("t3", { topic: "Travel" }),
      memo("p1", { topic: "Portfolio", current_intent: "build", suggested_action: "build" }),
      memo("p2", { topic: "Portfolio", current_intent: "build", suggested_action: "build" }),
      memo("p3", { topic: "Portfolio", current_intent: "build", suggested_action: "build" }),
      memo("p4", { topic: "Portfolio", current_intent: "build", suggested_action: "build" }),
    ];
    const sets = detectCandidateSets(memories, []);
    expect(sets[0].members).toHaveLength(4);
    expect(sets[1].members).toHaveLength(3);
  });
});

describe("projectAssessment", () => {
  const build = (id: string, daysAgo: number) =>
    memo(id, { topic: "Portfolio", current_intent: "build", suggested_action: "build", created_at: iso(daysAgo) });

  it("qualifies only with ≥4 memories, ≥2 build signals, ≥7-day spread, coherence", () => {
    const ok = [build("p1", 35), build("p2", 25), build("p3", 15), build("p4", 5)];
    expect(projectAssessment(ok, []).isProject).toBe(true);

    const tooFew = [build("p1", 35), build("p2", 25), build("p3", 5)];
    expect(projectAssessment(tooFew, []).isProject).toBe(false);

    const oneBuild = [build("p1", 35), memo("p2", { topic: "Portfolio", created_at: iso(25) }), memo("p3", { topic: "Portfolio", created_at: iso(15) }), memo("p4", { topic: "Portfolio", created_at: iso(5) })];
    expect(projectAssessment(oneBuild, []).buildSignals).toBe(1);
    expect(projectAssessment(oneBuild, []).isProject).toBe(false);

    const oneEvening = [build("p1", 4), build("p2", 3), build("p3", 2), build("p4", 1)];
    expect(projectAssessment(oneEvening, []).isProject).toBe(false); // spread < 7 days

    const incoherent = [
      memo("p1", { topic: "One", current_intent: "build", created_at: iso(35) }),
      memo("p2", { topic: "Two", current_intent: "build", created_at: iso(25) }),
      memo("p3", { topic: "Three", current_intent: "build", created_at: iso(15) }),
      memo("p4", { topic: "Four", current_intent: "build", created_at: iso(5) }),
    ];
    expect(projectAssessment(incoherent, []).coherent).toBe(false);
    expect(projectAssessment(incoherent, []).isProject).toBe(false);
  });

  it("a non-project cluster stays a collection", () => {
    const cluster = [memo("c1"), memo("c2"), memo("c3")];
    const sets = detectCandidateSets(cluster, []);
    expect(sets).toHaveLength(1);
    expect(sets[0].isProject).toBe(false);
  });
});

// ------------------------------------------------------------- runDiscovery

describe("runDiscovery", () => {
  it("creates a suggestion when evidence clears the gate (deterministic-first)", async () => {
    const memories = [memo("m1"), memo("m2"), memo("m3")];
    const { client, insertedCollections, insertedMembers } = makeClient({ memories });
    const result = await runDiscovery({
      getClient: async () => client,
      synthesize: async () => ({ name: "Trip planning", description: "A group around travel saves." }),
    });

    expect(result.created).toHaveLength(1);
    expect(insertedCollections).toHaveLength(1);
    const row = insertedCollections[0];
    expect(row.origin).toBe("ai_suggested");
    expect(row.state).toBe("suggested");
    expect(row.kind).toBe("collection");
    expect(row.basis.signature).toBe(signatureOf(["m1", "m2", "m3"]));
    expect(row.basis.signals.length).toBeGreaterThanOrEqual(2);

    expect(insertedMembers).toHaveLength(1);
    expect(insertedMembers[0]).toHaveLength(3);
    expect(insertedMembers[0][0].state).toBe("suggested");
  });

  it("AI suggestions remain suggestions — never accepted on their own", async () => {
    const { client, insertedCollections } = makeClient({ memories: [memo("m1"), memo("m2"), memo("m3")] });
    await runDiscovery({ getClient: async () => client, synthesize: async () => ({ name: "X", description: "Y" }) });
    expect(insertedCollections[0].state).toBe("suggested");
    expect(insertedCollections[0].origin).toBe("ai_suggested");
  });

  it("stays quiet when there is no evidence", async () => {
    const { client, insertedCollections } = makeClient({ memories: [memo("m1")] });
    const result = await runDiscovery({ getClient: async () => client, synthesize: async () => ({ name: "X", description: "Y" }) });
    expect(result.created).toEqual([]);
    expect(insertedCollections).toHaveLength(0);
  });

  it("respects the unresolved-suggestions cap", async () => {
    const collections = [1, 2, 3].map((i) => ({ id: `c${i}`, name: `n${i}`, state: "suggested", kind: "collection", basis: { signature: `s${i}` }, updated_at: iso(1) }));
    const { client, insertedCollections } = makeClient({ memories: [memo("m1"), memo("m2"), memo("m3")], collections });
    const result = await runDiscovery({ getClient: async () => client, synthesize: async () => ({ name: "X", description: "Y" }) });
    expect(result.skipped).toBe("unresolved_cap");
    expect(insertedCollections).toHaveLength(0);
  });

  it("dismissed signatures do not resurface (90-day cooldown)", async () => {
    const sig = signatureOf(["m1", "m2", "m3"]);
    const collections = [
      { id: "c1", name: "Old idea", state: "dismissed", kind: "collection", basis: { signature: sig, dismissed_at: iso(2) }, updated_at: iso(2) },
    ];
    const { client, insertedCollections } = makeClient({ memories: [memo("m1"), memo("m2"), memo("m3")], collections });
    const result = await runDiscovery({ getClient: async () => client, synthesize: async () => ({ name: "X", description: "Y" }) });
    expect(result.created).toEqual([]);
    expect(insertedCollections).toHaveLength(0);
  });

  it("skips sets already covered by an accepted collection (≥70% overlap)", async () => {
    const collections = [
      { id: "c1", name: "Accepted", state: "accepted", kind: "collection", basis: { signature: "other" }, updated_at: iso(1) },
    ];
    const members = ["m1", "m2", "m3", "m4"].map((id) => ({ collection_id: "c1", memory_id: id }));
    const { client, insertedCollections } = makeClient({ memories: [memo("m1"), memo("m2"), memo("m3")], collections, members });
    const result = await runDiscovery({ getClient: async () => client, synthesize: async () => ({ name: "X", description: "Y" }) });
    expect(result.created).toEqual([]);
    expect(insertedCollections).toHaveLength(0);
  });

  it("caps new suggestions per run", () => {
    expect(MAX_NEW_PER_RUN).toBe(2);
  });
});

// ------------------------------------------------------------------ actions

describe("actOnCollection", () => {
  it("accept activates membership and preserves the original evidence", async () => {
    const { client, updates } = makeClient({ singleRow: { id: "c1", state: "suggested", basis: { signature: "s", signals: [{ type: "topic_frequency", detail: "3 around travel" }] } } });
    const result = await actOnCollection("c1", "accept", {}, { getClient: async () => client });
    expect(result).toEqual({ ok: true, state: "accepted" });

    const collectionUpdate = updates.find((u) => u.table === "collections")!;
    expect(collectionUpdate.payload.state).toBe("accepted");
    expect(collectionUpdate.payload.basis.signature).toBe("s");
    expect(typeof collectionUpdate.payload.basis.accepted_at).toBe("string");

    const memberUpdate = updates.find((u) => u.table === "collection_members")!;
    expect(memberUpdate.payload).toEqual({ state: "confirmed" });
  });

  it("dismiss records dismissed_at for cooldown bookkeeping", async () => {
    const { client, updates } = makeClient({ singleRow: { id: "c1", state: "suggested", basis: { signature: "s" } } });
    const result = await actOnCollection("c1", "dismiss", {}, { getClient: async () => client });
    expect(result).toEqual({ ok: true, state: "dismissed" });
    const update = updates.find((u) => u.table === "collections")!;
    expect(typeof update.payload.basis.dismissed_at).toBe("string");
  });

  it("rename validates and surfaces name conflicts", async () => {
    const ok = makeClient({ singleRow: { id: "c1", state: "accepted", basis: {} } });
    expect(await actOnCollection("c1", "rename", { name: "My trips" }, { getClient: async () => ok.client })).toEqual({ ok: true, state: "accepted" });

    const conflict = makeClient({ singleRow: { id: "c1", state: "accepted", basis: {} }, updateError: { code: "23505" } });
    expect(await actOnCollection("c1", "rename", { name: "Taken" }, { getClient: async () => conflict.client })).toEqual({ ok: false, reason: "name_taken" });

    const empty = makeClient({ singleRow: { id: "c1", state: "accepted", basis: {} } });
    expect(await actOnCollection("c1", "rename", { name: "  " }, { getClient: async () => empty.client })).toEqual({ ok: false, reason: "invalid_name" });
  });

  it("archive only from accepted", async () => {
    const accepted = makeClient({ singleRow: { id: "c1", state: "accepted", basis: {} } });
    expect(await actOnCollection("c1", "archive", {}, { getClient: async () => accepted.client })).toEqual({ ok: true, state: "archived" });

    const suggested = makeClient({ singleRow: { id: "c1", state: "suggested", basis: {} } });
    expect(await actOnCollection("c1", "archive", {}, { getClient: async () => suggested.client })).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("another user's collection is invisible (RLS) → not_found", async () => {
    const { client } = makeClient({ singleRow: null });
    expect(await actOnCollection("c-foreign", "accept", {}, { getClient: async () => client })).toEqual({ ok: false, reason: "not_found" });
  });
});
