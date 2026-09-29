import { describe, it, expect } from "vitest";
import {
  orderPair,
  validateCandidates,
  persistConnectionCandidates,
  actOnConnection,
  MIN_CONNECTION_CONFIDENCE,
} from "@/server/services/connections";

// ------------------------------------------------------------------ fakes

type AnyHandler = (table: string, ops: Array<[string, any[]]>, terminal: string) => any;

function makeClient(handler: AnyHandler) {
  const client: any = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      const ops: Array<[string, any[]]> = [];
      const builder: any = {};
      for (const method of ["select", "eq", "neq", "in", "limit", "order", "not", "ilike"]) {
        builder[method] = (...args: any[]) => {
          ops.push([method, args]);
          return builder;
        };
      }
      builder.maybeSingle = async () => handler(table, ops, "maybeSingle");
      builder.single = async () => handler(table, ops, "single");
      builder.insert = (payload: any) => {
        ops.push(["insert", [payload]]);
        return builder;
      };
      builder.update = (payload: any) => {
        ops.push(["update", [payload]]);
        return builder;
      };
      builder.then = (resolve: any, reject: any) =>
        Promise.resolve(handler(table, ops, "then")).then(resolve, reject);
      return builder;
    },
  };
  return client;
}

// ---------------------------------------------------------------- ordering

describe("orderPair", () => {
  it("keeps canonical ordering (source < target)", () => {
    expect(orderPair("aaa", "bbb")).toEqual(["aaa", "bbb"]);
    expect(orderPair("bbb", "aaa")).toEqual(["aaa", "bbb"]);
  });
});

// -------------------------------------------------------------- validation

describe("validateCandidates", () => {
  const allowed = ["m2", "m3", "m4"];
  const valid = {
    memory_id: "m2",
    relationship_type: "same_subject",
    confidence: 0.8,
    basis: "Both are product pages for the same perfume brand.",
  };

  it("accepts a justified, confident candidate from the retrieved set", () => {
    const out = validateCandidates({ newMemoryId: "m1", allowedMemoryIds: allowed, candidates: [valid] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ otherMemoryId: "m2", relationshipType: "same_subject", confidence: 0.8 });
  });

  it("similarity alone is never enough — rejects low confidence, empty basis, bad type", () => {
    const junk = [
      { ...valid, confidence: MIN_CONNECTION_CONFIDENCE - 0.01 },
      { ...valid, basis: "" },
      { ...valid, basis: "  hi " },
      { ...valid, relationship_type: "similar" },
      { ...valid, relationship_type: "user_linked" },
    ];
    expect(validateCandidates({ newMemoryId: "m1", allowedMemoryIds: allowed, candidates: junk })).toHaveLength(0);
  });

  it("rejects self-connections and ids outside the retrieved set", () => {
    expect(
      validateCandidates({
        newMemoryId: "m1",
        allowedMemoryIds: allowed,
        candidates: [{ ...valid, memory_id: "m1" }, { ...valid, memory_id: "mZZ" }],
      })
    ).toHaveLength(0);
  });

  it("dedupes repeated ids and caps the list", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...valid, memory_id: `x${i}` }));
    const out = validateCandidates({
      newMemoryId: "m1",
      allowedMemoryIds: [...many.map((m) => m.memory_id), "m2"],
      candidates: [valid, valid, ...many],
    });
    expect(out.length).toBeLessThanOrEqual(5);
    expect(new Set(out.map((c) => c.otherMemoryId)).size).toBe(out.length);
  });
});

// ------------------------------------------------------------ persistence

describe("persistConnectionCandidates", () => {
  const input = {
    userId: "u1",
    newMemoryId: "bbb",
    allowedMemoryIds: ["aaa", "ccc"],
    candidates: [
      { memory_id: "aaa", relationship_type: "complementary", confidence: 0.9, basis: "Both about the same laptop." },
      { memory_id: "ccc", relationship_type: "thematic", confidence: 0.7, basis: "Both part of the same travel plan." },
    ],
  };

  it("persists as suggested/ai with canonical ordering and skips existing pairs", async () => {
    const inserts: any[] = [];
    const client = makeClient((table, ops, terminal) => {
      if (table === "memories") return { data: [{ id: "aaa" }, { id: "ccc" }] };
      if (table === "connections" && ops.some(([m]) => m === "insert")) {
        inserts.push(ops.find(([m]) => m === "insert")![1][0]);
        return { error: null };
      }
      if (table === "connections" && terminal === "maybeSingle") {
        // simulates the "ccc" pair already existing (any state — never recreated)
        return { data: ops.some(([m, a]) => m === "eq" && a[1] === "ccc") ? { id: "existing" } : null };
      }
      return { data: null };
    });

    const result = await persistConnectionCandidates(input, { getClient: async () => client });
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);

    const row = inserts[0];
    expect(row.source_memory_id).toBe("aaa"); // canonical: min first (aaa < bbb)
    expect(row.target_memory_id).toBe("bbb");
    expect(row.state).toBe("suggested");
    expect(row.origin).toBe("ai");
    expect(row.relationship_type).toBe("complementary");
    expect(row.basis.prompt_version).toBe("connections-v1");
    expect(typeof row.basis.reasoning).toBe("string");
  });

  it("never links memories that don't belong to the user", async () => {
    const inserts: any[] = [];
    const client = makeClient((table, ops) => {
      if (table === "memories") return { data: [{ id: "aaa" }] }; // ccc not owned
      if (table === "connections" && ops.some(([m]) => m === "insert")) {
        inserts.push(ops.find(([m]) => m === "insert")![1][0]);
        return { error: null };
      }
      return { data: null, error: null };
    });
    const result = await persistConnectionCandidates(input, { getClient: async () => client });
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(inserts).toHaveLength(1);
  });

  it("does nothing when there are no valid candidates", async () => {
    const result = await persistConnectionCandidates(
      { ...input, candidates: [{ memory_id: "aaa", relationship_type: "same_subject", confidence: 0.2, basis: "x" }] },
      { getClient: async () => makeClient(() => ({ data: null })) }
    );
    expect(result).toEqual({ created: 0, skipped: 0 });
  });
});

// ------------------------------------------------------------------ actions

describe("actOnConnection", () => {
  it("confirms a suggested connection", async () => {
    const updates: any[] = [];
    const client = makeClient((table, ops, terminal) => {
      if (terminal === "maybeSingle") return { data: { id: "c1", state: "suggested" } };
      if (ops.some(([m]) => m === "update")) {
        updates.push(ops.find(([m]) => m === "update")![1][0]);
        return { error: null };
      }
      return { data: null };
    });
    const result = await actOnConnection("c1", "confirm", { getClient: async () => client });
    expect(result).toEqual({ ok: true, state: "confirmed" });
    expect(updates[0]).toEqual({ state: "confirmed" });
  });

  it("dismisses a suggested connection", async () => {
    const client = makeClient((table, ops, terminal) => {
      if (terminal === "maybeSingle") return { data: { id: "c1", state: "suggested" } };
      if (ops.some(([m]) => m === "update")) return { error: null };
      return { data: null };
    });
    const result = await actOnConnection("c1", "dismiss", { getClient: async () => client });
    expect(result).toEqual({ ok: true, state: "dismissed" });
  });

  it("cannot re-decide an already-decided connection", async () => {
    const client = makeClient((table, ops, terminal) => {
      if (terminal === "maybeSingle") return { data: { id: "c1", state: "confirmed" } };
      return { data: null, error: null };
    });
    expect(await actOnConnection("c1", "dismiss", { getClient: async () => client })).toEqual({
      ok: false,
      reason: "invalid_state",
    });
  });

  it("another user's connection is invisible (RLS) → not_found", async () => {
    const client = makeClient(() => ({ data: null }));
    expect(await actOnConnection("c-foreign", "confirm", { getClient: async () => client })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
