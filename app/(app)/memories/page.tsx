import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signedUrlMap } from "@/server/services/storage";
import { MemoriesClient, type ListItem } from "@/components/memories/MemoriesClient";

export const dynamic = "force-dynamic";

export default async function MemoriesPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: captures } = await supabase
    .from("captures")
    .select("id, processing_status, original_note, storage_path, created_at, last_error")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(60);

  const captureIds = (captures ?? []).map((c) => c.id);
  const { data: memories } = captureIds.length
    ? await supabase
        .from("memories")
        .select("id, capture_id, title, topic, current_intent, status")
        .in("capture_id", captureIds)
    : { data: [] as never[] };

  const memoryByCapture = new Map((memories ?? []).map((m) => [m.capture_id as string, m]));
  const urls = await signedUrlMap((captures ?? []).map((c) => c.storage_path), 3600);

  const items: ListItem[] = (captures ?? []).map((c) => {
    const memory = memoryByCapture.get(c.id);
    return {
      captureId: c.id,
      memoryId: memory?.id ?? null,
      signedUrl: urls[c.storage_path] ?? null,
      note: c.original_note,
      status: c.processing_status,
      memoryStatus: memory?.status ?? null,
      title: memory?.title ?? null,
      topic: memory?.topic ?? null,
      intent: memory?.current_intent ?? null,
      createdAt: c.created_at,
      lastError: c.last_error,
    };
  });

  return <MemoriesClient items={items} />;
}
