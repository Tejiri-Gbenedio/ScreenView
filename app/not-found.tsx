import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center">
        <p className="text-sm text-neutral-600">This page doesn&apos;t exist (or was deleted).</p>
        <Link
          href="/memories"
          className="mt-4 inline-block rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Back to Memories
        </Link>
      </div>
    </div>
  );
}
