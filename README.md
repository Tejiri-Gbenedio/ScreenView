# ScreenView

**A personal AI second brain built around screenshots.**

ScreenView lets you dump screenshots (with an optional note) and lets the system do the remembering and organizing for you — what each capture is, why you saved it, what it relates to, and what might come next.

> "I shouldn't have to organize my life for the AI. I should just be able to dump things into it, and it should do the remembering and organizing for me."

**Mental model:** Capture → Memory → Connection → Collection → Action

## Status

- **Phase 1 — Product Definition:** complete — see [`docs/phase-1-product-definition.md`](./docs/phase-1-product-definition.md).
- **Phase 2 — Data & Memory Architecture:** complete — see [`docs/phase-2-data-memory-architecture.md`](./docs/phase-2-data-memory-architecture.md).
- **Phase 3 — AI Architecture:** complete — see [`docs/phase-3-ai-architecture.md`](./docs/phase-3-ai-architecture.md).
- **Phase 4 — Application & Processing Architecture:** complete — see [`docs/phase-4-application-processing-architecture.md`](./docs/phase-4-application-processing-architecture.md).
- **Phase 5 — Personal Assistant / PA Architecture:** complete — see [`docs/phase-5-personal-assistant-architecture.md`](./docs/phase-5-personal-assistant-architecture.md).
- **Phase 6 — Personal Learning Architecture:** complete — see [`docs/phase-6-personal-learning-architecture.md`](./docs/phase-6-personal-learning-architecture.md).
- **Phase 7 — Interface & UX Architecture:** complete — see [`docs/phase-7-interface-ux-architecture.md`](./docs/phase-7-interface-ux-architecture.md).
- **Phase 8 — Build Plan & V1 Implementation:** complete — see [`docs/phase-8-build-plan.md`](./docs/phase-8-build-plan.md).
- No application code yet (by design). Next up: Phase 9 — Actual Implementation.
- Full roadmap and working rules: [PROJECT_PLAN.md](./PROJECT_PLAN.md).

## How it is meant to work

1. **Capture** — screenshot + optional note → upload → done. No folders, categories, or tags at capture time.
2. **Memory** — the AI reads the screenshot (*what*) and the note (*why*) and builds a structured memory.
3. **Connection** — related memories get linked, even across different topics.
4. **Collection** — meaningful collections emerge from usage; a capture can belong to several.
5. **Action** — the PA helps you follow through (buy, research, try, build, read, …) at a calm weekly cadence.

## Architecture (locked through Phase 4)

GitHub → Next.js app on Vercel (frontend + API) → Supabase (Postgres, Storage, pgvector) → background processing via Inngest → AI services: Groq (vision + reasoning) and NVIDIA (embeddings); fallbacks via OpenRouter where justified. The PA runs as a scheduled report job (Mon & Thu) — deterministic detectors, one synthesis call, delivered in-app. Personal learning uses one `learned_patterns` table — structured signals + contextual hints into reasoning, no fine-tuning. The UX (Phase 7) is capture-first — 3 areas + one capture action — with a “You said vs ScreenView thinks” language throughout.

ScreenView is a real software application — it is **not** an n8n / Zapier / Make workflow project.

## Repository layout

- `README.md` — this file
- `PROJECT_PLAN.md` — roadmap, working rules, decisions, guardrails
- `docs/` — phase documentation (product, architecture, design)
