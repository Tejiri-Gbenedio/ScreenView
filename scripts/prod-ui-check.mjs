// ScreenView — production UI render check: a memory row must render on /memories (server-rendered),
// and the page must be auth-gated without a session. Creates + removes its own labeled fixture.
// Run: node --env-file=.env.local scripts/prod-ui-check.mjs
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = "https://screenview-two.vercel.app";
const TEST_EMAIL = "tejirigbe+screenview-m1@gmail.com";
const TITLE = "UI render check — safe to delete";

const admin = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });

const password = crypto.randomBytes(24).toString("base64url");
const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
const user = (data?.users ?? []).find((u) => u.email === TEST_EMAIL);
if (!user) throw new Error("test user missing — run prod-e2e first");
await admin.auth.admin.updateUserById(user.id, { password });

const jar = [];
const ssr = createServerClient(SUPA_URL, ANON, {
  cookies: { getAll: () => [], setAll: (list) => list.forEach((c) => jar.push(`${c.name}=${c.value}`)) },
});
await ssr.auth.signInWithPassword({ email: TEST_EMAIL, password });
const cookie = jar.join("; ");

const captureId = crypto.randomUUID();
const memoryId = crypto.randomUUID();
const { error: e1 } = await admin.from("captures").insert({
  id: captureId,
  user_id: user.id,
  storage_path: `${user.id}/${captureId}.png`,
  source: "web",
  mime_type: "image/png",
  processing_status: "completed",
});
if (e1) throw new Error("capture insert: " + e1.message);
const { error: e2 } = await admin.from("memories").insert({
  id: memoryId,
  user_id: user.id,
  capture_id: captureId,
  title: TITLE,
  summary: "fixture for UI render verification",
  visual_description: "fixture",
  topic: "verification",
  current_intent: "save_for_later",
  intent_source: "user_statement",
  intent_confidence: 0.9,
  suggested_action: "none",
  status: "active",
});
if (e2) throw new Error("memory insert: " + e2.message);
console.log("fixture created:", memoryId);

const authed = await fetch(`${APP}/memories`, { headers: { Cookie: cookie } });
const html = await authed.text();
const titleRendered = html.includes(TITLE);
console.log("authed /memories →", authed.status, "| memory title in HTML:", titleRendered ? "YES" : "NO");

const anonRes = await fetch(`${APP}/memories`, { redirect: "manual" });
console.log("anon /memories →", anonRes.status, "(expect 3xx redirect to /login)");

await admin.from("memories").delete().eq("id", memoryId);
await admin.from("captures").delete().eq("id", captureId);
console.log("fixture removed");

const pass = authed.status === 200 && titleRendered && [301, 302, 307, 308].includes(anonRes.status);
console.log(pass ? "UI CHECK: PASS" : "UI CHECK: FAIL");
process.exit(pass ? 0 : 9);
