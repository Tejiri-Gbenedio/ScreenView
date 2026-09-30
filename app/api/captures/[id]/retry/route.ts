import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { retryCapture } from "@/server/services/captures";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const result = await retryCapture(user.id, params.id);
    return NextResponse.json(result);
  } catch (error) {
    console.error("retry failed:", (error as Error).message);
    return NextResponse.json(
      { error: "retry_failed", message: "Couldn't restart processing. Please try again." },
      { status: 400 }
    );
  }
}
