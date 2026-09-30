import { describe, it, expect } from "vitest";
import { retryCapture } from "@/server/services/captures";

type Ops = Array<[string, any[]]>;

function makeClient(row: any) {
  const updates: any[] = [];
  const client: any = {
    from: (_table: string) => {
      const ops: Ops = [];
      const builder: any = {};
      for (const method of ["select", "eq", "neq", "in", "gte", "order", "limit"]) {
        builder[method] = (...args: any[]) => {
          ops.push([method, args]);
          return builder;
        };
      }
      const resolve = () => {
        const updateOp = ops.find(([m]) => m === "update");
        if (updateOp) {
          updates.push(updateOp[1][0]);
          return { error: null };
        }
        return { data: row };
      };
      builder.single = async () => resolve();
      builder.maybeSingle = async () => resolve();
      builder.update = (payload: any) => {
        ops.push(["update", [payload]]);
        return builder;
      };
      builder.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej);
      return builder;
    },
  };
  return { client, updates };
}

describe("retryCapture recovery paths (M6)", () => {
  it("recovers an 'uploaded' capture that was never claimed (enqueue failure edge)", async () => {
    const { client, updates } = makeClient({
      id: "c1",
      processing_status: "uploaded",
      attempt_count: 0,
      last_attempt_at: null,
    });
    const enqueues: any[] = [];
    const result = await retryCapture("u1", "c1", {
      getClient: () => client,
      enqueue: async (id, attempts, unique) => {
        enqueues.push({ id, attempts, unique });
        return { enqueued: true };
      },
    });
    expect(result).toEqual({ status: "uploaded" });
    expect(updates[0]).toEqual({ processing_status: "uploaded", last_error: null });
    expect(enqueues[0]).toEqual({ id: "c1", attempts: 0, unique: true });
  });

  it("recovers stale 'processing' (run died between claim and outcome)", async () => {
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const { client } = makeClient({
      id: "c1",
      processing_status: "processing",
      attempt_count: 2,
      last_attempt_at: stale,
    });
    const enqueues: any[] = [];
    const result = await retryCapture("u1", "c1", {
      getClient: () => client,
      enqueue: async (id, attempts, unique) => {
        enqueues.push({ id, attempts, unique });
        return { enqueued: true };
      },
    });
    expect(result).toEqual({ status: "uploaded" });
    expect(enqueues[0]).toEqual({ id: "c1", attempts: 2, unique: true });
  });

  it("does not touch fresh transient states", async () => {
    const fresh = new Date(Date.now() - 60 * 1000).toISOString();
    const { client } = makeClient({
      id: "c1",
      processing_status: "processing",
      attempt_count: 1,
      last_attempt_at: fresh,
    });
    const result = await retryCapture("u1", "c1", {
      getClient: () => client,
      enqueue: async () => {
        throw new Error("should not enqueue");
      },
    });
    expect(result).toEqual({ status: "processing" });
  });

  it("failed retries keep the attempt-based deterministic id (double-click dedupe)", async () => {
    const { client } = makeClient({
      id: "c1",
      processing_status: "failed",
      attempt_count: 1,
      last_attempt_at: null,
    });
    const enqueues: any[] = [];
    await retryCapture("u1", "c1", {
      getClient: () => client,
      enqueue: async (_id, attempts, unique) => {
        enqueues.push({ attempts, unique });
        return { enqueued: true };
      },
    });
    expect(enqueues[0]).toEqual({ attempts: 1, unique: false });
  });

  it("respects the retry cap", async () => {
    const { client } = makeClient({
      id: "c1",
      processing_status: "failed",
      attempt_count: 6,
      last_attempt_at: null,
    });
    const result = await retryCapture("u1", "c1", {
      getClient: () => client,
      enqueue: async () => {
        throw new Error("should not enqueue");
      },
    });
    expect(result).toEqual({ status: "failed", error: "retry_limit_reached" });
  });
});
