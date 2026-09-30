import crypto from "crypto";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { inngest } from "@/inngest/client";
import { EXT_BY_MIME, type InitCaptureInput } from "@/lib/validation";
import * as storage from "./storage";

/** Capture lifecycle (user-scoped operations; RLS enforced). */

export async function createCapture(userId: string, input: InitCaptureInput) {
  const captureId = crypto.randomUUID();
  const ext = EXT_BY_MIME[input.mime_type];
  const path = `${userId}/${captureId}.${ext}`;

  const supabase = createClient();
  const { error } = await supabase.from("captures").insert({
    id: captureId,
    user_id: userId,
    storage_path: path,
    original_note: input.note ?? null,
    source: "web",
    mime_type: input.mime_type,
    processing_status: "upload_pending",
  });
  if (error) throw new Error(`capture insert failed: ${error.message}`);

  const upload = await storage.createSignedUploadUrl(path);
  return {
    capture_id: captureId,
    path,
    upload: { signed_url: upload.signedUrl, token: upload.token },
  };
}

export async function countRecentCaptures(userId: string): Promise<number> {
  const supabase = createClient();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await supabase
    .from("captures")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  return count ?? 0;
}

export async function completeCapture(userId: string, captureId: string, fileHash: string) {
  const supabase = createClient();
  const { data: capture, error } = await supabase
    .from("captures")
    .select("id, storage_path, processing_status, attempt_count")
    .eq("id", captureId)
    .single();
  if (error || !capture) throw new Error("capture not found");

  // Idempotent: already past upload?
  if (capture.processing_status !== "upload_pending" && capture.processing_status !== "failed") {
    return { status: capture.processing_status };
  }

  const { exists } = await storage.objectExists(capture.storage_path);
  if (!exists) throw new Error("upload not found — please try uploading again");

  const { error: updateError } = await supabase
    .from("captures")
    .update({ processing_status: "uploaded", file_hash: fileHash, last_error: null })
    .eq("id", captureId);
  if (updateError) throw new Error(updateError.message);

  await enqueueProcessing(captureId, capture.attempt_count ?? 0);
  return { status: "uploaded" };
}

export async function enqueueProcessing(captureId: string, attemptCount = 0, unique = false) {
  if (env.processingPaused()) return { enqueued: false, reason: "paused" };
  try {
    // Attempt-aware event id: the first enqueue uses the stable id (duplicate
    // completions dedupe), but retries MUST be re-triggerable — Inngest ignores
    // duplicate event ids for 24h, so each retry sends a fresh id. Stuck-state
    // recoveries pass unique=true (atomic claim makes double-delivery safe).
    const base =
      attemptCount > 0 ? `capture-${captureId}-r${attemptCount}` : `capture-${captureId}`;
    const eventId = unique ? `${base}-t${Date.now()}` : base;
    await inngest.send({
      id: eventId,
      name: "capture/complete",
      data: { captureId },
    });
    return { enqueued: true };
  } catch (error) {
    // Do not fail the capture because the queue is unreachable — the capture
    // stays 'uploaded' and can be re-enqueued later.
    console.error("enqueue failed:", (error as Error).message);
    return { enqueued: false, reason: "send_failed" };
  }
}

const STALE_PROCESSING_MS = 10 * 60 * 1000;

export async function retryCapture(
  userId: string,
  captureId: string,
  deps: { getClient?: () => any; enqueue?: typeof enqueueProcessing } = {}
) {
  const supabase = await (deps.getClient ? deps.getClient() : createClient());
  const enqueue = deps.enqueue ?? enqueueProcessing;
  const { data: capture } = await supabase
    .from("captures")
    .select("id, processing_status, attempt_count, last_attempt_at")
    .eq("id", captureId)
    .single();
  if (!capture) throw new Error("capture not found");
  if ((capture.attempt_count ?? 0) >= 6) {
    return { status: capture.processing_status, error: "retry_limit_reached" };
  }

  const status = capture.processing_status;
  // Recovery paths for the rare stuck states (M6):
  // - uploaded + never claimed: the initial enqueue send may have failed.
  // - processing + stale: a run died between claim and outcome.
  const enqueueNeverRan = status === "uploaded" && (capture.attempt_count ?? 0) === 0;
  const staleProcessing =
    status === "processing" &&
    Boolean(capture.last_attempt_at) &&
    Date.now() - Date.parse(capture.last_attempt_at) > STALE_PROCESSING_MS;

  if (!["failed", "retrying"].includes(status) && !enqueueNeverRan && !staleProcessing) {
    return { status };
  }

  await supabase
    .from("captures")
    .update({ processing_status: "uploaded", last_error: null })
    .eq("id", captureId);
  // failed/retrying retries keep the attempt-based deterministic id (dedupe on
  // double-click); stuck-state recoveries use a unique id so a previously
  // consumed id can never trap the capture (atomic claim prevents double work).
  await enqueue(captureId, capture.attempt_count ?? 0, enqueueNeverRan || staleProcessing);
  return { status: "uploaded" };
}

export async function deleteCapture(userId: string, captureId: string) {
  const supabase = createClient();
  const { data: capture } = await supabase
    .from("captures")
    .select("id, storage_path")
    .eq("id", captureId)
    .single();
  if (!capture) return { deleted: false };

  try {
    await storage.removeObject(capture.storage_path);
  } catch {
    // Object may already be gone — continue with row deletion.
  }

  const { error } = await supabase.from("captures").delete().eq("id", captureId);
  if (error) throw new Error(error.message);
  return { deleted: true };
}
