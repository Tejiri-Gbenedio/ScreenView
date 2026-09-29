import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <span className="text-sm font-semibold tracking-tight">ScreenView</span>
            <nav className="flex items-center gap-3 text-xs text-neutral-500">
              <Link href="/memories" className="hover:text-neutral-900">
                Memories
              </Link>
              <Link href="/collections" className="hover:text-neutral-900">
                Collections
              </Link>
            </nav>
          </div>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="text-xs text-neutral-500 hover:text-neutral-800"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6">{children}</main>
    </div>
  );
}
