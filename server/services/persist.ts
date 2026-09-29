import { createAdminClient } from "@/lib/supabase/admin";

/** Persistence helpers used by the processing pipeline (service role). */

export async function claimCapture(captureId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_capture", { p_capture_id: captureId });
  if (error) throw new Error(`claim failed: ${error.message}`);
  return data as Record<string, unknown> | null;
}

export async function getCapture(captureId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("captures").select("*").eq("id", captureId).single();
  if (error || !data) throw new Error("capture not found");
  return data;
}

export async function getMemoryByCapture(captureId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("memories")
    .select("*")
    .eq("capture_id", captureId)
    .maybeSingle();
  return data;
}

export async function getMemory(memoryId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("memories").select("*").eq("id", memoryId).single();
  if (error || !data) throw new Error("memory not found");
  return data;
}

export async function persistMemory(args: {
  captureId: string;
  title: string;
  summary: string;
  visualDescription: string;
  perception: unknown;
  topic: string;
  intent: string;
  intentSource: string;
  intentConfidence: number | null;
  action: string;
  reason: string;
}) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("persist_memory", {
    p_capture_id: args.captureId,
    p_title: args.title,
    p_summary: args.summary,
    p_visual_description: args.visualDescription,
    p_perception: args.perception as never,
    p_topic: args.topic,
    p_intent: args.intent,
    p_intent_source: args.intentSource,
    p_intent_confidence: args.intentConfidence,
    p_action: args.action,
    p_reason: args.reason,
  });
  if (error) throw new Error(`persist failed: ${error.message}`);
  return data as string;
}

export async function markCaptureFailed(captureId: string, message: string) {
  const admin = createAdminClient();
  await admin
    .from("captures")
    .update({
      processing_status: "failed",
      last_error: message.slice(0, 800),
      last_attempt_at: new Date().toISOString(),
    })
    .eq("id", captureId);
}

export async function upsertEmbedding(args: {
  userId: string;
  memoryId: string;
  model: string;
  embeddingLiteral: string;
  inputHash: string;
}) {
  const admin = createAdminClient();
  const { error } = await admin.from("memory_embeddings").upsert(
    {
      user_id: args.userId,
      memory_id: args.memoryId,
      model: args.model,
      embedding: args.embeddingLiteral,
      input_hash: args.inputHash,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "memory_id,model" }
  );
  if (error) throw new Error(`embedding upsert failed: ${error.message}`);
}

export async function recentMemories(userId: string, limit = 5) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("memories")
    .select("id, title, topic, current_intent, suggested_action, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}
