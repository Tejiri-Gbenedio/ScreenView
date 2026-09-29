// ScreenView — signed-upload E2E check (the exact browser upload path).
// Server issues a signed URL (as our API does) → ANON client uploads with the token
// (as the browser does) → object verified → public access must be denied (private bucket).
// Run: node --env-file=.env.local scripts/e2e-signed-upload.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function main() {
  const { data: userList } = await admin.auth.admin.listUsers();
  const userId = userList.users[0].id;
  const path = `${userId}/e2e-signed-upload-${Date.now()}.png`;

  // 1) signed upload URL (server-side, as our API does)
  const { data: signed, error: signedError } = await admin.storage
    .from("captures")
    .createSignedUploadUrl(path);
  if (signedError) throw signedError;
  console.log("1. signed url issued for:", path);

  // 2) upload with the ANON client + token (browser path)
  const { error: uploadError } = await anon.storage
    .from("captures")
    .uploadToSignedUrl(path, signed.token, PNG, { contentType: "image/png" });
  if (uploadError) throw uploadError;
  console.log("2. uploadToSignedUrl succeeded (anon client)");

  // 3) verify the object exists
  const folder = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const { data: list } = await admin.storage.from("captures").list(folder, { search: name, limit: 3 });
  const found = (list ?? []).some((entry) => entry.name === name);
  console.log("3. object exists:", found);

  // 4) public URL must be denied (private bucket)
  const publicRes = await fetch(`${url}/storage/v1/object/public/captures/${path}`);
  console.log("4. public access status (expect 400):", publicRes.status);

  // 5) cleanup
  await admin.storage.from("captures").remove([path]);
  console.log("5. cleanup done");
  process.exit(found && publicRes.status >= 400 ? 0 : 1);
}

main().catch((error) => {
  console.error("signed-upload check failed:", error.message ?? error);
  process.exit(9);
});
