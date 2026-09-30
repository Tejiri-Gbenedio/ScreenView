import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { completeCapture } from "@/server/services/captures";
import { CompleteCaptureSchema } from "@/lib/validation";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await request.json().catch(() => null);
  const parsed = CompleteCaptureSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await completeCapture(user.id, params.id, parsed.data.file_hash.toLowerCase());
    return NextResponse.json(result);
  } catch (error) {
    console.error("complete failed:", (error as Error).message);
    return NextResponse.json(
      { error: "complete_failed", message: "Couldn't finish the upload. Please try again." },
      { status: 400 }
    );
  }
}
