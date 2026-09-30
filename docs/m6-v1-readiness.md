# ScreenView — V1 Readiness (M6)

**Status: V1-ready for real personal use** (single-user personal deployment). All six milestones (M1–M6) implemented and production-verified; 126 unit tests; lint/typecheck/build clean.

Live: https://screenview-two.vercel.app

## Product capabilities

| Capability | State | Notes |
|---|---|---|
| Capture | ✅ | Drag/drop, paste, file picker (desktop); camera/library + bottom-sheet flow (mobile); optional note; batch uploads; signed direct-to-storage uploads; 20MB cap; png/jpeg/webp. |
| Processing | ✅ | Durable Inngest pipeline: claim → vision (Groq) → query embedding → retrieval → reasoning (GPT-OSS) → memory persist → connections → document embedding. Non-fatal degradation per stage; retries + checkpoint reuse. |
| Memories | ✅ | List + detail; “You said” vs “ScreenView thinks”; one-tap corrections with history; original screenshot via signed URLs; delete (memory page + stuck/failed items in list). |
| Search | ✅ | Natural-language semantic search (pgvector KNN + exact-topic supplement), intent/topic/action/status filters, empty/failure states, RLS-scoped, ≤12 results. |
| Connections | ✅ | AI-judged suggestions only (confidence floor + required basis; similarity alone never links); confirm/dismiss; canonical ordering; pair-level dedupe; dismissed pairs stay dismissed. |
| Collections | ✅ | Deterministic discovery (≥3 memories, ≥2 independent signals, 60-day window); accept/dismiss/rename/archive; multiple membership; dismissal cooldowns. |
| Projects | ✅ | `kind='project'` with strict criteria (≥4 memories, ≥2 build signals, ≥7-day spread, coherence); never auto-created; no tasks/milestones by design. |
| Personal Assistant | ✅ | Mon+Thu 18:00 WAT Inngest cron; deterministic detectors (reminders 14/21/30d + cooldowns/suppression, patterns, project candidates, recall); ≤5 items; quiet periods with **zero** LLM calls; evidence chips; Complete/Dismiss/Snooze/Keep-active — the PA never modifies memories itself. |
| Personal Learning | ✅ | Daily consolidation (03:00 WAT); deterministic cases from user actions only (AI inference weight 0; accepts ×0.4; ignored ≠ rejected); tentative/established thresholds; half-life decay; expiry; scoped suppressions (connections/collections/PA); ≤6-line context bundle into reasoning only; the current note always wins. |

## Reliability

- **Retries:** Inngest function retries + attempt-aware event IDs (double-click dedupe; retries re-triggerable).
- **Checkpoint resume:** vision result reuse via stored perception (verified: 597ms resume vs 10.6s fresh); claim-step guards.
- **Idempotency:** duplicate events ignored; duplicate completes no-op; atomic `claim_capture` prevents double processing.
- **Failure recovery:** every failed capture is retryable; stuck-state recovery added in M6 (`uploaded`-never-enqueued and stale `processing` recover via Retry with unique ids); state machine never permanently stuck.

## Security

- **RLS** on every user-owned table (captures, memories, memory_events, connections, collections, collection_members, memory_embeddings, pa_reports, learned_patterns) — verified with a second user + anonymous probes.
- **Private storage** — the `captures` bucket is private; access strictly via short-lived signed URLs; public access denied.
- **Server-only secrets** — service-role + provider keys never reach the browser (client-bundle scans clean); `.env.*` files gitignored; repo secret-scan clean.
- **Authentication** — every API route validates the session; user ids come from the session, never from input; deletion/report/pattern access is owner-scoped.

## Cost

- 20MB upload cap; **200 captures/day** soft cap; retry caps (6 attempts then manual retry only); retry/attempt guards.
- **Kill switch**: `PROCESSING_PAUSED=1` halts new processing.
- **PA quiet gate**: zero reasoning calls when nothing qualifies (verified live).
- **Learning**: fully deterministic — no model calls, ever.
- Embeddings are upserted per memory/model (no regeneration loops).

## UX

- Desktop + mobile layouts (responsive, no horizontal overflow); capture tray/bottom sheet; touch-friendly targets.
- Visible keyboard focus styles; labeled inputs; `role=status` notices; error boundaries + not-found page.
- Safe failure states everywhere: upload/processing/search/AI failures show plain-language messages (no stack traces, provider internals, or DB errors); session expiry redirects to login; deleted memories 404 calmly.

## Production

- **Vercel** — pushes to `main` auto-deploy; production envs configured.
- **Supabase** — schema via `supabase/migrations/` (single forward-only set); auth allowlist configured.
- **Inngest** — 6 functions registered: capture-process (+failure handler), pa-schedule (cron), pa-generate, learning-schedule (cron), learning-consolidate.
- **Providers** — Groq (vision/reasoning), OpenRouter (embeddings). Model IDs configurable via env.

## Known limitations (honest list)

1. **Embedding endpoint (current environment):** `nvidia/llama-nemotron-embed-vl-1b-v2:free` via OpenRouter is a **development/testing provider — its free tier logs inputs**. Not appropriate for sensitive/private data long-term. The host is config-swappable (same 2048-d model → no schema change, no redesign).
2. **Collections discovery runs on screen load** — is not yet a scheduled job; the first Collections visit after new evidence adds a few seconds while one naming call runs (deterministic when nothing qualifies).
3. **Schedules depend on Inngest Cloud** (free tier); all jobs can also be triggered manually via events (`pa/generate`, `learning/consolidate`) and the capture pipeline via `capture/complete`.
4. **Conservative learning:** positive generalization from accepted suggestions is intentionally limited (suppression-only) in V1; explicit-preference acquisition UI is deferred (data model ready).
5. **In-app only:** no email/push notifications and no analytics/monitoring vendors — by design.
6. **English-only UI** in V1.
7. **Single-user product stance:** the architecture is per-user safe, but multi-user product features are out of V1 scope.
8. **Mobile verification** was done via responsive layout + the production browser flow; a physical-device click-through by the owner remains a nice-to-have.
9. Stale `processing` recovery threshold is intentionally conservative (10 minutes).

## Verification evidence (all green)

- Unit tests: **126 passing** (8 files) — contracts, validation, search, connections, collections, PA, learning, capture retry recovery.
- `npm run lint` — no warnings/errors (eslint + next/core-web-vitals).
- `tsc --noEmit` — clean; `npm run build` — clean (includes typecheck + lint).
- Production verifications: M1 (pipeline), M2 (search, 27 checks), M3 (connections/collections, 47 checks), M4 (PA, 50 checks), M5 (learning, 17 checks), M6 smoke (full lifecycle incl. learning signal) + security sweep.
- Test data from verification removed; only the owner's real data remains.
