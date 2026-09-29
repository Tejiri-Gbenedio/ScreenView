import { Inngest } from "inngest";

/**
 * Inngest client. Keys are read from the environment by the SDK
 * (INNGEST_EVENT_KEY for sending, INNGEST_SIGNING_KEY for serving).
 * Local development works with the Inngest dev server — no keys needed.
 */
export const inngest = new Inngest({ id: "screenview" });
