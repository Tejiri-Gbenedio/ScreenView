// ScreenView — PRODUCTION end-to-end verification (deployed app + Inngest Cloud).
// Runs against https://screenview-two.vercel.app using a dedicated test user.
// Phases:
//   --phase=main        happy path (init -> upload -> complete -> pipeline) + idempotent re-complete
//   --phase=drill       failure -> fix -> retry drill
//   --phase=checkpoint  checkpoint-reuse check on a completed capture
//   --phase=cleanup     delete test captures/memories/storage objects
// Run: node --env-file=.env.local scripts/prod-e2e.mjs --phase=main
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = "https://screenview-two.vercel.app";
const TEST_EMAIL = "tejirigbe+screenview-m1@gmail.com";

const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
const PHASE = phaseArg ? phaseArg.split("=")[1] : "main";

const admin = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });
const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const GARBAGE = Buffer.from("this is not a real image — vision must fail on this payload");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function ensureTestUser() {
  const password = crypto.randomBytes(24).toString("base64url");
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
  let user = (data?.users ?? []).find((u) => u.email === TEST_EMAIL);
  if (!user) {
    const res = await admin.auth.admin.createUser({ email: TEST_EMAIL, password, email_confirm: true });
    if (res.error) throw new Error("createUser: " + res.error.message);
    user = res.data.user;
    log("· test user created:", user.id);
  } else {
    const res = await admin.auth.admin.updateUserById(user.id, { password });
    if (res.error) throw new Error("updateUser: " + res.error.message);
    log("· test user reused:", user.id);
  }
  return { userId: user.id, password };
}

async function sessionCookies(email, password) {
  const jar = [];
  const ssr = createServerClient(SUPA_URL, ANON, {
    cookies: {
      getAll: () => [],
      setAll: (list) => list.forEach((c) => jar.push(`${c.name}=${c.value}`)),
    },
  });
  const { error } = await ssr.auth.signInWithPassword({ email, password });
  if (error) throw new Error("signIn: " + error.message);
  return jar.join("; ");
}

async function call(path, cookie, body) {
  const res = await fetch(APP + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function pollCapture(captureId, wanted, timeoutMs, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const { data } = await admin
      .from("captures")
      .select("processing_status, attempt_count, last_error, file_hash, original_note, storage_path")
      .eq("id", captureId)
      .single();
    if (data) {
      if (data.processing_status !== last) {
        log(`· [${label}] status: ${last} → ${data.processing_status} (attempts ${data.attempt_count})`);
        last = data.processing_status;
      }
      if (wanted.includes(data.processing_status)) return data;
    }
    await sleep(3500);
  }
  return last === null ? null : { processing_status: last, timed_out: true };
}

async function preflight() {
  const health = await fetch(APP + "/api/health");
  log("· preflight /api/health:", health.status);
  const serve = await fetch(APP + "/api/inngest");
  log("· preflight /api/inngest:", serve.status);
}

async function uploadToSigned(path, token, buffer) {
  const { error } = await anon.storage.from("captures").uploadToSignedUrl(path, token, buffer, {
    contentType: "image/png",
  });
  if (error) throw new Error("signed upload: " + error.message);
  return true;
}

async function memoryByCapture(captureId) {
  const { data } = await admin.from("memories").select("*").eq("capture_id", captureId).maybeSingle();
  return data;
}

async function latestCapture(userId, statuses) {
  const { data } = await admin
    .from("captures")
    .select("id, storage_path, processing_status, attempt_count, original_note")
    .eq("user_id", userId)
    .in("processing_status", statuses)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

async function phaseMain() {
  const { userId, password } = await ensureTestUser();
  const cookie = await sessionCookies(TEST_EMAIL, password);
  await preflight();

  // --- happy path ---
  const note = "Production M1 E2E — safe to delete";
  const init = await call("/api/captures", cookie, {
    file_name: "prod-e2e.png",
    mime_type: "image/png",
    size: PNG.length,
    note,
  });
  log("1. POST /api/captures →", init.status, JSON.stringify(init.json).slice(0, 160));
  if (init.status !== 201) throw new Error("init failed: " + JSON.stringify(init.json));
  const { capture_id, path, upload } = init.json;

  await uploadToSigned(path, upload.token, PNG);
  log("2. signed upload → ok");

  const hash = sha256(PNG);
  const done = await call(`/api/captures/${capture_id}/complete`, cookie, { file_hash: hash });
  log("3. POST complete →", done.status, JSON.stringify(done.json));
  if (done.status !== 200) throw new Error("complete failed");

  const final = await pollCapture(capture_id, ["completed", "failed"], 180000, "main");
  log("4. final:", final.processing_status, "| attempts:", final.attempt_count, "| last_error:", final.last_error ?? "none");

  const mem = await memoryByCapture(capture_id);
  log("5. memory:", mem ? JSON.stringify({
    title: mem.title, topic: mem.topic, intent: mem.current_intent,
    intent_source: mem.intent_source, confidence: mem.confidence,
  }).slice(0, 240) : "MISSING");

  let emb = "MISSING";
  if (mem) {
    const { data } = await admin
      .from("memory_embeddings")
      .select("model, input_hash")
      .eq("memory_id", mem.id)
      .maybeSingle();
    emb = data ? `${data.model} (hash ${String(data.input_hash).slice(0, 12)}…)` : "MISSING";
  }
  log("6. embedding:", emb);

  const { data: cap } = await admin
    .from("captures")
    .select("original_note, file_hash, mime_type")
    .eq("id", capture_id)
    .single();
  log("7. original preserved:", JSON.stringify({
    note_ok: cap?.original_note === note,
    hash_ok: cap?.file_hash === hash,
    mime: cap?.mime_type,
  }));

  const folder = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const { data: objs } = await admin.storage.from("captures").list(folder, { search: name, limit: 3 });
  log("8. storage object exists:", (objs ?? []).some((o) => o.name === name));

  // --- idempotent re-complete ---
  const again = await call(`/api/captures/${capture_id}/complete`, cookie, { file_hash: hash });
  log("9. re-complete →", again.status, JSON.stringify(again.json));

  log("RESULT main: capture", capture_id, "status", final.processing_status);
  log("TEST_USER_ID", userId);
}

async function phaseDrill() {
  const { password } = await ensureTestUser();
  const cookie = await sessionCookies(TEST_EMAIL, password);

  // capture #2: upload garbage (invalid image) so vision fails, then fix object + retry
  const init = await call("/api/captures", cookie, {
    file_name: "prod-e2e-retry.png",
    mime_type: "image/png",
    size: GARBAGE.length,
    note: "Retry drill — safe to delete",
  });
  log("d1. init →", init.status, JSON.stringify(init.json).slice(0, 140));
  if (init.status !== 201) throw new Error("init failed");
  const capId = init.json.capture_id;

  await uploadToSigned(init.json.path, init.json.upload.token, GARBAGE);
  log("d2. uploaded garbage payload (vision should fail)");

  const done = await call(`/api/captures/${capId}/complete`, cookie, { file_hash: sha256(GARBAGE) });
  log("d3. complete →", done.status, JSON.stringify(done.json));
  if (done.status !== 200) throw new Error("complete failed");

  const failed = await pollCapture(capId, ["completed", "failed"], 240000, "drill");
  log("d4. after processing:", failed.processing_status, "| attempts:", failed.attempt_count);
  log("d5. last_error:", failed.last_error ?? "(none)");

  // fix: overwrite object with a valid PNG (service role; simulates user fixing upload)
  const { error: fixErr } = await admin.storage
    .from("captures")
    .upload(init.json.path, PNG, { upsert: true, contentType: "image/png" });
  if (fixErr) throw new Error("fix upload: " + fixErr.message);
  log("d6. object replaced with valid PNG");

  const retry = await call(`/api/captures/${capId}/retry`, cookie, undefined);
  log("d7. POST retry →", retry.status, JSON.stringify(retry.json));

  const after = await pollCapture(capId, ["completed", "failed"], 240000, "drill-after-retry");
  log("d8. after retry:", after.processing_status, "| attempts:", after.attempt_count);
  log("d9. last_error:", after.last_error ?? "(none)");
  log("RESULT drill: capture", capId, "status", after.processing_status);
}

async function phaseCheckpoint() {
  const { userId, password } = await ensureTestUser();
  const cookie = await sessionCookies(TEST_EMAIL, password);

  const cap = await latestCapture(userId, ["completed"]);
  if (!cap) throw new Error("no completed capture found for checkpoint test");
  log("c1. target capture:", cap.id, "attempts:", cap.attempt_count);

  const before = await memoryByCapture(cap.id);
  if (!before) throw new Error("memory missing");
  const perceptionLenBefore = JSON.stringify(before.perception ?? null).length;

  // simulate a retryable state (as if a later step had failed after vision was persisted)
  await admin
    .from("captures")
    .update({ processing_status: "failed", last_error: "simulated for checkpoint verification" })
    .eq("id", cap.id);
  log("c2. capture set to 'failed' (simulated); memory+perception already exist");

  const t0 = Date.now();
  const retry = await call(`/api/captures/${cap.id}/retry`, cookie, undefined);
  log("c3. POST retry →", retry.status, JSON.stringify(retry.json));

  const after = await pollCapture(cap.id, ["completed", "failed"], 240000, "checkpoint");
  const elapsed = Math.round((Date.now() - t0) / 1000);
  log("c4. after retry:", after.processing_status, "| attempts:", after.attempt_count, "| took", elapsed + "s");

  const post = await memoryByCapture(cap.id);
  const perceptionLenAfter = JSON.stringify(post?.perception ?? null).length;
  const { count } = await admin
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("capture_id", cap.id);
  log("c5. memory count for capture (expect 1):", count);
  log("c6. perception stored bytes before/after (expect equal, reused):", perceptionLenBefore, "/", perceptionLenAfter);
  log("RESULT checkpoint: capture", cap.id, "status", after.processing_status, "seconds", elapsed);
}

async function phaseCleanup() {
  const { userId } = await ensureTestUser();
  const { data: caps } = await admin.from("captures").select("id, storage_path").eq("user_id", userId);
  const capIds = (caps ?? []).map((c) => c.id);
  const paths = (caps ?? []).map((c) => c.storage_path).filter(Boolean);
  log("cleanup: captures to remove:", capIds.length);

  if (capIds.length) {
    const { data: mems } = await admin.from("memories").select("id").in("capture_id", capIds);
    const memIds = (mems ?? []).map((m) => m.id);
    if (memIds.length) {
      await admin.from("memory_events").delete().in("memory_id", memIds);
      await admin.from("memory_embeddings").delete().in("memory_id", memIds);
      await admin.from("memories").delete().in("id", memIds);
      log("cleanup: memories removed:", memIds.length);
    }
    await admin.from("captures").delete().in("id", capIds);
    log("cleanup: capture rows removed:", capIds.length);
  }
  if (paths.length) {
    const { error } = await admin.storage.from("captures").remove(paths);
    log("cleanup: storage objects removed:", error ? "error " + error.message : paths.length);
  }
  log("cleanup: done (test user kept for future runs)");
}

const phases = { main: phaseMain, drill: phaseDrill, checkpoint: phaseCheckpoint, cleanup: phaseCleanup };
const fn = phases[PHASE];
if (!fn) {
  console.error("unknown phase:", PHASE);
  process.exit(2);
}
fn()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PROD E2E FAILED:", e?.message ?? e);
    process.exit(9);
  });
