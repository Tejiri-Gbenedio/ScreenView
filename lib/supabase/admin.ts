import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client — SERVER ONLY (jobs, privileged operations).
 * Never import this file from client components.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}
