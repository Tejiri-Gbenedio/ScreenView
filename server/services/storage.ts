import { createAdminClient } from "@/lib/supabase/admin";

/** Supabase Storage helpers for the private `captures` bucket (service-side). */

export const CAPTURES_BUCKET = "captures";

export async function createSignedUploadUrl(path: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(CAPTURES_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(`signed upload url failed: ${error?.message ?? "unknown"}`);
  return data; // { signedUrl, token, path }
}

export async function objectExists(path: string): Promise<{ exists: boolean; size?: number }> {
  const admin = createAdminClient();
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const { data, error } = await admin.storage.from(CAPTURES_BUCKET).list(folder, {
    search: name,
    limit: 5,
  });
  if (error || !data) return { exists: false };
  const hit = data.find((entry) => entry.name === name);
  if (!hit) return { exists: false };
  const rawSize = (hit.metadata as Record<string, unknown> | null)?.size;
  return { exists: true, size: typeof rawSize === "number" ? rawSize : undefined };
}

export async function downloadObject(path: string): Promise<{ buffer: Buffer; contentType: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(CAPTURES_BUCKET).download(path);
  if (error || !data) throw new Error(`download failed: ${error?.message ?? "unknown"}`);
  const ab = await data.arrayBuffer();
  return { buffer: Buffer.from(ab), contentType: data.type || "image/png" };
}

export async function removeObject(path: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(CAPTURES_BUCKET).remove([path]);
  if (error) throw new Error(`remove failed: ${error.message}`);
}

export async function signedUrlMap(
  paths: string[],
  expiresIn = 3600
): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(CAPTURES_BUCKET).createSignedUrls(paths, expiresIn);
  const map: Record<string, string> = {};
  if (error || !data) return map;
  for (const item of data) {
    if (item.path && item.signedUrl) map[item.path] = item.signedUrl;
  }
  return map;
}
