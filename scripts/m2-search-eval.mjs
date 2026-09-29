// ScreenView — M2 search verification against PRODUCTION.
// Phases:
//   --phase=seed     seed a controlled memory set for two test users (real embeddings)
//   --phase=run      semantic/filter/RLS/UI assertions against the deployed app
//   --phase=cleanup  remove seeded data
// Run: node --env-file=.env.local scripts/m2-search-eval.mjs --phase=seed|run|cleanup
import crypto from "node:crypto";
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
const SEED_MARK = "m2seed";

const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
const PHASE = phaseArg ? phaseArg.split("=")[1] : "run";

const admin = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const toVectorLiteral = (vec) => `[${vec.join(",")}]`;

// ------------------------------------------------------------ seed fixtures

const SEED_A = [
  { key: "perfume", title: "Perfume to try later", note: "I want to try this perfume later.", topic: "Fragrance", intent: "try", action: "test", status: "active", summary: "A perfume the user wants to try later.", visual: "A product page for a perfume bottle." },
  { key: "portfolio", title: "Portfolio layout inspiration", note: "I saw this website design and might use the layout for my portfolio.", topic: "Web design", intent: "inspiration", action: "save_for_reference", status: "active", summary: "A website layout the user might reuse for their portfolio.", visual: "A modern website homepage with a grid layout." },
  { key: "laptop", title: "Laptop comparison", note: "That laptop I was comparing options for", topic: "Laptops", intent: "compare", action: "compare", status: "active", summary: "A laptop listing kept for a purchase comparison.", visual: "A product page for a silver laptop." },
  { key: "aitools", title: "AI tools to explore", note: "AI tools I saved", topic: "AI tools", intent: "save_for_later", action: "save_for_reference", status: "active", summary: "Screenshots of AI tools worth exploring later.", visual: "A list of AI tools on a website." },
  { key: "desk", title: "Standing desk", note: "Things I want to buy — this desk looks solid", topic: "Shopping", intent: "buy", action: "buy", status: "active", summary: "A standing desk the user wants to purchase.", visual: "An adjustable standing desk product photo." },
  { key: "finance", title: "Investing apps research", note: "Research these investing apps", topic: "Finance", intent: "research", action: "evaluate", status: "active", summary: "Investing apps to look into.", visual: "A comparison table of investing apps." },
  { key: "recipe", title: "Jollof rice recipe", note: "Cook this someday", topic: "Cooking", intent: "try", action: "test", status: "active", summary: "A recipe the user wants to try cooking.", visual: "A food blog page with a rice recipe." },
  { key: "talk", title: "Design systems talk", note: "Watch this talk on design systems", topic: "Design", intent: "watch", action: "watch", status: "active", summary: "A talk to watch about design systems.", visual: "A conference talk video thumbnail." },
  { key: "boots", title: "Hiking boots deal", note: "Bought these already", topic: "Shopping", intent: "buy", action: "buy", status: "archived", summary: "Hiking boots — already purchased.", visual: "Hiking boots product photo." },
  { key: "hotel", title: "Kyoto hotel ideas", note: "Places to stay in Kyoto next year", topic: "Travel", intent: "save_for_later", action: "save_for_reference", status: "active", summary: "Hotel options in Kyoto saved for a future trip.", visual: "A travel booking page for a hotel." },
];

const SEED_B = [
  { key: "zdive", title: "Zanzibar scuba trip", note: "Book the zanzibar scuba trip", topic: "Diving", intent: "try", action: "test", status: "active", summary: "Zanzibar scuba diving plan.", visual: "A diving school booking page." },
  { key: "bsauce", title: "Private sauce recipe", note: "my private sauce recipe", topic: "Cooking", intent: "save_for_later", action: "none", status: "active", summary: "A personal sauce recipe.", visual: "A handwritten recipe card." },
];

function buildCanonicalText(m) {
  return [
    `Title: ${m.title}`,
    `Summary: ${m.summary}`,
    m.topic ? `Topic: ${m.topic}` : null,
    m.intent ? `Intent: ${m.intent}` : null,
    m.action ? `Action: ${m.action}` : null,
    m.visual ? `Visual: ${m.visual}` : null,
    m.note ? `User note: ${m.note}` : null,
  ]
    .filter(Boolean)
    .join("\n");
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
  throw new Error("embedding failed for: " + text.slice(0, 60));
}

// ------------------------------------------------------------ user helpers

async function ensureUser(email) {
  const password = crypto.randomBytes(24).toString("base64url");
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
  let user = (data?.users ?? []).find((u) => u.email === email);
  if (!user) {
    const res = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (res.error) throw new Error("createUser " + email + ": " + res.error.message);
    user = res.data.user;
  } else {
    await admin.auth.admin.updateUserById(user.id, { password });
  }
  return { id: user.id, password };
}

async function sessionCookie(email, password) {
  const jar = [];
  const ssr = createServerClient(SUPA_URL, ANON, {
    cookies: { getAll: () => [], setAll: (list) => list.forEach((c) => jar.push(`${c.name}=${c.value}`)) },
  });
  const { error } = await ssr.auth.signInWithPassword({ email, password });
  if (error) throw new Error("signIn: " + error.message);
  return jar.join("; ");
}

// ---------------------------------------------------------------- phases

async function phaseSeed() {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);
  for (const [owner, seeds] of [[a, SEED_A], [b, SEED_B]]) {
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      const captureId = crypto.randomUUID();
      const memoryId = crypto.randomUUID();
      const canonical = buildCanonicalText(s);
      const vector = await embed(canonical);
      const { error: e1 } = await admin.from("captures").insert({
        id: captureId,
        user_id: owner.id,
        storage_path: `${owner.id}/${SEED_MARK}-${s.key}-${captureId}.png`,
        original_note: s.note,
        source: "web",
        mime_type: "image/png",
        processing_status: "completed",
      });
      if (e1) throw new Error("capture insert: " + e1.message);
      const { error: e2 } = await admin.from("memories").insert({
        id: memoryId,
        user_id: owner.id,
        capture_id: captureId,
        title: s.title,
        summary: s.summary,
        visual_description: s.visual,
        perception: {
          content_type: "other",
          visual_description: s.visual,
          visible_text: "",
          detected_entities: [],
          prices: [],
          urls: [],
          dates: [],
          important_visual_details: [],
          meta: { model: "seed", provider: "seed" },
        },
        topic: s.topic,
        current_intent: s.intent,
        intent_source: "user_statement",
        intent_confidence: 0.9,
        suggested_action: s.action,
        status: s.status,
      });
      if (e2) throw new Error("memory insert: " + e2.message);
      const { error: e3 } = await admin.from("memory_embeddings").insert({
        user_id: owner.id,
        memory_id: memoryId,
        model: EMBEDDING_MODEL,
        embedding: toVectorLiteral(vector),
        input_hash: sha256(canonical),
      });
      if (e3) throw new Error("embedding insert: " + e3.message);
      log(`seeded ${owner.id.slice(0, 8)}… → ${s.key} (${memoryId.slice(0, 8)}…)`);
    }
  }
  log("SEED DONE:", SEED_A.length, "+", SEED_B.length, "memories");
}

async function phaseRun() {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);
  const cookieA = await sessionCookie(USER_A, a.password);
  const cookieB = await sessionCookie(USER_B, b.password);

  // map key -> memory id
  const { data: rowsA } = await admin
    .from("captures")
    .select("id, storage_path, memories!inner(id)")
    .eq("user_id", a.id)
    .like("storage_path", `%${SEED_MARK}%`);
  const keyToId = {};
  for (const row of rowsA ?? []) {
    const match = /m2seed-([a-z]+)-/.exec(row.storage_path);
    if (match) keyToId[match[1]] = row.memories?.[0]?.id ?? row.memories?.id;
  }
  const idsOf = (...keys) => keys.map((k) => keyToId[k]).filter(Boolean);

  const search = async (cookie, body) => {
    const res = await fetch(APP + "/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const ids = (json) => (json?.results ?? []).map((r) => r.memoryId);

  let failures = 0;
  const check = (name, pass, detail = "") => {
    log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " | " + detail : ""}`);
    if (!pass) failures += 1;
  };

  // ---- semantic / exact / multi / no-match
  const cases = [
    { name: "exact wording → perfume", body: { query: "I want to try this perfume later" }, must: idsOf("perfume") },
    { name: "different wording → perfume", body: { query: "that perfume I wanted to try" }, must: idsOf("perfume") },
    { name: "semantic “website inspiration” → portfolio", body: { query: "website design inspiration" }, must: idsOf("portfolio") },
    { name: "“things I want to buy” → desk", body: { query: "things I want to buy" }, must: idsOf("desk") },
    { name: "“stuff I wanted to try” → perfume or recipe", body: { query: "stuff I wanted to try" }, mustAny: idsOf("perfume", "recipe") },
    { name: "“AI tools I saved” → aitools", body: { query: "AI tools I saved" }, must: idsOf("aitools") },
    { name: "“things I wanted to research” → finance", body: { query: "things I wanted to research" }, must: idsOf("finance") },
    { name: "“that screenshot about a laptop” → laptop", body: { query: "that screenshot about a laptop" }, must: idsOf("laptop") },
  ];
  for (const c of cases) {
    const r = await search(cookieA, c.body);
    const got = ids(r.json);
    const ok =
      r.status === 200 &&
      (c.must ? c.must.every((id) => got.includes(id)) : c.mustAny ? c.mustAny.some((id) => got.includes(id)) : true);
    const top = r.json?.results?.[0];
    check(c.name, ok, `results=${got.length}${top ? ` top=“${top.title}”` : ""}`);
  }

  // ---- multi-relevant
  {
    const r = await search(cookieA, { query: "design inspiration for my portfolio" });
    const got = ids(r.json);
    check("multiple relevant → portfolio + ≥1 more", r.status === 200 && got.includes(keyToId.portfolio) && got.length >= 2, `results=${got.length}`);
  }

  // ---- no match (expect empty; debug top similarity via direct KNN)
  {
    const r = await search(cookieA, { query: "quantum chromodynamics lecture notes" });
    const got = ids(r.json);
    let topSim = null;
    try {
      const vec = await embed("quantum chromodynamics lecture notes");
      const { data } = await admin.rpc("match_memories", {
        p_user_id: a.id,
        query_embedding: toVectorLiteral(vec),
        match_count: 3,
      });
      topSim = (data ?? [])[0]?.similarity ?? null;
    } catch {}
    check("no-match query → empty", r.status === 200 && got.length === 0, `results=${got.length} topSim=${topSim}`);
  }

  // ---- filters
  const filterCases = [
    { name: "filter intent=try + “perfume”", body: { query: "perfume", intent: "try" }, must: idsOf("perfume"), allIntent: "try" },
    { name: "filter intent=buy excludes perfume", body: { query: "perfume", intent: "buy" }, mustNot: idsOf("perfume") },
    { name: "browse intent=buy (no query)", body: { intent: "buy" }, must: idsOf("desk", "boots"), allIntent: "buy" },
    { name: "browse topic=Fragrance", body: { topic: "Fragrance" }, must: idsOf("perfume"), allTopic: "Fragrance" },
    { name: "browse action=test", body: { action: "test" }, must: idsOf("perfume", "recipe"), allAction: "test" },
    { name: "browse status=archived", body: { status: "archived" }, must: idsOf("boots"), mustNot: idsOf("perfume"), allStatus: "archived" },
    { name: "browse intent=buy + status=archived", body: { intent: "buy", status: "archived" }, must: idsOf("boots"), mustNot: idsOf("desk") },
    { name: "query “design” + topic filter", body: { query: "design talk", topic: "Design" }, must: idsOf("talk"), allTopic: "Design" },
  ];
  for (const c of filterCases) {
    const r = await search(cookieA, c.body);
    const results = r.json?.results ?? [];
    const got = ids(r.json);
    let ok = r.status === 200;
    if (c.must) ok = ok && c.must.every((id) => got.includes(id));
    if (c.mustNot) ok = ok && c.mustNot.every((id) => !got.includes(id));
    if (c.allIntent) ok = ok && results.every((x) => x.intent === c.allIntent);
    if (c.allTopic) ok = ok && results.every((x) => x.topic === c.allTopic);
    if (c.allAction) ok = ok && results.every((x) => x.action === c.allAction);
    if (c.allStatus) ok = ok && results.every((x) => x.status === c.allStatus);
    check(`filter: ${c.name}`, ok, `results=${got.length}`);
  }

  // ---- RLS / ownership
  {
    const { data: rowsB } = await admin
      .from("captures")
      .select("id, storage_path, memories!inner(id)")
      .eq("user_id", b.id);
    const bIds = (rowsB ?? []).map((x) => x.memories?.[0]?.id ?? x.memories?.id).filter(Boolean);

    const rA = await search(cookieA, { query: "zanzibar scuba diving trip" });
    const gotA = ids(rA.json);
    check("A never sees B's memories", bIds.every((id) => !gotA.includes(id)), `A results=${gotA.length} (B ids ${bIds.length})`);

    const rB = await search(cookieB, { query: "zanzibar scuba diving" });
    const gotB = ids(rB.json);
    check("B finds B's own memory", rB.status === 200 && bIds.some((id) => gotB.includes(id)), `B results=${gotB.length}`);
  }

  // ---- malformed + auth
  {
    const r1 = await search(cookieA, {});
    check("empty request → 400", r1.status === 400, `status=${r1.status}`);
    const r2 = await search(cookieA, { query: "x".repeat(301) });
    check("overlong query → 400", r2.status === 400, `status=${r2.status}`);
    const r3 = await fetch(APP + "/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "perfume" }),
    });
    check("anonymous search → 401", r3.status === 401, `status=${r3.status}`);
  }

  // ---- UI (server-rendered)
  const page = async (path) => {
    const res = await fetch(APP + path, { headers: { Cookie: cookieA } });
    return { status: res.status, html: await res.text() };
  };
  {
    const r1 = await page("/memories?q=perfume");
    check("UI: search results contain perfume card", r1.status === 200 && r1.html.includes("Perfume to try later") && !r1.html.includes("Search couldn"), `status=${r1.status}`);
    const r2 = await page("/memories?q=definitelynomatchzzz+quantum");
    check("UI: no-match copy renders", r2.status === 200 && r2.html.includes("Nothing matched yet."), `status=${r2.status}`);
    const r3 = await page("/memories");
    check("UI: browse mode still intact", r3.status === 200 && r3.html.includes("Add screenshots"), `status=${r3.status}`);
    const r4 = await page("/memories?intent=buy");
    check("UI: filter browse renders", r4.status === 200 && r4.html.includes("Standing desk"), `status=${r4.status}`);
  }

  log(failures === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
}

async function phaseCleanup() {
  for (const email of [USER_A, USER_B]) {
    const a = await ensureUser(email);
    const { data: caps } = await admin
      .from("captures")
      .select("id, storage_path")
      .eq("user_id", a.id)
      .like("storage_path", `%${SEED_MARK}%`);
    const capIds = (caps ?? []).map((c) => c.id);
    if (!capIds.length) {
      log(`cleanup ${email}: nothing to remove`);
      continue;
    }
    const { data: mems } = await admin.from("memories").select("id").in("capture_id", capIds);
    const memIds = (mems ?? []).map((m) => m.id);
    if (memIds.length) {
      await admin.from("memory_events").delete().in("memory_id", memIds);
      await admin.from("memory_embeddings").delete().in("memory_id", memIds);
      await admin.from("memories").delete().in("id", memIds);
    }
    await admin.from("captures").delete().in("id", capIds);
    log(`cleanup ${email}: removed ${capIds.length} captures, ${memIds.length} memories`);
  }
  log("CLEANUP DONE");
}

const phases = { seed: phaseSeed, run: phaseRun, cleanup: phaseCleanup };
const fn = phases[PHASE];
if (!fn) {
  console.error("unknown phase:", PHASE);
  process.exit(2);
}
fn()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("M2 EVAL FAILED:", e?.message ?? e);
    process.exit(9);
  });
