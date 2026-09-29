import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { applyPaInteraction } from "@/server/services/pa";

const ACTIONS = ["open", "keep_active", "snooze", "complete", "dismiss"];

/** M4: record a PA item interaction and apply its side effects (user-scoped). */
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await request.json().catch(() => ({}));
  const reportId = json?.reportId;
  const itemId = json?.itemId;
  const action = json?.action;
  if (
    typeof reportId !== "string" ||
    typeof itemId !== "string" ||
    typeof action !== "string" ||
    !ACTIONS.includes(action)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await applyPaInteraction({ reportId, itemId, action });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.reason },
        { status: result.reason === "not_found" ? 404 : 400 }
      );
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
