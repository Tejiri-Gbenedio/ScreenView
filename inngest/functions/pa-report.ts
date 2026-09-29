import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { generatePaReportForUser } from "@/server/services/pa";

/**
 * M4 Personal Assistant schedule: Monday + Thursday, 18:00 West Africa Time.
 * The fan-out uses deterministic event ids, so a slot can never double-run.
 */
export const paSchedule = inngest.createFunction(
  { id: "pa-schedule", name: "PA schedule (Mon/Thu 18:00 WAT)", retries: 1, concurrency: { limit: 1 } },
  { cron: "TZ=Africa/Lagos 0 18 * * 1,4" },
  async ({ step }: { step: any }) => {
    const users: string[] = await step.run("list-users", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("memories").select("user_id").limit(1000);
      return Array.from(new Set((data ?? []).map((row: any) => String(row.user_id))));
    });
    if (users.length === 0) return { users: 0, sent: 0 };

    const dateKey = new Date().toISOString().slice(0, 10);
    const events = users.map((userId) => ({
      id: `pa-${userId}-${dateKey}`,
      name: "pa/generate",
      data: { userId },
    }));
    await step.sendEvent("fan-out", events);
    return { users: users.length, sent: events.length };
  }
);

/** Per-user report generation: deterministic first, at most one wording call. */
export const paGenerate = inngest.createFunction(
  {
    id: "pa-generate",
    name: "PA generate report",
    retries: 1,
    concurrency: { limit: 1, key: "event.data.userId" },
  },
  { event: "pa/generate" },
  async ({ event, step }: { event: any; step: any }) => {
    const userId = String(event?.data?.userId ?? "");
    if (!userId) return { skipped: "no-user" };
    return await step.run("generate", async () => generatePaReportForUser(userId));
  }
);
