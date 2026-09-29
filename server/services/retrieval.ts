import { createAdminClient } from "@/lib/supabase/admin";
import { toVectorLiteral } from "../ai/providers";
import type { MemoryCard } from "../ai/contracts";

/**
 * V1 retrieval (Phase 3 §9): semantic KNN top-10 + duplicate supplement +
 * recency fallback → at most 12 memory cards. No reranker, no MMR.
 */
export async function retrieveContext(input: {
  userId: string;
  captureId: string;
  fileHash: string | null;
  queryEmbedding: number[] | null;
}): Promise<MemoryCard[]> {
  const admin = createAdminClient();
  const cards: MemoryCard[] = [];
  const seen = new Set<string>();
  const push = (card: MemoryCard) => {
    if (!seen.has(card.memory_id) && cards.length < 12) {
      seen.add(card.memory_id);
      cards.push(card);
    }
  };

  if (input.queryEmbedding) {
    const { data, error } = await admin.rpc("match_memories", {
      p_user_id: input.userId,
      query_embedding: toVectorLiteral(input.queryEmbedding),
      match_count: 10,
    });
    if (!error && data) {
      for (const row of data as Record<string, unknown>[]) {
        push({
          memory_id: String(row.memory_id),
          title: (row.title as string) ?? null,
          topic: (row.topic as string) ?? null,
          current_intent: (row.current_intent as string) ?? null,
          suggested_action: (row.suggested_action as string) ?? null,
          status: (row.status as string) ?? null,
          created_at: String(row.created_at),
          similarity: typeof row.similarity === "number" ? row.similarity : undefined,
        });
      }
    }
  }

  if (input.fileHash) {
    const { data: duplicates } = await admin
      .from("captures")
      .select("id")
      .eq("user_id", input.userId)
      .eq("file_hash", input.fileHash)
      .neq("id", input.captureId)
      .limit(3);
    for (const duplicate of duplicates ?? []) {
      const { data: memory } = await admin
        .from("memories")
        .select("id, title, topic, current_intent, suggested_action, status, created_at")
        .eq("capture_id", duplicate.id)
        .maybeSingle();
      if (memory) {
        push({
          memory_id: memory.id,
          title: memory.title,
          topic: memory.topic,
          current_intent: memory.current_intent,
          suggested_action: memory.suggested_action,
          status: memory.status,
          created_at: memory.created_at,
        });
      }
    }
  }

  if (cards.length < 3) {
    const { data: recent } = await admin
      .from("memories")
      .select("id, title, topic, current_intent, suggested_action, status, created_at")
      .eq("user_id", input.userId)
      .order("created_at", { ascending: false })
      .limit(5);
    for (const memory of recent ?? []) {
      push({
        memory_id: memory.id,
        title: memory.title,
        topic: memory.topic,
        current_intent: memory.current_intent,
        suggested_action: memory.suggested_action,
        status: memory.status,
        created_at: memory.created_at,
      });
    }
  }

  return cards;
}
