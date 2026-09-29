import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { actOnCollection } from "@/server/services/collections";

const ACTIONS = ["accept", "dismiss", "archive", "rename"] as const;

/** M3 collection lifecycle: POST { action, name? } */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await request.json().catch(() => ({}));
  const action = json?.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await actOnCollection(params.id, action as (typeof ACTIONS)[number], {
      name: typeof json?.name === "string" ? json.name : undefined,
    });
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
