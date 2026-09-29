import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { actOnConnection } from "@/server/services/connections";

/** M3 connection decision: POST { action: "confirm" | "dismiss" } */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await request.json().catch(() => null);
  const action = json?.action;
  if (action !== "confirm" && action !== "dismiss") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await actOnConnection(params.id, action);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.reason },
        { status: result.reason === "not_found" ? 404 : 400 }
      );
    }
    return NextResponse.json({ ok: true, state: result.state });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
