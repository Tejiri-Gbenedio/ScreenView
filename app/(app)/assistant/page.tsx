import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PaActions } from "@/components/pa/PaActions";
import { relativeTime } from "@/lib/labels";

export const dynamic = "force-dynamic";

const SECTION_TITLES: Record<string, string> = {
  needs_attention: "Needs Attention",
  emerging: "Emerging",
  everything_else: "Everything Else",
};

function provenanceLabel(item: any): string {
  if (item.kind === "recall" && item.claim_type === "fact") return "You saved";
  if (item.claim_type === "fact") return "You said";
  return "ScreenView noticed";
}

export default async function AssistantPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: reports } = await supabase
    .from("pa_reports")
    .select("id, generated_at, is_empty, content, seen_at")
    .eq("user_id", user.id)
    .order("generated_at", { ascending: false })
    .limit(1);
  const report = reports?.[0] ?? null;

  if (report && !report.seen_at) {
    await supabase
      .from("pa_reports")
      .update({ seen_at: new Date().toISOString() })
      .eq("id", report.id);
  }

  const items = ((report?.content as any)?.items ?? []) as any[];
  const sections = ((report?.content as any)?.sections ?? []) as any[];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Assistant</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {report
            ? `ScreenView checked in ${relativeTime(report.generated_at)}.`
            : "ScreenView checks in on Monday and Thursday evenings."}
        </p>
      </div>

      {!report || report.is_empty ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <p className="text-sm text-neutral-500">Nothing needs your attention right now.</p>
          <p className="mt-1 text-xs text-neutral-400">
            ScreenView keeps looking quietly in the background.
          </p>
        </div>
      ) : (
        sections.map((section: any) => (
          <section key={section.key} className="space-y-3">
            <p className="text-[11px] uppercase tracking-wide text-neutral-400">
              {SECTION_TITLES[section.key] ?? section.key}
            </p>
            <ul className="space-y-3">
              {(section.item_ids ?? []).map((itemId: string) => {
                const item = items.find((i: any) => i?.id === itemId);
                return item ? <PaItemCard key={itemId} item={item} reportId={report.id} /> : null;
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function PaItemCard({ item, reportId }: { item: any; reportId: string }) {
  return (
    <li className="rounded-2xl border border-neutral-200 bg-white p-4">
      <p className="text-[11px] uppercase tracking-wide text-neutral-400">
        {provenanceLabel(item)}
      </p>
      <p className="mt-1 text-sm">{item.wording}</p>
      {Array.isArray(item.evidence) && item.evidence.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.evidence.slice(0, 4).map((e: any) => (
            <span
              key={e.memory_id}
              className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-[11px] text-neutral-600"
            >
              {e.title}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-3">
        <PaActions
          reportId={reportId}
          itemId={item.id}
          actions={item.actions ?? []}
          interaction={item.interaction ?? null}
          captureId={item.meta?.capture_id ?? null}
          collectionId={item.meta?.collection_id ?? null}
        />
      </div>
    </li>
  );
}
