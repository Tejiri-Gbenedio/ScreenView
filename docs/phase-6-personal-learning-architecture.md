# Phase 6 — Personal Learning Architecture: ScreenView

| | |
|---|---|
| **Project** | ScreenView |
| **Phase** | 6 — Personal Learning Architecture |
| **Status** | ✅ Complete |
| **Date** | 2026-09-29 |
| **Next phase** | Phase 7 — Interface & UX |

This document defines how ScreenView **gradually learns the user's personal patterns, preferences, corrections, and interpretation style** — and how it stays conservative about what it believes it knows. Architecture only: no code, no migrations, no prompts, no jobs, no UI. Phases 1–5 remain the source of truth.

**Guiding principle (adopted verbatim):** *"ScreenView should learn from the user's behavior and corrections without pretending that every interaction is a permanent preference."*

### Relationship to earlier phases (no conflicts found)

Inspection of Phases 1–5 found **no architectural conflicts**. Phase 6 builds directly on:
- Phase 2's append-only `memory_events` (raw correction history — the primary evidence source),
- Phase 3's reserved `LEARNING_SIGNALS` input slot for GPT-OSS (now given its content contract, §13),
- Phase 4's job architecture (learning reuses it; no new infrastructure),
- Phase 5's feedback signals (§16 there; formalized into a taxonomy here).

One additive refinement is required, documented and **not executed**:
- **A1 — `learned_patterns` table** (the single new data structure Phase 6 needs; full justification and schema in §10/§26). No other schema change is required; explicitly answered in §26.

---

## 1. Phase objective

Define how learning works — what counts as learning, which signals teach what, how evidence accumulates, how confidence and decay behave, how learning enters the AI pipeline (and where it must not), how feedback loops are prevented, how the user stays in control, and the V1 boundary. The output is a practical, tunable architecture: **structured signals + contextual prompting — no fine-tuning, no personality modeling, no hidden profiling.**

## 2. Definition of learning

Five distinct categories, with hard boundaries:

| Category | What it is | Where it lives | Authority | Example |
|---|---|---|---|---|
| **Static system knowledge** | Explicitly stored facts about what happened | `memory_events`, `memories`, `connections`, `pa_reports` | Fact — describes an event | "User changed intent from `buy` to `research` on Sep 3." |
| **Explicit user preference** | The user directly states a *general* rule | `learned_patterns` (`origin='explicit'`) | Highest (user-authored) | "I usually save website screenshots as design inspiration." |
| **Learned interpretation pattern** | Inferred from *repeated* behavior, with retained evidence | `learned_patterns` (`origin='inferred'`) | Medium — a soft nudge, never a rule | "When the user writes 'maybe later', they frequently mean `save_for_later`." |
| **Temporary / contextual behavior** | Time-bound behavior that must NOT become identity | Usually *not stored as a preference* — handled by short half-lives; possible `tentative` patterns | Low / short-lived | "Researching laptops this month." |
| **AI inference** | A model belief the user never confirmed | Inside one memory's current interpretation only | Lowest — **never becomes learning by itself** | Model guesses `intent=buy` before any user response. |

Boundary rules:

- **Facts don't become patterns automatically.** A correction is a fact; only *aggregated repetitions* (or explicit statements) become learning.
- **Patterns never masquerade as facts.** Learned patterns are always presented as hints with provenance (§13, §20).
- **AI inference never counts as evidence.** Only user actions count (§9).
- **Temporary behavior defaults to low influence and decays fast**; it can become a pattern only through sustained, repeated evidence past default thresholds.

## 3. Learning signal taxonomy

Every signal, with what it can and cannot teach. **Weights, durations and bars are tunable defaults**, not architectural constants (§6). Strength classes: **S** strong (explicit acts with clear intent), **M** medium (confirmed behavior), **W** weak (passive behavior), **—** not evidence.

| Signal | What happened | Can teach | Cannot safely teach | Type | Strength | Influence duration (default) | Evidence bar to become a pattern (default) |
|---|---|---|---|---|---|---|---|
| Intent correction | User changed a memory's intent | Intent interpretation mappings (topic/phrasing → intent) | "Never classify X as Y" from a single case | Explicit | S | long (half-life ~120d) | ≥3 similar corrections across ≥2 distinct captures/days |
| Topic correction | User changed topic | Preferred topic vocabulary/labels | Anything beyond labeling style | Explicit | S | ~120d | ≥3 similar |
| Action correction | User changed suggested action | Intent → practical-action mappings | Blanket action rules from one case | Explicit | S | ~120d | ≥3 similar |
| Other memory corrections (title/summary/status edits) | Edits to interpretation or lifecycle | Lifecycle habits (e.g., quick completion of read-items) | Broad behavioral claims | Explicit | M–S | ~90d | ≥3 similar |
| Connection confirm | User confirmed a suggested connection | Relationship-type preferences per topic pair | That the *AI suggestion itself* was good judgment (§9) | Explicit-positive | M | ~90d | ≥3 similar confirms for type×cluster |
| Connection dismiss | User dismissed a connection | Pair-level: never re-suggest (immediate, direct); type×cluster: repeated rejections → suppression | Permanent global bans; rejection of related-but-different pairs | Explicit-negative | S (but cheap act) | pair: indefinite (stored fact); type-level: ~60–90d decay | pair: 1; type×cluster: ≥3 dismissals |
| Collection accept | User accepted a collection suggestion | Grouping preferences; naming style | That AI-generated groupings are universally wanted | Explicit-positive | M | ~90d | ≥3 |
| Collection dismiss | User rejected a collection suggestion | Rejected grouping signatures | "Never suggest collections" | Explicit-negative | S | signature: cooldown 90d (Phase 5) extended; ≥2 similar → longer suppression | ≥2 similar dismissals |
| Reminder completion | User completed a PA reminder | Which reminder kinds are acted on (usefulness) | Speed/priority rules hidden from user | Explicit-positive | M–S | ~90d | ≥3 per kind |
| Reminder dismissal | User dismissed a reminder | Kind-level fatigue (with care) | That the *memory* was unimportant | Explicit-negative | M | ~90d | ≥3 per kind |
| Reminder snooze | User deferred a reminder | Timing preference (later); possible cadence learnings | Content-level preferences | Implicit | W | ~45d | ≥5, study-only in V1 |
| Ignored suggestion | Item shown, no action, period elapsed | Fatigue signal — *"not now", not "never"* | Rejection (ignored ≠ dismissed, §17) | Implicit | W | short (~30d rolloff) | ≥3–5 consecutive with no positives → frequency reduction only |
| Seen-but-untouched | Report opened, items untouched | Very weak attention signal | Anything strong | Implicit | W (weakest) | ~30d | supporting signal only |
| "Not useful" | Explicit per-item negative | Per-kind aversion; pattern suppression | Global bans | Explicit-negative | S | kind-level ~90d | ≥2–3 per kind |
| Repeated user behavior | Any repeated user action pattern (e.g., re-correcting same direction) | Stable preferences *after* consistency + diversity | Anything from 1–2 occurrences | Implicit | M | ~90d | ≥4–5 consistent, diverse (distinct captures/days) |
| Completed actions | User marked actions done | Follow-through style per intent kind | Priority/rush inferences | Explicit-positive | M | ~90d | ≥3 |
| Changing intentions | Intent trajectory (buy→research→dismissed) | That intent evolves; avoid over-anchoring on first intent | "The user is indecisive" (not our business) | Neutral fact | — | history retained (already append-only) | n/a — informs context, not patterns |

Notes: **exposure ≠ evidence** — seeing a suggestion teaches nothing; only the user's response does (§9). Signals about *task-specific interpretation and interaction preferences* only — never personal characteristics (§12).

## 4. Correction learning

The core loop:

```
Capture → AI interpretation → user correction → correction event (memory_events, append-only)
   → learning signal (tagged: field, from→to, capture, topic, at)
   → evidence accumulates in a correction "class" (same field + same from→to direction + similar topic/context)
   → thresholds crossed → tentative pattern → (repetition) → established pattern
   → relevant patterns selected for future captures → GPT-OSS receives compact personal context
   → interpretation improves → future feedback reinforces or corrects the pattern (loop continues)
```

The brief's example: AI said `buy`; user corrected to `research`. What is remembered:

- **The fact:** "AI previously believed `buy`; the user explicitly corrected it to `research`." (Already stored — `memory_events` + provenance. Nothing destroyed.)
- **What is NOT concluded:** "The user never wants this topic classified as `buy`." A single correction is one case, not a rule.

**From cases to patterns (deterministic):** corrections cluster into classes by (field, direction, topic-cluster or context signature). Classes accumulate simply by counting stored events — no LLM needed to find "5 corrections of buy→research". A single case may create a *tentative* pattern only when default bars are met (≥3 similar across ≥2 distinct captures); before that, no influence. Repeated corrections in the same direction gradually strengthen; contradictions (user sometimes accepts `buy` for the same class) attenuate confidence and can retire the pattern.

## 5. Positive and negative learning

Both directions are first-class, with different mechanics:

- **Positive signals** (confirms, accepts, completions, repeated accepts of an interpretation) → build patterns/priors. Rate of influence is deliberately *slower*: positive evidence usually needs repetition (≥3) before it nudges interpretation. Accepts are **discounted** (weak-medium) because acceptance can be convenience (§9).
- **Negative signals** (dismissals, rejections, "not useful", repeated corrections against a direction, repeated ignores) → suppress the *specific* thing, not the class:
  - a dismissed connection: that exact pair is never re-suggested (stored fact, already Phase 3); repeated dismissals of a *type across a topic pair* create a suppressed pattern (§15);
  - a rejected collection signature: suppressed with cooldown, escalating on repetition (§16);
  - repeated ignores of a reminder kind: frequency reduction only — **ignored ≠ rejected** (§17).

**Asymmetry rule:** negative signals act *faster* (they prevent repeats of known mistakes — cheap to honor) but *narrower* (suppression is scoped and decays). Positive signals act *slower* (require evidence) but *broader* (can generalize within a scope once established). Neither ever becomes permanent by accident.

**A single dismissal never creates a permanent rule.** Defaults: pair-level suppression is a stored fact (Phase 3); class-level suppression requires ≥2–3 similar rejections and decays (~60–90d); nothing is "forever" except the explicit per-pair record and user-authored statements.

## 6. Confidence and evidence

**Evidence units** (each raw signal counts once per occurrence; diversity matters):

| Evidence source | Default weight |
|---|---|
| Explicit user statement about general behavior | 1.0 (authority class; origin=`explicit`) |
| User correction / explicit negative ("not useful", dismissal) | 1.0 per event |
| Confirmed behavior (confirm/accept/complete) | 0.6 per event |
| Accepted AI suggestion (any) | 0.4 per event (discounted, §9) |
| Passive behavior (ignore, seen-untouched) | 0.25 per event, frequency-effects only |
| AI inference / AI suggestions themselves | **0** — never evidence |

**Levels** (conceptual; thresholds tunable defaults, deliberately not hard-coded in architecture):

| Level | Rough shape | Influence |
|---|---|---|
| Observation | 1 event | None — stored only |
| Tentative | ≈3 weighted evidence, ≥2 diversity units (distinct captures/days), no unresolved contradiction | Narrow-scope soft hints only |
| Established | ≈5+ weighted, consistent, recent, contradictions absent/dealt with | Standard soft context; suppression decisions for negatives |
| Explicit | User-authored | Highest authority (never decayed by time; changed only by the user) |

**Rules:** capped confidence for inferred patterns (e.g., ≤0.9; explicit = 1.0); every pattern retains **evidence references** (event ids/captures, capped list + counts) so "why does it believe this?" is answerable (§20); thresholds live in config and will be tuned with real data — the architecture requires only that the *concept* of accumulated evidence exists. Numbers in this document are starting defaults, changeable without redesign.

## 7. Recency and decay

Learning must not become permanent by accident:

- **Recency weighting / decay:** each pattern has a half-life (defaults by scope: corrections ~120d, behavior ~90d, PA-kind ~60–90d, language ~90d). Effective confidence = stored confidence scaled by time since last reinforcement. Computed lazily at read/decision time; a periodic job recomputes stored values (§23).
- **Reinforcement:** new matching evidence resets `last_reinforced_at` and adds weight — patterns can become stronger over time, up to the inferred cap.
- **Expiration:** effective confidence below a floor (default ~0.2) → status `expired` — retained for history/provenance but excluded from AI context. The user's example resolves naturally: months of AI-coding-tool saves build a pattern; when saves stop, decay quietly reduces its influence instead of it remaining forever.
- **Temporary patterns:** bursts of activity (the "laptop month") are naturally short-lived: burst evidence decays quickly once unreinforced; a burst never reaches established confidence without sustained reinforcement. (Optionally, a "concentrated in ≤14 days" flag makes decay slightly faster — tunable default.)
- **Reactivation:** new matching evidence revives an expired pattern at a low level (tentative), not at its old peak.
- **Overrides:** a newer explicit user statement or a strong consistent correction stream **supersedes** older learned behavior for the conflicting scope — the older pattern is demoted (`superseded`) with a link, not deleted (history preserved).

## 8. Explicit vs inferred preferences

- **Explicit** — the user directly communicates a general rule (e.g., "I usually save website screenshots as design inspiration."). Stored in `learned_patterns` with `origin='explicit'`, full authority, no time decay, user-editable. *(V1 acquisition: the data structure exists from day one; the primary way to set these — a light "teach ScreenView" affordance — is a Phase 7+ UI decision. Corrections remain case-level until they aggregate.)*
- **Inferred** — detected from repeated behavior; capped confidence; soft nudge; decays; always labeled as learned in contexts.

**Authority:** explicit > inferred. **Conflicts:** when an explicit preference conflicts with an inferred pattern, the explicit one wins for decisions, and the conflicting inferred pattern is demoted (`superseded`) — it may still exist historically, but never overrides the user's stated rule. When inferred signals accumulate *against* a stale explicit preference, the system may **surface a question** to the user later ("You've been saving website shots as 'build' lately — update your usual 'inspiration' rule?" — a Phase 7+ affordance; never a silent override). User statements are never silently reversed.

## 9. Feedback-loop safeguards

The failure mode: AI believes X → suggests X repeatedly → user accepts out of convenience → system concludes X is highly preferred → suggests X even more — a self-reinforcing false belief. Safeguards (architectural, enforced in the ingest rules):

1. **AI-origin items are never evidence by themselves.** Model suggestions, classifications and inferences have weight **0** until the user *responds*. Seeing/ignoring AI suggestions does not count as endorsement.
2. **Exposure is tracked, not learned from.** Suggestion counts are audit metadata, never positive evidence.
3. **Accepted AI suggestions are discounted** (×0.4) versus corrections (×1.0) — acceptance is weaker than authorship.
4. **Provenance is structural:** every event records `actor`/`source` (already in Phase 2/3: user vs system). Learning ingest rejects any signal whose provenance isn't a user action.
5. **Diversity requirement:** N accepts of the same AI suggestion flavor don't reach established alone — evidence must span distinct captures/days (≥2 diversity units), preventing tight loops.
6. **Negative signals work:** dismissed suggestions *suppress* future suggestions (pair-level immediate; class-level after repetition), so the loop breaks in the other direction too.
7. **No "learning from learning":** pattern-derived contextual hints that influence a suggestion do not feed back as evidence for that pattern.
8. **Loop audit (cheap):** acceptance-rate-vs-correction-rate per scope is visible in pattern evidence counts, so a runaway loop is observable and tunable without redesign.

## 10. Learning representation / schema decision

**Evaluation:** raw signals already live in existing tables (`memory_events`, `connections`, `collections`, `pa_reports` interactions, `memories.status/intent`). What has **no home** is the *aggregated, evolving, decaying* representation of what the system believes: per-class evidence, confidence, status, decay/reinforcement metadata, and user-authored explicit preferences. Deriving that on every read would scatter aggregation logic everywhere and lose decay state — so a minimal dedicated structure is justified.

**Decision: exactly one new table — `learned_patterns`** (A1). No `learning_signals` table (raw signals already exist — duplicating them into a second store would create drift), no `user_preferences` table (explicit preferences are patterns with `origin='explicit'`), no per-scope tables (one generic shape serves all seven scopes). Reference schema (documentation only — not executed):

```sql
create table public.learned_patterns (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  scope                text not null check (scope in
                         ('intent','topic','action','connection','collection','pa','language')),
  origin               text not null check (origin in ('inferred','explicit')),
  status               text not null default 'tentative' check (status in
                         ('tentative','active','suppressed','expired','retired','superseded')),
  condition            jsonb not null,              -- when it applies (topic cluster, phrase hints, pair signature…)
  conclusion           jsonb not null,              -- what it suggests ({intent:'inspiration'} / {suppress:{type:'thematic', pair:…}} / …)
  confidence           real not null default 0,     -- current (lazily decayed) effective value
  half_life_days       int,                         -- null → scope default
  evidence_count       int not null default 0,
  positive_count       int not null default 0,
  negative_count       int not null default 0,
  evidence             jsonb not null default '[]'::jsonb,  -- capped refs: [{type, ref_id, at}] — provenance (§20)
  last_reinforced_at   timestamptz,
  last_contradicted_at timestamptz,
  suppressed_until     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index learned_patterns_user_scope_idx on public.learned_patterns (user_id, scope, status);
```

- **Lifecycle:** `tentative → active → (suppressed | expired | retired | superseded)`; `retired` = user rejection (blocks re-derivation of the same signature until the user reactivates); `explicit` patterns are `active` while they exist (user-controlled).
- **Evidence/provenance:** the capped `evidence` array + counters answer every "why" (§20); raw events remain the deeper archive.
- **RLS:** standard owner policy; learned patterns inherit the identical privacy boundaries as memories (§21).

## 11. What ScreenView learns

| Dimension | Learns | Primary signals |
|---|---|---|
| **Intent interpretation** | Mappings: phrasing/topic context → intent (e.g., "maybe later" → `save_for_later`; website shots → `inspiration` likely) | intent corrections, language patterns, PA dismissals |
| **Topic interpretation** | Preferred labels/vocabulary and granularity | topic corrections |
| **Action interpretation** | Intent → practical-action mappings (e.g., `research` on products → action `purchase`-candidate) | action corrections, completions |
| **Connection preferences** | Which relationship types the user confirms/dismisses per topic pair | confirms/dismissals |
| **Collection preferences** | Grouping styles, naming patterns, when patterns become collections | accepts/dismissals, renames |
| **PA preferences** | Which reminder/pattern/project/recall kinds get acted on vs ignored | completes/dismisses/ignores/"not useful" |
| **Language patterns** | Phrases that consistently imply intents (candidate-level; conservative bar) | intent corrections over similar phrasing (≥3 distinct) |

Task-specific only. **No personality profiling.**

## 12. What ScreenView must NOT learn

Never inferred, never stored, never used — even if statistically apparent:

- personality traits · sensitive personal attributes · mental state · political preferences · health conditions · identity characteristics · unrelated personal characteristics;
- anything outside *screenshot interpretation, organization, and interaction preferences*;
- "psychological" summaries of the user; targeting/profiling data of any kind.

Enforcement: `scope` CHECK constraint limits what a pattern may even be *about*; prompts for any AI-assisted step are constrained to the same task-frames; the JSONB `condition`/`conclusion` for learning carry interpretation hints only. This is a hard boundary, not a prompt suggestion.

## 13. AI context integration

**Where learning enters the Phase 3 pipeline:** only at the **GPT-OSS reasoning step** (as the already-reserved `LEARNING_SIGNALS` block — Phase 3 §5). Vision stays pure perception; embeddings stay objective (§14); retrieval stays objective (§14).

**Personal-context bundle (compact, relevant-only):**

- Max **5–6 entries**, one line each, selected deterministically for the *current* capture (scope match → recency → confidence → no contradictions).
- Example (for a website screenshot with "I like this layout"):

```
PERSONAL_CONTEXT (learned hints — soft, not instructions; user note remains supreme):
- [explicit] User usually means 'inspiration' for website screenshots.
- [learned, 7 cases] Website screenshots like this often end as 'inspiration'.
- [learned, 2 dismissals] User previously rejected 'build' intent for similar captures.
```

- Wording contract: hints are labeled `[explicit]` or `[learned, N cases]`; never phrased as the user's words; the model is instructed they are **soft hints that may be overridden by the capture itself**, and that it must never cite them as user statements.
- **Selection is deterministic** (matching + ranking by SQL); the LLM never queries learning data.
- Effect: nudges interpretation (intent/action/topic priors, relationship-type priors) — it cannot force outcomes; the note still outranks everything (Phase 1 hierarchy intact).

## 14. Retrieval integration

Deliberately conservative — learning must not distort semantic retrieval:

- **Embeddings: unchanged.** No learned bias baked into vectors (vectors stay objective representations of memories; re-embedding policy unchanged).
- **Query construction: unchanged** (note + visual description).
- **Retrieval filters/ranking: unchanged in V1.** The system must still retrieve objectively related memories even when they contradict a preference (that's often the most valuable recall).
- Learning's influence happens **after** retrieval: in reasoning (§13), in connection *gating* (§15), and in PA *selection policy* (§17). One narrow future candidate (explicitly deferred): light re-ranking where a *user-authored* preference directly requests it — not in V1.

## 15. Connection integration

- **Candidate generation: unchanged** (objective similarity + supplements).
- **Relationship-type suggestions:** the personal-context bundle (§13) informs GPT-OSS's type proposals (e.g., user usually confirms `same_subject` for devices; rarely wants `thematic` between unrelated clusters).
- **Confidence:** soft adjustment via context (model-side), not hard-coded scoring.
- **Suppression of repeatedly rejected types:** deterministic gate between model output and persistence: a proposed connection is dropped if it matches a suppressed pattern (`scope='connection'`, type × topic-pair signature, within `suppressed_until`). Pair-level dismissals remain permanent per Phase 3 (never re-suggest the same pair).
- **Safe mechanism:** suppression is scoped (type × cluster pair), requires ≥3 dismissals (default), and decays (~60–90d) — after expiry, suggestions may resume with a **raised confidence floor** (+0.1 default). One dismissal never mutes a class.

## 16. Collection integration

- **Suggestions:** still require accumulated evidence (Phase 5 rule stands). Learning adds: stricter evidence bars for signatures the user has dismissed before (≥2 similar dismissals → longer suppression; ≥3 → raise the evidence bar for that signature).
- **Naming:** past accepted names are passed into the synthesis call as style context (the PA/collection call), so names feel consistent with the user's vocabulary.
- **Membership suggestions:** grouping preferences (from accepts) act as soft context for candidate membership (never forced).
- **Rejected patterns:** suppressed signatures (decaying) — never "collections are unwanted" as a global conclusion.
- **Never:** learning alone creates a collection or auto-accepts one.

## 17. PA integration

- **Reminder selection:** per-kind usefulness scores (deterministic): completes and dismissals adjust a kind's weight; **ignored ≠ explicit rejection** — ignores (weak, bulk) reduce *frequency* only (fewer slots for that kind), while dismissals/"not useful" (explicit) suppress the *kind/pattern* for a cooldown. A kind can be demoted from 2 slots → 1 → paused, but pausing is visible and reversible (a quiet-state note; Phase 7 affordance).
- **Emerging pattern surfacing:** dismissed pattern signatures learn longer suppression; accepted ones slightly lower the bar for *similar* signatures (capped, evidence still required).
- **Project candidates:** accepted projects teach naming/framing style; dismissed ones raise the bar for similar signatures (default +1 evidence, decaying).
- **Proactive recall:** recall dismissals increase the cooldown for recalled memories (90d → 180d, default); accepted recalls reinforce the class.
- **Overall:** PA quietness (Phase 5) remains the ceiling; learning only ever makes the PA *quieter or better-targeted*, never louder.

## 18. Cold start

- **Zero signals:** ScreenView behaves exactly per Phases 1–5 defaults — visual analysis + note + retrieval + reasoning; learning adds nothing and is not needed. The product works before it learns.
- **Sparse signals (1–2):** stored as observations; **no influence** on interpretation (except unpreventable direct effects already in the design: a dismissed pair isn't re-suggested — that's a stored fact, not learning).
- **When influence begins:** tentative patterns (default ≈3 weighted evidence, ≥2 diversity units) may appear as narrow soft hints; established patterns (≈5+) get standard influence. **No hard "observation period" wall** — thresholds + diversity caps are the overfit protection (plus §9's loop safeguards). Early patterns are capped in confidence and scope, so a user's first enthusiastic day can't define them permanently.
- **How fast it becomes useful:** typically after a handful of corrections around recurring topics (days–weeks of normal use) — and quiet when there's nothing to learn.

## 19. Conflicting signals

**Final authority hierarchy** (evaluated; adopted with refinements — the brief's draft plus case-level supremacy and recency mechanics):

1. **This capture's explicit user statement** (the note, now) — supreme for this capture.
2. **Current explicit user preferences** (user-authored, active) — they are the user speaking generally.
3. **Recent explicit corrections** (recency-weighted).
4. **Repeated confirmed behavior** (established patterns).
5. **Older learned patterns** (tentative or decayed).
6. **Single observations** — stored, not influencing.
7. **AI inference** — never influences learning; corrected by any user action.

**Mechanics:**

- *Old vs new preference:* newer explicit statements supersede older ones (older pattern demoted, link kept).
- *Explicit vs inferred:* explicit wins; conflicting inferred pattern demoted; inferred evidence mounting against explicit → system may *ask* (never silently override).
- *Behavior vs statement:* the statement wins for decisions; behavior evidence may reduce that pattern's confidence over time (and surface a question).
- *Topic behavior changes over time:* decay + reinforcement handle drift naturally; no permanent identity.
- *Same phrase, different contexts:* patterns are **scoped by condition** (topic cluster/context signature); a pattern applies only when its condition matches — no global generalization from context-specific evidence.

## 20. Explainability / provenance

Every pattern must be able to answer **"Why does ScreenView think I usually mean this?"**:

- Data: `evidence` refs (capped, e.g., last 20 + counts) point to the exact corrections/feedback that built it; `origin`, `scope`, `created_at`, `last_reinforced_at`, `confidence` complete the story.
- Example answer (future UI, not built): *"Based on 5 corrections where you changed 'buy' to 'research' for similar captures (last: Sep 12)."*
- Context bundles carry their own provenance markers (`[explicit]` / `[learned, N cases]`) so even model-side use is traceable.
- No V1 UI required — the **data architecture preserves enough evidence** for it later.

## 21. Privacy and user control

- **Same boundaries as memories:** patterns live in the user's database under the same RLS/ownership; they cascade with the user; nothing is shared externally beyond the compact context bundle sent to the same reasoning provider already used (Phase 3/4 privacy posture unchanged — no new exposure).
- **User control (architecture-ready, UI later):** *inspect* (list patterns + evidence) · *correct* (edit → creates/updates an explicit override) · *reject* (`retired` — blocks re-derivation of that signature until reactivated) · *reset* (delete pattern; raw events remain as history) · *prevent signals* (scope-level opt-out stored as an explicit "do not learn X" preference).
- Deleting a memory removes its contributions? — **No silent recomputation needed:** evidence refs may point to deleted items (rendered as "[deleted]"); counters/confidence stay valid until the daily consolidation recomputes from surviving refs. User reset/deletion always honored.

## 22. Deterministic vs AI-assisted learning

Per the Phase 5 principle — *everything that selects, checks, counts, gates or validates is deterministic*:

| Operation | Mode |
|---|---|
| Counting corrections/feedback; weighted evidence | **Deterministic** |
| Recency/decay math; reinforcement; expiry | **Deterministic** |
| Threshold enforcement (tentative/established); caps | **Deterministic** |
| Authority resolution (§19); contradiction handling | **Deterministic** |
| Suppression windows; cooldowns; gating suggestions | **Deterministic** |
| Selecting the relevant personal-context bundle for a capture | **Deterministic** |
| Provenance assembly + "why" queries | **Deterministic** |
| Judging whether several corrections represent the *same semantic pattern* (near-duplicate clustering of wording) | **AI-assisted** (candidate grouping only; probabilistic; thresholds still deterministic) |
| Summarizing a pattern into one human-readable line | **AI-assisted (optional)** — deterministic templates are the V1 default |
| Future UI explanations ("why do you think this?") phrasing | **AI-assisted (later)** |

Rule: the model may *label and summarize* what deterministic logic selected; it never sets thresholds, weights, or authority, and never touches raw decisions.

## 23. Learning jobs

Minimal, reusing the Phase 4/5 architecture — **no new infrastructure**:

- **Immediate (synchronous, inside existing transactions):** record the raw event (already happens); update evidence/counters for the matching pattern; create a `tentative` pattern when a threshold is crossed. All deterministic, milliseconds, personal-scale — done via a single internal `record_learning_signal(...)` RPC invoked by every feedback path (corrections, connection/collection actions, PA item actions). *(The brief anticipated async aggregation; at this scale synchronous deterministic aggregation is simpler and safer — async becomes worthwhile only if volume ever justifies it, documented as a tuning point.)*
- **Periodic (reusing existing cadence):** `learning/consolidate`, co-scheduled with the existing daily collections run: recompute decayed confidences, expire below-floor patterns, apply suppression expiries, (optionally AI-assisted) merge redundant patterns, recompute PA per-kind usefulness scores. One lightweight step in an existing scheduled window.
- **No other jobs.** No per-capture learning calls; no realtime learners; nothing LLM-based in the hot path.

## 24. V1 scope / boundary

**V1 learning includes:** the full signal taxonomy (§3) recorded in existing tables · `learned_patterns` with evidence, confidence, decay, statuses · correction-driven patterns (intent/topic/action/language candidates) · connection/collection/PA preferences and suppressions · the compact personal-context bundle into GPT-OSS · explainability data · user-control data paths (retire/reset/override).

**V1 learning does NOT include:** fine-tuning or custom model training · reinforcement learning · autonomous personality/psychological modeling · hidden behavioral profiling · unrestricted long-term memory · cross-user learning (single-user system) · retrieval distortion · any learning outside the seven task-scopes · notifications or UI for learned rules (Phase 7+).

**Approach:** structured signals + contextual prompting — *not* model training.

## 25. End-to-end architecture (final flow)

```
User capture
  → AI interpretation (vision → retrieval → reasoning; PERSONAL_CONTEXT hints injected here)
  → memory stored
  → user correction / feedback (correction · confirm/dismiss · accept/dismiss · PA item action)
  → event recorded (existing tables: memory_events, connection/collection states, PA interactions)
  → learning signal tagged + evidence accumulated           [synchronous, deterministic]
  → confidence/recency evaluated; pattern created/updated    [thresholds, caps, decay]
  → relevant patterns selected for future captures           [deterministic, scope-matched, ≤5–6]
  → GPT-OSS receives compact personal context                [hints only; note remains supreme]
  → interpretation improves → future feedback reinforces/corrects the pattern
        ↕
  daily: consolidation (decay recompute · expiry · merge · PA kind scores)
  any time: user can inspect / correct / reject / reset patterns (data paths ready)
```

## 26. Schema impact

1. **Can Phase 6 be implemented entirely with existing tables?** Raw signals: **yes** (already stored). The aggregated, decaying belief state: **no** — it has no safe home without scattering logic and losing decay state.
2. **Minimum new structure:** **one table** — `learned_patterns` (§10), covering inferred patterns and explicit preferences via `origin`.
3. **Existing-field refinements needed:** **none mandatory.** Conventions documented (no schema change): `memory_events.detail` carries a standardized signal payload (`field`, `from`, `to`, `context`); Phase 3's `LEARNING_SIGNALS` block gains the §13 contract.
4. **Deferred changes:** a dedicated `pa_feedback` table (still deferred from Phase 5 — patterns reference raw interactions and PA item evidence directly); any audit fields for suggestion exposure (only if loop audits later demand them); explicit-preference acquisition UI (Phase 7+).

**Nothing executed** — reference DDL only.

## 27. Deferred decisions

- Final threshold values, weights, caps and half-lives (defaults in this document; tuned with real data)
- AI-assisted consolidation mechanics (merging redundant patterns) — batch shape and prompts
- Explicit-preference acquisition surface ("teach ScreenView" affordance) — Phase 7+
- How PA kind-demotion is surfaced (silent slot reduction vs. an explanatory note)
- Learned-pattern retention/pruning policy (rows are tiny; keep all in V1)
- Language-pattern detection depth beyond candidate list (e.g., phrase classes) — later refinement
- Whether accepted-suggestion discounting (×0.4) needs a second discount tier for repeated same-day accepts (tuning)

## 28. Final decisions

1. **Five-category definition of learning** with hard boundaries; AI inference is never evidence (§2).
2. **Signal taxonomy** with per-signal teaching scope, strength classes, durations and evidence bars — all tunable defaults (§3).
3. **Correction loop:** cases → classes → tentative → established; single corrections never become rules (§4).
4. **Positive/negative asymmetry:** negatives act faster and narrower; positives slower and broader; one dismissal ≠ permanent rule (§5).
5. **Confidence model:** weighted evidence + diversity; levels observation → tentative → established → explicit; inferred capped ≤0.9 (§6).
6. **Decay & reinforcement:** half-lives by scope; expiry below floor; reactivation low; explicit statements supersede, never silently (§7).
7. **Explicit > inferred**, with conflict questions surfaced instead of silent overrides (§8).
8. **Feedback-loop safeguards:** AI-origin weight 0; exposure ≠ evidence; accepts discounted; diversity required; suppression works; audits cheap (§9).
9. **One new table** (`learned_patterns`) + conventions; no other schema change (§10, §26).
10. **Learning enters only at GPT-OSS reasoning** as a ≤5–6-line personal-context bundle; retrieval and embeddings stay objective (§13, §14).
11. **Connections/collections/PA:** scoped, decaying suppressions; evidence bars raised, never auto-created items; PA can only get quieter/better-targeted (§15–§17).
12. **Cold start:** works with zero learning; influence begins only at tentative thresholds (§18).
13. **Authority hierarchy** adopted with case-supremacy and recency mechanics (§19).
14. **Explainability by data** (evidence refs on every pattern) and **user control paths** (inspect/correct/reject/reset/opt-out) (§20, §21).
15. **Deterministic-first:** models label/summarize only what deterministic logic selected (§22).
16. **Jobs:** synchronous ingest inside existing transactions + one daily consolidation step — no new infrastructure (§23).
17. **V1 boundary:** structured signals + contextual prompting; no fine-tuning, no RL, no profiling (§24).

---

_Phase 6 complete — learning architecture defined, nothing implemented. Next: Phase 7 — Interface & UX (awaiting go-ahead)._
