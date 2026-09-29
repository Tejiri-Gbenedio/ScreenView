// ScreenView — local pipeline E2E smoke tests.
// Default: creates a synthetic capture, triggers the Inngest dev server, waits for memory + embedding.
// --fail:  creates a capture with a missing object to verify the failure path.
// Run: node --env-file=.env.local scripts/e2e-pipeline.mjs [--fail]
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INNGEST_DEV = "http://127.0.0.1:8288";
const FAIL_MODE = process.argv.includes("--fail");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing Supabase env — run with: node --env-file=.env.local scripts/e2e-pipeline.mjs");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// 1x1 red PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const sha = crypto.createHash("sha256").update(PNG).digest("hex");

async function main() {
  const { data: userList, error: listError } = await admin.auth.admin.listUsers();
  if (listError) throw listError;
  const user = userList.users[0];
  if (!user) throw new Error("no auth user exists yet — sign in once first");
  console.log("user:", user.id);

  const captureId = crypto.randomUUID();
  const path = FAIL_MODE
    ? `${user.id}/missing-${captureId}.png` // deliberately absent object
    : `${user.id}/${captureId}.png`;

  if (!FAIL_MODE) {
    const { error: uploadError } = await admin.storage
      .from("captures")
      .upload(path, PNG, { contentType: "image/png", upsert: true });
    if (uploadError) throw uploadError;
  }

  const { error: insertError } = await admin.from("captures").insert({
    id: captureId,
    user_id: user.id,
    storage_path: path,
    original_note: FAIL_MODE ? "E2E failure test — safe to delete." : "E2E pipeline test — safe to delete.",
    source: "e2e",
    mime_type: "image/png",
    file_hash: sha,
    processing_status: "uploaded",
  });
  if (insertError) throw insertError;
  console.log("capture:", captureId);

  const res = await fetch(`${INNGEST_DEV}/e/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "capture/complete", data: { captureId } }),
  });
  console.log("event:", res.status, (await res.text().catch(() => "")).slice(0, 200));

  let last = "";
  const started = Date.now();
  let memorySeen = null;

  while (Date.now() - started < 150000) {
    const { data: capture } = await admin
      .from("captures")
      .select("processing_status, attempt_count, last_error")
      .eq("id", captureId)
      .single();
    if (capture && capture.processing_status !== last) {
      console.log(
        "status:",
        capture.processing_status,
        capture.last_error ? `(error: ${String(capture.last_error).slice(0, 160)})` : ""
      );
      last = capture.processing_status;
    }

    if (FAIL_MODE) {
      if (capture?.processing_status === "failed") {
        console.log("\n=== FAILURE PATH VERIFIED (marked failed + error recorded) ===");
        console.log("last_error:", capture.last_error);
        const { error: cleanupError } = await admin.from("captures").delete().eq("id", captureId);
        console.log("cleanup:", cleanupError ? cleanupError.message : "deleted");
        process.exit(0);
      }
    } else if (!memorySeen) {
      const { data: memory } = await admin
        .from("memories")
        .select("id, title, topic, current_intent, intent_source, intent_confidence, suggested_action, status")
        .eq("capture_id", captureId)
        .maybeSingle();
      if (memory) {
        memorySeen = memory;
        // wait for the embedding step to land (it runs right after persist)
        const embedDeadline = Date.now() + 30000;
        while (Date.now() < embedDeadline) {
          const { data: embedding } = await admin
            .from("memory_embeddings")
            .select("model, input_hash")
            .eq("memory_id", memory.id);
          if (embedding && embedding.length > 0) {
            console.log("\n=== SUCCESS (memory + embedding) ===");
            console.log(JSON.stringify({ memory, embedding }, null, 2));
            process.exit(0);
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        console.log("\n=== PARTIAL: memory created, embedding not found within 30s ===");
        console.log(JSON.stringify({ memory }, null, 2));
        process.exit(4);
      }
    }

    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("timeout");
  process.exit(3);
}

main().catch((error) => {
  console.error("E2E error:", error.message ?? error);
  process.exit(9);
});
