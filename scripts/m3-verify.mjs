// ScreenView — M3 production verification (connections + collections), against the deployed app.
// Phases:
//   --phase=seed     reset test user A and seed the controlled memory set (real embeddings)
//   --phase=run      full M3 verification flow (connections, discovery, lifecycle, RLS, UI)
//   --phase=cleanup  remove all of user A's data
// Run: node --env-file=.env.local scripts/m3-verify.mjs --phase=seed|run|cleanup
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
const SEED_MARK = "m3seed";
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

// ------------------------------------------------------------------ fixtures

const SEED = [
  { key: "perfume1", title: "Perfume to try later", note: "I want to try this perfume later.", topic: "Fragrance", intent: "try", action: "test", days: 25, summary: "A perfume the user wants to try later.", visual: "A product page for a perfume bottle." },
  { key: "cologne", title: "Cologne shortlist", note: "Maybe worth testing", topic: "Fragrance", intent: "try", action: "test", days: 15, summary: "A cologne kept for a possible test.", visual: "A cologne bottle product shot." },
  { key: "pasta", title: "Pasta recipe", note: "Pasta recipe to try", topic: "Cooking", intent: "try", action: "test", days: 12, summary: "A pasta recipe to try.", visual: "A recipe page with pasta." },
  { key: "risotto", title: "Risotto recipe", note: "Risotto for a weekend", topic: "Cooking", intent: "try", action: "test", days: 11, summary: "A risotto recipe for the weekend.", visual: "A risotto dish photo." },
  { key: "sourdough", title: "Sourdough starter guide", note: "Baking project", topic: "Cooking", intent: "try", action: "test", days: 2, summary: "A guide to making a sourdough starter.", visual: "A bread baking guide." },
  { key: "kyoto", title: "Kyoto hotel ideas", note: "Places to stay in Kyoto next year", topic: "Travel", intent: "save_for_later", action: "save_for_reference", days: 40, summary: "Hotel options in Kyoto.", visual: "A hotel booking page." },
  { key: "tokyo", title: "Tokyo flight deal", note: "Flight prices for Tokyo", topic: "Travel", intent: "save_for_later", action: "save_for_reference", days: 30, summary: "Flight options to Tokyo.", visual: "An airline search results page." },
  { key: "lisbon", title: "Lisbon guide", note: "Lisbon travel guide", topic: "Travel", intent: "save_for_later", action: "save_for_reference", days: 20, summary: "A guide for Lisbon.", visual: "A travel blog about Lisbon." },
  { key: "bali", title: "Bali villas", note: "Compare villas in Bali", topic: "Travel", intent: "research", action: "evaluate", days: 10, summary: "Villa options in Bali to compare.", visual: "A villa listing page." },
  { key: "pf1", title: "Portfolio redesign idea", note: "I want something like this for my portfolio site", topic: "Portfolio", intent: "build", action: "build", days: 35, summary: "A design the user may want to build into their portfolio.", visual: "A modern portfolio website." },
  { key: "pf2", title: "Portfolio hero section", note: "Nice hero layout", topic: "Portfolio", intent: "build", action: "build", days: 25, summary: "A hero section layout for a portfolio.", visual: "A website hero section screenshot." },
  { key: "pf3", title: "Portfolio color palettes", note: "Palette references", topic: "Portfolio", intent: "build", action: "build", days: 15, summary: "Color palettes for a portfolio build.", visual: "A color palette swatch sheet." },
  { key: "pf4", title: "Portfolio animations", note: "Scroll animation ideas", topic: "Portfolio", intent: "build", action: "build", days: 5, summary: "Animation ideas for the portfolio.", visual: "A website with scroll animations." },
  { key: "garden1", title: "Balcony garden layout", note: "Planting ideas", topic: "Gardening", intent: "save_for_later", action: "save_for_reference", days: 6, summary: "A layout idea for a balcony garden.", visual: "A small balcony garden." },
  { key: "garden2", title: "Herb planter", note: "Herbs to plant", topic: "Gardening", intent: "save_for_later", action: "save_for_reference", days: 5, summary: "An herb planter idea.", topicTags: [], visual: "Herb planters on a windowsill." },
];

function buildCanonicalText(s) {
  return [
    `Title: ${s.title}`,
    `Summary: ${s.summary}`,
    s.topic ? `Topic: ${s.topic}` : null,
    s.intent ? `Intent: ${s.intent}` : null,
    s.action ? `Action: ${s.action}` : null,
    s.visual ? `Visual: ${s.visual}` : null,
    s.note ? `User note: ${s.note}` : null,
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

// -------------------------------------------------------------------- seed

async function wipeUserA(userId) {
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
  if (paths.length) await admin.storage.from("captures").remove(paths);
  log(`wipe: ${capIds.length} captures, ${colIds.length} collections removed`);
}

async function phaseSeed() {
  const a = await ensureUser(USER_A);
  await wipeUserA(a.id);
  for (const s of SEED) {
    const captureId = crypto.randomUUID();
    const memoryId = crypto.randomUUID();
    const canonical = buildCanonicalText(s);
    const vector = await embed(canonical);
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
      created_at: iso(s.days),
    });
    if (e2) throw new Error(`memory ${s.key}: ` + e2.message);
    const { error: e3 } = await admin.from("memory_embeddings").insert({
      user_id: a.id,
      memory_id: memoryId,
      model: EMBEDDING_MODEL,
      embedding: toVectorLiteral(vector),
      input_hash: sha256(canonical),
    });
    if (e3) throw new Error(`embedding ${s.key}: ` + e3.message);
    log(`seeded ${s.key} (${memoryId.slice(0, 8)}…)`);
  }
  log("SEED DONE:", SEED.length, "memories");
}

// --------------------------------------------------------------------- run

async function phaseRun() {
  const a = await ensureUser(USER_A);
  const b = await ensureUser(USER_B);
  const cookieA = await sessionCookie(USER_A, a.password);
  const cookieB = await sessionCookie(USER_B, b.password);

  let failures = 0;
  const check = (name, pass, detail = "") => {
    log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " | " + detail : ""}`);
    if (!pass) failures += 1;
  };

  // helpers to look up seeded ids
  const memoryIdByKey = async () => {
    const { data } = await admin
      .from("captures")
      .select("storage_path, memories!inner(id)")
      .eq("user_id", a.id)
      .like("storage_path", `%${SEED_MARK}%`);
    const map = {};
    for (const row of data ?? []) {
      const m = /m3seed-([a-z0-9]+)-/.exec(row.storage_path);
      if (m) map[m[1]] = row.memories?.[0]?.id ?? row.memories?.id;
    }
    return map;
  };

  let ids = await memoryIdByKey();
  const collectionsFor = async (state) => {
    const { data } = await admin.from("collections").select("id, name, kind, state, basis").eq("user_id", a.id).eq("state", state);
    return data ?? [];
  };
  const membersOf = async (collectionId) => {
    const { data } = await admin.from("collection_members").select("memory_id").eq("collection_id", collectionId);
    return (data ?? []).map((x) => x.memory_id);
  };
  const collectionWithMembers = async (expectedIds, state = "suggested") => {
    for (const col of await collectionsFor(state)) {
      const members = await membersOf(col.id);
      if (expectedIds.every((id) => members.includes(id)) && members.length === expectedIds.length) return { col, members };
    }
    return null;
  };

  // ---- Wave A: discovery with 2-member Fragrance (pre-threshold) ----
  const run1 = await api(cookieA, "/api/collections/discover", undefined);
  const r1 = run1.json ?? {};
  log("discovery#1 created:", JSON.stringify((r1.created ?? []).map((c) => ({ n: c.name, k: c.kind }))));

  const portfolioSet = await collectionWithMembers([ids.pf1, ids.pf2, ids.pf3, ids.pf4]);
  const travelSet = await collectionWithMembers([ids.kyoto, ids.tokyo, ids.lisbon, ids.bali]);
  check("collection: Portfolio suggested as PROJECT (strict criteria)", Boolean(portfolioSet) && portfolioSet.col.kind === "project");
  check("collection: Travel suggested as collection (not project)", Boolean(travelSet) && travelSet.col.kind === "collection");
  check("collection: works before threshold appears — Fragrance NOT suggested (2 members)", !(await collectionWithMembers([ids.perfume1, ids.cologne])), "fragrance stayed quiet");
  const { data: gardenMembers } = await admin
    .from("collection_members")
    .select("id")
    .in("memory_id", [ids.garden1, ids.garden2]);
  check("collection: Gardening (2 memories) never suggested", (gardenMembers ?? []).length === 0, `member rows=${(gardenMembers ?? []).length}`);

  // ---- UI: suggestions visible, AI-labeled ----
  {
    const page = await html(cookieA, "/collections");
    check(
      "UI: Collections screen shows AI suggestions with 'ScreenView noticed'",
      page.status === 200 && page.html.includes("ScreenView noticed") && page.html.includes("Project") && page.html.includes("Accept"),
      `status=${page.status}`
    );
    const detail = await html(cookieA, `/collections/${portfolioSet.col.id}`);
    check(
      "UI: collection detail explains why + member list",
      detail.status === 200 && detail.html.includes("Why ScreenView grouped these") && detail.html.includes("Portfolio redesign idea"),
      `status=${detail.status}`
    );
  }

  // ---- accept Travel (rename), accept Portfolio (rename) ----
  {
    const acc1 = await api(cookieA, `/api/collections/${travelSet.col.id}`, { action: "accept" });
    check("collection: accept works (Travel)", acc1.status === 200 && acc1.json?.state === "accepted");
    const ren1 = await api(cookieA, `/api/collections/${travelSet.col.id}`, { action: "rename", name: "Trip ideas" });
    check("collection: rename works", ren1.status === 200);
    const acc2 = await api(cookieA, `/api/collections/${portfolioSet.col.id}`, { action: "accept" });
    const ren2 = await api(cookieA, `/api/collections/${portfolioSet.col.id}`, { action: "rename", name: "Portfolio build" });
    check("collection: accept works (Portfolio project)", acc2.status === 200 && acc2.json?.state === "accepted" && ren2.status === 200);

    const memberStates = await admin.from("collection_members").select("state").eq("collection_id", travelSet.col.id);
    check("collection: membership becomes active on accept", (memberStates.data ?? []).every((m) => m.state === "confirmed"));

    const { data: renamed } = await admin.from("collections").select("name, basis").eq("id", travelSet.col.id).single();
    check("collection: rename persisted + original evidence preserved", renamed?.name === "Trip ideas" && renamed?.basis?.signature && renamed?.basis?.accepted_at);
  }

  // ---- connection dismissal fixture (pasta ↔ risotto, suggested by "AI") ----
  {
    const [source, target] = [ids.pasta, ids.risotto].sort();
    const { data: inserted, error } = await admin
      .from("connections")
      .insert({
        user_id: a.id,
        source_memory_id: source,
        target_memory_id: target,
        relationship_type: "same_subject",
        state: "suggested",
        origin: "ai",
        confidence: 0.8,
        basis: { signals: ["verify_fixture"], reasoning: "Both are cooking recipes the user wants to try.", prompt_version: "m3-verify" },
      })
      .select("id")
      .single();
    check("connections: fixture suggested connection created", !error && Boolean(inserted?.id), error?.message ?? "");

    const page = await html(cookieA, `/memories/${await captureIdFor(ids.pasta)}`);
    check(
      "UI: suggested connection appears with 'ScreenView suggested' + actions",
      page.status === 200 && page.html.includes("Related memories") && page.html.includes("ScreenView suggested") && page.html.includes("Confirm"),
      `status=${page.status}`
    );

    const dis = await api(cookieA, `/api/connections/${inserted.id}`, { action: "dismiss" });
    check("connections: dismiss works", dis.status === 200 && dis.json?.state === "dismissed");

    const after = await html(cookieA, `/memories/${await captureIdFor(ids.pasta)}`);
    check("connections: dismissed suggestion is no longer shown", !after.html.includes("Related memories"));
  }

  // ---- M1 intact + AI connection generation: real capture of perfume2 ----
  let perfume2MemoryId = null;
  let perfume2CaptureId = null;
  {
    const init = await api(cookieA, "/api/captures", {
      file_name: "m3-perfume2.png",
      mime_type: "image/png",
      size: PNG.length,
      note: "I want to try this perfume too — like the one I saved earlier.",
    });
    check("M1: capture init works (perfume2)", init.status === 201, JSON.stringify(init.json).slice(0, 100));
    if (init.status === 201) {
      const { capture_id, path, upload } = init.json;
      perfume2CaptureId = capture_id;
      const up = await anon.storage.from("captures").uploadToSignedUrl(path, upload.token, PNG, { contentType: "image/png" });
      const done = await api(cookieA, `/api/captures/${capture_id}/complete`, { file_hash: sha256Bytes(PNG) });
      check("M1: upload + complete work", !up.error && done.status === 200);

      // poll pipeline
      let status = null;
      const started = Date.now();
      while (Date.now() - started < 240000) {
        const { data } = await admin.from("captures").select("processing_status").eq("id", capture_id).single();
        status = data?.processing_status;
        if (status === "completed" || status === "failed") break;
        await sleep(4000);
      }
      check("M1: processing pipeline completes on M3 build", status === "completed", `status=${status}`);
      const { data: mem } = await admin.from("memories").select("id").eq("capture_id", capture_id).maybeSingle();
      perfume2MemoryId = mem?.id ?? null;
      check("M1: memory persisted", Boolean(perfume2MemoryId));
    }
  }

  // ---- AI-generated connection (perfume2 → perfume1, from the pipeline) ----
  let aiConnection = null;
  {
    // give the connections step a moment (it runs right after persist)
    for (let i = 0; i < 10 && !aiConnection; i++) {
      if (!perfume2MemoryId) break;
      const { data } = await admin
        .from("connections")
        .select("id, source_memory_id, target_memory_id, relationship_type, state, origin, basis, confidence")
        .eq("user_id", a.id)
        .or(`source_memory_id.eq.${perfume2MemoryId},target_memory_id.eq.${perfume2MemoryId}`);
      aiConnection = (data ?? [])[0] ?? null;
      if (!aiConnection) await sleep(3000);
    }
    const partner = aiConnection
      ? aiConnection.source_memory_id === perfume2MemoryId
        ? aiConnection.target_memory_id
        : aiConnection.source_memory_id
      : null;
    check(
      "connections: pipeline generated a suggested connection for the new memory",
      Boolean(aiConnection) && aiConnection.state === "suggested" && aiConnection.origin === "ai",
      aiConnection ? `type=${aiConnection.relationship_type} conf=${aiConnection.confidence}` : "none found"
    );
    check(
      "connections: the partner is an existing perfume memory (meaningful, not just similar)",
      partner === ids.perfume1 || partner === ids.cologne,
      partner ? partner.slice(0, 8) : "n/a"
    );
    check(
      "connections: basis is recorded (justified, not cosine)",
      Boolean(aiConnection?.basis?.reasoning && aiConnection.basis.prompt_version),
      String(aiConnection?.basis?.reasoning ?? "").slice(0, 80)
    );
    check(
      "connections: canonical ordering (source < target)",
      Boolean(aiConnection) && aiConnection.source_memory_id < aiConnection.target_memory_id
    );

    if (aiConnection) {
      const conf = await api(cookieA, `/api/connections/${aiConnection.id}`, { action: "confirm" });
      check("connections: confirm works", conf.status === 200 && conf.json?.state === "confirmed");
      const { data: row } = await admin.from("connections").select("state").eq("id", aiConnection.id).single();
      check("connections: confirmed state persists", row?.state === "confirmed");
      const page = await html(cookieA, `/memories/${perfume2CaptureId}`);
      check("UI: confirmed connection stays visible ('Confirmed')", page.html.includes("Related memories") && page.html.includes("Confirmed"));
    }
  }

  // ---- Wave B: threshold reached (Fragrance now has 3) → new suggestions ----
  const run2 = await api(cookieA, "/api/collections/discover", undefined);
  const r2 = run2.json ?? {};
  log("discovery#2 created:", JSON.stringify((r2.created ?? []).map((c) => ({ n: c.name, k: c.kind }))));
  const fragranceSet = perfume2MemoryId
    ? await collectionWithMembers([ids.perfume1, ids.cologne, perfume2MemoryId])
    : null;
  const cookingSet = await collectionWithMembers([ids.pasta, ids.risotto, ids.sourdough]);
  check("collection: threshold — Fragrance suggested only now it has 3 memories", Boolean(fragranceSet));
  check("collection: Cooking suggested (3 memories, 2 signals)", Boolean(cookingSet));

  // accept Cooking; dismiss Fragrance
  {
    if (cookingSet) {
      const acc = await api(cookieA, `/api/collections/${cookingSet.col.id}`, { action: "accept" });
      check("collection: accept Cooking", acc.status === 200 && acc.json?.state === "accepted");
    } else {
      check("collection: accept Cooking", false, "cooking set not suggested");
    }
    if (fragranceSet) {
      const dis = await api(cookieA, `/api/collections/${fragranceSet.col.id}`, { action: "dismiss" });
      check("collection: dismiss Fragrance", dis.status === 200 && dis.json?.state === "dismissed");
      const page = await html(cookieA, "/collections");
      check("UI: dismissed collection hidden from list", !page.html.includes(`/collections/${fragranceSet.col.id}`), "by id");
    } else {
      check("collection: dismiss Fragrance", false, "fragrance set not suggested");
    }

    const run3 = await api(cookieA, "/api/collections/discover", undefined);
    check("collection: dismissed signature does not resurface immediately", (run3.json?.created ?? []).length === 0, JSON.stringify(run3.json?.created ?? []));
  }

  // ---- multiple membership (+ user_created origin) ----
  {
    const { data: extra, error } = await admin
      .from("collections")
      .insert({
        user_id: a.id,
        name: "Weekend experiments",
        description: "Hand-made group.",
        origin: "user_created",
        state: "accepted",
        kind: "collection",
        basis: { detector: "manual", member_ids: [ids.sourdough, ids.garden1] },
      })
      .select("id")
      .single();
    check("collection: user_created fixture inserted", !error && Boolean(extra?.id));
    await admin.from("collection_members").insert([
      { user_id: a.id, collection_id: extra.id, memory_id: ids.sourdough, state: "confirmed" },
      { user_id: a.id, collection_id: extra.id, memory_id: ids.garden1, state: "confirmed" },
    ]);
    const { data: memberships } = await admin
      .from("collection_members")
      .select("collection_id")
      .eq("memory_id", ids.sourdough);
    check("collection: multiple membership works (one memory, two collections)", (memberships ?? []).length === 2, `memberships=${(memberships ?? []).length}`);

    const page = await html(cookieA, `/memories/${await captureIdFor(ids.sourdough)}`);
    if (cookingSet) {
      check(
        "UI: memory shows both collections ('In collections')",
        page.status === 200 &&
          page.html.includes("In collections") &&
          page.html.includes(`/collections/${cookingSet.col.id}`) &&
          page.html.includes(`/collections/${extra.id}`)
      );
    } else {
      check("UI: memory shows both collections ('In collections')", false, "cooking set missing");
    }

    const arc = await api(cookieA, `/api/collections/${extra.id}`, { action: "archive" });
    check("collection: archive works", arc.status === 200 && arc.json?.state === "archived");

    const detail = await html(cookieA, `/collections/${extra.id}`);
    check("UI: user-created collection labeled 'You created'", detail.status === 200 && detail.html.includes("You created this collection."));
  }

  // ---- RLS / ownership with a second user ----
  {
    const otherSide = await html(cookieB, "/collections");
    check("RLS: user B sees no collections of user A", !otherSide.html.includes("Trip ideas") && !otherSide.html.includes("Portfolio build"), `status=${otherSide.status}`);

    const accAsB = await api(cookieB, `/api/collections/${portfolioSet.col.id}`, { action: "accept" });
    check("RLS: B cannot accept A's collection (invisible → 404)", accAsB.status === 404 || accAsB.status === 400, `status=${accAsB.status}`);

    if (aiConnection) {
      const connAsB = await api(cookieB, `/api/connections/${aiConnection.id}`, { action: "dismiss" });
      check("RLS: B cannot touch A's connection", connAsB.status === 404 || connAsB.status === 400, `status=${connAsB.status}`);
      const { data: stillConfirmed } = await admin.from("connections").select("state").eq("id", aiConnection.id).single();
      check("RLS: A's connection unchanged after B's attempt", stillConfirmed?.state === "confirmed");
    }

    const { count: bConn } = await admin.from("connections").select("id", { count: "exact", head: true }).eq("user_id", b.id);
    const { count: bCols } = await admin.from("collections").select("id", { count: "exact", head: true }).eq("user_id", b.id);
    check("RLS: user B has zero organization data", (bConn ?? 0) === 0 && (bCols ?? 0) === 0, `conns=${bConn} cols=${bCols}`);

    const anonRes = await fetch(APP + "/api/collections/discover", { method: "POST" });
    check("RLS: anonymous discover → 401", anonRes.status === 401, `status=${anonRes.status}`);
  }

  // ---- M2 intact: search still works ----
  {
    const q1 = await api(cookieA, "/api/search", { query: "that perfume I wanted to try" });
    const t1 = (q1.json?.results ?? []).map((r) => r.title ?? "");
    check("M2: search still works (perfume query)", q1.status === 200 && t1.some((t) => /perfume/i.test(t)), t1[0] ?? "");
    const q2 = await api(cookieA, "/api/search", { query: "places to stay in Kyoto" });
    check("M2: search finds travel memory", q2.status === 200 && (q2.json?.results ?? []).length > 0);
  }

  // ---- total connections sanity: only the two expected pairs exist ----
  {
    const { data: allConn } = await admin
      .from("connections")
      .select("id, source_memory_id, target_memory_id, state")
      .eq("user_id", a.id);
    const pairKey = (x, y) => [x, y].sort().join("|");
    const meaningful = new Set([
      pairKey(ids.pasta, ids.risotto),
      ...(perfume2MemoryId
        ? [pairKey(perfume2MemoryId, ids.perfume1), pairKey(perfume2MemoryId, ids.cologne)]
        : []),
    ]);
    const allMeaningful = (allConn ?? []).every((c) =>
      meaningful.has(pairKey(c.source_memory_id, c.target_memory_id))
    );
    check(
      "connections: only meaningful pairs exist (no similarity-only spam)",
      allMeaningful && (allConn ?? []).length <= 3,
      `count=${(allConn ?? []).length}`
    );
  }

  log(failures === 0 ? "ALL M3 CHECKS PASSED" : `FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 9);
}

async function captureIdFor(memoryId) {
  const { data } = await admin.from("memories").select("capture_id").eq("id", memoryId).single();
  return data?.capture_id;
}

// ----------------------------------------------------------------- cleanup

async function phaseCleanup() {
  const a = await ensureUser(USER_A);
  await wipeUserA(a.id);
  const { data: left } = await admin.from("captures").select("id").eq("user_id", a.id);
  const { data: cols } = await admin.from("collections").select("id").eq("user_id", a.id);
  log(`cleanup verify — captures left: ${(left ?? []).length}, collections left: ${(cols ?? []).length}`);
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
    console.error("M3 VERIFY FAILED:", e?.message ?? e);
    process.exit(9);
  });
