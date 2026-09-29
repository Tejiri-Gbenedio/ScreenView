# Phase 5 — Personal Assistant / PA Architecture: ScreenView

| | |
|---|---|
| **Project** | ScreenView |
| **Phase** | 5 — Personal Assistant / PA Architecture |
| **Status** | ✅ Complete |
| **Date** | 2026-09-29 |
| **Next phase** | Phase 6 — Personal Learning Architecture |

This document defines what ScreenView's Personal Assistant actually **does** with the memories, connections, intent history, collections, and activity signals produced by Phases 1–4. It is architecture only — **nothing is implemented**: no table, no migration, no route, no job, no prompt, no notification. Phases 1–4 remain the source of truth; this phase adds the PA layer on top and documents three small additions (below). No prior-phase redesign was needed; no conflicts were found.

### Refinements to earlier phases (documented, not executed)

- **A1 — `collections.kind`** (`text not null default 'collection'`, CHECK ∈ `collection | project`). Reason: "project" is a *kind of collection* (Phase 5 §13), not a new subsystem; this flag is the minimum needed to distinguish them. Non-destructive.
- **A2 — `memories.pa_state jsonb not null default '{}'`**. Reason: reminder bookkeeping must be queryable by the detectors (last reminded at, snooze until, ignore count, suppression until). Kept as one JSONB field rather than four columns so PA-domain state can evolve (Phase 6 will extend it) without touching the core memory table. Non-destructive.
- **A3 — `pa_reports` table** (the one genuinely necessary new table — full justification and schema in §17). Reason: generated reports must be stored for history, dismissal/feedback, cost control (no regeneration), and reproducibility. Non-destructive (new table).

---

## 1. PA purpose

ScreenView is not primarily a chatbot. The PA is the layer that turns accumulated screenshots and memories into **useful awareness and action**:

**Capture → Memory → Connection → Collection → Action → PA**

The user should never have to ask "What did I save recently?", "What was I planning to do with this?", or "Did I save something related to this?" — the system surfaces those things when useful, on its own. The PA's feeling should be:

> *"I remember the things you saved and why you saved them."*

— not *"Here is an AI-generated productivity dashboard."* The PA stays grounded in the user's captured memories and never becomes a task manager, calendar, chatbot, project-management platform, notes app, habit tracker, or notification machine.

## 2. PA principles

1. **Quiet by default.** Prefer "no useful update" over manufactured observations. The PA is allowed to say nothing.
2. **Deterministic-first.** If SQL can determine it reliably, an LLM does not. Models synthesize *selected evidence*; they never query the database.
3. **Evidence-grounded.** Every PA item traces to specific memories (ids) and signal types. No grounding → no item.
4. **Fact ≠ inference ≠ suggestion.** Three claim types, always distinguishable in wording and metadata (§7).
5. **Suggest, never act.** The PA writes only reports. All state changes come from explicit user actions (§20).
6. **Never nag.** Cooldowns, caps, suppression, snooze — the machinery of restraint (§8, §22).
7. **Nothing fake.** No "insights" invented to fill sections; no confidence theater; no productivity theater.
8. **Grounded in what the user saved** — and in *why* they said they saved it.

## 3. PA inputs

The signals the PA may use, and what each is used for:

| Signal | Used by | Notes |
|---|---|---|
| Memory core fields (title, summary, topic, intent, action, status, timestamps) | All functions | The substrate |
| Original user note (verbatim) | Reminders, project detection, recall | **Quoted, never paraphrased into a system claim** |
| Intent history (`memory_events`) | Wording context, suppression logic, feedback (§9) | Latest intent governs; history is read-only |
| Action + status | Eligibility + suppression (§10) | |
| Connections (suggested + confirmed) | Pattern detection, project coherence, recall | Confirmed weigh more than suggested |
| Collections + membership | Dedupe ("already grouped"), pattern thresholds | |
| Repeated topics / intents / subjects | Pattern detectors (§11) | |
| Completed / dismissed items | Suppression + an "everything else" summary line | Never a feature of its own |
| Ignored suggestions / prior PA items | Cooldowns, escalation (§8, §16) | |
| Corrections | Correct wording; feed Phase 6 | |
| Prior PA reports + item interactions | Dedupe, cooldowns, "seen" tracking | |
| **Excluded:** raw screenshot pixels | — | Never sent to the PA model (consistent with Phase 3 §18) |
| **Excluded:** the full database | — | Only the *selected candidate bundle* reaches the model (§18) |

## 4. V1 capabilities

### 4.1 Evaluation of the ten proposed functions

| # | Proposed | V1 verdict | How it ships / why not |
|---|---|---|---|
| 1 | Things needing attention | ✅ | **Reminders** — aged unresolved intentions (§8) |
| 2 | Unresolved intentions | ✅ | Same engine as #1; the candidate pool is identical, attention = older/stronger subset |
| 3 | Emerging patterns | ✅ | **Pattern items** (§11) |
| 4 | Related memories forgotten | ✅ | **Recall item** (§14) |
| 5 | Repeated interests | ✅ (as subtype) | Pattern detector variant: topic/intent recurrence — same item type as #3 |
| 6 | Potential projects | ✅ (strict) | **Project candidates** (§12) — higher bar than patterns |
| 7 | Things saved for later | ✅ (as subtype) | Reminder subtype with longer age threshold (§8) |
| 8 | Changes in intent | ⛔ V1 | Informational only; surfaces naturally when opening a memory. Proactively announcing "you changed your mind" is noise |
| 9 | Completed/dismissed items | ⛔ as feature | Used for suppression + a light summary line; not a log or a streak |
| 10 | Useful reminders | ✅ | = #1/#2/#7 core |

**Four V1 capabilities:** Reminders (Needs Attention) · Emerging patterns (Emerging) · Project candidates (Emerging, strict) · Proactive recall (Everything Else, incl. saved-for-later).

### 4.2 Shipped capabilities — per-capability detail

**C1 — Reminders ("Have you gotten to this?")**

- *Problem:* saved intentions decay silently; the user forgets what they meant to buy/research/try.
- *Evidence trigger:* actionable intent (user-stated preferred), status open, age past threshold, no prior action, cooldown passed (§8).
- *Data read:* memory fields + intent history + `pa_state` + prior reminders.
- *LLM:* yes — **wording only** (one quote-grounded sentence + a question). Candidate selection is 100% deterministic.
- *Frequency:* at most 2 per report; per-memory cooldown 21 days (doubling on ignore).
- *User sees:* an item quoting their own note + "Still interested?" with actions.
- *Dismiss:* yes (dismiss/complete/snooze/keep active). *Correct:* yes — the intent/action/status can be corrected in place; corrections update what future reports say.

**C2 — Emerging patterns**

- *Problem:* the user is accumulating a direction without noticing (design references, AI tools…).
- *Evidence trigger:* deterministic cluster detection (§11) reaching threshold.
- *Data read:* memories, topics, intents, connections.
- *LLM:* yes — synthesis of the **selected cluster only** into ~1–2 hedged sentences; must cite member memories.
- *Frequency:* ≤2 per report; dismissed patterns cooldown 90 days.
- *User sees:* "You've saved N things around <topic/theme> recently…" with member chips + "Make a collection?".
- *Dismiss:* yes ("not useful") → cooldown. *Correct:* rename/reshape when accepting; dismissals recorded.

**C3 — Project candidates**

- *Problem:* "things I might actually build/do" get lost among plain saves.
- *Evidence trigger:* strict composite (§12); includes at least one *build-flavored* user signal (build intent or an explicit build statement in a note).
- *Data read:* cluster + build signals + connections + time spread.
- *LLM:* yes — candidate *shape* is deterministic; the LLM frames the suggestion (name hint + confidence wording), strictly from the bundle.
- *Frequency:* rare by design; ≤1 per report; 90-day cooldown.
- *User sees:* "These N saves look like they're converging on something you may want to build — want to make it a project?" with "Make a project" / "Just a collection" / "Not now".
- *Dismiss:* yes. *Correct:* the resulting project is a normal collection of kind `project` (renameable, reshapeable).

**C4 — Proactive recall ("Did you forget…?")**

- *Problem:* genuinely relevant old memories that the user isn't looking for.
- *Evidence trigger:* (a) an old memory (≥60 days) that is *related to something saved this week* (connection or strong similarity — deterministic), or (b) a `save_for_later` item past 30 days (summary line). Cap: 1 item.
- *Data read:* timestamps, connections, selected similarity (RPC).
- *LLM:* optional — a single connective sentence ("Related to what you saved this week: …"). Can be deterministic in V1 if wording templates suffice; the call is included in the single synthesis pass anyway.
- *Frequency:* ≤1 per report; each memory resurfaces at most once per 90 days.
- *User sees:* "This is related to something you saved recently — you might have forgotten it." + link.
- *Dismiss:* yes. *Correct:* no correction needed (it's a pointer).

### 4.3 Exclusions (and why)

- Intent-change announcements, completion logs, streaks, scores, "insights" about productivity: none of these are grounded in "why did I save this" — they are dashboard bait. Excluded.
- No mid-period ad-hoc generation in V1 (one scheduled cadence; ad-hoc "generate now" is a possible later nicety).

## 5. PA cadence

Phase 1 established *weekly or twice-weekly*; Phase 4 proposed **Monday & Thursday 18:00 WAT**. **Evaluated and retained** — with three guards:

1. **Emptiness gate:** if the gated candidate set is empty, the run produces a *quiet period* record and surfaces nothing (§6). No manufactured insights.
2. **No daily drift:** two slots per week is the maximum for V1; no per-event notifications.
3. **Configurable:** cadence lives in job config; the default stays Mon/Thu until real usage shows otherwise.

**Output shape:** **one concise report per slot** — not a stream of independent insights, not a live feed. A small, bounded artifact the user can read in under a minute.

## 6. PA report structure

Concepts retained from Phase 1 — with explicit rules:

- **Needs Attention** — reminders (≤2 items). Each: quoted user note + plain question + actions.
- **Emerging** — patterns + project candidates (≤2 items). Each: hedged observation, member memories, one suggestion.
- **Everything Else** — one light line at most (e.g., "2 things you saved for later this week"; a single recall item). Often omitted.

Rules: sections **self-omit when empty**; total ≤ **5 items**; zero items → the report is stored as a *quiet period* (the app may show a subtle "nothing needs your attention") and **no notification of any kind**. The report is written to be read in under a minute; nothing is added to fill space.

## 7. Fact vs inference vs suggestion

Three claim types, distinguished in **wording and metadata** — the brief's core trust rule:

| Type | Meaning | Wording style | Metadata |
|---|---|---|---|
| **FACT** | Something the user said or did | Verbatim quote: *You said: "I want to buy this."* | `claim_type: fact`, `evidence: note excerpt` |
| **INFERENCE** | Something the system observed | Explicitly hedged: *It looks like… / You've saved several…* — never "you want" | `claim_type: inference`, `signals: [...]`, `memory_ids: [...]` |
| **SUGGESTION** | A proposed action | Interrogative: *Want to group these into a collection?* | `claim_type: suggestion`, `action: accept/dismiss` |

Language boundary (enforced at generation): the PA never says "you want", "you plan to", "you're interested in" — those are inferences wearing facts' clothes. Facts are quotes; inferences are observations with sources; suggestions are questions. Each item's metadata always carries its type + grounding ids (§20) so the UI (Phase 7) can label them consistently.

## 8. Reminder architecture

**Candidate creation (deterministic):** a memory is reminder-eligible when:

- `intent` ∈ actionable set and `intent_source` ∈ {`user_statement`, `strong_context`} (user-stated first; strong-context lower priority),
- `status` ∈ {`new`, `active`} (never completed/dismissed/archived),
- age ≥ **minimum age** by intent type (below),
- not snoozed (`pa_state.snoozed_until` ≤ now), not suppressed (`pa_state.suppressed_until` ≤ now),
- last reminder older than the **cooldown** (below).

| Intent | Min age | Rationale |
|---|---|---|
| buy, compare, contact | 14 days | short-horizon intentions |
| research, try, build | 21 days | medium |
| read, watch, save_for_later | 30 days | consume-later items wait longer |

**Resurfacing limits:** per memory ≤ **1 reminder per cooldown**; global ≤ **2 reminders per report**; cooldown default **21 days** (doubles per ignore: 21 → 42 → 84 → suppressed, see expiry).

**Cooldown & ignore escalation:** an item shown and not acted on (no open/complete/dismiss/snooze) within one full period counts as *ignored*; `pa_state.ignore_count` increments. After 2 ignores, the memory is **suppressed for 90 days**; after 3, indefinitely (until the user opens it or its status/intent changes). Reminders therefore *expire* by suppression — the memory itself is never auto-changed.

**Actions per reminder:** *Open* · *Keep active* (acknowledge → resets cooldown, snoozes 30 days) · *Snooze* (30 days; options 1w/1m deferred to Phase 7) · *Mark completed* (status → completed via user event) · *Dismiss* (status → dismissed via user event).

**After dismissal:** excluded from all future reminders; recorded as feedback (§16).
**After completion:** excluded; may appear once in a completion summary line; recorded as feedback.

## 9. Intent-history usage

The PA reads the **latest intent** for decisions and the **history** for context — never the reverse, and never by rewriting:

- **Current intent** governs eligibility (e.g., `buy` triggers reminders; `inspiration` does not).
- **Previous intent / changes** are used only when they improve wording — e.g., "You first saved this to buy, later you changed it to research — still want to keep it active?" — and only when the change is user-visible in the history. Usually omitted.
- **Change reasons/sources** (from `memory_events`) feed suppression logic: a user correction *away* from an actionable intent immediately removes future reminders of the old type.
- History is **append-only input**: the PA never merges, edits, or "summarizes away" events; Phase 6 will mine them, Phase 5 only reads.

## 10. Action / status usage

| Action / status | PA behavior |
|---|---|
| action actionable + status `new` | reminder candidate (subject to §8 rules) |
| action actionable + status `active` | follow-up candidate (same rules; slightly lower priority) |
| status `completed` | never reminded; excluded everywhere |
| status `dismissed` | suppressed by default; never reminded |
| status `archived` | fully excluded |
| intent `unknown` / `inspiration` (with no action) | no reminders (nothing actionable was said) |

Status is used as a **filter and lifecycle marker** — not extended, not made into a task system. There is no due date, no priority field, no recurrence.

## 11. Emerging-pattern detection

**Deterministic detections (SQL/RPC) over a rolling 60-day window:**

1. **Topic recurrence:** ≥3 memories sharing a normalized topic (≈ same short label) — *or* ≥4 in 90 days for slower topics.
2. **Intent×topic recurrence:** ≥3 memories with the same actionable intent within one topic (e.g., three `buy`s in "fragrance").
3. **Connection cluster:** ≥3 memories with ≥2 connections among them (`same_subject`/`thematic`), density ≥ 40%.
4. **Cadence signal (supporting only):** the topic is *accelerating* (≥2 captures in the last 14 days on top of earlier ones).

**Thresholds (V1):** ≥3 distinct memories **and** ≥2 independent signal types from the list above, within 60 days; not already covered by an accepted collection (similar-name/description check); no 90-day cooldown active for the same normalized signature.

**Deliberately excluded:** "two related screenshots" — two is never a pattern; visual similarity alone; anything that doesn't clear ≥2 independent signals. The system must *not* manufacture a pattern to fill the Emerging section.

**Selection & phrasing:** top ≤2 candidates by strength (memory count → signals → recency), synthesized by the single PA call into hedged, grounded sentences (§7).

## 12. Project detection

A project candidate is a **pattern that has crossed an intent line** — something the user may actually build or do:

- **Required:** a pattern (§11) that reaches **≥4 memories**, **plus** ≥2 *build-flavored* signals among them: `intent=build`, `action=build`, or explicit build statements in notes ("I want something like this", "this would be cool to build") — quoted from actual user notes,
- **Coherence:** cluster density ≥ 40% **or** single clear topic,
- **Time spread:** captures span ≥7 days (a one-evening dump is a moment, not a project),
- **Not already:** a project suggestion for the same signature hasn't been dismissed (90-day cooldown).

**Wording:** suggestion type, hedged, with a name hint drawn from the members ("My new portfolio redesign" style is the user's eventual name — the PA proposes a placeholder like *"Something to build: website design"*). Actions: **Make a project** · **Just a collection** · **Not now** (all feedback).

**Never:** auto-create; upgrade a collection silently; call a single save a project; add milestones/tasks/deadlines (non-goals).

## 13. Collections vs projects

- **Collection** = a group of related memories (no commitment). *"Website inspiration."*
- **Project** = a collection **with intent** — memories connected to something the user may actually build/do. *"My new portfolio redesign."* Technically: the same entity with `kind='project'` (A1), plus (later, optional) a goal sentence in the description.

Rules: never force a collection to become a project; the upgrade is always a user action ("Make it a project"); a project obeys all collection mechanics (membership, states, suggestions) — there is no parallel project system, no tasks, no timelines.

## 14. Proactive recall

Recall is **proactive and contextual**, never a generic search box (search architecture lives in Phase 4/7):

- **Resurfacing rule (V1):** one item max per report, chosen deterministically: an old memory (≥60 days) connected to — or strongly similar to — something saved in the last 7 days; or a `save_for_later` memory aged ≥30 days as a quiet summary line ("You often save things for later — 2 from this week are still fresh. All good.").
- **De-dup:** each memory recalls at most once per 90 days; never recall completed/dismissed items; never recall what the user just saw in this report.
- **Wording:** factual lead ("You saved this in July.") + connective inference ("It's related to something you saved this week.") + optional suggestion (e.g., "Want to group these?").
- **Purpose:** answer "did I ever save anything related to this?" *before the user asks* — without becoming a feed.

## 15. PA actions

Deliberately small action set, mapped to existing flows (no new state machines):

| Action (item-level) | Effect |
|---|---|
| Open memory | Navigation only |
| Mark completed / Dismiss | Status change via the normal correction flow (user event) |
| Snooze / Keep active | `pa_state` bookkeeping only |
| Change intent / action | Opens the normal correction flow |
| Confirm / dismiss connection | Existing connection state change |
| Accept / dismiss collection or project suggestion | Existing collection state change (accept creates/activates; dismiss cooldowns) |
| "Not useful" | Pattern/recall-level dismissal → cooldown, feedback signal |

Conceptual endpoints (final shapes in Phase 7): `GET /api/pa/reports`, `GET /api/pa/reports/{id}`, `POST /api/pa/reports/{id}/seen`, `POST /api/pa/items/{itemId}/action`. No task-management UI ever attaches to these.

## 16. PA feedback signals

Defined now, **learned from in Phase 6**:

| Signal | Where recorded | Mechanism |
|---|---|---|
| Item dismissed / completed | Item interaction + `memory_events` (status change, reason = "from PA") | User action |
| Snooze / keep active | Item interaction + `memories.pa_state` | User action |
| Suggestion accepted / rejected | `collections.state` / connections + item interaction | User action |
| Connection confirmed / dismissed | `connections.state` (existing) | User action |
| Intent/action corrected after PA | `memory_events` (existing) | User action |
| Ignored item | Computed at next generation from open interactions + elapsed period | Deterministic |
| Report seen but untouched | `pa_reports.seen_at` + zero interactions | Deterministic |
| "Not useful" | Item interaction | Explicit |

Phase 5 *defines* the signals and where they live; Phase 6 defines what the system learns from them.

## 17. PA storage decision

**Evaluated options:**

1. **No storage (generate on view):** rejected — reports would change between opens, no history, no seen/dismissed state, and LLM cost on every view.
2. **Multiple dedicated tables** (reports + feedback + items): rejected for V1 — over-modeled; item interactions fit inside the report; Phase 6 can add a feedback table *if* needed.
3. **One table + two small fields (selected):** reports stored once; interactions stored on the items; bookkeeping fields on memories and collections.

**Decision: yes — one new table, `pa_reports`** (A3), plus A1/A2 fields. It is genuinely necessary: history ("what did you tell me last month?"), reproducibility (a report is a snapshot of selected evidence + wording), dismissal/feedback flows, and cost control (never regenerate a period) all require persistence. Schema (reference, not executed):

```sql
create table public.pa_reports (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  generated_at    timestamptz not null default now(),
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  is_empty        boolean not null default false,     -- quiet period
  content         jsonb not null default '{}'::jsonb, -- sections; items carry: id, kind, claim_type,
                                                      -- memory_ids[], wording, actions[], interaction{}
  generation_meta jsonb not null default '{}'::jsonb, -- model, provider, prompt_version, candidate/dropped counts
  seen_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index pa_reports_user_generated_idx on public.pa_reports (user_id, generated_at desc);
```

RLS: standard owner policy (`auth.uid() = user_id`). Retention: keep all in V1 (tiny rows); pruning is a later setting.

## 18. PA generation architecture

Phase 4's proposal (scheduled job → SQL signals → ≤1 reasoning call → stored artifact) is **retained**, with the pipeline specified:

```
Inngest cron (Mon & Thu 18:00 WAT)  →  job: pa/report
  [1] DETECT (deterministic, SQL/RPC):
        reminders candidates  ·  pattern candidates  ·  project candidates  ·  recall candidates
  [2] GATE (deterministic): suppressions · cooldowns · dedupe vs open items ·
        section caps · global cap (≤5)  →  candidate bundle (≤12 items, ids + compact facts)
  [3] SYNTHESIZE (one GPT-OSS call): bundle in → item wordings + final selection out
        — evidence-only synthesis; no database access; strict schema
  [4] VALIDATE (deterministic): every item keeps ≥1 valid memory id; quotes match stored notes
        verbatim; drop anything ungrounded or unsupported
  [5] PERSIST: pa_reports row (or is_empty=true)  ·  update pa_state (reminded-at, ignores)
  [6] NO NOTIFICATION (in-app only, §24)
```

Guarantees: the model receives **only the selected bundle** (never the DB, never raw images, never unrelated notes); ≤1 LLM call per run; zero LLM calls for quiet periods; determinism everywhere it is possible.

## 19. Deterministic vs LLM responsibilities

| Operation | Mode |
|---|---|
| Finding unresolved items / reminder candidates | **Deterministic** (SQL) |
| Age calculations, min-age thresholds | **Deterministic** |
| Repeated topics / topic+intent clustering | **Deterministic** |
| Connection counting / cluster density | **Deterministic** |
| Status/intent/action eligibility checks | **Deterministic** |
| Cooldowns, snooze, ignore escalation, suppression | **Deterministic** |
| Selecting the candidate bundle + caps | **Deterministic** |
| Grounding validation (quotes, ids) | **Deterministic** |
| Choosing *what to store* and gating empties | **Deterministic** |
| Synthesizing multiple signals into concise insights | **LLM** |
| Writing natural-language wording/questions | **LLM** |
| Distinguishing nuanced patterns (beyond thresholds) | **LLM** (within the bundle only) |
| Explaining why something *may* matter | **LLM** (hedged, grounded) |
| Final wording of every PA item | **LLM** |

Rule of thumb (from the brief): **no LLM where SQL can do the job reliably.** The LLM never decides *what is eligible* — only how the eligible few are *said*.

## 20. PA trust / grounding

The PA **never**: invents an intention · claims the user said something they didn't · silently changes memory/intent/status · creates confirmed collections · marks anything completed · presents inference as fact.

Enforcement:

- **Writes are structurally limited:** the PA job writes only `pa_reports` (+ `pa_state` bookkeeping). All material state changes require an authenticated user action through the normal endpoints.
- **Every item carries `memory_ids[]`** (and collection/connection ids where relevant) + `claim_type` + `signals[]` — the UI can always render "Based on these memories: …" links.
- **Quote fidelity check** at validation: any FACT wording must match the stored note verbatim (substring check); mismatches drop the item.
- **Type discipline in prompts + validation** (§7 language boundary).

## 21. PA quality controls

An item is **valid** only if all hold: grounded in ≥1 actual memory · useful (matches one of the four V1 capabilities) · timely (within its evidence window) · non-redundant (not in cooldown, not previously dismissed/ignored past thresholds) · not completed/dismissed · not repeatedly resurfaced · confidence above its rule threshold. No arbitrary scoring systems — simple, auditable rule thresholds only. Anything failing validation is **dropped**, not softened.

## 22. PA quietness principles

- Prefer **"no useful update"** over twelve observations.
- Hard caps: ≤5 items per report; ≤2 reminders; ≤2 patterns; ≤1 project candidate; ≤1 recall item; sections self-omit.
- One reminder per memory per cooldown; one pattern per signature per 90 days; one recall per memory per 90 days.
- Low-confidence candidates are dropped entirely (never shown "with caveats").
- No duplicates across reports; no re-wording the same insight to sneak it back in.
- The PA never becomes a daily machine: two slots per week, maximum.

## 23. Realistic PA examples

**Example 1 — reminder (fact + suggestion):**

> **Needs Attention** · *You said: "I want to buy this."* — that was 3 weeks ago. Still interested?
> Actions: Open · Keep active · Snooze · Mark completed · Dismiss
> *Label:* fact (your note) + suggestion · *Based on:* Memory X

**Example 2 — emerging pattern (inference + suggestion):**

> **Emerging** · You've saved three website references around a similar layout over two weeks. *It looks like* an emerging design direction.
> Actions: Make a collection · Not useful
> *Label:* **AI observation** (inference — not something you said) · *Based on:* Memories A, B, C

**Example 3 — emerging pattern for tools (inference):**

> **Emerging** · You've saved several AI tools recently, mostly around agent building. It may be worth grouping them.
> Actions: Make a collection · Not useful
> *Label:* AI observation · *Based on:* Memories D, E, F, G

**Example 4 — nothing meaningful:**

> No useful PA insights this period. *(Quiet period — stored, not surfaced as noise.)*

**Example 5 — proactive recall:**

> **Everything Else** · You saved this in July — it's related to something you saved this week. You might have forgotten it.
> *Based on:* Memory H (July) ↔ Memory I (this week)

## 24. Notification strategy

**V1: in-app only.** The report exists in the app (list + detail, with a subtle unseen indicator); **no email, no push, no external notification infrastructure** is assumed or built. Justification: simplest possible V1, zero new dependencies, and perfectly aligned with the quietness principle — the user checks when they're ready; the PA does not chase. Email digests / push are explicitly deferred (they require new infrastructure and would change the quietness calculus). Quiet periods notify nothing.

## 25. Future conversational PA boundary

Not built in Phase 5 — and not in V1. The architecture already contains what a grounded conversational assistant would need later:

- **"What was that perfume I saved?"** → retrieval over `memory_embeddings` (Phase 3) + SQL filters.
- **"Why did I save this?"** → the original note + `memory_events` history (Phases 2–3).
- **"What did you mean by 'emerging'?"** → the report item's `memory_ids` + `signals` (this phase).

Constraints documented for that future: answers must cite supporting memories; no answers from model memory; same fact/inference/suggestion discipline. The interface, prompts, and guardrails are a later phase's work. **Do not build chat now.**

## 26. Definitive PA architecture diagram

```
              ┌─────────────────────────── SCHEDULE ───────────────────────────┐
              │  Inngest cron: Mon & Thu 18:00 WAT  →  job: pa/report          │
              └───────────────────────────────┬────────────────────────────────┘
                                              ▼
                 ┌───────────────────────────────────────────────────────┐
                 │ [D] DETERMINISTIC DETECTORS (SQL/RPC)                 │
                 │   reminders · patterns · projects · recall candidates │
                 └───────────────────────────────┬───────────────────────┘
                                              ▼
                 ┌───────────────────────────────────────────────────────┐
                 │ [G] GATE: eligibility · cooldowns · snooze/suppress  │
                 │      dedupe · caps (≤5 total, ≤12 bundle)            │
                 └───────────────┬───────────────────────┬───────────────┘
                                 │ empty                 │ candidates
                                 ▼                       ▼
                 ┌───────────────────────┐   ┌────────────────────────────┐
                 │ quiet period record   │   │ [S] ONE GPT-OSS CALL       │
                 │ (no notification)     │   │  bundle → wording, ≤1 call │
                 └───────────┬───────────┘   └───────────────┬────────────┘
                             │                       ▼
                             │           ┌────────────────────────────┐
                             │           │ [V] VALIDATE grounding/    │
                             │           │   quotes; drop ungrounded  │
                             │           └───────────────┬────────────┘
                             ▼                           ▼
                 ┌───────────────────────────────────────────────────────┐
                 │ [P] PERSIST: pa_reports row · pa_state updates       │
                 └───────────────────────────────┬───────────────────────┘
                                                 ▼
                 ┌───────────────────────────────────────────────────────┐
                 │ IN-APP surface (no external notifications)            │
                 │  report view · item actions · "based on…" grounding   │
                 └───────────────────────────────┬───────────────────────┘
                                                 ▼
                 ┌───────────────────────────────────────────────────────┐
                 │ USER ACTIONS → existing events/flows + item feedback  │
                 │ → cooldown/suppression updates → future gating        │
                 │ →→ (Phase 6: learning from accumulated signals)       │
                 └───────────────────────────────────────────────────────┘
```

## 27. Decisions deferred to Phase 6

- What learns from feedback (weights, personalization, adaptive thresholds)
- Whether a dedicated `pa_feedback`/signal table is needed once learning exists
- How corrections flow back into prompt context ("learning signals" for Phase 3 §5)
- Pattern/reminder precision tuning based on accept/dismiss history
- Whether Phase 6 changes any Phase 5 thresholds via learned policy (Phase 5 defaults stay the baseline)

## 28. Decisions deferred to later implementation

- Final detector thresholds & caps tuning (defaults in this doc are the baseline)
- Report retention/pruning policy; exact `pa_state` field set as it firms up
- Item wording templates (prompts written at implementation, per Phase 3 §19 discipline)
- Snooze duration options (1w/1m) and "generate now" affordance (Phase 7 UX)
- Unseen indicator, badge design, report list UX (Phase 7)
- Email/push digests (explicitly deferred past V1)

---

_Phase 5 complete — PA architecture defined, nothing implemented. Next: Phase 6 — Personal Learning Architecture (awaiting go-ahead)._
