# Phase 4 — Application & Processing Architecture: ScreenView

| | |
|---|---|
| **Project** | ScreenView |
| **Phase** | 4 — Application & Processing Architecture |
| **Status** | ✅ Complete |
| **Date** | 2026-09-29 |
| **Next phase** | Phase 5 — Personal Assistant / PA Architecture |

This document translates Phases 1–3 into the concrete technical architecture of the ScreenView application: what runs where, what is synchronous vs asynchronous, how uploads flow, how processing jobs are created/retried/observed, and how the system stays secure and cost-bounded. **Nothing here is implemented** — no code, no routes, no migrations, no packages, no configuration. Where platform capabilities mattered, they were verified against official documentation on **2026-09-29** (sources in §0).

---

## 0. Platform verification summary (checked 2026-09-29)

| Claim | Verdict | Source |
|---|---|---|
| Vercel Functions (Fluid compute): Hobby max duration **300s** (default = max); request/response body limit **4.5MB**; concurrency auto-scales; Hobby memory 2GB/1vCPU | ✅ Confirmed | vercel.com/docs/functions/limitations |
| Vercel Cron: Hobby = **once-per-day minimum interval** (frequent expressions fail deployment); Pro = once-per-minute | ✅ Confirmed — cannot drive processing on Hobby | vercel.com/docs/cron-jobs/usage-and-pricing |
| Vercel **Workflows** exist: durable multi-step code (`use workflow`/`use step`), retries, resume across crashes, observability, "no duration limits", usage-based pricing (Events, Data Written, Data Retained) — built on **Vercel Queues** (durable streaming, retries, idempotency keys; *beta*) | ✅ Confirmed (feature set). ⚠️ Pricing/limits page did not extract — **not verified** | vercel.com/docs/workflows, /docs/queues |
| Inngest free tier: **50k executions/month, 5 concurrent steps**, 500k events, 24h trace history, no credit card; features = retries, state, concurrency, throttling, scheduling, observability; open source, self-hostable | ✅ Confirmed | inngest.com/pricing |
| Trigger.dev: tasks run on their infra with **no timeouts**; free plan includes **$5/month credits** then pauses; concurrency limited on free; billing alerts available | ✅ Confirmed | trigger.dev/pricing |
| Supabase Edge Functions: wall-clock **150s free / 400s paid**, CPU time **2s/request** (async I/O excluded), 256MB memory | ✅ Confirmed | supabase.com/docs/guides/functions/limits |
| Supabase **Queues**: Postgres-native durable queue on `pgmq`; guaranteed delivery; exactly-once within a visibility window; RLS-aware | ✅ Confirmed | supabase.com/docs/guides/queues |
| Supabase free tier: 500MB DB, **1GB file storage**, 5GB egress, max upload **50MB**, 50k MAU; **free projects pause after 1 week of inactivity**; Pro from $25/mo | ✅ Confirmed | supabase.com/pricing |
| Supabase Storage **signed upload URLs**: `createSignedUploadUrl(path)` returns a signed URL + token; client uploads directly to Storage | ✅ Confirmed (API), details at implementation | supabase.com docs (JS reference) |
| ScreenView domains served over HTTPS; all provider calls server-side; Vercel Hobby = personal, non-commercial use (fits ScreenView's personal-first V1) | ✅ Confirmed | Vercel docs/plans |

## 1. Application architecture overview

**Components**

| Component | Runs on | Responsibility |
|---|---|---|
| **Browser app** | User's phone/laptop (served by Vercel) | Capture UI (file pick + optional note), direct upload to Storage, status display, corrections/confirmations |
| **App/API** | Vercel (Next.js route handlers, Fluid compute) | Auth, validation, signed-upload issuance, capture lifecycle, corrections, reads/search, job endpoint |
| **Job orchestrator** | Inngest Cloud (free tier) | Durable execution: retries/backoff, concurrency caps, cron schedules, run history |
| **Workers** | Vercel functions (invoked by Inngest) | Execute pipeline steps; call AI providers; write to Supabase |
| **Data platform** | Supabase | Postgres (+pgvector), private Storage, Auth (sessions), RPC functions |
| **AI providers** | Groq, NVIDIA (fallback: OpenRouter) | Vision, reasoning, embeddings — called server-side only |

**Principles**

1. **The browser uploads bytes and displays state — nothing else.** No AI keys, no service-role key, no processing logic in the client.
2. **Large files never transit Vercel** (4.5MB body limit): screenshots go browser → Supabase Storage directly via signed upload URLs.
3. **The server is never blocked:** every AI call happens inside a durable, retryable background step; the user gets "uploaded" in milliseconds.
4. **DB is the system of record; the orchestrator is the execution engine.** User-visible state lives in Postgres; Inngest owns retries/concurrency/schedules.
5. **Every stage is idempotent and resumable** (DB-checkpoints per stage; deterministic event ids; unique constraints as backstops).
6. **One orchestrator, swappable:** the job layer is encapsulated so a future move (e.g., to Vercel Workflows once mature) touches no domain logic.

### 1.1 Refinements to Phases 1–3 (documented, not executed)

Required by this phase, each with reason (per the phase rules):

- **R1 — `captures.processing_status` states extended:** from `('pending','processing','completed','failed')` to `('upload_pending','uploaded','processing','retrying','completed','failed')`. Reason: the state machine below distinguishes "awaiting bytes", "queued", "worker active", "auto-retrying", and terminal states; the old set cannot express upload/retry distinctions. Non-destructive (constraint on a table that does not exist yet).
- **R2 — operational columns on `captures`:** `attempt_count int not null default 0`, `last_error text`, `last_attempt_at timestamptz`. Reason: retry UX + observability without inventing a jobs table (justification in §8).
- **R3 — `memories.perception jsonb` (nullable):** stores the raw vision-analysis output (including `model`, `provider`, `prompt_version` fields). Reason: makes the vision step resumable without re-calling the provider, enables re-embedding/re-interpretation without re-vision, and provides provenance/traceability.
- **R4 — action vocabulary CHECK refinement** (from Phase 3 §7) carries into the initial migration.

No other Phase 1–3 change is needed; all other decisions stand as written.

## 2. Frontend responsibilities

The capture experience stays: **screenshot + optional note → Upload → Done.** No categories, no intent picking, no waiting on AI.

**Responsibilities**

- Pick one or many images; type an optional note per capture (or one shared note for a batch — minor UX detail for Phase 7).
- Obtain a signed upload URL from our API per capture, then upload directly to Supabase Storage (multi-select uploads run 3 concurrently).
- Show capture cards immediately (**optimistic UI**): the card appears as "Uploading…"; server ids reconcile when the API responds.
- Show status: `Uploading → Uploaded → Processing → Done / Failed (Retry)`. Polling (§20) drives transitions; no spinner ever blocks the UI.
- Surface failures with a Retry action and a plain-language error; never expose stack traces or provider errors.
- Support cancellation: an in-flight upload can be aborted; a queued capture can be deleted.
- Present processed memories (title, topic, intent/action chips) in lists and detail views; provide corrections (edit intent/topic/action/status with a reason), connection confirm/dismiss, collection accept/dismiss.
- **Not responsible for:** AI calls of any kind, category/organization decisions at capture time, understanding the pipeline.

**Batch behavior (client):** N files = N independent captures; the UI shows progress per item and a batch summary. No single mega-request.

## 3. Backend/API responsibilities

- **Auth & ownership:** every request resolves the user from the session server-side; all reads/writes are ownership-checked (and RLS backstops).
- **Validation:** request bodies validated (schema-based); files validated (allowlist mime, size cap, extension); note text length-capped.
- **Capture lifecycle:** create capture rows, issue signed upload URLs, verify upload completion, enqueue processing, serve status reads.
- **Corrections & confirmations:** append `memory_events`, update denormalized current values, flip suggestion states; enqueue re-embedding when semantic fields change.
- **Read APIs:** capture list/detail, memory list/detail, search (query embedding + pgvector KNN via Postgres RPC), collections list.
- **Job endpoint:** serve the Inngest function route (signature-verified; the only endpoint that runs pipeline code).
- **Rate limiting (concept):** per-user fixed-window limits on write endpoints + a daily capture cap (cost guard, §23).
- **Explicitly NOT the backend's job:** receiving image bytes (browser → Storage direct), invoking AI providers from request handlers (only from job steps), holding long-running requests.

## 4. Upload architecture

**Flow (per capture):**

```
Browser                      App/API (Vercel)                Supabase Storage
  │  POST /api/captures {file_name, mime, size, note?}          │
  │ ─────────────────────────►│ create captures row            │
  │                           │ (upload_pending) + signed URL  │
  │ ◄──── {capture_id, url, token, path} ─────────────────────│
  │                                                             │
  │  PUT bytes → signed URL ───────────────────────────────────►│ object stored (private)
  │                                                             │
  │  POST /api/captures/{id}/complete {file_hash}               │
  │ ─────────────────────────►│ verify object+size+mime        │
  │                           │ status → uploaded; enqueue job │
  │ ◄──── {status: "uploaded"} ────────────────────────────────│
```

- **Direct-to-storage, always.** Vercel's 4.5MB body limit makes server-proxied uploads a non-starter for screenshots; signed upload URLs keep the server to a few KB per request.
- **Constraints:** ≤ **20MB** per file (aligns with Groq's image-request cap); formats: **PNG, JPEG, WebP**; HEIC/other rejected with a clear message (Phase 7 can add client-side conversion later).
- **Validation:** server checks declared size/mime before issuing the URL; on completion, verifies the object exists and its stored size matches; `file_hash` (SHA-256, computed client-side during upload) is recorded — duplicates are detected, not blocked (§6, §23).
- **Cancellation:** abort the upload request; the capture stays `upload_pending` and is cleaned up after 24h (§8 maintenance job). A failed upload can be retried for the same capture (new signed URL, same path).
- **Resumability:** consciously skipped for V1 — files are ≤20MB and modern mobile connections handle single-shot uploads; (Supabase does offer resumable uploads if ever needed).
- **Batch:** client uploads files with ≤3 parallel singles; each capture is independently recoverable.

## 5. Storage architecture

- **Bucket:** one private bucket, `captures` (never public).
- **Path convention:** `{user_id}/{capture_id}.{ext}` — user-scoped prefixes make ownership policies trivial and allow a clean per-user wipe.
- **Ownership & access rules (to apply at build):** Storage RLS policies allow a user to read/write only objects whose first folder segment equals their `auth.uid()`; uploads happen through short-lived signed URLs issued server-side; reads (viewing a screenshot) happen through short-lived signed download URLs.
- **Relationship to capture record:** `captures.storage_path` is written at capture creation (path is deterministic — known before upload); object existence is verified at `/complete`. The DB row is the source of truth; a missing object can always be detected.
- **Deletion:** deleting a capture deletes its storage object (retried; §24). Orphaned objects (no capture row) are swept by the maintenance job.

## 6. Database lifecycle

Mapping the capture lifecycle onto the Phase 2 tables (no new tables — §8 justifies):

| Stage | Writes | Notes |
|---|---|---|
| Capture created | `captures` row (`upload_pending`), storage path reserved | note stored verbatim; file_hash later |
| Upload verified | `captures.processing_status='uploaded'`, `file_hash` set | enqueue processing |
| Vision done | `memories` not yet created; perception held in job state | written with the memory on success |
| Memory created | `memories` row (incl. `perception` jsonb) + initial `memory_events` (one `intent_change`, one `status_change` = `new`) — **single transaction** (RPC) | also `captures.processing_status='completed'` |
| Embedding created | `memory_embeddings` row (model + input_hash + vector) | may lag (backfill) — memory is still usable |
| Connections suggested | `connections` rows, `state='suggested'`, `origin='ai'` | from the reasoning call + sweeps |
| Collections discovered | `collections` + `collection_members` rows, `suggested` | periodic job only |

Duplicate signals: same `file_hash` within a user → the client may show a gentle "you saved this before" hint; processing still proceeds (cost is negligible; §23).

## 7. Processing architecture

Phase 3's pipeline, placed onto the runtime:

| Step (Phase 3 §14) | Executes in | Notes |
|---|---|---|
| [1] Vision (Qwen) | Worker step (Vercel fn via Inngest) | downloads screenshot once from Storage; server-side key |
| [2] Query embedding | Worker step | text-only (note + visual description) |
| [3] Retrieval | Worker step (SQL/RPC) | pgvector KNN + supplements → ≤12 cards |
| [4] Reasoning (GPT-OSS) | Worker step | note verbatim + vision + cards; strict schema |
| [5] Persist memory | Worker step (Postgres RPC, single transaction) | memory + events + suggested connections |
| [6] Document embedding | Worker step | image + canonical text → `memory_embeddings` |
| [P1] Collection discovery | Scheduled job | daily check + threshold gate |
| [P2] Connection sweep | Scheduled/debounced job | batch-level pairs |
| [P3] Embedding backfill | Scheduled job | hourly check |
| [P4] PA report | Scheduled job | Mon & Thu (Phase 5 finalizes) |

Browsers execute **none** of this. Request handlers execute **none** of this (they only enqueue). No permanently-running workers anywhere.

## 8. Job/worker architecture (the Phase 4 decision)

### 8.1 Options evaluated (verified figures, §0)

| Option | Durable steps | Retries | Concurrency control | Scheduling | Observability | Free tier / cost | Verdict |
|---|---|---|---|---|---|---|---|
| **Supabase Edge Functions + pg_cron consumers** | ✗ (hand-rolled) | ✗ hand-rolled | ✗ hand-rolled | pg_cron (1-min granularity) | logs only | Free (500k invocations) | High DIY; no step semantics — rejected |
| **Supabase Queues (pgmq) + consumers** | queue only | visibility timeouts only | ✗ hand-rolled | needs a consumer trigger | dashboard basics | Free | Queue primitive without orchestration; consumer problem remains — rejected for V1 |
| **Vercel Cron + function worker** | ✗ | ✗ | ✗ | Hobby daily-only; Pro minutely ($20+/mo) | basics | Hobby insufficient; Pro paid | Rejected (fails Hobby constraints) |
| **Vercel Functions + `waitUntil`** | ✗ (not durable) | ✗ | ✗ | via cron | basics | Free | Insufficient alone — rejected |
| **Vercel Workflows + Queues** | ✓ | ✓ per-step | queue rate control; granular caps **unverified** | **unverified** | ✓ dashboard | usage-based; **specifics unverified** | Strong native candidate — **revisit** after maturity; not selected now (new platform, unverified limits/pricing) |
| **Trigger.dev** | ✓ | ✓ | ✓ (paid for more) | ✓ | ✓ dashboard | $5/mo credits ≈ ~13k 10s runs | Viable; adds a second deploy surface (tasks deploy via their CLI) — not selected |
| **Inngest** | ✓ | ✓ per-step, backoff | ✓ concurrency + throttle + debounce | ✓ cron triggers | ✓ 24h traces (free) | **50k executions/mo, 5 concurrent steps** | **SELECTED** |

### 8.2 Decision: Inngest (V1)

Why Inngest wins for a personal-first V1 on Vercel + Supabase:

- **Exactly matches the workload:** per-step retries with backoff (Phase 3's failure model maps 1:1), first-class concurrency caps (the "don't fire 100 AI calls" requirement), debounce (batch sweeps), cron (collections/backfill/PA/health).
- **Runs inside our Vercel app** — no separate deployment surface (unlike Trigger.dev tasks), no infrastructure of ours to run.
- **Observability on the free tier** satisfies most of §22 (per-run step traces, durations, retries, failures).
- **Free tier is comfortably enough:** one capture ≈ 8 steps = ~9 executions; 50k/month ≈ ~5,000 captures/month. Periodic jobs add a few dozen executions/day.
- **Portable & open source** (self-hostable; predictable swap path).

**Architectural separation:** the *principles* — durable execution, per-step retry/backoff, capped concurrency, scheduled jobs, idempotent steps, per-run observability — are the architecture. Inngest is the V1 implementation, encapsulated behind the job-layer module; swapping to Vercel Workflows (or anything else) later changes that module only.

### 8.3 Job definitions (V1)

| Job | Trigger | Steps (abridged) | Concurrency limit |
|---|---|---|---|
| `capture/process` | event `capture/complete` (deterministic id `capture:{id}`) | claim → vision → embed query → retrieve → reason → persist (txn) → embed document → complete | **4** (global) |
| `batch/sweep` | debounced event (5 min after completions) + hourly safety | collect recent memories → evaluate candidate pairs (capped) → persist suggestions | 1 |
| `collections/discover` | cron daily (07:00 WAT) | gather pattern candidates (SQL) → exit if none → suggest (≤1 reasoning call) → persist | 1 |
| `embeddings/backfill` | cron hourly | find missing/stale embeddings → re-embed (capped N/run) | 1 |
| `maintenance/health` | cron hourly | stuck captures (>15 min in processing/retrying) → re-enqueue or fail; clean abandoned uploads (>24h); orphan-object sweep | 1 |
| `pa/report` | cron Mon & Thu 18:00 WAT | (Phase 5 defines generation) | 1 |

Retry policy per step: vision 3, reasoning 3, embeddings 5, DB ops 3 — exponential backoff; validation errors are non-retriable. After automatic run retries are exhausted (max 3 runs), the capture becomes `failed` with `last_error`. Manual retry = re-enqueue (§10). **Dead-letter = the `failed` captures list** (queryable, visible); no separate DLQ infra. **Cancellation:** deleting a capture sends a cancel signal; steps also check row existence and no-op.

**Job ownership:** jobs run with the service role but operate strictly on rows belonging to the capture's `user_id`; ownership is carried in job payloads as ids only — no user content travels through the orchestrator (payload principle: **ids, not data**).

## 9. Sync vs async boundaries

| Process | Sync / Async | Reason |
|---|---|---|
| File upload (bytes) | Async | Direct browser → Storage; UI stays responsive; optimistic card |
| Capture init (signed URL) | **Sync** | Milliseconds; small body; must return URL before upload |
| Capture completion ack | **Sync** | Verify + enqueue + return; < ~300ms; processing itself is async |
| Vision processing | Async | External AI call; minutes-scale worst case; retryable step |
| Query embedding | Async | External call (inside job) |
| Retrieval | Async (inside job) | Needs vision output first; DB-only (fast) |
| Reasoning | Async | External AI call; the heaviest step |
| Memory persist | Sync *within job step* | DB transaction; must be atomic |
| Document embedding | Async | External call; allowed to lag (graceful degradation) |
| Connection discovery | Async | Same job (persist) + scheduled sweeps |
| Collection discovery | Async (scheduled) | Needs accumulated evidence; never blocks capture |
| PA generation | Async (scheduled) | Weekly/twice-weekly by design |
| Status polling (read) | Sync per request | Cheap DB reads |

**Rule:** the user waits for exactly three synchronous things — URL issuance, bytes upload, completion ack. Nothing else.

## 10. Processing state machine

```
                ┌──────────────────┐
   create ────► │  upload_pending  │
                └────────┬─────────┘
          complete       │        abandon/cleanup (24h)
                ┌────────▼─────────┐        │
                │     uploaded     │        ▼
                └────────┬─────────┘     [failed]
                    claim│               (upload_abandoned)
                ┌────────▼─────────┐
                │    processing    │◄─────────────┐
                └───┬──────────┬───┘              │
        success     │          │ failure (attempts remain)
                ┌───▼─────┐  ┌─▼─────────┐        │
                │completed│  │ retrying  │────────┘
                └─────────┘  └─────┬─────┘  (auto re-enqueue)
                                   │ attempts exhausted
                              ┌────▼────┐   manual retry
                              │ failed  │──────────► retrying
                              └─────────┘
   any state ── user delete ──► deleted (cascade)
```

States: `upload_pending` · `uploaded` · `processing` · `retrying` · `completed` · `failed`. (Six, each load-bearing; no extras.) Partial-failure example from the brief — Qwen succeeds, GPT-OSS fails: perception is checkpointed (R3), the capture goes `retrying`→`processing`, and the retry **skips vision** (DB check) and continues from reasoning; nothing is duplicated.

## 11. Idempotency

| Scenario | Mechanism |
|---|---|
| Duplicate upload (same file twice) | Allowed by design; detected via `file_hash`; processed independently (or manual skip) — never crashes |
| User refreshes during upload | Capture exists in `upload_pending`; re-init returns a fresh signed URL for the same path; no duplicate rows |
| Job retry (step failed) | Inngest step memoization (within run) + each step begins with a DB check ("already done? exit") — vision/reasoning/embedding never repeat completed work |
| Worker crash after DB write | Retried step re-checks; writes are upserts/RPC transactions with unique constraints (`memories.capture_id`, `(memory_id, model)`, `(source,target,type)`, `(collection_id, memory_id)`) |
| Provider timeout after completing | Retry re-runs only if the checkpoint is missing; a provider-side "completed but timed out" call is harmless (pure inference, no side effects) |
| Double enqueue | Deterministic event id `capture:{id}` deduplicates within the orchestrator window; claim step (`UPDATE … WHERE status='uploaded'`) atomically prevents double processing |
| Correcting the same field twice | Each correction appends an event (intent history by design); denormalized value = latest |
| Re-embedding | Gated by `input_hash`; unchanged input never re-embeds |

## 12. Batch processing

Principles: **one capture = one lifecycle**; batches are fan-out + a separate batch-level pass; nothing giant, nothing N×N.

| Batch | Behavior |
|---|---|
| 1 | Normal pipeline. |
| 10 | 10 independent jobs; concurrency cap 4 drains them in ~3 waves. |
| 50 | Same; each capture recoverable independently; UI shows per-item + overall progress. |
| 100 | Same; expect ~5–10 min end-to-end at cap 4 (mostly AI latency); `batch/sweep` debounces to **one** post-batch relationship pass. |

- **Concurrency control:** Inngest function-level cap (4 for `capture/process`) — 100 screenshots never mean 100 simultaneous AI calls. Providers' rate limits keep huge headroom (Groq dev tier: 250K TPM / 1K RPM).
- **Batch-level relationship discovery:** debounced `batch/sweep` 5 minutes after the last completion (collapses 100 events into one run); evaluates candidate pairs among new memories + corpus (inngest-side cap on pairs per run), writes `suggested` rows.
- **Collection discovery:** never per-batch; next scheduled run picks up patterns.
- **Cost:** ~$0.006/capture → a 100-batch ≈ $0.60 (§23).

## 13. AI execution architecture

- **All AI calls happen in worker steps**, server-side, with keys from server environment only. Providers: Groq (vision, reasoning), NVIDIA (embeddings), OpenRouter (fallbacks, off by default).
- **Per-call execution profile:** download screenshot (Storage → worker, ≤20MB) → provider call with explicit timeout (vision 60s, reasoning 60s, embeddings 30s) → validate output against the contract (§Phase 3) → hand to next step. Fallbacks run **sequentially** (only after primary failure), exactly as Phase 3 §17.
- **Provider abstraction:** one internal module (the "AI gateway") reading model IDs + provider config from environment variables; all call sites go through it. Model IDs are config, never hard-coded (Phase 3 requirement).
- **Traceability:** every artifact records its origin — `memories.perception` (model/provider/prompt_version), `memory_events.detail` (model/provider on intent events), `connections.basis` / `collections.basis` (model + prompt version), `memory_embeddings.model`. Combined with Inngest traces, every AI result is attributable end-to-end.
- **Egress note:** each capture downloads its screenshot twice (vision + embedding steps) ≈ ~4MB average → well inside Supabase's 5GB free egress at personal scale (~1,000+ captures/month); monitor, and optimize later if needed.

## 14. Retrieval architecture

- **Capture-time (pre-reasoning):** provisional query embedding (text: note + visual description) → Postgres RPC `match_memories(query_embedding, k=10)` (cosine/HNSW, user-scoped) → supplements: exact-topic matches (≤5) + same-`file_hash` → merge/dedupe → ≤12 cards. Empty corpus → empty set (normal).
- **User search (Phase 7 surface):** same RPC with the user's query text → results + facets.
- **PA/resurfacing:** SQL first (statuses, dates, patterns); vector queries only when semantic similarity is actually needed.
- **Query embeddings are ephemeral** — computed per request, never stored. **Stored embeddings** (multimodal, 2048-dim) serve all future retrievals; **stale embeddings** (input changed after correction) are refreshed by the `embeddings/backfill` job; retrieval skips memories lacking a current-model vector (they remain reachable via SQL).
- Implementation detail: prefer a Postgres function invoked via RPC (keeps serverless connection-free via PostgREST; no direct pools needed).

## 15. API surface (conceptual)

| Endpoint | Purpose | Caller | Auth | Triggers processing |
|---|---|---|---|---|
| `POST /api/captures` | Create capture + signed upload URL | Browser | ✅ user | No |
| `POST /api/captures/{id}/complete` | Verify upload; enqueue processing | Browser | ✅ owner | **Yes** |
| `GET /api/captures/{id}` | Status/detail (poll target) | Browser | ✅ owner | No |
| `GET /api/captures` | Recent list (+ filters) | Browser | ✅ user | No |
| `DELETE /api/captures/{id}` | Delete capture (+cascade) | Browser | ✅ owner | Cancels job |
| `POST /api/captures/{id}/retry` | Re-enqueue failed capture | Browser | ✅ owner | **Yes** |
| `GET /api/memories` | List/filter memories | Browser | ✅ user | No |
| `GET /api/memories/{id}` | Memory detail (events, connections, collections) | Browser | ✅ owner | No |
| `PATCH /api/memories/{id}` | Submit correction {field, value, reason} | Browser | ✅ owner | Re-embed enqueue only |
| `POST /api/search` | Semantic search {q} | Browser | ✅ user | No |
| `POST /api/connections/{id}/confirm` / `/dismiss` | Confirm/dismiss suggestion | Browser | ✅ owner | No |
| `POST /api/collections/{id}/accept` / `/dismiss`; `PATCH /api/collections/{id}` | Manage collection suggestions | Browser | ✅ owner | No |
| `GET /api/collections` | List collections | Browser | ✅ user | No |
| `POST /api/inngest` | Job framework endpoint (serve + verify) | Inngest | Signature | Executes jobs |
| PA endpoints | (deferred to Phase 5) | Browser | ✅ | No |

Every endpoint maps to a defined action; nothing speculative. No versioning ceremony for a personal V1 beyond consistent JSON shapes.

## 16. Authentication

- **Provider:** Supabase Auth (email magic-link/OTP — the simplest fit for a personal, multi-device app), session cookies via `@supabase/ssr`; middleware refreshes sessions.
- **Identity:** single user (`user_id` = `auth.uid()`); signups can be **disabled/allowlisted** after the owner's account exists (private app).
- **Server-side authorization:** every handler obtains `user_id` from the session server-side — never from client input. RLS (below) backstops every query; the service role is used only by jobs and job-adjacent operations, which always scope by the capture's user.
- **Not built now** (per brief); the schema is already auth-ready, so this is additive.

## 17. Security / RLS

**Boundary:** Browser → (public, authenticated APIs) → Vercel server → Supabase → AI providers; all key material stays at the last two hops' server side.

| Secret | Where it lives | Never |
|---|---|---|
| Groq / NVIDIA / OpenRouter keys | Server env (Vercel, production scope) | Browser, logs, repo, `NEXT_PUBLIC_*` |
| Supabase service-role key | Server env; used by jobs/privileged ops only | Browser, repo |
| Supabase anon key | Public by design | (safe) |

- **RLS:** enabled on all tables (owner policies `auth.uid() = user_id`); Storage policies scope objects by `{user_id}/` prefix; service-role usage is code-reviewed to always write `user_id` correctly.
- **Signed URLs:** upload URLs (single-use, short-lived); download URLs (short TTL); no public objects, ever.
- **Request validation:** schema validation on every mutating endpoint; size/mime/extension checks on files; note length caps.
- **Rate limiting (concept):** per-user fixed-window limits on write endpoints (init/complete/corrections) + daily capture cap (§23). V1 implementation keeps this lightweight (DB-backed counter); heavier WAF options deferred.
- Explicitly **not** over-engineered: no custom crypto, no IP allowlists, no enterprise SSO — personal-first, correct-by-construction.

## 18. Vercel architecture & constraints (verified §0)

- **Fit analysis:** worst-case step durations (vision ~10–30s including download) sit far below Hobby's **300s** function limit; Fluid compute bills active CPU (our workload is I/O-bound → cheap); functions are stateless — orchestration lives in Inngest.
- **Body limit 4.5MB** → drives direct-to-storage uploads (§4); only small JSON flows through functions.
- **Cron:** Hobby is daily-only — **we do not depend on Vercel Cron at all**; all schedules run on Inngest. (If Vercel-native scheduling ever becomes attractive, revisit at Pro.)
- **Concurrency:** Vercel autoscales; our *own* caps (Inngest limits) are the throttle that matters.
- **Regions:** single-region deployment; pick the region nearest the user + Supabase (candidate: EU-West/EU-Central for Lagos latency) — finalized at setup.
- **Environments:** Preview deployments must **not** process production jobs (separate Inngest environment/keys; prod-only provider keys or paused flag on preview).
- **Deployments:** atomic; steps are deployment-idempotent (resume-safe), so mid-deploy runs are safe.

## 19. Supabase architecture & constraints (verified §0)

- **Postgres (+pgvector):** the whole data model of Phase 2; 500MB free is ample (text-heavy; screenshots live in Storage). pgvector available on all plans — enabled at build.
- **Storage:** private bucket; 1GB free (≈ hundreds of screenshots; trivially expandable); max upload 50MB (ours capped at 20MB); served via signed URLs.
- **Auth:** sessions as §16.
- **Connection behavior:** serverless-friendly — prefer PostgREST/supabase-js and RPC functions (no direct Postgres pools); if a direct connection is ever needed, use the pooler (transaction mode). No raw connection strings in request paths.
- **Realtime:** available (2M messages free) — **not used in V1**; status updates via polling (§20). Deliberate.
- **Edge Functions:** available and cheap, but **not used for V1 pipeline** — one runtime for all server code (Vercel) is simpler to build, debug and observe; documented alternative if we ever want Supabase-native consumers.
- **Queues (pgmq):** available, not adopted (Inngest supersedes for V1; kept in the comparison trail).
- **Free-project pause caveat:** Supabase pauses free projects after **1 week of inactivity** — for an actively used personal app this is edge-case; document handling (dashboard resume; optionally a weekly health ping later).

## 20. Processing status updates

| Option | Verdict |
|---|---|
| **Polling** | ✅ **Recommended.** `GET /api/captures` every ~3s while any capture is in a non-terminal state (backoff to ~10s on long items; stop when all terminal; refetch on focus). Tiny payloads, per-user scoping trivial, zero extra infrastructure. |
| Supabase Realtime | Deferred. Setup cost (channel auth, RLS wiring) buys little at personal scale. Upgrade path if polling ever feels laggy. |
| SSE / WebSockets | Overkill for V1 — rejected. |

UX contract: "Processing…" → "Memory ready" transitions come from polling; failures surface with Retry.

## 21. PA processing

- **Placement:** a scheduled job (`pa/report`, twice weekly Mon & Thu 18:00 WAT, configurable) — **never** part of capture processing.
- **Reads:** SQL over memories/status/events/connections/collections: items needing attention, stalled intents (no events in N days), emerging patterns, recent completions, aging saves.
- **Generates:** the structured report (Immediate / Emerging / Everything Else) — at most one reasoning call for composition.
- **Stored:** as a user-owned generated artifact. This is the one place where a **new table becomes genuinely necessary** (`pa_reports`-style: id, user_id, generated_at, window, payload) — it cannot be safely represented by existing tables without polluting their semantics. Final structure is Phase 5's decision (PA architecture); Phase 4 only guarantees the job slot and the principle.
- **Delivery/UX:** Phase 5/7.

## 22. Observability (V1-appropriate)

| Need | Mechanism |
|---|---|
| Capture failed | `captures.status='failed'` + `last_error` + visible in UI |
| AI call failed | Inngest step trace (error, attempt, timing) + summarized into `last_error` |
| Embedding failed | Backfill job + capture completes anyway (graceful) |
| Processing stuck | `maintenance/health` (hourly) → flags/re-enqueues >15 min stuck |
| Retry occurred | `attempt_count` + Inngest trace history |
| Fallback model used | Recorded in step output + artifact provenance fields (model/provider) |
| Processing duration | Inngest traces + `last_attempt_at` deltas |
| Provider/model per result | Provenance fields (§13) on every artifact |

Plus: Vercel function logs (errors), Inngest dashboard (runs/steps, 24h free), Supabase logs (limited to 1 day on free — hence the DB-field-first design). No external monitoring platform in V1; optional Sentry-class tooling deferred.

## 23. Cost controls

- **File cap** 20MB; format allowlist (rejects costly edge cases).
- **Daily capture cap** (soft): default **200/day** — blocks init with a clear message beyond it; adjustable via config.
- **Concurrency caps:** global pipeline 4; sweeps/collections/PA 1 → batches can't burst AI spend.
- **Retry caps:** per-step limits + max 3 run attempts; no infinite loops; non-retriable errors don't retry.
- **No unnecessary AI calls:** corrections = 0 LLM calls (re-embed only if semantic fields changed, gated by `input_hash`); reads/search never call LLMs; collections/PA scheduled only; fallbacks run sequentially.
- **Idempotency + dedupe:** hash signal + deterministic job ids + step checkpoints prevent duplicate spend.
- **Batch throttling:** debounce + concurrency drains.
- **Spend alerts:** provider dashboards (Groq/NVIDIA/OpenRouter) + Inngest usage; monthly budget review in Phase 9.
- **Kill switch:** server env flag to pause AI steps (captures queue safely) in an incident.
- Reliability is not sacrificed: caps are generous for personal scale (200/day ≈ $1.20/day worst case).

## 24. Data deletion

User deletes a capture → ordered, recoverable steps:

1. **Cancel**: signal the orchestrator to stop the job (steps also no-op if the row disappeared).
2. **Storage**: delete the storage object (retried; orphan swept later if it fails).
3. **Database**: delete the `captures` row → cascades: `memories` → (`memory_events`, `memory_embeddings`, `connections` both sides, `collection_members`). Collections themselves persist (they may now hold fewer members; auto-archiving empties is a Phase 6/7 nicety).
4. **Signals**: dismissed/kept rows are hard-deleted here — deletion is user intent and wins over learning value.

Account-level deletion (later): same cascade for all rows + prefix wipe of `{user_id}/` in Storage. No soft-delete trash in V1 (privacy-first default; a grace period is a documented future option).

## 25. Definitive end-to-end architecture diagram

```
┌───────────────────────────── BROWSER (Next.js client) ──────────────────────────────┐
│  capture: pick file(s) + optional note   •  optimistic cards  •  status polling     │
│  memory views: corrections • connection/collection confirm/dismiss • search         │
└───────┬───────────────────────────────────────────────────────────────┬─────────────┘
        │ 1. POST /api/captures (auth)                                  │ 2. PUT bytes
        │    → capture row (upload_pending) + signed upload URL         │    (direct)
        ▼                                                                ▼
┌───────────────────────────────┐                          ┌─────────────────────────────┐
│ APP/API — Vercel (Next.js)    │                          │ SUPABASE                    │
│ • auth/session, validation    │     3. POST /complete    │ • Postgres + pgvector       │
│ • capture lifecycle, reads    │◄─────────────────────────│   (RPC: match_memories,     │
│ • corrections/confirmations   │                          │    create_memory_from_…)    │
│ • serves job endpoint         │  4. enqueue event        │ • Storage (private bucket)  │
│ • NO AI calls in handlers     │──────────┐               │ • Auth (sessions)           │
└───────────────────────────────┘          ▼               └──────────────▲──────────────┘
                                 ┌──────────────────────┐                  │ writes (service role,
                                 │ JOB ORCHESTRATOR      │                  │ user-scoped; RLS on
                                 │ Inngest (durable)     │                  │ tables + storage)
                                 │ • per-step retries    │                  │
                                 │ • concurrency caps    │                  │
                                 │ • cron + debounce     │                  │
                                 └──────────┬───────────┘                  │
                                            │ invokes steps (HTTP)         │
                                            ▼                              │
                        ┌──────────────────────────────────────┐           │
                        │ WORKERS — Vercel functions           │───────────┘
                        │ capture/process: claim → vision →    │
                        │   embed(query) → retrieve → reason → │
                        │   persist(txn) → embed(document)     │
                        │ batch/sweep • collections/discover • │
                        │ embeddings/backfill • health • PA    │
                        └──────────────┬───────────────────────┘
                                       │ server-side provider calls (keys in server env)
                                       ▼
                  GROQ (vision qwen3.8-27b · reasoning gpt-oss-120b)
                  NVIDIA (embeddings llama-nemotron-embed-vl-1b-v2)
                  OPENROUTER (fallbacks — off by default)
```

## 26. Technology decisions (locked for V1)

| Layer | Decision | Notes |
|---|---|---|
| Frontend | **Next.js (App Router) + TypeScript**, Tailwind | Vercel-native; UI details Phase 7 |
| API | **Next.js route handlers** + Postgres RPC functions | No separate backend service |
| Jobs | **Inngest** (free tier), encapsulated | Alternatives documented (§8); revisit Vercel Workflows later |
| Database | Supabase Postgres + **pgvector** | Phase 2 schema (+R1–R4 refinements) |
| Storage | Supabase Storage, private bucket, signed URLs | Direct browser uploads |
| Auth | Supabase Auth (magic link/OTP), `@supabase/ssr` | Signups closed after setup |
| AI | Groq + NVIDIA + (OpenRouter standby) | Phase 3 contracts; model IDs = config |
| Validation | Schema validation library (zod-class) | At implementation |
| Observability | Inngest traces + DB fields + platform logs | No extra vendors |

## 27. Decisions deferred to Phase 5+

- PA report structure/storage/delivery (Phase 5 owns; `pa_reports` flagged as the expected single new table)
- Learning signals ingestion (Phase 6); UI/UX specifics (Phase 7); build plan & sequencing (Phase 8); test strategy (Phase 9)
- Realtime upgrade decision (only if polling proves insufficient)

## 28. Decisions deferred to implementation

- Exact concurrency numbers (start: 4 / 1) and retry/backoff values; stuck threshold (15 min); abandon TTL (24h)
- Polling cadence final tuning (start ~3s)
- Region selection (Vercel + Supabase) and project setup
- Signed-URL TTLs; rate-limit numbers (start: 60 init/hour, 200 captures/day); kill-switch flag naming
- Provider account provisioning (Groq ZDR, NVIDIA key), env layout, domain, Inngest app setup
- Whether dedupe hints at upload-time include a "skip processing" option (UX call, Phase 7)

---

_Phase 4 complete — architecture defined, nothing implemented. Next: Phase 5 — Personal Assistant / PA Architecture (awaiting go-ahead)._
