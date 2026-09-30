import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteCapture } from "@/server/services/captures";

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const result = await deleteCapture(user.id, params.id);
    return NextResponse.json(result);
  } catch (error) {
    console.error("delete failed:", (error as Error).message);
    return NextResponse.json(
      { error: "delete_failed", message: "Couldn't delete this item. Please try again." },
      { status: 400 }
    );
  }
}
