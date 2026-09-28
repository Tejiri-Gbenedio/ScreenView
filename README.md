# ScreenView

**A personal AI second brain built around screenshots.**

ScreenView lets you dump screenshots (with an optional note) and lets the system do the remembering and organizing for you — what each capture is, why you saved it, what it relates to, and what might come next.

> "I shouldn't have to organize my life for the AI. I should just be able to dump things into it, and it should do the remembering and organizing for me."

**Mental model:** Capture → Memory → Connection → Collection → Action

## Status

- **Phase 0 — Project Setup:** complete.
- **Phase 1 — Product Definition:** in progress — output lands in [`docs/`](./docs/).
- No application code yet (by design). Full roadmap: [PROJECT_PLAN.md](./PROJECT_PLAN.md).

## How it is meant to work

1. **Capture** — screenshot + optional note → upload → done. No folders, categories, or tags at capture time.
2. **Memory** — the AI reads the screenshot (*what*) and the note (*why*) and builds a structured memory.
3. **Connection** — related memories get linked, even across different topics.
4. **Collection** — meaningful collections emerge from usage; a capture can belong to several.
5. **Action** — the PA helps you follow through (buy, research, try, build, read, …) at a calm weekly cadence.

## Architecture direction (not locked)

GitHub → frontend + backend application (likely Vercel) → Supabase (Postgres, Storage, pgvector) → AI services (Groq; candidates to be finalized in later phases).

ScreenView is a real software application — it is **not** an n8n / Zapier / Make workflow project.

## Repository layout

- `README.md` — this file
- `PROJECT_PLAN.md` — roadmap, working rules, decisions, guardrails
- `docs/` — phase documentation (product, architecture, design)
