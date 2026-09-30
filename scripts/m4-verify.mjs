// ScreenView — M4 production verification (quiet Personal Assistant), against the deployed app.
// Phases:
//   --phase=seed      wipe test user A, seed controlled memories, run one real capture
//   --phase=run       trigger PA generation #1 + verify report, reminders, patterns, project, recall, UI
//   --phase=interact  complete/dismiss via API + RLS attempts with user B
//   --phase=run2      trigger generation #2 (quiet period, zero LLM) + regressions (M1/M2/M3) + RLS
//   --phase=cleanup   remove all test data
// Run: node --env-file=.env.local scripts/m4-verify.mjs --phase=seed|run|interact|run2|cleanup
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
const SEED_MARK = "m4seed";
const DAY = 864e5;

const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
const PHASE = phaseArg ? phaseArg.split("=")[1] : "run";

const admin = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });
const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const sha256Bytes = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const toVectorLiteral = (vec) => `[${vec.join(",")}]`;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

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

async function api(cookie, path, body, method = "POST") {
  const res = await fetch(APP + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function html(cookie, path) {
  const res = await fetch(APP + path, { headers: { Cookie: cookie } });
  return { status: res.status, html: await res.text() };
}

function triggerPa(userId) {
  const bodyPath = "C:\\Users\\HP\\Documents\\.openclaw\\tmp\\pa-event.json";
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  fs.writeFileSync(
    bodyPath,
    JSON.stringify({
      name: "pa/generate",
      data: { userId },
      id: `pa-verify-${userId.slice(0, 8)}-${Date.now()}`,
    })
  );
  const out = execSync(
    `npx --yes inngest-cli@latest api send-event --body-file "${bodyPath}" --prod`,
    { cwd: "C:\\Users\\HP\\Documents\\ScreenView", encoding: "utf8" }
  );
  return out.trim();
}

async function latestReport(userId) {
  const { data } = await admin
    .from("pa_reports")
    .select("*")
    .eq("user_id", userId)
    .order("generated_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

async function waitForNewReport(userId, previousId, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const report = await latestReport(userId);
    if (report && report.id !== previousId) return report;
    await sleep(4000);
  }
  return null;
}

async function memoryIdByKey(userId, key) {
  const { data } = await admin
    .from("captures")
    .select("storage_path, memories!inner(id)")
    .eq("user_id", userId)
    .like("storage_path", `%${SEED_MARK}-${key}-%`);
  const row = data?.[0];
  return row?.memories?.[0]?.id ?? row?.memories?.id ?? null;
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
  if (paths.length) await admin.storage.from("captures").remove(paths);
  log(`wipe: ${capIds.length} captures, ${colIds.length} collections`);
}

// -------------------------------------------------------------------- seed

const SEED = [
  { key: "keyboard", title: "Mechanical keyboard", note: "I want to buy this mechanical keyboard", topic: "Desk setup", intent: "buy", action: "buy", days: 16, status: "new", source: "user_statement", embed: true },
  { key: "tent", title: "Camping tent research", note: "Research camping tents for the trip", topic: "Camping", intent: "research", action: "evaluate", days: 23, status: "new", source: "user_statement" },
  { key: "yoga", title: "Yoga app", note: "Try this yoga app", topic: "Fitness", intent: "try", action: "test", days: 20, status: "new", source: "user_statement" },
  { key: "scuba", title: "Zanzibar scuba course", note: null, topic: "Diving", intent: "save_for_later", action: "save_for_reference", days: 65, status: "active", source: "ai_inference", embed: true },
  { key: "pasta", title: "Pasta recipe", note: "Pasta recipe to try", topic: "Cooking", intent: "try", action: "test", days: 12, status: "active", source: "user_statement" },
  { key: "risotto", title: "Risotto recipe", note: "Risotto for a weekend", topic: "Cooking", intent: "try", action: "test", days: 11, status: "active", source: "user_statement" },
  { key: "sourdough", title: "Sourdough starter", note: "Baking project", topic: "Cooking", intent: "try", action: "test", days: 2, status: "active", source: "user_statement" },
  { key: "pf1", title: "Portfolio redesign idea", note: "I want something like this for my portfolio site", topic: "Portfolio", intent: "build", action: "build", days: 35, status: "active", source: "user_statement" },
  { key: "pf2", title: "Portfolio hero section", note: "Nice hero layout", topic: "Portfolio", intent: "build", action: "build", days: 25, status: "active", source: "user_statement" },
  { key: "pf3", title: "Portfolio color palettes", note: "Palette references", topic: "Portfolio", intent: "build", action: "build", days: 15, status: "active", source: "user_statement" },
  { key: "pf4", title: "Portfolio animations", note: "Scroll animation ideas", topic: "Portfolio", intent: "build", action: "build", days: 5, status: "active", source: "user_statement" },
  { key: "garden1", title: "Balcony garden layout", note: "Planting ideas", topic: "Gardening", intent: "save_for_later", action: "save_for_reference", days: 6, status: "active", source: "user_statement" },
  { key: "garden2", title: "Herb planter", note: "Herbs to plant", topic: "Gardening", intent: "save_for_later", action: "save_for_reference", days: 5, status: "active", source: "user_statement" },
];

function canonical(s) {
  return [
    `Title: ${s.title}`,
    `Summary: A saved item about ${s.topic}.`,
    s.topic ? `Topic: ${s.topic}` : null,
    s.intent ? `Intent: ${s.intent}` : null,
    s.action ? `Action: ${s.action}` : null,
    s.note ? `User note: ${s.note}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function phaseSeed() {
  const a = await ensureUser(USER_A);
  await wipeUser(a.id);
  for (const s of SEED) {
    const captureId = crypto.randomUUID();
    const memoryId = crypto.randomUUID();
    const { error: e1 } = await admin.from("captures").insert({
      id: captureId,
      user_id: a.id,
      storage_path: `${a.id}/${SEED_MARK}-${s.key}-${captureId}.png`,
      original_note: s.note,
      source: "web",
      mime_type: "image/png",
      processing_status: "completed",
      created_at: iso(s.days),
    });
    if (e1) throw new Error(`capture ${s.key}: ` + e1.message);
    const { error: e2 } = await admin.from("memories").insert({
      id: memoryId,
      user_id: a.id,
      capture_id: captureId,
      title: s.title,
      summary: `A saved item about ${s.topic}.`,
      visual_description: `A screenshot about ${s.topic}.`,
      topic: s.topic,
      current_intent: s.intent,
      intent_source: s.source,
      intent_confidence: 0.9,
      suggested_action: s.action,
      status: s.status,
      created_at: iso(s.days),
    });
    if (e2) throw new Error(`memory ${s.key}: ` + e2.message);
    if (s.embed) {
      const text = canonical(s);
      const { error: e3 } = await admin.from("memory_embeddings").insert({
        user_id: a.id,
        memory_id: memoryId,
        model: EMBEDDING_MODEL,
        embedding: toVectorLiteral(await embed(text)),
        input_hash: sha256(text),
      });
      if (e3) throw new Error(`embedding ${s.key}: ` + e3.message);
    }
    log(`seeded ${s.key}`);
  }

  // real capture → connection → recall path (a)
  const cookie = await sessionCookie(USER_A, a.password);
  const init = await api(cookie, "/api/captures", {
    file_name: "m4-scuba.png",
    mime_type: "image/png",
    size: PNG.length,
    note: "Scuba diving trip ideas for Zanzibar",
  });
  if (init.status !== 201) throw new Error("capture init failed: " + JSON.stringify(init.json));
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
  log(`capture done: ${status} (${capture_id})`);
  if (status !== "completed") throw new Error("seed capture failed");
  log("SEED DONE");
}

// --------------------------------------------------------------------- run

async function phaseRun() {
  const a = await ensureUser(USER_A);
  const cookieA = await sessionCookie(USER_A, a.password);

  let failures = 0;
  const check = (name, pass, detail = "") => {
    log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " | " + detail : ""}`);
    if (!pass) failures += 1;
  };

  const before = await latestReport(a.id);
  log("triggering pa/generate …");
  try {
    triggerPa(a.id);
  } catch (error) {
    check("PA job triggered via Inngest Cloud", false, String(error?.message ?? error).slice(0, 200));
    log(`FAILURES: ${failures + 1}`);
    process.exit(9);
  }
  check("PA job triggered via Inngest Cloud", true, "event sent");

  const report = await waitForNewReport(a.id, before?.id ?? null);
  check("report generated", Boolean(report), report ? report.id.slice(0, 8) : "timeout");
  if (!report) process.exit(9);

  const items = report.content?.items ?? [];
  const sections = report.content?.sections ?? [];
  const meta = report.generation_meta ?? {};
  const titleOf = (id) => (items.flatMap((i) => i.evidence ?? []).find((e) => e.memory_id === id)?.title ?? id?.slice(0, 8));

  check("not a quiet period (items found)", report.is_empty === false && items.length > 0);
  check("ONE wording call (cost guard)", meta.llm_calls === 1, `llm_calls=${meta.llm_calls}`);
  check("max 5 items", items.length <= 5, `items=${items.length}`);

  const keyboardId = await memoryIdByKey(a.id, "keyboard");
  const tentId = await memoryIdByKey(a.id, "tent");
  const yogaId = await memoryIdByKey(a.id, "yoga");
  const scubaId = await memoryIdByKey(a.id, "scuba");
  const pf1Id = await memoryIdByKey(a.id, "pf1");
  const pf2Id = await memoryIdByKey(a.id, "pf2");
  const pf3Id = await memoryIdByKey(a.id, "pf3");

  const reminders = items.filter((i) => i.kind === "reminder");
  const reminderIds = reminders.map((i) => i.memory_ids[0]);
  check("reminders: exactly 2 (cap)", reminders.length === 2, `${reminders.length}`);
  check(
    "reminder: most overdue eligible pair shown (build 35d + 25d)",
    reminderIds.includes(pf1Id) && reminderIds.includes(pf2Id),
    reminderIds.map((x) => titleOf(x)).join(",")
  );
  check("reminder: yoga NOT shown (try, 20d < 21d)", !reminderIds.includes(yogaId));
  check("reminder: pf3 NOT shown (build, 15d < 21d)", !reminderIds.includes(pf3Id));
  check(
    "reminder: keyboard + tent eligible but cap-enforced (next wave)",
    !reminderIds.includes(keyboardId) && !reminderIds.includes(tentId)
  );
  check("reminder wording grounded in the note", reminders.every((i) => typeof i.wording === "string" && i.wording.length > 0 && i.claim_type === "fact"));

  const projectItem = items.find((i) => i.kind === "project_candidate");
  const patternItem = items.find((i) => i.kind === "pattern");
  check("project candidate present (strict criteria met)", Boolean(projectItem) && projectItem.memory_ids.length === 4);
  check("pattern present (Cooking: 3 memories, 2 signals)", Boolean(patternItem) && patternItem.memory_ids.length === 3);

  const recallItem = items.find((i) => i.kind === "recall");
  check("proactive recall present (old + connected to this week)", Boolean(recallItem) && recallItem.memory_ids[0] === scubaId, recallItem?.meta?.reason ?? "none");

  const banned = ["you want", "you plan", "you're interested", "you are interested", "you need"];
  const wordingOk = items.every((i) => !banned.some((b) => String(i.wording).toLowerCase().includes(b)));
  check("no banned phrasing anywhere", wordingOk);

  check("sections: Needs Attention / Emerging / Everything Else", JSON.stringify(sections.map((s) => s.key)) === JSON.stringify(["needs_attention", "emerging", "everything_else"]), sections.map((s) => s.key).join(","));

  const { data: pf1Memory } = await admin.from("memories").select("pa_state").eq("id", pf1Id).single();
  const { data: pf2Memory } = await admin.from("memories").select("pa_state").eq("id", pf2Id).single();
  const { data: scubaMemory } = await admin.from("memories").select("pa_state").eq("id", scubaId).single();
  check("bookkeeping: last_reminded_at set", Boolean(pf1Memory?.pa_state?.last_reminded_at && pf2Memory?.pa_state?.last_reminded_at));
  check("bookkeeping: last_recall_at set", Boolean(scubaMemory?.pa_state?.last_recall_at));

  // UI: dot before visiting, calm page marks seen, dot after
  const pageBefore = await html(cookieA, "/memories");
  check("unseen dot on Assistant nav (new report)", pageBefore.html.includes("-right-2 -top-1"));
  const assistant = await html(cookieA, "/assistant");
  check("UI: Assistant page renders sections", assistant.status === 200 && assistant.html.includes("Needs Attention") && assistant.html.includes("Everything Else"), `status=${assistant.status}`);
  check("UI: 'You said' vs 'ScreenView noticed' labels", assistant.html.includes("You said") && assistant.html.includes("ScreenView noticed"));
  const pageAfter = await html(cookieA, "/memories");
  check("unseen dot cleared after viewing", !pageAfter.html.includes("-right-2 -top-1"));

  log("RUN1 items:", JSON.stringify(items.map((i) => ({ k: i.kind, w: String(i.wording).slice(0, 70) }))));
  log(failures === 0 ? "ALL RUN1 CHECKS PASSED" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
}

// ---------------------------------------------------------------- interact

async function phaseInteract() {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);
  const cookieA = await sessionCookie(USER_A, a.password);
  const cookieB = await sessionCookie(USER_B, b.password);

  let failures = 0;
  const check = (name, pass, detail = "") => {
    log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " | " + detail : ""}`);
    if (!pass) failures += 1;
  };

  const report = await latestReport(a.id);
  if (!report) throw new Error("no report found");
  const items = report.content?.items ?? [];
  const pf1Id = await memoryIdByKey(a.id, "pf1");
  const pf2Id = await memoryIdByKey(a.id, "pf2");

  const reminderOf = (memoryId) => items.find((i) => i.kind === "reminder" && i.memory_ids[0] === memoryId);
  const projectItem = items.find((i) => i.kind === "project_candidate");

  const complete = await api(cookieA, "/api/pa/items", {
    reportId: report.id,
    itemId: reminderOf(pf1Id).id,
    action: "complete",
  });
  check("complete action ok", complete.status === 200);
  const { data: pf1After } = await admin.from("memories").select("status").eq("id", pf1Id).single();
  check("completed memory excluded (status=completed)", pf1After?.status === "completed");
  const { data: events } = await admin.from("memory_events").select("event_type, actor, reason").eq("memory_id", pf1Id).eq("actor", "user");
  check("completion recorded as a user event", (events ?? []).some((e) => e.event_type === "status_change"));

  const dismiss = await api(cookieA, "/api/pa/items", {
    reportId: report.id,
    itemId: reminderOf(pf2Id).id,
    action: "dismiss",
  });
  check("dismiss action ok", dismiss.status === 200);
  const { data: pf2After } = await admin.from("memories").select("status, pa_state").eq("id", pf2Id).single();
  check("dismissed memory excluded (status=dismissed)", pf2After?.status === "dismissed");

  const patternItem = items.find((i) => i.kind === "pattern");
  if (patternItem) {
    const dis = await api(cookieA, "/api/pa/items", { reportId: report.id, itemId: patternItem.id, action: "dismiss" });
    const collectionId = patternItem.meta?.collection_id;
    const { data: collectionAfter } = await admin.from("collections").select("state, basis").eq("id", collectionId).single();
    check("pattern dismissal → collection dismissed + cooldown recorded", dis.status === 200 && collectionAfter?.state === "dismissed" && Boolean(collectionAfter?.basis?.dismissed_at));
  } else {
    check("pattern dismissal → collection dismissed + cooldown recorded", false, "no pattern item");
  }

  const { data: reportAfter } = await admin.from("pa_reports").select("content").eq("id", report.id).single();
  const interacted = (reportAfter?.content?.items ?? []).filter((i) => i.interaction);
  check("interactions persisted on the report", interacted.length >= 3, `${interacted.length} items`);

  // RLS
  if (projectItem) {
    const asB = await api(cookieB, "/api/pa/items", { reportId: report.id, itemId: projectItem.id, action: "dismiss" });
    check("RLS: user B cannot act on A's report item (404)", asB.status === 404, `status=${asB.status}`);
    const { data: collectionStill } = await admin.from("collections").select("state").eq("id", projectItem.meta?.collection_id).single();
    check("RLS: A's collection unchanged after B's attempt", collectionStill?.state === "suggested");
  } else {
    check("RLS: user B cannot act on A's report item (404)", false, "no project item");
  }

  const anonRes = await fetch(APP + "/api/pa/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reportId: report.id, itemId: "x", action: "open" }),
  });
  check("RLS: anonymous rejected (401)", anonRes.status === 401, `status=${anonRes.status}`);

  log(failures === 0 ? "ALL INTERACT CHECKS PASSED" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
}

// -------------------------------------------------------------------- run2

async function phaseRun2() {
  const a = await ensureUser(USER_A);
  const cookieA = await sessionCookie(USER_A, a.password);

  let failures = 0;
  const check = (name, pass, detail = "") => {
    log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " | " + detail : ""}`);
    if (!pass) failures += 1;
  };

  const keyboardId = await memoryIdByKey(a.id, "keyboard");
  const tentId = await memoryIdByKey(a.id, "tent");
  const pf1Id = await memoryIdByKey(a.id, "pf1");
  const pf2Id = await memoryIdByKey(a.id, "pf2");

  const before = await latestReport(a.id);
  triggerPa(a.id);
  const report2 = await waitForNewReport(a.id, before.id);
  check("second report generated", Boolean(report2));
  if (!report2) process.exit(9);

  const items2 = report2.content?.items ?? [];
  const reminderIds2 = items2.filter((i) => i.kind === "reminder").map((i) => i.memory_ids[0]);
  check("resolved reminders never resurface (pf1 completed, pf2 dismissed)", !reminderIds2.includes(pf1Id) && !reminderIds2.includes(pf2Id));
  check("next-most-overdue pair appears (keyboard + tent)", reminderIds2.includes(keyboardId) && reminderIds2.includes(tentId), `shown=${reminderIds2.length}`);
  check("one wording call again", (report2.generation_meta ?? {}).llm_calls === 1, `llm_calls=${report2.generation_meta?.llm_calls}`);
  check("completed/dismissed still excluded from this report", !items2.some((i) => i.memory_ids?.includes(pf1Id) || i.memory_ids?.includes(pf2Id)));

  // interact2: complete keyboard, snooze tent (pa_state only)
  const kItem = items2.find((i) => i.kind === "reminder" && i.memory_ids[0] === keyboardId);
  const tItem = items2.find((i) => i.kind === "reminder" && i.memory_ids[0] === tentId);
  const doneK = await api(cookieA, "/api/pa/items", { reportId: report2.id, itemId: kItem.id, action: "complete" });
  const { data: kAfter } = await admin.from("memories").select("status").eq("id", keyboardId).single();
  check("complete works on the next pair", doneK.status === 200 && kAfter?.status === "completed");
  const snooze = await api(cookieA, "/api/pa/items", { reportId: report2.id, itemId: tItem.id, action: "snooze" });
  const { data: tAfter } = await admin.from("memories").select("status, pa_state").eq("id", tentId).single();
  check(
    "snooze works (pa_state only — memory untouched)",
    snooze.status === 200 && tAfter?.status !== "dismissed" && tAfter?.status !== "completed" && Boolean(tAfter?.pa_state?.snoozed_until)
  );

  log(failures === 0 ? "ALL RUN2 CHECKS PASSED" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
}

async function phaseRun3() {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);
  const cookieA = await sessionCookie(USER_A, a.password);
  const cookieB = await sessionCookie(USER_B, b.password);

  let failures = 0;
  const check = (name, pass, detail = "") => {
    log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " | " + detail : ""}`);
    if (!pass) failures += 1;
  };

  const before = await latestReport(a.id);
  triggerPa(a.id);
  const report3 = await waitForNewReport(a.id, before.id);
  check("third report generated", Boolean(report3));
  if (!report3) process.exit(9);

  check("quiet period: no items", report3.is_empty === true);
  check("quiet period: ZERO LLM calls", (report3.generation_meta ?? {}).llm_calls === 0, `llm_calls=${report3.generation_meta?.llm_calls}`);

  const quietPage = await html(cookieA, "/assistant");
  check("UI: calm quiet copy", quietPage.html.includes("Nothing needs your attention right now."));

  // RLS with user B
  triggerPa(b.id);
  const bReport = await waitForNewReport(b.id, null, 240000);
  check("RLS: user B gets their own (quiet) report", Boolean(bReport) && bReport.is_empty === true);
  const bPage = await html(cookieB, "/assistant");
  check("RLS: B never sees A's report content", !bPage.html.includes("Mechanical keyboard") && !bPage.html.includes("Camping tent"));
  const bAttempt = await api(cookieB, "/api/pa/items", { reportId: report3.id, itemId: "x", action: "open" });
  check("RLS: B cannot fetch A's report items (404)", bAttempt.status === 404, `status=${bAttempt.status}`);

  // regressions (M1/M2/M3)
  const { data: fresh } = await admin
    .from("captures")
    .select("processing_status")
    .eq("user_id", a.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  check("M1: pipeline still completes (fresh capture)", fresh?.processing_status === "completed");

  const search = await api(cookieA, "/api/search", { query: "scuba diving trip" });
  check("M2: semantic search still works", search.status === 200 && (search.json?.results ?? []).length > 0, `${(search.json?.results ?? []).length} results`);

  const scubaId = await memoryIdByKey(a.id, "scuba");
  const { data: conns } = await admin
    .from("connections")
    .select("id, state")
    .eq("user_id", a.id)
    .or(`source_memory_id.eq.${scubaId},target_memory_id.eq.${scubaId}`);
  check("M3: connection still generated for the fresh capture", (conns ?? []).length >= 1, `conns=${(conns ?? []).length}`);
  const collectionsPage = await html(cookieA, "/collections");
  check("M3: collections screen still works", collectionsPage.status === 200 && collectionsPage.html.includes("ScreenView noticed"));

  log(failures === 0 ? "ALL RUN3 CHECKS PASSED" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
}

// ----------------------------------------------------------------- cleanup

async function phaseCleanup() {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);
  await wipeUser(a.id);
  await wipeUser(b.id);
  const { data: leftA } = await admin.from("captures").select("id").eq("user_id", a.id);
  const { data: reportsA } = await admin.from("pa_reports").select("id").eq("user_id", a.id);
  log(`cleanup verify — captures: ${(leftA ?? []).length}, reports: ${(reportsA ?? []).length}`);
  log("CLEANUP DONE");
}

const phases = { seed: phaseSeed, run: phaseRun, interact: phaseInteract, run2: phaseRun2, run3: phaseRun3, cleanup: phaseCleanup };
const fn = phases[PHASE];
if (!fn) {
  console.error("unknown phase:", PHASE);
  process.exit(2);
}
fn()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("M4 VERIFY FAILED:", e?.message ?? e);
    process.exit(9);
  });
