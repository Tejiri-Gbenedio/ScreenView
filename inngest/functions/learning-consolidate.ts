import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { consolidateLearning } from "@/server/services/learning";

/**
 * M5 learning consolidation — one lightweight daily run (Phase 6 §23):
 * recompute decayed confidences, promote tentative/established patterns,
 * expire weak ones, apply suppression expiries. Deterministic only.
 */
export const learningSchedule = inngest.createFunction(
  { id: "learning-schedule", name: "Learning schedule (daily 03:00 WAT)", retries: 1, concurrency: { limit: 1 } },
  { cron: "TZ=Africa/Lagos 0 3 * * *" },
  async ({ step }: { step: any }) => {
    const users: string[] = await step.run("list-users", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("memories").select("user_id").limit(1000);
      return Array.from(new Set((data ?? []).map((row: any) => String(row.user_id))));
    });
    if (users.length === 0) return { users: 0, sent: 0 };

    const dateKey = new Date().toISOString().slice(0, 10);
    const events = users.map((userId) => ({
      id: `learning-${userId}-${dateKey}`,
      name: "learning/consolidate",
      data: { userId },
    }));
    await step.sendEvent("fan-out", events);
    return { users: users.length, sent: events.length };
  }
);

export const learningConsolidate = inngest.createFunction(
  {
    id: "learning-consolidate",
    name: "Learning consolidate",
    retries: 1,
    concurrency: { limit: 1, key: "event.data.userId" },
  },
  { event: "learning/consolidate" },
  async ({ event, step }: { event: any; step: any }) => {
    const userId = String(event?.data?.userId ?? "");
    if (!userId) return { skipped: "no-user" };
    return await step.run("consolidate", async () => consolidateLearning(userId));
  }
);
