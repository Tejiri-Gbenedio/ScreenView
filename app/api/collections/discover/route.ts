import { NextResponse } from "next/server";
import { runDiscovery } from "@/server/services/collections";

/** M3: run deterministic collection discovery for the session user. */
export async function POST() {
  try {
    const result = await runDiscovery();
    if (result.skipped === "unauthorized") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
