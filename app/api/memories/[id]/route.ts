import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CorrectionSchema } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await request.json().catch(() => null);
  const parsed = CorrectionSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.rpc("apply_correction", {
    p_memory_id: params.id,
    p_field: parsed.data.field,
    p_value: parsed.data.value,
    p_reason: parsed.data.reason ?? null,
  });

  if (error) {
    return NextResponse.json({ error: "correction_failed", message: error.message }, { status: 400 });
  }
  return NextResponse.json({ memory: data });
}
