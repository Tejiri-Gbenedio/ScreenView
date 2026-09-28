# ScreenView — Project Plan

_Last updated: 2026-09-28_

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
| 3 | AI Architecture | Pending |
| 4 | Application & Processing Architecture | Pending |
| 5 | Personal Assistant / PA Architecture | Pending |
| 6 | Personal Learning | Pending |
| 7 | Interface & UX | Pending |
| 8 | Build Plan & V1 Implementation | Pending |
| 9 | Testing & Iteration | Pending |

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

## Technology direction (candidates — NOT locked)

| Area | Candidate |
|---|---|
| Frontend | Modern responsive web app / PWA — likely deployed on Vercel |
| Backend | Application backend/API — likely on Vercel initially |
| Database | Supabase / Postgres |
| File storage | Supabase Storage |
| Vector search | pgvector |
| Vision / screenshot understanding | Groq Qwen multimodal |
| Reasoning / memory interpretation | Groq GPT-OSS 120B |
| Multimodal embeddings | Llama Nemotron Embed VL (potential) |
| Fallback models | Gemma models / OpenRouter models |

Phase 3 (AI Architecture) and Phase 4 (Application & Processing Architecture) will evaluate and finalize these. **No integrations before then.**

## Phase log

- **2026-09-28 — Phase 0 (Project Setup):** repo initialized (`ScreenView`), initial project structure, README, project plan, `docs/` directory.
- **2026-09-28 — Phase 1 (Product Definition):** product definition documented in [`docs/phase-1-product-definition.md`](./docs/phase-1-product-definition.md); no application code (by design). Next: Phase 2 — Data & Memory Architecture (awaiting go-ahead).
- **2026-09-28 — Phase 2 (Data & Memory Architecture):** data model defined in [`docs/phase-2-data-memory-architecture.md`](./docs/phase-2-data-memory-architecture.md) — 7-table greenfield design, reference DDL only, nothing executed. Next: Phase 3 — AI Architecture (awaiting go-ahead).
