// ScreenView — production security spot-check: anon RLS across every user-owned table,
// client bundle scan, serve auth, and repo secret scan inputs.
// Run: node --env-file=.env.local scripts/prod-security-check.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP = "https://screenview-two.vercel.app";

const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const checks = [];

const USER_TABLES = [
  "captures",
  "memories",
  "memory_events",
  "connections",
  "collections",
  "collection_members",
  "memory_embeddings",
  "pa_reports",
  "learned_patterns",
];

for (const table of USER_TABLES) {
  const { data, error } = await anon.from(table).select("id").limit(5);
  checks.push([
    `anon cannot read ${table} (0 rows)`,
    (data ?? []).length === 0,
    error ? `error: ${error.message.slice(0, 40)}` : "[]",
  ]);
}

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
];
for (const c of chunkUrls.slice(0, 30)) {
  const js = await (await fetch(APP + c)).text();
  scanned += 1;
  for (const p of patterns) if (js.includes(p)) hits.push(`${c} :: ${p}`);
}
checks.push([`client bundles clean (${scanned} scanned)`, hits.length === 0, hits.join(" | ") || "no secret patterns"]);

const serve = await fetch(APP + "/api/inngest");
checks.push(["unsigned /api/inngest rejected (401)", serve.status === 401, `status ${serve.status}`]);

const protectedRoutes = [
  ["/api/search", "POST", { query: "x" }],
  ["/api/pa/items", "POST", { reportId: "x", itemId: "y", action: "open" }],
  ["/api/collections/discover", "POST", {}],
];
for (const [p, method, body] of protectedRoutes) {
  const res = await fetch(APP + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  checks.push([`anon ${method} ${p} → 401/404/400 (no data)`, [401, 404, 400].includes(res.status), `status ${res.status}`]);
}

for (const [name, pass, extra] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} — ${name} | ${extra}`);
}
process.exit(checks.every((c) => c[1]) ? 0 : 9);
