// Verify the delete flow against production: create a real capture → confirm the
// Delete control renders → delete via API → verify cascade (memory/embedding/storage)
// and that another user can never delete it.
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = "https://screenview-two.vercel.app";
const USER_A = "tejirigbe+screenview-m1@gmail.com";
const USER_B = "tejirigbe+screenview-m2b@gmail.com";

const admin = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });
const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const sha256Bytes = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function ensureUser(email) {
  const password = crypto.randomBytes(24).toString("base64url");
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
  let user = (data?.users ?? []).find((u) => u.email === email);
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

async function call(cookie, path, body, method = "POST") {
  const res = await fetch(APP + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let failures = 0;
const check = (name, pass, detail = "") => {
  log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? " | " + detail : ""}`);
  if (!pass) failures += 1;
};

const a = await ensureUser(USER_A);
const b = await ensureUser(USER_B);
const cookieA = await sessionCookie(USER_A, a.password);
const cookieB = await sessionCookie(USER_B, b.password);

// 1) create a real capture through the pipeline
const init = await call(cookieA, "/api/captures", {
  file_name: "delete-verify.png",
  mime_type: "image/png",
  size: PNG.length,
  note: "DELETE ME — delete-flow verification",
});
if (init.status !== 201) throw new Error("init failed: " + JSON.stringify(init.json));
const { capture_id, path: storagePath, upload } = init.json;
await anon.storage.from("captures").uploadToSignedUrl(storagePath, upload.token, PNG, { contentType: "image/png" });
await call(cookieA, `/api/captures/${capture_id}/complete`, { file_hash: sha256Bytes(PNG) });

let status = null;
const started = Date.now();
while (Date.now() - started < 240000) {
  const { data } = await admin.from("captures").select("processing_status").eq("id", capture_id).single();
  status = data?.processing_status;
  if (status === "completed" || status === "failed") break;
  await sleep(4000);
}
check("capture processed", status === "completed", `status=${status}`);

// 2) the Delete button renders on the memory page
const detail = await fetch(APP + `/memories/${capture_id}`, { headers: { Cookie: cookieA } });
const detailHtml = await detail.text();
check("detail page shows 'Delete this screenshot'", detail.status === 200 && detailHtml.includes("Delete this screenshot"));

// 3) pre-delete state exists
const { data: memory } = await admin.from("memories").select("id").eq("capture_id", capture_id).maybeSingle();
check("memory exists before delete", Boolean(memory?.id));
const folder = storagePath.slice(0, storagePath.lastIndexOf("/"));
const name = storagePath.slice(storagePath.lastIndexOf("/") + 1);
const { data: objs } = await admin.storage.from("captures").list(folder, { search: name, limit: 3 });
check("storage object exists before delete", (objs ?? []).some((o) => o.name === name));

// 4) another user cannot delete it
const asB = await fetch(APP + `/api/captures/${capture_id}`, { method: "DELETE", headers: { Cookie: cookieB } });
const asBJson = await asB.json().catch(() => null);
const { count: stillThere } = await admin
  .from("captures")
  .select("id", { count: "exact", head: true })
  .eq("id", capture_id);
check("RLS: user B cannot delete A's capture", asBJson?.deleted === false && stillThere === 1);

// 5) delete as the owner
const del = await fetch(APP + `/api/captures/${capture_id}`, { method: "DELETE", headers: { Cookie: cookieA } });
const delJson = await del.json().catch(() => null);
check("delete succeeds", del.status === 200 && delJson?.deleted === true);

// 6) cascade + storage cleanup
await sleep(1500);
const { count: capsLeft } = await admin.from("captures").select("id", { count: "exact", head: true }).eq("id", capture_id);
const { count: memsLeft } = await admin.from("memories").select("id", { count: "exact", head: true }).eq("capture_id", capture_id);
const { data: objsAfter } = await admin.storage.from("captures").list(folder, { search: name, limit: 3 });
check("capture row removed", (capsLeft ?? 0) === 0);
check("memory cascade removed", (memsLeft ?? 0) === 0);
check("storage object removed", !(objsAfter ?? []).some((o) => o.name === name));
if (memory?.id) {
  const { count: embLeft } = await admin
    .from("memory_embeddings")
    .select("id", { count: "exact", head: true })
    .eq("memory_id", memory.id);
  check("embedding cascade removed", (embLeft ?? 0) === 0);
}
const gone = await fetch(APP + `/memories/${capture_id}`, { headers: { Cookie: cookieA } });
check("memory page now 404", gone.status === 404, `status=${gone.status}`);

log(failures === 0 ? "ALL DELETE-FLOW CHECKS PASSED" : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 9);
