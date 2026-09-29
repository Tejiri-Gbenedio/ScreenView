export default function MemoriesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Memories</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Screenshot something you don&apos;t want to forget.
        </p>
      </div>
      <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
        <p className="text-sm text-neutral-500">Nothing saved yet.</p>
      </div>
    </div>
  );
}
