// ScreenView — production security spot-check: anon RLS + client bundle scan + serve auth.
// Run: node --env-file=.env.local scripts/prod-security-check.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP = "https://screenview-two.vercel.app";

const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const checks = [];

const cap = await anon.from("captures").select("id").limit(5);
checks.push(["anon cannot read captures (0 rows)", (cap.data ?? []).length === 0, JSON.stringify(cap.data ?? [])]);
const mem = await anon.from("memories").select("id").limit(5);
checks.push(["anon cannot read memories (0 rows)", (mem.data ?? []).length === 0, JSON.stringify(mem.data ?? [])]);

const html = await (await fetch(APP + "/login")).text();
const chunkUrls = [...new Set([...html.matchAll(/\/_next\/static\/[^"'\s]+\.js/g)].map((m) => m[0]))];
let scanned = 0;
const hits = [];
const patterns = [
  "service_role",
  "sk-or-",
  "gsk_",
  "sb_secret",
  "SUPABASE_SERVICE_ROLE",
  "INNGEST_SIGNING_KEY",
  "INNGEST_EVENT_KEY",
  "signkey-",
];
for (const c of chunkUrls.slice(0, 30)) {
  const js = await (await fetch(APP + c)).text();
  scanned += 1;
  for (const p of patterns) if (js.includes(p)) hits.push(`${c} :: ${p}`);
}
checks.push([`client bundles clean (${scanned} scanned)`, hits.length === 0, hits.join(" | ") || "no secret patterns"]);

const serve = await fetch(APP + "/api/inngest");
checks.push(["unsigned /api/inngest rejected (401)", serve.status === 401, `status ${serve.status}`]);

for (const [name, pass, extra] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} — ${name} | ${extra}`);
}
process.exit(checks.every((c) => c[1]) ? 0 : 9);
