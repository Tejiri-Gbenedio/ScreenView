// ScreenView — M5 production verification (personal learning), against the deployed app.
// Phases:
//   --phase=seed        wipe test users, seed topic memories (+embeddings)
//   --phase=cold        consolidation with zero evidence → no patterns (cold start)
//   --phase=wave1       below bar (2 corrections) → still no pattern
//   --phase=wave2       3rd correction → tentative
//   --phase=wave3       5 corrections across days → established (active)
//   --phase=behavior    real captures: learned hint applies / unrelated / explicit override
//   --phase=suppress    3 dismissed connections + 2 PA dismissals → scoped suppressions
//   --phase=decay       age evidence → pattern expires
//   --phase=rls         second user isolation
//   --phase=cleanup     remove all test data
// Run: node --env-file=.env.local scripts/m5-verify.mjs --phase=...
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL_ID ?? "nvidia/llama-nemotron-embed-vl-1b-v2:free";
const APP = "https://screenview-two.vercel.app";

const USER_A = "tejirigbe+screenview-m1@gmail.com";
const USER_B = "tejirigbe+screenview-m2b@gmail.com";
const SEED_MARK = "m5seed";
const DAY = 864e5;

const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
const PHASE = phaseArg ? phaseArg.split("=")[1] : "seed";

const admin = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });
const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
const sha256Bytes = (b) => crypto.createHash("sha256").update(b).digest("hex");
const toVectorLiteral = (v) => `[${v.join(",")}]`;
const iso = (d) => new Date(Date.now() - d * DAY).toISOString();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let failures = 0;
const check = (name, pass, detail = "") => {
  log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " | " + detail : ""}`);
  if (!pass) failures += 1;
};

async function ensureUser(email) {
  const password = crypto.randomBytes(24).toString("base64url");
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
  let user = (data?.users ?? []).find((u) => u.email === email);
  if (!user) {
    const res = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (res.error) throw new Error("createUser: " + res.error.message);
    user = res.data.user;
  } else {
    await admin.auth.admin.updateUserById(user.id, { password });
  }
  return { id: user.id, password };
}

async function sessionCookie(email, password) {
  const jar = [];
  const ssr = createServerClient(SUPA_URL, ANON, {
    cookies: { getAll: () => [], setAll: (l) => l.forEach((c) => jar.push(`${c.name}=${c.value}`)) },
  });
  const { error } = await ssr.auth.signInWithPassword({ email, password });
  if (error) throw new Error("signIn: " + error.message);
  return jar.join("; ");
}

async function api(cookie, path, body) {
  const res = await fetch(APP + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function embed(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "HTTP-Referer": APP,
        "X-Title": "ScreenView",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    });
    if (res.ok) {
      const json = await res.json();
      const vec = json?.data?.[0]?.embedding;
      if (Array.isArray(vec) && vec.length === 2048) return vec;
    }
    await sleep(800);
  }
  throw new Error("embedding failed: " + text.slice(0, 50));
}

function triggerLearning(userId) {
  const bodyPath = "C:\\Users\\HP\\Documents\\.openclaw\\tmp\\m5-event.json";
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  fs.writeFileSync(
    bodyPath,
    JSON.stringify({ name: "learning/consolidate", data: { userId }, id: `m5-consolidate-${userId.slice(0, 8)}-${Date.now()}` })
  );
  return execSync(`npx --yes inngest-cli@latest api send-event --body-file "${bodyPath}" --prod`, {
    cwd: "C:\\Users\\HP\\Documents\\ScreenView",
    encoding: "utf8",
  }).trim();
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await sleep(3000);
  }
  log(`timeout waiting for: ${label}`);
  return null;
}

async function patternsFor(userId) {
  const { data } = await admin.from("learned_patterns").select("*").eq("user_id", userId).order("created_at", { ascending: false });
  return data ?? [];
}

async function seedMemory(user) {
  const id = crypto.randomUUID();
  const captureId = crypto.randomUUID();
  const days = Math.floor(Math.random() * 20) + 5;
  const { error: e1 } = await admin.from("captures").insert({
    id: captureId,
    user_id: user.id,
    storage_path: `${user.id}/${SEED_MARK}-${id}.png`,
    original_note: "Perfume finds",
    source: "web",
    mime_type: "image/png",
    processing_status: "completed",
    created_at: iso(days),
  });
  if (e1) throw new Error(e1.message);
  const { error: e2 } = await admin.from("memories").insert({
    id,
    user_id: user.id,
    capture_id: captureId,
    title: `Perfume find ${id.slice(0, 4)}`,
    summary: "A perfume the user saved.",
    visual_description: "A perfume product page.",
    topic: "Fragrance",
    current_intent: "research",
    intent_source: "user_statement",
    intent_confidence: 0.9,
    suggested_action: "evaluate",
    status: "active",
    created_at: iso(days),
  });
  if (e2) throw new Error(e2.message);
  const text = `Title: Perfume find\nSummary: A perfume the user saved.\nTopic: Fragrance\nUser note: Perfume finds`;
  const { error: e3 } = await admin.from("memory_embeddings").insert({
    user_id: user.id,
    memory_id: id,
    model: EMBEDDING_MODEL,
    embedding: toVectorLiteral(await embed(text)),
    input_hash: sha256(text),
  });
  if (e3) throw new Error(e3.message);
  return id;
}

async function addCorrection(userId, memoryId, daysAgo) {
  const { error } = await admin.from("memory_events").insert({
    user_id: userId,
    memory_id: memoryId,
    event_type: "intent_change",
    old_value: "buy",
    new_value: "research",
    source: "user_statement",
    actor: "user",
    confidence: 1,
    reason: "correction",
    created_at: iso(daysAgo),
  });
  if (error) throw new Error(error.message);
}

async function wipeUser(userId) {
  const { data: caps } = await admin.from("captures").select("id, storage_path").eq("user_id", userId);
  const capIds = (caps ?? []).map((c) => c.id);
  const paths = (caps ?? []).map((c) => c.storage_path).filter(Boolean);
  const { data: cols } = await admin.from("collections").select("id").eq("user_id", userId);
  const colIds = (cols ?? []).map((c) => c.id);
  if (capIds.length) {
    const { data: mems } = await admin.from("memories").select("id").in("capture_id", capIds);
    const memIds = (mems ?? []).map((m) => m.id);
    if (memIds.length) {
      await admin.from("connections").delete().in("source_memory_id", memIds);
      await admin.from("connections").delete().in("target_memory_id", memIds);
      await admin.from("collection_members").delete().in("memory_id", memIds);
      await admin.from("memory_events").delete().in("memory_id", memIds);
      await admin.from("memory_embeddings").delete().in("memory_id", memIds);
      await admin.from("memories").delete().in("id", memIds);
    }
    await admin.from("captures").delete().in("id", capIds);
  }
  if (colIds.length) {
    await admin.from("collection_members").delete().in("collection_id", colIds);
    await admin.from("collections").delete().in("id", colIds);
  }
  await admin.from("pa_reports").delete().eq("user_id", userId);
  await admin.from("learned_patterns").delete().eq("user_id", userId);
  if (paths.length) await admin.storage.from("captures").remove(paths);
}

async function captureForUser(a, note) {
  const cookie = await sessionCookie(USER_A, a.password);
  const init = await api(cookie, "/api/captures", {
    file_name: "m5-behavior.png",
    mime_type: "image/png",
    size: PNG.length,
    note,
  });
  if (init.status !== 201) throw new Error("init failed: " + JSON.stringify(init.json));
  const { capture_id, path: storagePath, upload } = init.json;
  await anon.storage.from("captures").uploadToSignedUrl(storagePath, upload.token, PNG, { contentType: "image/png" });
  await api(cookie, `/api/captures/${capture_id}/complete`, { file_hash: sha256Bytes(PNG) });
  let status = null;
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const { data } = await admin.from("captures").select("processing_status").eq("id", capture_id).single();
    status = data?.processing_status;
    if (status === "completed" || status === "failed") break;
    await sleep(4000);
  }
  if (status !== "completed") throw new Error(`capture failed: ${status}`);
  const { data: memory } = await admin
    .from("memories")
    .select("id, title, summary, current_intent, intent_source")
    .eq("capture_id", capture_id)
    .maybeSingle();
  return { captureId: capture_id, memory };
}

// ------------------------------------------------------------------ phases

const phaseSeed = async () => {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);
  await wipeUser(a.id);
  await wipeUser(b.id);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await seedMemory(a));
  log("seeded 5 topic memories:", ids.join(", "));
  fs.writeFileSync("C:\\Users\\HP\\Documents\\.openclaw\\tmp\\m5-ids.json", JSON.stringify({ ids }));
  log("SEED DONE");
};

const loadIds = () => JSON.parse(fs.readFileSync("C:\\Users\\HP\\Documents\\.openclaw\\tmp\\m5-ids.json", "utf8")).ids;

const phaseCold = async () => {
  const a = await ensureUser(USER_A);
  triggerLearning(a.id);
  await sleep(8000);
  const patterns = await patternsFor(a.id);
  check("cold start: zero learned patterns, nothing to influence", patterns.length === 0, `patterns=${patterns.length}`);
  log(failures === 0 ? "COLD START OK" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
};

const phaseWave1 = async () => {
  const a = await ensureUser(USER_A);
  const ids = loadIds();
  await addCorrection(a.id, ids[0], 6);
  await addCorrection(a.id, ids[1], 4);
  triggerLearning(a.id);
  await sleep(10000);
  const patterns = await patternsFor(a.id);
  check("below the bar: 2 corrections do NOT create a pattern", patterns.length === 0, `patterns=${patterns.length}`);
  log(failures === 0 ? "WAVE1 OK" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
};

const phaseWave2 = async () => {
  const a = await ensureUser(USER_A);
  const ids = loadIds();
  await addCorrection(a.id, ids[2], 2);
  triggerLearning(a.id);
  const pattern = await waitFor(
    async () => (await patternsFor(a.id)).find((p) => p.scope === "intent" && p.condition?.topic === "fragrance"),
    90000,
    "tentative pattern"
  );
  check("3 corrections across 3 days → tentative pattern", Boolean(pattern) && pattern.status === "tentative", pattern ? `status=${pattern.status} ev=${pattern.evidence_count}` : "none");
  check("pattern is scoped + traceable + decaying", Boolean(pattern) &&
    pattern.condition?.topic === "fragrance" &&
    pattern.conclusion?.intent === "research" &&
    Array.isArray(pattern.evidence) && pattern.evidence.length >= 3 &&
    pattern.half_life_days === 120 &&
    pattern.origin === "inferred", JSON.stringify(pattern?.conclusion));
  log(failures === 0 ? "WAVE2 OK" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
};

const phaseWave3 = async () => {
  const a = await ensureUser(USER_A);
  const ids = loadIds();
  await addCorrection(a.id, ids[3], 1.5);
  await addCorrection(a.id, ids[4], 1);
  triggerLearning(a.id);
  const pattern = await waitFor(
    async () => {
      const p = (await patternsFor(a.id)).find((x) => x.scope === "intent" && x.condition?.topic === "fragrance");
      return p && p.status === "active" ? p : null;
    },
    90000,
    "established pattern"
  );
  check("sufficient diverse evidence → established (active)", Boolean(pattern), pattern ? `status=${pattern.status} ev=${pattern.evidence_count}` : "none");
  check("confidence capped (≤0.9)", Boolean(pattern) && pattern.confidence <= 0.9, `conf=${pattern?.confidence}`);
  log(failures === 0 ? "WAVE3 OK" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
};

const phaseBehavior = async () => {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);

  // 1) relevant capture — the learned hint should bias the ambiguous note
  const relevant = await captureForUser(a, "Another fragrance for the shelf — saw this at the store");
  log("relevant capture intent:", JSON.stringify(relevant.memory));
  check(
    "reasoning received relevant learning (intent matches learned preference, not the note)",
    relevant.memory?.current_intent === "research" && relevant.memory?.intent_source !== "user_statement",
    `intent=${relevant.memory?.current_intent} source=${relevant.memory?.intent_source}`
  );

  // 2) unrelated capture — no relevant pattern, no bias
  const unrelated = await captureForUser(a, "Found this at the nursery — cute plant pot idea");
  log("unrelated capture intent:", JSON.stringify(unrelated.memory));
  check(
    "unrelated capture does NOT receive the fragrance hint",
    unrelated.memory?.current_intent !== "research",
    `intent=${unrelated.memory?.current_intent}`
  );

  // 3) explicit override — current note wins over the learned pattern
  const override = await captureForUser(a, "I want to buy this one now — buying it today.");
  log("override capture intent:", JSON.stringify(override.memory));
  check(
    "explicit user statement overrides the learned pattern",
    override.memory?.current_intent === "buy" && override.memory?.intent_source === "user_statement",
    `intent=${override.memory?.current_intent} source=${override.memory?.intent_source}`
  );

  // 4) control: same note for user B (no patterns) — informational
  const bCookie = await sessionCookie(USER_B, b.password);
  const init = await api(bCookie, "/api/captures", {
    file_name: "m5-control.png",
    mime_type: "image/png",
    size: PNG.length,
    note: "Another fragrance for the shelf — saw this at the store",
  });
  if (init.status === 201) {
    await anon.storage.from("captures").uploadToSignedUrl(init.json.path, init.json.upload.token, PNG, { contentType: "image/png" });
    await api(bCookie, `/api/captures/${init.json.capture_id}/complete`, { file_hash: sha256Bytes(PNG) });
    const control = await waitFor(async () => {
      const { data } = await admin.from("memories").select("current_intent, intent_source").eq("capture_id", init.json.capture_id).maybeSingle();
      return data ?? null;
    }, 240000, "control capture memory");
    log("control (user B, no learning):", JSON.stringify(control));
    check("control user B has no learned patterns", (await patternsFor(b.id)).length === 0);
  } else {
    check("control capture created", false, JSON.stringify(init.json));
  }

  log(failures === 0 ? "BEHAVIOR OK" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
};

const phaseSuppress = async () => {
  const a = await ensureUser(USER_A);
  const ids = loadIds();

  // 3 dismissed connections across distinct days (thematic)
  const pairs = [
    [ids[0], ids[1]],
    [ids[1], ids[3]],
    [ids[2], ids[4]],
  ];
  const daysList = [6, 4, 2];
  for (let i = 0; i < pairs.length; i++) {
    const [source, target] = pairs[i].sort();
    const { error } = await admin.from("connections").insert({
      user_id: a.id,
      source_memory_id: source,
      target_memory_id: target,
      relationship_type: "thematic",
      state: "dismissed",
      origin: "ai",
      confidence: 0.7,
      basis: { signals: ["verify_fixture"], reasoning: "fixture", user_action_at: iso(daysList[i]) },
    });
    if (error && error.code !== "23505") throw new Error(error.message);
  }

  // 2 PA reminder dismissals for the fragrance topic
  const nowIso = new Date().toISOString();
  const { error: reportError } = await admin.from("pa_reports").insert({
    user_id: a.id,
    period_start: iso(7),
    period_end: nowIso,
    is_empty: false,
    content: {
      items: [
        { id: crypto.randomUUID(), kind: "reminder", claim_type: "fact", memory_ids: [ids[0]], wording: "x", actions: ["dismiss"], meta: { memory_id: ids[0] }, evidence: [], interaction: { action: "dismiss", at: iso(3) } },
        { id: crypto.randomUUID(), kind: "reminder", claim_type: "fact", memory_ids: [ids[1]], wording: "y", actions: ["snooze"], meta: { memory_id: ids[1] }, evidence: [], interaction: { action: "snooze", at: iso(2) } },
      ],
      sections: [],
    },
    generation_meta: { prompt_version: "m5-verify", llm_calls: 0 },
  });
  if (reportError) throw new Error(reportError.message);

  triggerLearning(a.id);
  const suppressed = await waitFor(async () => {
    const patterns = await patternsFor(a.id);
    const conn = patterns.find((p) => p.scope === "connection" && p.status === "suppressed");
    const pa = patterns.find((p) => p.scope === "pa" && p.status === "suppressed");
    return conn && pa ? { conn, pa } : null;
  }, 90000, "suppression patterns");

  check("3 dismissed connection types → scoped suppression (decaying)", Boolean(suppressed?.conn) && Boolean(suppressed?.conn.suppressed_until), suppressed?.conn ? `until=${suppressed.conn.suppressed_until}` : "none");
  check("repeated PA dismissals → reminder category muted (PA can only get quieter)", Boolean(suppressed?.pa) && suppressed?.pa.condition?.topic === "fragrance");

  log(failures === 0 ? "SUPPRESS OK" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
};

const phaseDecay = async () => {
  const a = await ensureUser(USER_A);

  // Age the raw evidence beyond the window and the pattern's reinforcement clock
  const { data: mems } = await admin.from("memories").select("id").eq("user_id", a.id);
  const memIds = (mems ?? []).map((m) => m.id);
  for (const id of memIds) {
    await admin.from("memory_events").update({ created_at: iso(400) }).eq("memory_id", id).eq("event_type", "intent_change");
  }
  await admin
    .from("learned_patterns")
    .update({ last_reinforced_at: iso(400) })
    .eq("user_id", a.id)
    .eq("scope", "intent")
    .eq("status", "active");

  triggerLearning(a.id);
  const expired = await waitFor(async () => {
    const p = (await patternsFor(a.id)).find((x) => x.scope === "intent");
    return p && p.status === "expired" ? p : null;
  }, 90000, "expired pattern");

  check("decay: unreinforced pattern expires below the floor (stops influencing)", Boolean(expired), expired ? `status=${expired.status}` : "none");

  log(failures === 0 ? "DECAY OK" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
};

const phaseRls = async () => {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);
  const bCookie = await sessionCookie(USER_B, b.password);

  const { data: aPatterns } = await admin.from("learned_patterns").select("id").eq("user_id", a.id);
  check("user A has learned patterns (from previous phases)", (aPatterns ?? []).length > 0, `${(aPatterns ?? []).length}`);

  // B reads via their own session (RLS)
  const bRes = await fetch(SUPA_URL + "/rest/v1/learned_patterns?select=id", {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  const bData = await bRes.json().catch(() => null);
  check("RLS: unauthenticated/anon cannot read learned patterns", Array.isArray(bData) && bData.length === 0, JSON.stringify(bData).slice(0, 80));

  const bPatterns = await patternsFor(b.id);
  check("RLS: user B has zero patterns of their own", bPatterns.length === 0);

  triggerLearning(b.id);
  await sleep(6000);
  const { data: aStill } = await admin.from("learned_patterns").select("id").eq("user_id", a.id);
  check("B's consolidation never touches A's patterns", (aStill ?? []).length === (aPatterns ?? []).length);

  log(failures === 0 ? "RLS OK" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
};

const phaseCleanup = async () => {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);
  await wipeUser(a.id);
  await wipeUser(b.id);
  const { data: leftA } = await admin.from("captures").select("id").eq("user_id", a.id);
  const { data: patA } = await admin.from("learned_patterns").select("id").eq("user_id", a.id);
  log(`cleanup verify — captures: ${(leftA ?? []).length}, patterns: ${(patA ?? []).length}`);
  log("CLEANUP DONE");
};

const phases = {
  seed: phaseSeed,
  cold: phaseCold,
  wave1: phaseWave1,
  wave2: phaseWave2,
  wave3: phaseWave3,
  behavior: phaseBehavior,
  suppress: phaseSuppress,
  decay: phaseDecay,
  rls: phaseRls,
  cleanup: phaseCleanup,
};

const fn = phases[PHASE];
if (!fn) {
  console.error("unknown phase:", PHASE);
  process.exit(2);
}
fn()
  .then(() => {
    if (PHASE === "seed" || PHASE === "cleanup") {
      log(failures === 0 ? "OK" : `FAILURES: ${failures}`);
      process.exit(failures === 0 ? 0 : 9);
    }
  })
  .catch((e) => {
    console.error("M5 VERIFY FAILED:", e?.message ?? e);
    process.exit(9);
  });
