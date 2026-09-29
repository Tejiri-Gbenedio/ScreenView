# ScreenView — Project Plan

_Last updated: 2026-09-29_

This document is the single source of truth for **what we are building, how we work, and where we are**. Detailed phase output lives in [`docs/`](./docs/).

## What ScreenView is

A personal-first AI second brain built around screenshots. The user dumps screenshots (+ optional notes); the AI understands, organizes, connects, and remembers them. Mental model: **Capture → Memory → Connection → Collection → Action**.

## Working rules

1. We build in phases, in order — **do not skip phases**.
2. No implementation until the relevant architecture is locked.
3. Each phase produces documentation in `docs/` and a git commit.
4. Personal-first: V1 is built for one real user; no premature enterprise design.
5. ScreenView is a real software application — **no n8n / Zapier / Make / workflow automation platforms** in the architecture.

## Phase roadmap

| Phase | Name | Status |
|---|---|---|
| 0 | Project Setup | Complete |
| 1 | Product Definition | Complete |
| 2 | Data & Memory Architecture | Complete |
| 3 | AI Architecture | Complete |
| 4 | Application & Processing Architecture | Complete |
| 5 | Personal Assistant / PA Architecture | Complete |
| 6 | Personal Learning | Complete |
| 7 | Interface & UX | Complete |
| 8 | Build Plan & V1 Implementation | Complete |
| 9 | Actual Implementation | Pending |

## Phase 1 — Product Definition

Status: **Complete.** Output: [`docs/phase-1-product-definition.md`](./docs/phase-1-product-definition.md).

**Decisions locked in Phase 1:**

- ScreenView is a personal-first screenshot second brain for a single user (the creator) in V1.
- Capture: screenshot + optional note → upload → done. Zero required metadata at capture time.
- Screenshot = *what*; note = *why*. Explicit user statements always outrank AI inference.
- Topic ("what is this about?") and intent ("why did I save this?") are separate concepts.
- Intent resolves through an explicit hierarchy: explicit statement > strong contextual statement > existing user behavior/pattern > visual inference > general AI inference. **"Unknown" is a valid answer** — intent is never invented.
- Intent history is preserved: intent can change without destroying what it was before.
- Collections are dynamic and AI-assisted, not folders; a capture can belong to multiple collections.
- Collections/projects are only *suggested* once enough evidence exists — never declared from a single capture.
- AI suggestions are always distinguishable from user intention; inferences never silently become user facts.
- The PA stays quiet at capture time; it reports **weekly / twice-weekly** with the structure: Immediate / Needs Attention → Emerging → Everything Else.
- Draft minimal taxonomies: actions (Buy, Research, Try, Build, Read, Watch, Save for later, Compare, Contact, …); status (New, Active, Completed, Dismissed, Archived).
- Non-goals documented: not a file manager, not a note-taking app, not a chatbot, not an enterprise knowledge-management system, not a workflow automation platform.

## Phase 2 — Data & Memory Architecture

Status: **Complete.** Output: [`docs/phase-2-data-memory-architecture.md`](./docs/phase-2-data-memory-architecture.md).

**Decisions locked in Phase 2:**

- **Greenfield confirmed:** no existing schema, SQL, migrations, or Supabase configuration anywhere in the repo — nothing was discarded, migrated, or externally touched.
- **7-table model:** `captures` (immutable originals) · `memories` (current understanding; 1:1 with capture in V1) · `memory_events` (append-only intent/status/action/topic history with provenance) · `connections` (meaningful memory↔memory relations with suggestion states) · `collections` + `collection_members` (dynamic many-to-many groups with suggestion states) · `memory_embeddings` (model-versioned vectors).
- **Capture ≠ Memory:** the original note is verbatim and never overwritten by AI interpretation.
- **Intent history** is append-only and fully reconstructable; current values are denormalized onto the memory; `unknown` is first-class; nothing historical is destroyed.
- **Suggestions vs facts:** AI-proposed connections/collections/memberships carry state + evidence (`basis`); dismissals are kept as learning signals, never hard-deleted.
- **Small evolvable vocabularies** (intent / action / status / relationship types) as text `CHECK` constraints — no giant enums.
- **Embeddings:** separate table keyed by `(memory, model)` with a canonical-input hash; the embedding represents the memory semantically (not raw OCR); model + dimensions deferred to Phase 3; pgvector HNSW/cosine planned.
- **Duplicates:** exact-duplicate signal via indexed per-user `file_hash` (duplicates allowed; policy deferred); near-duplicate → future pHash; same-subject → `same_subject` connections.
- **Privacy baseline:** `user_id` on every table, RLS documented (not applied), private storage bucket + signed URLs, AI keys server-side only.
- **Nothing executed:** reference DDL only — no Supabase changes, no migrations; implementation via forward-only migrations in the build phase.

## Phase 3 — AI Architecture

Status: **Complete.** Output: [`docs/phase-3-ai-architecture.md`](./docs/phase-3-ai-architecture.md).

**Locked AI architecture (verified against provider docs on 2026-09-28):**

- **Eyes:** Groq `qwen/qwen3.8-27b` (vision, JSON mode, preview status — guarded by a tested fallback). **Brain:** Groq `openai/gpt-oss-120b` with **strict structured outputs** (constrained decoding — verified limited to GPT-OSS models). **Signature:** NVIDIA `llama-nemotron-embed-vl-1b-v2` — multimodal, **2048-dim** (Groq hosts no embeddings; NVIDIA hosted API + self-host option).
- **2 LLM calls + 2 embedding calls per capture** (vision → query embedding → retrieval → reasoning → persist → document embedding); collections/cross-memory reasoning only in periodic jobs. ≈ $0.006/capture.
- Perception ≠ interpretation; the note is a first-class verbatim input; strict FACT-vs-SUGGESTION split enforced by the writer, not the model.
- **Intent ≠ action:** separate vocabularies locked (action CHECK refined; documented schema change, not executed).
- **Retrieval ≠ connections:** cosine similarity proposes candidates; only reasoned judgment with cited basis creates `suggested` connections. No generic `similar` type.
- Collections emerge from ≥3 memories + ≥2 signal types; one reasoning call per discovery run; never per-capture.
- Failure invariant: originals persist before any AI call; every AI artifact is re-creatable; embedding failure degrades gracefully (SQL-searchable + backfill).
- Fallbacks: vision → OpenRouter `qwen/qwen3-vl-8b-instruct` (needed); reasoning → `gpt-oss-20b` (auto) / OpenRouter (off by default). No V1 embedding fallback (graceful degradation instead — vector spaces aren't cross-model comparable).
- Privacy: Groq no-retention-by-default + self-serve ZDR (enable at impl); reasoning model never receives the raw image; OpenRouter off by default pending policy verification.
- Model IDs are config, not code (Groq's vision slot churned 4× in 18 months — verified).

## Phase 4 — Application & Processing Architecture

Status: **Complete.** Output: [`docs/phase-4-application-processing-architecture.md`](./docs/phase-4-application-processing-architecture.md).

**Locked application & processing architecture (verified against platform docs on 2026-09-29):**

- **Runtime split:** Next.js (App Router) on Vercel; the browser uploads + displays state only; all AI calls run server-side in durable job steps — keys never reach the client.
- **Uploads:** direct browser → Supabase Storage via short-lived signed upload URLs (Vercel's 4.5MB body limit rules out server-proxied files); private bucket, `{user_id}/{capture_id}.{ext}` paths; ≤20MB; PNG/JPEG/WebP.
- **Jobs:** **Inngest** selected (durable per-step retries, concurrency caps, cron, debounce; 50k executions/mo free) over Vercel Workflows (new; limits unverified), Trigger.dev (separate deploy surface), and Supabase-native queues/cron (heavy DIY). Job layer encapsulated — swappable.
- **State machine:** `upload_pending → uploaded → processing → (retrying) → completed | failed`; DB-checkpointed steps make every stage resumable and idempotent; originals persist before any AI call.
- **Batches:** one lifecycle per capture; concurrency cap 4 drains 1–100 uploads; batch-level connection sweep + collection discovery run as scheduled jobs, never per-capture.
- **Sync vs async:** only URL issuance, byte upload and completion ack are synchronous; vision/reasoning/embeddings/sweeps/PA are all async.
- **Status updates:** polling (~3s, terminal-stop) — Realtime deferred; no SSE/WebSockets.
- **Security:** Supabase Auth sessions; RLS + private storage policies; service-role & provider keys server-only; validation + rate-limit concepts; cost guards (20MB files, 200 captures/day cap, retry caps, kill switch).
- **No new tables** for jobs (captures operational columns + Inngest state); refinements documented: status CHECK extension, `attempt_count`/`last_error`/`last_attempt_at`, `memories.perception jsonb`, action vocab — none executed.
- **PA runs as a scheduled job** (Mon & Thu); its report storage is flagged as the one genuinely necessary new table, finalized in Phase 5.

## Phase 5 — Personal Assistant / PA Architecture

Status: **Complete.** Output: [`docs/phase-5-personal-assistant-architecture.md`](./docs/phase-5-personal-assistant-architecture.md).

**Locked PA architecture:**

- **Purpose:** the PA remembers what was saved and why — a quiet scheduled layer; not a dashboard, task manager, or chat.
- **V1 capabilities (4):** aged unresolved-intent reminders · emerging patterns (incl. repeated interests) · strict project candidates · proactive recall (incl. saved-for-later). All other proposed functions evaluated and excluded.
- **Cadence retained:** Mon & Thu 18:00 WAT with an emptiness gate — no useful items → quiet period, no manufactured insights, no notifications.
- **Deterministic-first:** candidates, eligibility, cooldowns, caps and validation via SQL; exactly ≤1 GPT-OSS call per run to word the selected evidence (never the full DB, never raw images).
- **Trust:** fact / inference / suggestion as distinct claim types in wording + metadata; every item grounded in memory ids; quotes verbatim; PA writes only reports — all state changes via user actions.
- **Quietness:** ≤5 items/report, section caps, one reminder per memory per cooldown (21d, escalating on ignore), 90-day cooldowns for patterns/recall, suppression instead of nagging.
- **Reminders:** min ages by intent (14–30d), snooze/complete/dismiss/keep-active actions; reminders expire by suppression; memories never auto-changed.
- **Projects = collections with `kind='project'`** (stricter evidence: ≥4 memories + build signals + time spread); never forced, no project-management features.
- **Storage:** one new table (`pa_reports`) + `memories.pa_state` + `collections.kind` — documented, not executed.
- **Delivery:** in-app only (no email/push in V1); future conversational PA boundary defined (grounded Q&A, not built).

## Phase 6 — Personal Learning Architecture

Status: **Complete.** Output: [`docs/phase-6-personal-learning-architecture.md`](./docs/phase-6-personal-learning-architecture.md).

**Locked learning architecture:**

- **Definition:** five distinct categories — static facts · explicit preferences · inferred patterns · temporary behavior · AI inference; AI inference is never evidence and never silently becomes a preference.
- **Signals:** full taxonomy with per-signal teaching scope, strength (explicit > confirmed > passive), influence duration and evidence bars — defaults tunable.
- **Correction loop:** cases → classes → tentative → established; single corrections never become rules; ≥3 similar across ≥2 distinct captures/days to begin influencing.
- **Confidence & decay:** weighted evidence + diversity requirements; half-life decay by scope; expiry below floor; reinforcement/reactivation; explicit statements supersede, never silently.
- **Loop safeguards:** AI-origin weight 0 · exposure ≠ evidence · accepted suggestions discounted (×0.4) · diversity required · suppressions decay.
- **Injection point:** only at GPT-OSS reasoning — a ≤5–6-line personal-context bundle (labeled [explicit]/[learned]); vision, embeddings and retrieval stay objective.
- **Suppressions:** connection types, collection signatures and PA kinds are scoped, decaying, and never permanent (except stored per-pair facts and user statements).
- **Schema:** one new table (`learned_patterns`) + documented conventions — nothing else; nothing executed.
- **Jobs:** synchronous deterministic ingest + one daily consolidation step (no new infrastructure).
- **User control & explainability:** every pattern retains evidence refs; inspect/correct/reject/reset/opt-out paths are architecturally ready (UI later).

## Phase 7 — Interface & UX Architecture

Status: **Complete.** Output: [`docs/phase-7-interface-ux-architecture.md`](./docs/phase-7-interface-ux-architecture.md).

**Locked UX architecture:**

- **Navigation:** 3 areas (Memories · Collections · Assistant) + one Capture action; Settings via avatar. Search is a mode of Memories — no separate destination.
- **Capture:** frictionless everywhere — drag-drop/paste/picker (desktop), camera/library + bottom sheet (mobile); optional note; one Save; in-place states (Uploading → Understanding… → Ready / Retry).
- **Memory card/detail:** three-tier card (thumbnail + title + intent chip; richer info on space); detail separates **You said** from **ScreenView thinks**, with context + history sections.
- **Corrections:** one-tap pickers (intent/topic/action/status), inline title/summary edits, note edits (R1); no schema knowledge required; natural-language correction deferred.
- **Collections/connections:** suggestions stay labeled; no graph visualization in V1; multiple membership via chips; projects badged.
- **Search/recall:** NL semantic search + filter chips; works without exact words; calm empty/error states.
- **PA surface:** latest report (Needs Attention / Emerging / Everything Else), ≤5 items, claim labels + evidence chips, 1-tap actions; quiet periods show a calm line; unseen dot only; in-app only.
- **States everywhere:** empty states teach; failures reassure (“Your screenshot and note are safe”) with one-tap retry; nothing technical ever exposed.
- **Journeys A–J + 8-screen inventory** documented; onboarding = one skippable screen; first-session value demonstrated in under two minutes.
- **Refinement (documented, not executed):** R1 — `memory_events.event_type` gains `'note_change'`.

## Phase 8 — Build Plan & V1 Implementation

Status: **Complete.** Output: [`docs/phase-8-build-plan.md`](./docs/phase-8-build-plan.md).

**Locked build plan:**

- **V1 success:** the full loop works end-to-end for one person on phone + laptop — capture → processing → memory → corrections → search → connections → collections → PA → learning — with privacy and cost guards from day one.
- **Tech stack:** Next.js + TypeScript + Tailwind on Vercel · Supabase (Postgres + pgvector + Storage + Auth) · Inngest jobs · Groq vision/reasoning (+ wired fallbacks) · NVIDIA embeddings; no analytics/monitoring vendors in V1.
- **Repo:** single Next.js app — `app/` · `components/` · `lib/` · `server/` · `inngest/` · `supabase/` · `types/` · `tests/` · `docs/`.
- **Stages (vertical slices):** Foundation → Capture → Processing → Memories → Search → Connections → Collections → PA → Learning → Polish; dependencies documented; **first milestone M1** = upload → process → memory → view.
- **Sprints:** 10 content-defined sprints with objectives, deliverables, dependencies, risks.
- **Schema order:** all tables in one forward-only migration set at Stage 1 (incl. every documented refinement R1–R4, A1–A3, `learned_patterns`); no destructive changes.
- **Testing:** focused unit tests + integration invariants + E2E smoke + small AI-eval fixtures + manual device checklists.
- **Costs:** ≈ $0.006–0.010/capture → ~$0.6–1.0 per 100 captures, ~$6–10 per 1,000; storage may justify Supabase Pro ($25/mo) past ~500 captures.
- **Deployment:** local → preview (no prod jobs) → private V1; public not planned. Anti-scope list and readiness checklist included.

## Technology stack (locked through Phase 8)

| Area | Candidate |
|---|---|
| Frontend | ✅ Locked (P4): Next.js (App Router) + TypeScript — Vercel |
| Backend | ✅ Locked (P4): Next.js route handlers (Vercel) + Postgres RPCs |
| Database | Supabase / Postgres |
| File storage | Supabase Storage |
| Vector search | pgvector |
| Job / background processing | ✅ Locked (P4): Inngest — durable steps, retries, concurrency caps, cron |
| PA / proactive layer | ✅ Locked (P5): scheduled detector → synthesis pipeline (Mon/Thu); one `pa_reports` table; in-app delivery |
| Learning layer | ✅ Locked (P6): one `learned_patterns` table; deterministic aggregation + decay; soft context into reasoning (no fine-tuning) |
| Interface / UX | ✅ Locked (P7): capture-first 3-area nav; “You said vs ScreenView thinks” language; in-app PA; mobile + desktop defined |
| Vision / screenshot understanding | ✅ Locked (P3): Groq `qwen/qwen3.8-27b` · fallback OpenRouter `qwen/qwen3-vl-8b-instruct` |
| Reasoning / memory interpretation | ✅ Locked (P3): Groq `openai/gpt-oss-120b` (strict structured outputs) · fallbacks `gpt-oss-20b` / OpenRouter |
| Multimodal embeddings | ✅ Locked (P3): NVIDIA `llama-nemotron-embed-vl-1b-v2` — 2048-d, hosted NIM, self-host option |
| Fallback models | ✅ Locked (P3): minimal set (see Phase 3 §17); Gemma documented, not in V1 chain |

The stack is locked through Phase 4 (AI models verified in Phase 3; application/platform choices verified in Phase 4). **No integrations before the build phase.**

## Phase log

- **2026-09-28 — Phase 0 (Project Setup):** repo initialized (`ScreenView`), initial project structure, README, project plan, `docs/` directory.
- **2026-09-28 — Phase 1 (Product Definition):** product definition documented in [`docs/phase-1-product-definition.md`](./docs/phase-1-product-definition.md); no application code (by design). Next: Phase 2 — Data & Memory Architecture (awaiting go-ahead).
- **2026-09-28 — Phase 2 (Data & Memory Architecture):** data model defined in [`docs/phase-2-data-memory-architecture.md`](./docs/phase-2-data-memory-architecture.md) — 7-table greenfield design, reference DDL only, nothing executed. Next: Phase 3 — AI Architecture (awaiting go-ahead).
- **2026-09-28 — Phase 3 (AI Architecture):** AI architecture defined in [`docs/phase-3-ai-architecture.md`](./docs/phase-3-ai-architecture.md) — models verified against provider docs and locked (Groq qwen3.8-27b vision · Groq gpt-oss-120b reasoning · NVIDIA embed-vl 2048-d), contracts + fallbacks + failure handling defined; nothing implemented. Next: Phase 4 — Application & Processing Architecture (awaiting go-ahead).
- **2026-09-29 — Phase 4 (Application & Processing Architecture):** application & processing architecture defined in [`docs/phase-4-application-processing-architecture.md`](./docs/phase-4-application-processing-architecture.md) — Next.js on Vercel, direct-to-storage uploads, Inngest job layer, state machine + idempotency + security + cost controls; nothing implemented. Next: Phase 5 — Personal Assistant / PA Architecture (awaiting go-ahead).
- **2026-09-29 — Phase 5 (Personal Assistant / PA Architecture):** PA architecture defined in [`docs/phase-5-personal-assistant-architecture.md`](./docs/phase-5-personal-assistant-architecture.md) — 4 V1 capabilities, reminder/pattern/project logic, fact-vs-inference-vs-suggestion discipline, deterministic-first generation, `pa_reports` storage decision, in-app delivery; nothing implemented. Next: Phase 6 — Personal Learning Architecture (awaiting go-ahead).
- **2026-09-29 — Phase 6 (Personal Learning Architecture):** learning architecture defined in [`docs/phase-6-personal-learning-architecture.md`](./docs/phase-6-personal-learning-architecture.md) — signal taxonomy, evidence/confidence/decay model, feedback-loop safeguards, one new `learned_patterns` table, GPT-OSS context injection; nothing implemented. Next: Phase 7 — Interface & UX (awaiting go-ahead).
- **2026-09-29 — Phase 7 (Interface & UX Architecture):** UX architecture defined in [`docs/phase-7-interface-ux-architecture.md`](./docs/phase-7-interface-ux-architecture.md) — navigation, capture experience, memory card/detail, corrections, search, PA surface, states, journeys, screen inventory; nothing implemented. Next: Phase 8 — Build Plan & V1 Implementation (awaiting go-ahead).
- **2026-09-29 — Phase 8 (Build Plan & V1 Implementation):** build plan defined in [`docs/phase-8-build-plan.md`](./docs/phase-8-build-plan.md) — V1 success criteria, locked stack, repo layout, 10 stages + sprints, first milestone, testing strategy, risks, costs, deployment path, anti-scope; nothing implemented. Next: Phase 9 — Actual Implementation (awaiting go-ahead).
