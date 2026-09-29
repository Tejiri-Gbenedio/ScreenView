import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

async function sendMagicLink(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    redirect("/login?error=email");
  }

  const supabase = createClient();
  const origin =
    headers().get("origin") ?? process.env.APP_URL ?? "http://localhost:3000";

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });

  redirect(error ? "/login?error=send" : "/login?sent=1");
}

export default function LoginPage({
  searchParams,
}: {
  searchParams: { sent?: string; error?: string };
}) {
  const sent = searchParams.sent === "1";
  const error = searchParams.error;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">ScreenView</h1>
          <p className="mt-2 text-sm text-neutral-500">
            Dump screenshots. ScreenView remembers why.
          </p>
        </div>

        {sent ? (
          <div className="mt-8 rounded-2xl border border-neutral-200 bg-white p-6 text-center">
            <p className="text-sm font-medium">Check your email</p>
            <p className="mt-1 text-sm text-neutral-500">
              A sign-in link is on its way.
            </p>
          </div>
        ) : (
          <form action={sendMagicLink} className="mt-8 space-y-3">
            <input
              type="email"
              name="email"
              required
              placeholder="you@example.com"
              className="w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm outline-none focus:border-neutral-900"
            />
            <button
              type="submit"
              className="w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white hover:bg-neutral-700"
            >
              Send magic link
            </button>
            {error ? (
              <p className="text-center text-xs text-red-600">
                {error === "email"
                  ? "That email doesn't look right — try again."
                  : "Couldn't send the link. Try again in a moment."}
              </p>
            ) : null}
          </form>
        )}
      </div>
    </main>
  );
}
