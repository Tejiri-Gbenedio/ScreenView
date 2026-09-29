import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { processCapture } from "@/inngest/functions/process-capture";
import { paSchedule, paGenerate } from "@/inngest/functions/pa-report";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processCapture, paSchedule, paGenerate],
});
