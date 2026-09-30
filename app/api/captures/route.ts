import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createCapture, countRecentCaptures } from "@/server/services/captures";
import { DAILY_CAPTURE_CAP, InitCaptureSchema } from "@/lib/validation";

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await request.json().catch(() => null);
  const parsed = InitCaptureSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const recent = await countRecentCaptures(user.id);
  if (recent >= DAILY_CAPTURE_CAP) {
    return NextResponse.json(
      { error: "daily_cap_reached", message: "Daily capture limit reached. Try again tomorrow." },
      { status: 429 }
    );
  }

  try {
    const result = await createCapture(user.id, parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("capture failed:", (error as Error).message);
    return NextResponse.json(
      { error: "capture_failed", message: "Couldn't start the upload. Please try again." },
      { status: 500 }
    );
  }
}
