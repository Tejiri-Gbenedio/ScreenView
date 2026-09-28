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
| 2 | Data & Memory Architecture | Pending |
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
