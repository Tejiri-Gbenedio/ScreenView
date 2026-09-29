# Phase 8 — Build Plan & V1 Implementation Architecture: ScreenView

| | |
|---|---|
| **Project** | ScreenView |
| **Phase** | 8 — Build Plan & V1 Implementation |
| **Status** | ✅ Complete |
| **Date** | 2026-09-29 |
| **Next phase** | Phase 9 — Actual Implementation |

This document converts the locked architecture (Phases 1–7) into an **implementation roadmap**: what exactly we build, in what order, and the smallest path to a working ScreenView V1. It is **not** implementation — no code, no packages, no migrations, no deployments, no provider configuration. Phases 1–7 were inspected; no implementation conflicts found. One roadmap note: the original Phase 9 ("Testing & Iteration") is folded into this plan's testing strategy and stage gates — Phase 9 is now **Actual Implementation**.

---

## 1. V1 success definition

**V1 succeeds when the loop works end-to-end, privately, for one real person on phone and laptop:**

> screenshot it → add a note if you want → ScreenView remembers **why** you saved it, organizes it, connects it, and quietly resurfaces what matters.

### Must-have (V1 ships only with these)

| # | Capability | Success test |
|---|---|---|
| M1 | **Capture** — upload screenshot(s) + optional note from phone and laptop, zero required metadata | A capture completes from both devices without friction |
| M2 | **Processing** — automatic pipeline (vision → query embed → retrieval → reasoning → memory → document embed) with visible states, retries, checkpointed resume | A screenshot becomes a structured memory without intervention; failures are recoverable and never lose originals |
| M3 | **Memories** — browse list + detail; "You said vs ScreenView thinks"; corrections (intent/topic/action/status/title/summary/note) with history | A user can inspect and fix any interpretation in one or two taps |
| M4 | **Search** — natural-language semantic search + filter chips | "shoes I wanted to buy" finds the right items without exact words |
| M5 | **Connections** — suggested relationships (same_subject/complementary/thematic) with confirm/dismiss | Related memories are discoverable and suggestions are not noise |
| M6 | **Collections** — evidence-based suggestions, accept/rename/dismiss, membership, project badge | Groups emerge without manual filing |
| M7 | **PA** — twice-weekly quiet report (reminders/patterns/projects/recall), in-app, per-item actions | Useful, calm, correct items — and silence when there's nothing |
| M8 | **Learning** — signal recording, `learned_patterns`, soft context into reasoning, user controls (list/reset/pause) | Interpretation measurably improves from corrections without overfitting |
| M9 | **Privacy & safety** — private storage, RLS everywhere, server-only keys, deletion cascades, cost guards | No public objects, no key exposure, deletions complete, spend bounded |

### Nice-to-have (built when cheap, never blocking)

Swipe gestures and long-press quick actions · hover secondary card info · "why it matched" search lines · PWA share-sheet capture target · richer PA history views · snooze options (1 week / 1 month) · any AI-assisted learning summaries.

### Deferred (explicitly not V1)

Conversational Q&A / chat · data export · email or push notifications · knowledge-graph visualization · natural-language corrections · near-duplicate pHash detection · extra fallback models beyond the wired set · multi-user, sharing, or team features of any kind.

## 2. Implementation principles (build rules)

1. **Vertical slices.** Every stage ends with something usable end-to-end — never a big-bang integration.
2. **Ship usable pieces early.** The first milestone is the smallest version that proves the loop (§8).
3. **Deterministic before AI.** SQL does selection/counting/gating; LLMs synthesize selected evidence only (Phases 3/5/6 rule).
4. **Originals-first durability.** Screenshot + note are persisted before any AI call; every step is idempotent and resumable.
5. **Private by default.** RLS on from the first migration; private buckets; keys server-side only; nothing public.
6. **Measure before improving.** Metrics and failure visibility from day one; thresholds tuned with real data, not guesses.
7. **One dependency at a time.** Each package added is minimal, pinned, and smoke-tested the day it lands.
8. **Follow the docs; log deviations.** Phases 1–8 are the spec; any deviation is recorded in PROJECT_PLAN/log before it happens.
9. **The app owns its pipeline.** No n8n / Zapier / Make / workflow platforms — ever.
10. **Guardrails before features.** Cost caps, kill switch, and ZDR/data controls are configured during foundation, not after.

## 3. Final tech stack (locked)

| Layer | Choice | Notes |
|---|---|---|
| **Frontend** | Next.js (App Router) + TypeScript + Tailwind CSS | Mobile-first responsive; PWA-installable |
| **Backend** | Next.js route handlers (Vercel functions) + Postgres RPC functions | No separate service; atomic ops via RPC |
| **Database** | Supabase Postgres + **pgvector** | HNSW, cosine; RLS everywhere |
| **Storage** | Supabase Storage — private bucket `captures` | Signed upload/download URLs; `{user_id}/{capture_id}.{ext}` |
| **Jobs** | **Inngest** | Durable steps, per-step retries, concurrency caps, cron, debounce |
| **AI (eyes)** | Groq `qwen/qwen3.8-27b` | JSON mode; preview status — fallback wired |
| **AI (brain)** | Groq `openai/gpt-oss-120b` | Strict structured outputs (constrained decoding) |
| **AI (fallbacks)** | OpenRouter `qwen/qwen3-vl-8b-instruct` · `openai/gpt-oss-120b` (off by default) · Groq `gpt-oss-20b` (auto) | Per Phase 3 §17 |
| **Embeddings** | NVIDIA `llama-nemotron-embed-vl-1b-v2` | 2048-dim multimodal; hosted API |
| **Hosting** | Vercel (single region near the user) | Hobby (personal, non-commercial — fits) |
| **Auth** | Supabase Auth (email magic link/OTP) + `@supabase/ssr` | Signups disabled after owner's account exists |
| **Search** | pgvector KNN via RPC + SQL filters | No external search service |
| **UI** | Tailwind + minimal headless primitives | Small hand-rolled component set; no heavy kit |
| **Analytics** | None in V1 | Product metrics live in the DB (privacy-first) |
| **Monitoring** | Inngest dashboard + Vercel logs + DB fields (`last_error`, `attempt_count`, provenance fields) | Sentry-class tooling deferred |
| **Testing** | Vitest (unit) · Playwright (E2E smoke) · manual checklists · tiny AI-eval fixtures | Practical, not ceremonial |

Supporting libraries (added at Stage 1, kept minimal): `zod` (validation), `@supabase/supabase-js` + `@supabase/ssr`, `inngest`, provider SDKs via `fetch` or thin clients, date helpers.

## 4. Repository structure

```
ScreenView/
├── app/                    # Next.js App Router
│   ├── (app)/              # authed shell: memories, collections, assistant, settings
│   ├── welcome/            # first-run onboarding
│   ├── api/                # route handlers (captures, memories, search, pa, learning, inngest)
│   └── layout.tsx
├── components/             # memory card, detail sections, sheets/pickers, nav
├── lib/                    # clients (supabase, providers), validation, formatting, shared utils
├── server/                 # server-only services: captures, memories, corrections, search, learning
├── inngest/                # job functions: capture/process, batch/sweep, collections/discover,
│                           #   embeddings/backfill, maintenance/health, pa/report, learning/consolidate
├── supabase/               # migrations + config (forward-only; created at Stage 1)
├── types/                  # DB row types + contract types (vision/memory/PA JSON)
├── tests/                  # unit, e2e, ai-eval fixtures
├── docs/                   # phase docs (existing)
└── (root configs: package.json, tsconfig, tailwind, next.config, vercel.json if needed)
```

Rules: one obvious home per file kind; `server/` code never imported by client components; job files import services, never the reverse; no `src/` nesting; repo stays a single Next.js app (no monorepo).

## 5. Environment variables (names + purpose only)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key (safe; RLS protects data) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; job writes + privileged operations |
| `GROQ_API_KEY` | Server-only; vision + reasoning calls |
| `NVIDIA_API_KEY` | Server-only; embedding calls |
| `OPENROUTER_API_KEY` | Server-only; optional fallback (off by default) |
| `INNGEST_EVENT_KEY` | Server-only; enqueue events |
| `INNGEST_SIGNING_KEY` | Server-only; verify the job endpoint |
| `APP_URL` | Canonical URL (links, emails) |
| `VISION_MODEL_ID` · `REASONING_MODEL_ID` · `EMBEDDING_MODEL_ID` | Model IDs as configuration (Phase 3 rule) — with built-in defaults |
| `PROCESSING_PAUSED` | Ops kill switch for AI steps |

No secrets in the repo; all values live in Vercel env (production scope) and local `.env.local` (git-ignored, already covered by `.gitignore`).

## 6. Build stages

| Stage | Name | Delivers | End-of-stage test |
|---|---|---|---|
| 1 | **Foundation** | App scaffold (Next.js+TS+Tailwind), Supabase project + schema v1 (all tables incl. refinements R1–R4 + A1–A3), RLS + storage bucket, auth wiring, Inngest wiring, deploy skeleton, envs, cost guards | Deployed skeleton: login works; health check green; empty app shell loads |
| 2 | **Capture** | Capture init/complete APIs, signed upload flow, capture tray (desktop + mobile), Memories list with upload states, cancellation/retry | Phone + laptop can submit captures that land as `uploaded` records with intact files |
| 3 | **Processing** | Full `capture/process` pipeline (vision → query embed → retrieval stub → reasoning → persist → document embed), provider clients, contract validation, state machine, retries, failure handling | Screenshot → structured memory, end-to-end, unattended — **Milestone M1** |
| 4 | **Memories** | Memory cards, detail (4 sections), corrections (+ history timeline), intent UX, "You said vs ScreenView thinks" language | Full core loop usable daily — **Milestone M2** |
| 5 | **Search** | Real retrieval: query embedding, KNN RPC, filters, search UI, empty/error states | Natural-language search finds memories without exact words — **M3** |
| 6 | **Connections** | Connection persistence + gating from reasoning, Related section, confirm/dismiss, debounced `batch/sweep` | Related memories surface; suggestions are not noise |
| 7 | **Collections** | Discovery job + evidence thresholds, suggestion UI, membership, project candidates, naming context | Collections emerge, accept/rename/dismiss all work — **M4** |
| 8 | **PA** | Detectors, `pa/report` job (quiet gate + synthesis + validation), Assistant UI, item actions → feedback | Twice-weekly report works; quiet periods are silent — **M5** |
| 9 | **Learning** | Signal ingest RPC, `learned_patterns` lifecycle, decay/consolidation job, personal-context injection, settings list/reset/pause | Corrections visibly improve future interpretations; safeguards hold |
| 10 | **Polish & Hardening** | Empty/failure states, first-session journey, PWA touches, deletion flows verified, cost controls verified, eval fixtures green, runbook | V1 ready — **M6** |

## 7. Stage dependencies

```
S1 Foundation
 └─► S2 Capture ─► S3 Processing [M1] ─► S4 Memories [M2] ─┬─► S5 Search [M3]
                                                           ├─► S6 Connections ─► S7 Collections [M4]
                                                           │        └──────────┬─► S8 PA [M5] ─► S9 Learning
                                                           └───────────────────┘        │
S10 Polish (needs S3–S9 complete; may interleave small polish items from S4 onward) ◄──┘
```

Notes: Search (S5) needs embeddings from S3 but nothing from S4–S4's corrections; Connections need memories + reasoning output; Collections need connection sweeps; PA needs memories/connections/collections for evidence (reminders technically could start after S4, but keeping the PA together avoids half-features); Learning needs real signals from S4+ and PA feedback from S8. **Nothing builds before its dependency** — no collections code before connections exist, no learning rules before signals exist.

## 8. First working milestone (M1 — the smallest usable version)

**"Upload → process → memory → view" works end-to-end on phone and laptop.**

Definition of done:
1. Capture from both devices completes (bytes in private storage, note intact).
2. The pipeline runs unattended: vision → retrieval → reasoning → memory persisted → embedding stored.
3. The capture's card flips Uploading → Understanding… → Ready, with Retry on failure; originals never lost.
4. A minimal memory view shows: screenshot, your note, and ScreenView's understanding (title/topic/intent/action).
5. Every step is idempotent; a mid-pipeline failure resumes safely on retry.

This milestone proves the entire product thesis; everything after it is depth (better UX, organization, proactivity, learning).

Further milestones: **M2** full memory experience (cards/detail/corrections) · **M3** search · **M4** organization loop (connections + collections) · **M5** proactivity (PA) · **M6** V1 ready (learning + hardening).

## 9. Sprints (build order)

Sprints are content-defined, not calendar-bound (personal-first project).

**Sprint 1 — Foundation.** *Deliverables:* scaffold, schema v1 migration (forward-only), RLS policies, storage bucket + policies, auth (single user), Inngest app wiring, deploy skeleton, env layout, kill switch + caps configured. *Dependencies:* none. *Risks:* schema errata (mitigate: apply all documented refinements at creation); Supabase region/pause caveats (choose region; active use); signed-URLs not yet exercised (S2).
**Sprint 2 — Capture.** *Deliverables:* capture init/complete endpoints, signed upload flow, tray UI (both devices), list with upload states, cancel/retry. *Dependencies:* S1. *Risks:* mobile picker quirks (test on device early); upload edge cases (size/mime rejects).
**Sprint 3 — Processing.** *Deliverables:* pipeline job with all steps + contract validation + state machine + retries; provider clients; failure surfacing. *Dependencies:* S2 + provider keys. *Risks:* vision model availability/preview churn (fallback + config); structured-output discipline on fallback paths; cost guards verified live.
**Sprint 4 — Memories.** *Deliverables:* card + detail (4 sections), corrections (all fields + note edit R1), history timeline, intent UX. *Dependencies:* S3. *Risks:* correction event wiring (single transaction), mobile sheet polish.
**Sprint 5 — Search.** *Deliverables:* query embedding + KNN RPC, filters, search UI, states. *Dependencies:* S3 (embeddings). *Risks:* relevance tuning (fixtures + real use); empty-result handling.
**Sprint 6 — Connections.** *Deliverables:* suggestion persistence + gating, Related UI, confirm/dismiss, batch sweep. *Dependencies:* S3/S4. *Risks:* precision (thresholds); duplicate suppression correctness.
**Sprint 7 — Collections.** *Deliverables:* discovery job (evidence thresholds), suggestions/accept/rename/dismiss, membership, projects. *Dependencies:* S6. *Risks:* premature grouping (thresholds); naming quality.
**Sprint 8 — PA.** *Deliverables:* detectors, report job (quiet gate, synthesis, validation), Assistant UI, actions/feedback. *Dependencies:* S6/S7. *Risks:* noise (conservative defaults), wording discipline (fact/inference), cadence behavior.
**Sprint 9 — Learning.** *Deliverables:* ingest RPC, patterns + confidence/decay, consolidation job, context bundle injection, settings controls. *Dependencies:* S4+/S8 (signals). *Risks:* overfitting (diversity rules), loop safeguards verified with fixtures.
**Sprint 10 — Hardening & Polish.** *Deliverables:* empty/failure states, first-session flow, deletion verification, PWA touches, cost-control verification, AI eval fixtures green, runbook. *Dependencies:* S3–S9. *Risks:* scope creep — stick to the checklist; ship.

## 10. Schema implementation order (no SQL)

| Wave | When | Tables/fields | Notes |
|---|---|---|---|
| 1 | S1 | `captures` (incl. R1 status states + R2 operational columns), `memories` (incl. R3 `perception` jsonb + P5 `pa_state` + R4 action vocab), `memory_events` (incl. R1 `note_change`), `memory_embeddings` (`vector(2048)`) | Core loop schema; RLS + indexes from the start |
| 2 | S1 | `connections`, `collections` (incl. P5 `kind`), `collection_members` | Created in migration 1 (cheap) even though used from S6–S7 |
| 3 | S1 | `pa_reports` | Created early; used from S8 |
| 4 | S1 | `learned_patterns` | Created early; used from S9 |

One forward-only migration set at Stage 1 (all tables, RLS, indexes, constraints, RPC skeletons as needed per sprint) — creating tables ahead of their sprint costs nothing and avoids migration churn; **no destructive changes anywhere**, and nothing is optional (all tables serve the V1 scope).

## 11. API implementation order (conceptual)

1. **S2:** `POST /api/captures` (init + signed URL) · `POST /api/captures/{id}/complete` · `GET /api/captures/{id}` · `GET /api/captures`
2. **S3:** `POST /api/inngest` (jobs) · `POST /api/captures/{id}/retry`
3. **S4:** `GET /api/memories` · `GET /api/memories/{id}` · `PATCH /api/memories/{id}` (corrections) · `DELETE /api/captures/{id}`
4. **S5:** `POST /api/search`
5. **S6:** connection confirm/dismiss
6. **S7:** collection endpoints (list/accept/dismiss/rename, membership add/remove)
7. **S8:** `GET /api/pa/reports` · `GET /api/pa/reports/{id}` · `POST /api/pa/reports/{id}/seen` · `POST /api/pa/items/{id}/action`
8. **S9:** learning endpoints (list/reset/pause)

Each endpoint ships with its feature slice only — no speculative routes, no versioning ceremony.

## 12. UI implementation order (conceptual)

App shell + nav (S1–S2) → capture tray/sheet (S2) → Memories list + states (S2–S3) → memory detail + corrections + history (S4) → search view (S5) → Related section (S6) → collections views (S7) → Assistant (S8) → settings + learning controls (S9) → polish pass: empty/failure states, first-session, PWA touches (S10). Mobile patterns (§18 of Phase 7) land with each feature, not afterwards.

## 13. AI implementation order

1. **Vision** (Groq Qwen) + contract validation — S3
2. **Query embedding** (NVIDIA) — S3
3. **Retrieval** (SQL/RPC — started as a stub for context cards in S3; matured in S5)
4. **Reasoning** (Groq GPT-OSS, strict schema) + memory persistence transaction — S3
5. **Document embedding** — S3
6. **Connection reasoning** (same call + gating) — S6
7. **Collection synthesis call** — S7
8. **PA synthesis call** — S8
9. **Learning** (no new LLM; deterministic first) — S9

Fallbacks wired as primaries stabilize: vision → OpenRouter Qwen3-VL (S3, tested once); reasoning → `gpt-oss-20b` (S3); OpenRouter reasoning off-by-default, verified at S10. Every prompt/contract change runs the eval fixtures (§17).

## 14. Retrieval implementation order

Prerequisites: memory rows exist; embeddings exist for the current model; KNN RPC in place. Order: `memory_embeddings` schema + RPC skeleton (S3) → context-card retrieval used by reasoning (S3) → full query path: user search with filters (S5) → connection candidate retrieval matured (S6) → PA uses SQL-first, vector only when semantics required (S8). Guardrail: **no semantic search UI before embedding backfill safety exists** (missing vectors must degrade gracefully).

## 15. Learning implementation order

1. Raw signal recording (already inherent in S4 corrections + S6/S7/S8 actions) — free.
2. Ingest RPC (evidence counters, threshold detection) — S9.
3. `learned_patterns` lifecycle (tentative→established, contradictions, statuses) — S9.
4. Personal-context bundle injection into reasoning (≤5–6 lines) — S9.
5. Decay + consolidation job (daily) — S9.
6. Settings controls (list / reset / pause) — S9.
7. AI-assisted summaries/merges — deferred beyond V1.

## 16. PA implementation order

1. Detectors (reminders, patterns, projects, recall — all SQL) — S8.
2. `pa/report` job: gating (cooldowns/suppression/caps) + quiet-period handling — S8.
3. Synthesis call + grounding validation — S8.
4. Assistant UI + item actions + feedback wiring — S8.
5. Earlier-reports history — S8 (basic) / S10 (polish).
Deferred: email/push delivery, ad-hoc "generate now", richer snooze options.

## 17. Testing strategy (practical)

- **Unit (Vitest):** pure logic where bugs cost money or trust — eligibility rules, cooldown/decay math, contract parsers/validators, state transitions, gating filters.
- **Integration:** DB/RPC behavior against a dev Supabase (constraints, cascades, idempotent RPCs), job steps with mocked providers, and the four classic idempotency scenarios (double complete, retry after crash, duplicate enqueue, provider timeout).
- **E2E smoke (Playwright):** login → capture fixture image → processing (dev/stubbed provider mode) → memory visible → one correction → one search. Runs before each "ship" checkpoint, not on every commit.
- **AI evaluation (small, real):** ~10–20 fixture captures with expected topic/intent/action; measure contract validity + accuracy on clear cases after any prompt/model change; results logged in a markdown file. Not a framework — a script and a log.
- **Manual:** per-sprint checklist on phone + laptop (states, empty states, failure paths, mobile gestures).
Rule: test where failure hurts; skip ceremony where it doesn't.

## 18. Evaluation metrics (what we watch)

| Metric | Why | Source |
|---|---|---|
| Capture success rate | Frictionless promise | captures table |
| Processing success + retry rate + median time-to-ready | Pipeline health | captures/job data + Inngest traces |
| Correction rate per memory | Interpretation quality | memory_events |
| Search usage + result opens | Recall usefulness | API + events |
| Suggestion accept/dismiss rates (connections/collections/PA) | Noise vs value | states + interactions |
| Reminder action vs ignore rate | PA usefulness | pa_reports interactions |
| Quiet-period ratio | Quietness honored | pa_reports |
| Cost per capture | Budget health | provider dashboards |

V1: SQL queries + dashboards-of-one (manual); no analytics product.

## 19. Risks & mitigations

| Category | Risk | Mitigation |
|---|---|---|
| Technical | Vision model is **preview** status; provider churn | Model IDs as config; OpenRouter fallback wired + tested; smoke test on deploy |
| Technical | Strict-schema gaps on fallback paths | Server-side validation + repair retry; contracts are the source of truth |
| Technical | Supabase free tier pauses after 1 week idle | Active use; documented resume procedure in runbook |
| Technical | Signed upload edge cases (mobile) | Exercised in S2 on real devices before pipeline work |
| Product | Suggestions become noise (connections/collections/PA) | Conservative thresholds; quiet gates; accept/dismiss telemetry |
| Product | Trust erosion (inference presented as fact) | "You said vs ScreenView thinks" enforced in UI + validation |
| AI | Hallucinated intent | Hierarchy + `unknown` allowed + evidence validation + corrections cheap |
| AI | Embedding model is document-focused | Text channel carries semantics; monitor relevance in S5 |
| UX | Capture friction regressions | Single-Save discipline; no required fields; device checks each sprint |
| Cost | Runaway loops / accidental spend | 200/day cap, concurrency caps, retry caps, sequential fallbacks, budget alerts, kill switch |
| Privacy | Screenshot or key exposure | Private bucket + RLS + signed URLs; server-only secrets; ZDR toggle |
| Scope | Personal-project scope creep | Anti-scope list (§22) + stage gates |

## 20. Cost estimates (rough, list prices as verified in Phase 3)

Per capture: vision ≈ $0.003–0.005 · reasoning ≈ $0.0012 · embeddings ≈ small (NVIDIA pricing to confirm at signup) → **≈ $0.006–0.010 per capture**.

| Volume | AI (Groq + NVIDIA) | Storage (screenshots, ~2MB avg) | Infra |
|---|---|---|---|
| 100 captures | ≈ $0.6–1.0 | ~0.2 GB (free tier) | $0 (free tiers) |
| 500 captures | ≈ $3–5 | ~1 GB — at Supabase free-tier storage limit | $0–25 (Pro only if needed) |
| 1,000 captures | ≈ $6–10 | ~2 GB — likely Supabase Pro ($25/mo) or pruning | Inngest free tier still ample (~5k captures/mo) |

PA/sweeps/backfills add < $0.10/month at personal scale. Billing alerts set at all providers; monthly budget review in the runbook.

## 21. Deployment order

1. **Local** — full stack against dev keys; Inngest dev server; mocked providers for E2E.
2. **Preview** — Vercel preview deploys; **no production job processing** (separate Inngest env; prod keys only in production scope).
3. **Private V1** — production deploy, single user, signups closed, real captures. **This is the goal.**
4. **Public** — not planned; would require multi-user hardening (explicitly out of scope).

## 22. Anti-scope (what not to build)

No chat/Q&A interface · no knowledge-graph UI · no folders · no tasks/project management · no calendar · no email integration · no social/collaborative features · no analytics dashboards · no gamification · no heavy settings · no AI personality configuration · no natural-language corrections (V1) · no data export (V1) · no email/push notifications (V1) · no multi-user · no model fine-tuning · no extra infrastructure beyond Supabase + Vercel + Inngest + providers · no native apps · no premature optimization.

## 23. Implementation readiness

**Are we ready to build? Yes — pending only setup logistics, no architectural blockers.**

- All architecture locked: product (P1) · data (P2) · AI (P3) · application (P4) · PA (P5) · learning (P6) · UX (P7) · build plan (P8).
- Refinements to apply **at migration time** (all documented, none executed): R1 status states + `note_change`; R2 operational columns; R3 `perception`; R4 action vocab; A1 `kind`; A2 `pa_state`; A3 `pa_reports`; P6 `learned_patterns`.
- Setup prerequisites (Phase 9 kickoff checklist): Supabase project + region choice; Groq account (+ZDR toggle); NVIDIA API key (+terms/pricing confirm); Inngest app; Vercel project + envs; domain (optional).
- No blockers remain. Phase 9 begins with Sprint 1 upon explicit go-ahead.

---

_Phase 8 complete — build plan defined, nothing implemented. Next: Phase 9 — Actual Implementation (awaiting go-ahead)._
