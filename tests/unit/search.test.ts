import { describe, it, expect } from "vitest";
import {
  sanitizeQuery,
  normalizeFilters,
  hasFilters,
  applyFilters,
  assembleResults,
  detectTopicInQuery,
  searchMemories,
  SearchError,
  type Candidate,
} from "@/server/services/search";
import { SearchRequestSchema, MAX_SEARCH_QUERY_LEN } from "@/lib/validation";

// ---------------------------------------------------------------- fakes

function queue<T>(...items: T[]): () => T {
  let index = 0;
  return () => items[Math.min(index++, items.length - 1)];
}

function builder(result: any, log: any[]) {
  const b: any = {};
  for (const method of ["select", "eq", "neq", "ilike", "not", "order", "limit", "in"]) {
    b[method] = (...args: any[]) => {
      log.push([method, ...args]);
      return b;
    };
  }
  b.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return b;
}

function makeClient(opts: {
  user?: { id: string } | null;
  rpc?: (name: string, args: any) => { data: any; error?: any };
  tables?: Record<string, any>;
}) {
  const calls = { rpc: [] as any[], tables: [] as string[], chains: {} as Record<string, any[][]> };
  const client = {
    auth: {
      getUser: async () => ({ data: { user: opts.user === undefined ? { id: "u1" } : opts.user } }),
    },
    rpc: async (name: string, args: any) => {
      calls.rpc.push({ name, args });
      return opts.rpc ? opts.rpc(name, args) : { data: [] };
    },
    from: (table: string) => {
      calls.tables.push(table);
      calls.chains[table] = calls.chains[table] ?? [];
      const log: any[] = [];
      calls.chains[table].push(log);
      const result = opts.tables?.[table];
      const r = typeof result === "function" ? result() : result ?? { data: [] };
      return builder(r, log);
    },
  };
  return { client, calls };
}

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  memory_id: id,
  title: `T-${id}`,
  topic: "Topic",
  current_intent: "try",
  suggested_action: "test",
  status: "active",
  created_at: "2026-09-29T00:00:00Z",
  source: "semantic",
  ...over,
});

const fakeEmbed = (vector = 0.1) => async (_text: string) => new Array(2048).fill(vector);

// ---------------------------------------------------------------- validation

describe("SearchRequestSchema", () => {
  it("accepts a natural-language query", () => {
    expect(SearchRequestSchema.safeParse({ query: "that perfume I wanted to try" }).success).toBe(true);
  });
  it("accepts filter-only requests", () => {
    expect(SearchRequestSchema.safeParse({ intent: "buy" }).success).toBe(true);
  });
  it("rejects empty query with no filters", () => {
    expect(SearchRequestSchema.safeParse({}).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "   " }).success).toBe(false);
  });
  it("rejects overlong queries", () => {
    expect(SearchRequestSchema.safeParse({ query: "x".repeat(301) }).success).toBe(false);
  });
  it("rejects unknown intent/action/status values", () => {
    expect(SearchRequestSchema.safeParse({ query: "a", intent: "nope" }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "a", action: "nope" }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: "a", status: "nope" }).success).toBe(false);
  });
});

describe("sanitizeQuery", () => {
  it("trims and clamps", () => {
    expect(sanitizeQuery("  hello  ")).toBe("hello");
    expect(sanitizeQuery("x".repeat(500)).length).toBe(MAX_SEARCH_QUERY_LEN);
  });
  it("returns empty string for non-strings", () => {
    expect(sanitizeQuery(undefined)).toBe("");
    expect(sanitizeQuery(42)).toBe("");
  });
});

describe("normalizeFilters / hasFilters", () => {
  it("keeps valid filters, drops junk", () => {
    const junkInput: any = { intent: "try", topic: "  Fragrance ", action: "test", status: "archived", extra: "x" };
    const f = normalizeFilters(junkInput);
    expect(f).toEqual({ intent: "try", topic: "Fragrance", action: "test", status: "archived" });
    expect(normalizeFilters({ intent: "wrong", topic: "   ", status: "nope" })).toEqual({});
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ intent: "buy" })).toBe(true);
  });
});

describe("applyFilters", () => {
  const items = [
    cand("a", { current_intent: "try", topic: "Fragrance", suggested_action: "test", status: "active" }),
    cand("b", { current_intent: "buy", topic: "Shopping", suggested_action: "buy", status: "archived" }),
    cand("c", { current_intent: "research", topic: "Finance", suggested_action: "evaluate", status: "active" }),
  ];
  it("filters by intent/action/status exactly and topic case-insensitively", () => {
    expect(applyFilters(items, { intent: "try" }).map((x) => x.memory_id)).toEqual(["a"]);
    expect(applyFilters(items, { topic: "fragrance" }).map((x) => x.memory_id)).toEqual(["a"]);
    expect(applyFilters(items, { action: "buy" }).map((x) => x.memory_id)).toEqual(["b"]);
    expect(applyFilters(items, { status: "archived" }).map((x) => x.memory_id)).toEqual(["b"]);
    expect(applyFilters(items, { intent: "try", status: "archived" })).toEqual([]);
  });
});

describe("assembleResults", () => {
  it("dedupes, keeps order, caps at 12", () => {
    const many = Array.from({ length: 15 }, (_, i) => cand(`m${i}`));
    const deduped = assembleResults([cand("a"), cand("a"), cand("b")]);
    expect(deduped.map((x) => x.memory_id)).toEqual(["a", "b"]);
    expect(assembleResults(many)).toHaveLength(12);
  });
});

describe("detectTopicInQuery", () => {
  it("finds case-insensitive topic mentions, longest wins", () => {
    expect(detectTopicInQuery("grab that FRAGRANCE deal", ["Fragrance"])).toBe("fragrance");
    expect(detectTopicInQuery("ai tools I saved", ["ai", "ai tools"])).toBe("ai tools");
    expect(detectTopicInQuery("random words", ["Fragrance"])).toBeNull();
  });
});

// ---------------------------------------------------------------- service

describe("searchMemories (service)", () => {
  it("embeds the sanitized query, runs KNN with the session user and maps results", async () => {
    const embedded: string[] = [];
    const knn = [
      { memory_id: "m1", title: "Perfume", topic: "Fragrance", current_intent: "try", suggested_action: "test", status: "active", created_at: "2026-01-01T00:00:00Z", similarity: 0.62 },
      { memory_id: "m2", title: "Unrelated", topic: "X", current_intent: "unknown", suggested_action: "none", status: "active", created_at: "2026-01-02T00:00:00Z", similarity: 0.05 },
    ];
    const { client, calls } = makeClient({
      rpc: () => ({ data: knn }),
      tables: {
        memories: queue(
          { data: [{ topic: "Fragrance" }] },
          { data: [{ id: "m1", summary: "Wants to try it later", capture_id: "c1" }] }
        ),
        captures: { data: [{ id: "c1", storage_path: "u1/c1.png", original_note: "try this later" }] },
      },
    });

    const res = await searchMemories(
      { query: "  that perfume I wanted to try " },
      {
        getClient: async () => client,
        embed: (t) => {
          embedded.push(t);
          return fakeEmbed()(t);
        },
        signUrls: async () => ({ "u1/c1.png": "https://signed.example/c1.png" }),
      }
    );

    expect(embedded).toEqual(["that perfume I wanted to try"]);
    expect(calls.rpc[0].name).toBe("match_memories");
    expect(calls.rpc[0].args.p_user_id).toBe("u1");
    expect(calls.rpc[0].args.match_count).toBe(10); // no filters → KNN top-10
    expect(res.results).toHaveLength(1); // below-floor hit dropped
    expect(res.results[0]).toMatchObject({
      memoryId: "m1",
      summary: "Wants to try it later",
      note: "try this later",
      signedUrl: "https://signed.example/c1.png",
      similarity: 0.62,
    });
  });

  it("over-fetches and applies filters when filters are active", async () => {
    const knn = [
      { memory_id: "m1", title: "Perfume", topic: "Fragrance", current_intent: "try", suggested_action: "test", status: "active", created_at: "2026-01-01T00:00:00Z", similarity: 0.6 },
      { memory_id: "m2", title: "Desk", topic: "Shopping", current_intent: "buy", suggested_action: "buy", status: "active", created_at: "2026-01-02T00:00:00Z", similarity: 0.55 },
    ];
    const { client, calls } = makeClient({
      rpc: () => ({ data: knn }),
      tables: {
        memories: queue(
          { data: [{ topic: "Fragrance" }] },
          { data: [{ id: "m1", summary: "S", capture_id: "c1" }] }
        ),
        captures: { data: [{ id: "c1", storage_path: "u1/c1.png", original_note: null }] },
      },
    });

    const res = await searchMemories(
      { query: "perfume", filters: { intent: "try" } },
      { getClient: async () => client, embed: fakeEmbed(), signUrls: async () => ({}) }
    );

    expect(calls.rpc[0].args.match_count).toBe(25); // filters → headroom
    expect(res.results.map((r) => r.memoryId)).toEqual(["m1"]);
  });

  it("adds the exact-topic supplement after semantic hits (dedupe + order)", async () => {
    const knn = [
      { memory_id: "m1", title: "Perfume", topic: "Fragrance", current_intent: "try", suggested_action: "test", status: "active", created_at: "2026-01-01T00:00:00Z", similarity: 0.5 },
    ];
    const { client } = makeClient({
      rpc: () => ({ data: knn }),
      tables: {
        memories: queue(
          { data: [{ topic: "Fragrance" }] }, // topics list
          { data: [ // topic supplement (m1 duplicated)
              { id: "m1", title: "Perfume", topic: "Fragrance", current_intent: "try", suggested_action: "test", status: "active", created_at: "2026-01-01T00:00:00Z" },
              { id: "m9", title: "Cologne", topic: "Fragrance", current_intent: "save_for_later", suggested_action: "none", status: "active", created_at: "2026-01-03T00:00:00Z" },
            ] },
          { data: [
              { id: "m1", summary: "S1", capture_id: "c1" },
              { id: "m9", summary: "S9", capture_id: "c9" },
            ] }
        ),
        captures: { data: [
          { id: "c1", storage_path: "u1/c1.png", original_note: null },
          { id: "c9", storage_path: "u1/c9.png", original_note: null },
        ] },
      },
    });

    const res = await searchMemories(
      { query: "fragrance ideas" },
      { getClient: async () => client, embed: fakeEmbed(), signUrls: async () => ({}) }
    );

    expect(res.results.map((r) => r.memoryId)).toEqual(["m1", "m9"]);
  });

  it("filters-only browse: no embedding call, deterministic listing", async () => {
    let embedCalled = false;
    const { client, calls } = makeClient({
      tables: {
        memories: queue(
          { data: [{ id: "m1", title: "Desk", topic: "Shopping", current_intent: "buy", suggested_action: "buy", status: "active", created_at: "2026-01-01T00:00:00Z" }] },
          { data: [{ id: "m1", summary: "S", capture_id: "c1" }] }
        ),
        captures: { data: [{ id: "c1", storage_path: "u1/c1.png", original_note: "buy this" }] },
      },
    });

    const res = await searchMemories(
      { query: "", filters: { intent: "buy" } },
      {
        getClient: async () => client,
        embed: async (t) => {
          embedCalled = true;
          return fakeEmbed()(t);
        },
        signUrls: async () => ({}),
      }
    );

    expect(embedCalled).toBe(false);
    expect(calls.rpc).toHaveLength(0);
    const listing = calls.chains["memories"][0];
    expect(listing).toContainEqual(["eq", "current_intent", "buy"]);
    expect(res.results.map((r) => r.memoryId)).toEqual(["m1"]);
  });

  it("returns empty results cleanly", async () => {
    const { client } = makeClient({ rpc: () => ({ data: [] }), tables: { memories: { data: [] } } });
    const res = await searchMemories(
      { query: "quantum chromodynamics" },
      { getClient: async () => client, embed: fakeEmbed(), signUrls: async () => ({}) }
    );
    expect(res.results).toEqual([]);
  });

  it("maps embedding failure to a generic search_failed error", async () => {
    const { client } = makeClient({});
    await expect(
      searchMemories(
        { query: "perfume" },
        {
          getClient: async () => client,
          embed: async () => {
            throw new Error("HTTP 502: provider exploded");
          },
          signUrls: async () => ({}),
        }
      )
    ).rejects.toMatchObject({ name: "SearchError", code: "search_failed" });
  });

  it("rejects empty query with no filters as invalid_input", async () => {
    const { client } = makeClient({});
    await expect(
      searchMemories({ query: "   " }, { getClient: async () => client, embed: fakeEmbed(), signUrls: async () => ({}) })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("throws unauthorized when there is no session user", async () => {
    const { client } = makeClient({ user: null });
    await expect(
      searchMemories({ query: "x" }, { getClient: async () => client, embed: fakeEmbed(), signUrls: async () => ({}) })
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(SearchError.prototype instanceof Error).toBe(true);
  });
});
