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
| 1 | Product Definition | In progress |
| 2 | Data & Memory Architecture | Pending |
| 3 | AI Architecture | Pending |
| 4 | Application & Processing Architecture | Pending |
| 5 | Personal Assistant / PA Architecture | Pending |
| 6 | Personal Learning | Pending |
| 7 | Interface & UX | Pending |
| 8 | Build Plan & V1 Implementation | Pending |
| 9 | Testing & Iteration | Pending |

## Phase 1 — Product Definition

Status: **In progress.**

_Output: `docs/phase-1-product-definition.md` (pending)._

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
