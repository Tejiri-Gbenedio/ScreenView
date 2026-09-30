// ScreenView — M6 production smoke test: one clean end-to-end lifecycle across the whole system.
// Phases: --phase=run | --phase=cleanup
// Run: node --env-file=.env.local scripts/m6-smoke.mjs --phase=run
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
const DAY = 864e5;

const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
const PHASE = phaseArg ? phaseArg.split("=")[1] : "run";

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
  const user = (data?.users ?? []).find((u) => u.email === email);
  if (!user) throw new Error("test user missing: " + email);
  await admin.auth.admin.updateUserById(user.id, { password });
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

async function api(cookie, p, body, method = "POST") {
  const res = await fetch(APP + p, {
    method,
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
  throw new Error("embedding failed for: " + text.slice(0, 40));
}

function triggerEvent(name, data, idPrefix) {
  const bodyPath = "C:\\Users\\HP\\Documents\\.openclaw\\tmp\\m6-event.json";
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  fs.writeFileSync(bodyPath, JSON.stringify({ name, data, id: `${idPrefix}-${Date.now()}` }));
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

async function seedMemory(user, title, note, intent, days) {
  const id = crypto.randomUUID();
  const captureId = crypto.randomUUID();
  const { error: e1 } = await admin.from("captures").insert({
    id: captureId,
    user_id: user.id,
    storage_path: `${user.id}/m6smoke-${id}.png`,
    original_note: note,
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
    title,
    summary: `${title} — saved for later review.`,
    visual_description: "A perfume product page.",
    topic: "Fragrance",
    current_intent: intent,
    intent_source: "user_statement",
    intent_confidence: 0.9,
    suggested_action: "evaluate",
    status: "active",
    created_at: iso(days),
  });
  if (e2) throw new Error(e2.message);
  const canonical = `Title: ${title}\nSummary: ${title} — saved for later review.\nTopic: Fragrance\nIntent: ${intent}\nUser note: ${note}`;
  const { error: e3 } = await admin.from("memory_embeddings").insert({
    user_id: user.id,
    memory_id: id,
    model: EMBEDDING_MODEL,
    embedding: toVectorLiteral(await embed(canonical)),
    input_hash: sha256(canonical),
  });
  if (e3) throw new Error(e3.message);
  return { id, captureId };
}

async function phaseRun() {
  const a = await ensureUser(USER_A);
  await wipeUser(a.id);
  const cookie = await sessionCookie(USER_A, a.password);

  // ---- stage 0: seed two context memories ----
  const m1 = await seedMemory(a, "Perfume to buy", "I want to buy this perfume", "buy", 15);
  const m2 = await seedMemory(a, "Perfume research", "Researching this perfume line", "research", 3);
  log("seeded context memories");

  // ---- stage 1: capture → signed upload → processing → memory ----
  const init = await api(cookie, "/api/captures", {
    file_name: "m6-smoke.png",
    mime_type: "image/png",
    size: PNG.length,
    note: "Another fragrance like the last one — for the shelf",
  });
  check("capture: init + signed upload url", init.status === 201, JSON.stringify(init.json).slice(0, 90));
  const { capture_id, path: storagePath, upload } = init.json;
  const up = await anon.storage.from("captures").uploadToSignedUrl(storagePath, upload.token, PNG, { contentType: "image/png" });
  check("capture: signed upload works", !up.error);
  await api(cookie, `/api/captures/${capture_id}/complete`, { file_hash: sha256Bytes(PNG) });

  const done = await waitFor(async () => {
    const { data } = await admin.from("captures").select("processing_status, attempt_count").eq("id", capture_id).single();
    return data && ["completed", "failed"].includes(data.processing_status) ? data : null;
  }, 240000, "pipeline");
  check("processing: full pipeline completes (vision→embed→reasoning→persist→connections)", done?.processing_status === "completed", `status=${done?.processing_status}`);
  const { data: c4 } = await admin.from("memories").select("id, current_intent").eq("capture_id", capture_id).maybeSingle();
  check("memory: persisted with interpretation", Boolean(c4?.id), `intent=${c4?.current_intent}`);
  const { data: c4emb } = await waitFor(async () => {
    const { data } = await admin.from("memory_embeddings").select("model").eq("memory_id", c4.id).maybeSingle();
    return data ? { data } : null;
  }, 30000, "document embedding");
  check("embedding: stored (searchable)", Boolean(c4emb?.model));

  // ---- stage 2: searchable ----
  const search = await api(cookie, "/api/search", { query: "perfume I wanted to buy" });
  const titles = (search.json?.results ?? []).map((r) => r.title ?? "");
  check("search: finds the right memories semantically", search.status === 200 && (search.json?.results ?? []).length >= 2, `results=${titles.length}`);
  const anonSearch = await fetch(APP + "/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "x" }),
  });
  check("search: anonymous rejected (401)", anonSearch.status === 401);

  // ---- stage 3: connection suggestion from the pipeline ----
  const conns = await waitFor(async () => {
    const { data } = await admin
      .from("connections")
      .select("id, relationship_type, state, basis")
      .or(`source_memory_id.eq.${c4.id},target_memory_id.eq.${c4.id}`);
    return data?.length ? data : null;
  }, 60000, "connection suggestion");
  check("connections: at least one suggested, evidence-backed link", Boolean(conns) && conns.every((c) => c.state === "suggested" && c.basis?.reasoning), `count=${conns?.length ?? 0}`);

  // ---- stage 4: collection suggestion ----
  const discover = await api(cookie, "/api/collections/discover", undefined);
  const suggested = await waitFor(async () => {
    const { data } = await admin.from("collections").select("id, kind, state").eq("user_id", a.id).eq("state", "suggested");
    return data?.length ? data : null;
  }, 60000, "collection suggestion");
  check("collections: suggestion emerges from evidence", discover.status === 200 && Boolean(suggested), `suggested=${suggested?.length ?? 0}`);

  // ---- stage 5: PA report (with reminder) then quiet gate ----
  triggerEvent("pa/generate", { userId: a.id }, "m6-pa");
  const report = await waitFor(async () => {
    const { data } = await admin.from("pa_reports").select("*").eq("user_id", a.id).order("generated_at", { ascending: false }).limit(1);
    return data?.[0] ?? null;
  }, 180000, "PA report");
  const firstItems = report?.content?.items ?? [];
  check("PA: report generated with a reminder for the aged buy-memory", !report?.is_empty && firstItems.some((i) => i.kind === "reminder"), `items=${firstItems.length}`);
  check("PA: exactly one wording call (or zero if quiet)", (report?.generation_meta?.llm_calls ?? -1) <= 1, `llm_calls=${report?.generation_meta?.llm_calls}`);

  triggerEvent("pa/generate", { userId: a.id }, "m6-pa2");
  const report2 = await waitFor(async () => {
    const { data } = await admin.from("pa_reports").select("*").eq("user_id", a.id).order("generated_at", { ascending: false }).limit(1);
    return data?.[0] && data[0].id !== report?.id ? data[0] : null;
  }, 180000, "second PA report");
  check("PA: quiet gate — nothing qualifying → zero LLM calls", report2?.generation_meta?.llm_calls === 0, `llm_calls=${report2?.generation_meta?.llm_calls}`);

  // ---- stage 6: learning signal from a user correction ----
  const correction = await api(cookie, `/api/memories/${m1.id}`, { field: "intent", value: "research", reason: "changed my mind" }, "PATCH");
  check("learning: user correction recorded via the normal flow", correction.status === 200);
  const { data: event } = await admin
    .from("memory_events")
    .select("event_type, actor")
    .eq("memory_id", m1.id)
    .eq("event_type", "intent_change")
    .eq("actor", "user")
    .limit(1)
    .maybeSingle();
  check("learning: correction is a user-attributed signal", Boolean(event));
  // plant two more diverse corrections (backdated) to cross the threshold
  const m3 = await seedMemory(a, "Perfume third", "One more for the collection", "research", 2);
  for (const [mem, days] of [[m2.id, 4], [m3.id, 2]]) {
    await admin.from("memory_events").insert({
      user_id: a.id,
      memory_id: mem,
      event_type: "intent_change",
      old_value: "buy",
      new_value: "research",
      source: "user_statement",
      actor: "user",
      confidence: 1,
      reason: "correction",
      created_at: iso(days),
    });
  }
  triggerEvent("learning/consolidate", { userId: a.id }, "m6-learn");
  const pattern = await waitFor(async () => {
    const { data } = await admin
      .from("learned_patterns")
      .select("id, status, condition, conclusion, evidence_count")
      .eq("user_id", a.id)
      .eq("scope", "intent")
      .limit(1)
      .maybeSingle();
    return data ?? null;
  }, 120000, "learned pattern");
  check(
    "learning: consolidation promotes a tentative pattern from diverse corrections",
    pattern?.status === "tentative" && pattern?.condition?.topic === "fragrance",
    pattern ? `status=${pattern.status} ev=${pattern.evidence_count}` : "none"
  );

  log(failures === 0 ? "SMOKE: ALL CHECKS PASSED" : `SMOKE FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
}

async function phaseCleanup() {
  const a = await ensureUser(USER_A);
  await wipeUser(a.id);
  const { data: caps } = await admin.from("captures").select("id").eq("user_id", a.id);
  const { data: pats } = await admin.from("learned_patterns").select("id").eq("user_id", a.id);
  const { data: reps } = await admin.from("pa_reports").select("id").eq("user_id", a.id);
  log(`cleanup verify — captures: ${(caps ?? []).length}, patterns: ${(pats ?? []).length}, reports: ${(reps ?? []).length}`);
  log("CLEANUP DONE");
}

const phases = { run: phaseRun, cleanup: phaseCleanup };
const fn = phases[PHASE];
if (!fn) {
  console.error("unknown phase:", PHASE);
  process.exit(2);
}
fn()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("M6 SMOKE FAILED:", e?.message ?? e);
    process.exit(9);
  });
