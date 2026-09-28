# Phase 3 — AI Architecture: ScreenView

| | |
|---|---|
| **Project** | ScreenView |
| **Phase** | 3 — AI Architecture |
| **Status** | ✅ Complete |
| **Date** | 2026-09-28 |
| **Next phase** | Phase 4 — Application & Processing Architecture |

This document defines the complete AI architecture — what each model receives, produces, may decide, and must never decide — **before any AI integration or application code is written**. Nothing in this phase has been implemented: no SDKs installed, no API calls made, no tables created. Every capability claim below was checked against current provider documentation on **2026-09-28** (sources listed in §2); where a claim could not be verified, it is marked as such rather than assumed.

---

## 1. AI architecture overview

Three model roles, plus deterministic (code, not model) engines around them:

| Role | Model (locked) | One-line job |
|---|---|---|
| **THE EYES** — vision/perception | Groq `qwen/qwen3.8-27b` | Describe what is visible in the screenshot — nothing more |
| **THE BRAIN** — memory reasoning | Groq `openai/gpt-oss-120b` | Interpret *why* it was saved and structure the memory, using the note + vision + retrieved personal context |
| **THE SIGNATURE** — embedding | NVIDIA `nvidia/llama-nemotron-embed-vl-1b-v2` | Turn the memory (text + image) into one multimodal vector for retrieval |
| Retrieval orchestrator | code | Build the candidate context set for the brain |
| Connection engine | code + the brain's judgment | Decide whether candidates are *meaningfully* related |
| Collection discovery | code + ≤1 brain call per run | Detect repeated patterns strong enough to suggest a collection |
| PA reader | code (+ Phase 5 design) | Weekly/twice-weekly reads — mostly SQL, almost no model calls |

**Architectural principles**

1. **Perception ≠ interpretation.** The eyes describe; the brain interprets; neither may do the other's job.
2. **The note is a first-class input**, passed verbatim, and it outranks everything the models infer.
3. **Suggestions vs facts.** Model output splits into the memory record (fact-with-provenance) and suggestion arrays (state = `suggested` until the user confirms).
4. **Retrieval ≠ connection.** Vector similarity proposes candidates; only reasoned judgment creates a connection. Cosine similarity is never a relationship.
5. **Minimal AI calls.** Exactly **2 LLM calls + 2 embedding calls per capture**; everything else is code. Expensive reasoning over many memories happens only in periodic batch jobs.
6. **Every model sits behind a provider-agnostic interface.** Model IDs and providers are configuration, not code — because provider catalogs churn (evidence in §2).

## 2. Model responsibilities & verification summary

### 2.1 Verified model facts (checked 2026-09-28)

| Claim | Verdict | Source |
|---|---|---|
| Groq hosts exactly one vision-capable model: `qwen/qwen3.8-27b` — 27B multimodal, 131K context, JSON mode, tool use, ≤3 images/request, 20MB request cap, each image billed as 2048 input tokens, $0.80/$4.00 per 1M | ✅ Confirmed | console.groq.com/docs/models, /docs/vision |
| `qwen/qwen3.8-27b` is a **preview** model ("may be discontinued at short notice") | ✅ Confirmed — design risk | console.groq.com/docs/models, /docs/deprecations |
| Groq's vision slot churns: llama-3.2-vision → llama-4-scout (deprecated 07/26) → qwen3.6-27b (deprecated 09/14/26) → qwen3.8-27b (current) — 4 models in ~18 months | ✅ Confirmed | console.groq.com/docs/deprecations |
| `openai/gpt-oss-120b` on Groq: production, 131K context, 500 t/s, $0.15/$4.00→$0.60 output, 65K max completion | ✅ Confirmed ($0.15 input / $0.60 output per 1M) | console.groq.com/docs/models |
| Groq **strict** Structured Outputs (constrained decoding, guaranteed schema) is limited to **GPT-OSS 20B/120B**; other models get best-effort/JSON-object mode | ✅ Confirmed — decisive for contract design | console.groq.com/docs/structured-outputs |
| Groq hosts **no embedding models** (no embeddings endpoint in catalog) | ✅ Confirmed — embedding layer must live elsewhere | console.groq.com/docs/models |
| NVIDIA `nvidia/llama-nemotron-embed-vl-1b-v2`: hosted NIM API exists; multimodal bi-encoder (documents = image, text, or image+text; queries = text); **2048-dim** output; commercial-ready (NVIDIA Open Model License); self-hostable via vLLM | ✅ Confirmed | docs.api.nvidia.com NIM reference; HF model card `nvidia/llama-nemotron-embed-vl-1b-v2-fp8` |
| Embed model max input: NIM reference says 8,192 tokens; HF card says 10,240 (6 image tiles + thumbnail ≈ 1,792 visual tokens) | ⚠️ Discrepancy — plan against the conservative 8,192 hosted limit | both sources above |
| NVIDIA companion reranker exists (`nvidia/llama-nemotron-rerank-vl-1b-v2`) | ✅ Confirmed — noted as future quality option, not V1 | docs.api.nvidia.com |
| OpenRouter `qwen/qwen3-vl-8b-instruct`: $0.117/$0.455 per 1M, 262K context, images+text in, **structured outputs supported**, 2 providers, ~99.4% availability | ✅ Confirmed | openrouter.ai/qwen/qwen3-vl-8b-instruct |
| OpenRouter `openai/gpt-oss-120b`: 17+ provider endpoints, $0.03–$0.20 input across providers, ~99.7% availability | ✅ Confirmed | openrouter.ai/openai/gpt-oss-120b |
| Gemma 3 27B (`google/gemma-3-27b-it`) exists on NVIDIA's catalog as a visual model | ✅ Listed — but structured-output support **unverified** | docs.api.nvidia.com |
| OpenRouter data policy details (retention, training) | ❌ Not verified (policy page is JS-rendered; didn't extract) — **verify before enabling OpenRouter** | openrouter.ai homepage confirms provider allowlists / "custom data policies" exist |

**Corrections to the Phase 1 candidate list** (this is why we verify): "Groq Qwen multimodal" is real but is `qwen/qwen3.8-27b` in **preview** status; "Llama Nemotron Embed VL" is **not on Groq** — it runs on NVIDIA's hosted API (or self-hosted vLLM). Both are workable with the guardrails below.

### 2.2 Responsibility matrix

| | Receives | Produces | MAY decide | Must NOT decide |
|---|---|---|---|---|
| **Qwen 3.8 27B** (eyes) | screenshot + fixed instruction | visual analysis JSON (§4) | content_type, visible text, entities, prices, URLs, dates, visual description | user intent, importance, collections, actions, reminders, anything about *why* the user saved it |
| **GPT-OSS 120B** (brain) | verbatim note + visual analysis + retrieved memory cards + learning signals + existing collections (§5) | memory interpretation JSON (§6) | title, summary, topic, intent (+source, confidence), suggested_action, status=`new`, candidate connections, collection membership candidates | overwrite/reinterpret the note, confirm suggestions, set any status ≠ `new`, delete anything, promote its own inference to user fact |
| **Nemotron Embed VL** (signature) | canonical text + screenshot (doc role); text (query role) | one 2048-dim vector per input | nothing — vectors only | anything; similarity is a retrieval signal, never a judgment |
| **Deterministic engines** | DB state | candidate sets, jobs, persistence | retrieval assembly, noise filtering, thresholds, job timing | content or relationship judgments of their own |

## 3. Qwen input contract (eyes — input)

- **Message structure:** system prompt (perception responsibilities, §19) + user message containing exactly **one image** (base64 data URL; API limit is 3 images/req — we use 1) + the fixed, versioned instruction asking for the §4 JSON.
- **Mode:** `response_format: json_object` (JSON mode — verified supported). Strict json_schema mode is **not** available on this model, so schema enforcement is app-side (§16).
- **Parameters:** low temperature (final value at implementation), `max_completion_tokens` ≈ 1024.
- **Hard limits (verified):** request ≤ 20MB; image bills as 2048 input tokens regardless of resolution. The backend fetches from Supabase private storage and sends base64 (plumbing detail → Phase 4).

## 4. Qwen output contract (eyes — output)

```json
{
  "content_type": "product_page | pricing_page | article | social_post | website_ui | app_ui | chat_conversation | advertisement | video_frame | document | photo | meme | other",
  "visual_description": "1–3 sentences, objective, of what is visible",
  "visible_text": { "headings": [], "body_snippets": [], "captions": [], "buttons": [], "other": [] },
  "detected_entities": [ { "type": "product | brand | person | organization | app | website | place", "name": "", "confidence": 0.0 } ],
  "prices": [ { "amount": "", "currency": "", "context": "" } ],
  "urls": [],
  "dates_visible": [],
  "important_visual_details": [],
  "image_quality_notes": ""
}
```

- Deliberately compact; every field may be empty; `unknown`-style honesty beats guessing.
- Enforced **app-side**: JSON Schema validation → one repair retry (validation error fed back) → fallback model (§17) → failure path (§16). The capture is never lost.

## 5. GPT-OSS input contract (brain — input)

One user message assembled from five clearly delimited, versioned blocks:

1. `ORIGINAL_USER_NOTE` — **verbatim, never paraphrased**; `null` if absent. The user's own *why*.
2. `VISUAL_ANALYSIS` — the Qwen JSON from §4, verbatim.
3. `RETRIEVED_MEMORIES` — up to 12 compact cards: `{id, title, topic, intent, action, status, created_at, note_excerpt}`.
4. `LEARNING_SIGNALS` — compact summary of the user's relevant past corrections (V1: simple rules over `memory_events`; Phase 6 expands).
5. `EXISTING_COLLECTIONS` — accepted collections only: `{id, name, description, member_count}`.

- **Mode:** `response_format: json_schema` with **`strict: true`** — constrained decoding, guaranteed schema compliance (verified: GPT-OSS is one of only two Groq models supporting strict mode). This is the reliability backbone of the whole pipeline.
- Typical input ≈ 4K tokens (vision JSON ~1K + cards ~2K + instructions) — far under the 131K window.

## 6. GPT-OSS output contract (brain — output)

```json
{
  "title": "",
  "summary": "",
  "topic": "",
  "intent": "buy | research | try | build | read | watch | save_for_later | compare | contact | inspiration | unknown",
  "intent_source": "user_statement | strong_context | user_behavior | visual_inference | ai_inference | unknown",
  "intent_confidence": 0.0,
  "intent_reasoning": "short evidence chain citing which input justified this",
  "suggested_action": "buy | evaluate | test | build | read | watch | compare | contact | save_for_reference | none",
  "status": "new",
  "candidate_connections": [
    { "memory_id": "", "relationship_type": "same_subject | complementary | thematic", "confidence": 0.0, "basis": "" }
  ],
  "collection_membership_candidates": [
    { "collection_id": "", "confidence": 0.0, "basis": "" }
  ]
}
```

**FACT vs SUGGESTION split (enforced by the writer, not the model):**

- The scalar block becomes the `memories` row + initial `memory_events` (fact-with-provenance: `intent_source`, `intent_confidence`, `actor='system'`).
- The two arrays become `connections` / `collection_members` rows with `state='suggested'`, `origin='ai'` — **suggestions until the user confirms**. The brain never creates confirmed connections, collections, or non-`new` statuses.

**Hard guardrails encoded in the prompt responsibilities (§19) and validated app-side:**

- Explicit note present → intent must come from `user_statement` (the note is not "context", it is the user speaking).
- Note contradicts visual inference → note wins.
- No note → lower hierarchy tiers allowed; if none is reasonable → `intent: "unknown"`. **Never invented.**
- `intent_reasoning` must cite the actual input; a missing/empty chain fails validation.

## 7. Intent vs action model

Two different questions, two different vocabularies — overlapping only where life genuinely overlaps:

- **INTENT — "Why did I save this?"** (motivation): `buy · research · try · build · read · watch · save_for_later · compare · contact · inspiration · unknown`
- **ACTION — "What might I want to do next?"** (potential next step): `buy · evaluate · test · build · read · watch · compare · contact · save_for_reference · none`

The intent vocabulary stays as locked in Phase 2. The action vocabulary is refined here, per the Phase 3 brief's examples:

| User note | Intent | Action |
|---|---|---|
| "I don't know if this is worth buying." | `research` | `buy` (a potential future purchase — currently being evaluated) |
| "I want to remember this for later." | `save_for_later` | `none` |
| "This would be cool to build." | `build` | `build` |

Semantic rule: intent is the motivation at save time; action is the practical next step the memory implies. They may coincide (build→build) or diverge completely (research→buy, save_for_later→none). Neither field is derived from the other by string matching — the brain reasons both, with the intent hierarchy governing intent only.

**Recommended schema change (Phase 2 impact — documented, not executed):**

- **CURRENT:** `memories.suggested_action` CHECK = `('buy','research','try','build','read','watch','save_for_later','compare','contact','reference','none')`
- **PROBLEM:** the action vocabulary mirrored the intent vocabulary, collapsing the two concepts the product explicitly separates (Phase 1 §9/§14; Phase 3 brief "INTENT VS ACTION").
- **PROPOSED CHANGE:** CHECK = `('buy','evaluate','test','build','read','watch','compare','contact','save_for_reference','none')` — removes intent-only motivations (`research`, `try`, `save_for_later`), adds next-step values (`evaluate`, `test`, `save_for_reference`).
- **WHY:** enforces the semantic distinction at the storage layer; non-destructive (constraint swap in the initial migration at build time; the table doesn't exist yet anywhere).

## 8. Intent priority hierarchy (implementation of Phase 1's ladder)

Decision procedure, in order, first match wins:

1. **Explicit user statement** — the note (or an explicit confirmation) states the why → `intent_source='user_statement'`
2. **Strong contextual statement** — phrasing in the note implies the why without stating it outright
3. **Existing user behavior/pattern** — the user has treated similar captures this way before (from `memory_events` + learning signals)
4. **Visual inference** — what the content itself suggests (checkout page → shopping context)
5. **General AI inference** — weakest; plausible default reasoning

If none yields a reasonable answer: **`intent='unknown'`** — a first-class, honest value.

**Confidence model (conceptual):** confidence is per-assertion and bounded by source tier — `user_statement` ≥ 0.9 · `strong_context` 0.7–0.9 · `user_behavior` 0.5–0.8 · `visual_inference` 0.3–0.6 · `ai_inference` 0.2–0.5 · `unknown` → null. The model may place itself lower within its tier; never higher. App-side validation rejects out-of-band values.

**Anti-hallucination rules:** no intent without a citable input; `intent_reasoning` required; `unknown` always acceptable; user corrections always override and are recorded as events (Phase 2 §5 mechanics).

## 9. Retrieval strategy (V1 minimum)

**When:** once per capture, after vision, before reasoning — plus later at user-facing search time (Phase 7). Not on corrections, not on PA reads (those are SQL).

**How (minimal practical set):**

1. **Provisional query embedding** — text-only: `note + visual_description + content_type` → embed with the same model (query role) — this happens *before* the memory exists, which is why the query is provisional rather than the canonical document.
2. **Vector KNN** — pgvector cosine, top **K=10** over `memory_embeddings` (current model only).
3. **Deterministic supplements** — exact topic matches (≤5, most recent), and any memories sharing the `file_hash` (exact duplicates — they matter for judgment).
4. Merge, dedupe, cap at **12 memory cards** (fields in §5).

**Why this is enough for V1:** single user; the corpus starts at zero and grows by a few captures a day; HNSW over even tens of thousands of vectors is milliseconds. Rerankers (NVIDIA's `llama-nemotron-rerank-vl-1b-v2` is verified available) and intent/action-weighted retrieval are documented upgrades, deliberately not V1.

**Purpose (the brief's example):** a new AI-tool screenshot retrieves the earlier screenshot of the same tool, its pricing page, the "I want to test this" memory, and the project where it could be useful — so the brain can propose `same_subject` connections and see the user's pattern. Retrieval gives the brain *personal context*; it does not itself conclude anything.

## 10. Embedding strategy

- **Model:** `nvidia/llama-nemotron-embed-vl-1b-v2` — **locked**. Hosted via NVIDIA's API (verified endpoint; free trial credits typically available at signup — confirm at implementation), with self-hosted vLLM as the escape hatch (open license, verified serving recipe).
- **What it represents:** the **memory**, semantically — not OCR text.
- **Dimensions:** **2048** (verified) → Phase 2's `memory_embeddings.embedding` becomes `vector(2048)` at build time. The `(memory_id, model)` key already tolerates a future model change (new rows, new dims, no destructive migration).
- **Two calls per capture:** (a) *query* embedding — text-only, for retrieval; (b) *document* embedding — **screenshot image + canonical text together** (verified supported: image+text documents) — the stored signature. Queries are always text (verified: query side is text).
- **Similarity metric & index:** cosine (`vector_cosine_ops`), HNSW — as planned in Phase 2.
- **Input budgeting:** plan against the conservative hosted limit of **8,192 tokens** (NIM page; HF card says 10,240). Canonical text is capped (~1,500 tokens; template in §11) so text + image (≈1,792 visual tokens per HF card) fits.
- **Input hashing (Phase 2 §9, now concrete):** `input_hash = sha256(canonical_text + image_file_hash)`; re-embed only when the hash changes (i.e., when topic/intent/action/title/summary change — the note never changes).
- **Honest limitation:** this model was trained/evaluated for **visual document retrieval** (PDFs, tables, charts — ViDoRe). Casual phone screenshots are adjacent, not core, distribution. Expect the text channel to carry most of the semantics; the image channel adds visual-layout matching. Phase 9 should A/B text-only vs multimodal embeddings before over-investing.
- **Not finalized here (per the brief):** none — model, dims, metric, index are now locked; only account provisioning and exact pricing remain (implementation).

## 11. Canonical embedding representation

**Included (and why):**

| Component | Why it belongs in the vector |
|---|---|
| `title` | The memory's human-meaningful identity — dense semantic anchor |
| `summary` | The content essence |
| `topic` | Makes topic-adjacent memories reachable |
| `intent` | **The why** — same topic + different intent must NOT be maximally similar; this is what makes the vector a *memory* signature rather than OCR retrieval |
| `suggested_action` | Supports action-oriented queries ("what was I going to buy?") |
| `visual_description` | The perception layer in words — carries visual semantics into the text channel |
| **original user note (verbatim)** | The user's own why — the strongest personal signal in the system |
| **screenshot image (multimodal channel)** | Preserves visual similarity (same product on different sites, recurring UI patterns) that text cannot |

**Excluded (and why):** raw `visible_text` OCR dumps (redundant with visual_description, noisy, bloats the token budget) · URLs/prices/dates (exact-match territory, not semantic) · status (lifecycle ≠ meaning — archived memories must stay retrievable) · connections/collections (derived structure, not memory meaning) · ids/timestamps (non-semantic).

**Assembly:** a deterministic, versioned template (`canonical-v1`), e.g. `Title: … Summary: … Topic: … Intent: … Action: … Visual: … User note: …` + the image attached as the document's visual part. The exact template text is an implementation detail; its *composition* is locked here.

## 12. Connection engine

**Definition of the boundary (the brief's critical distinction):** vector retrieval answers *"which existing memories are potentially relevant?"* The connection engine answers *"are these two memories actually meaningfully related?"* — **cosine similarity itself is never a connection.** Two laptop screenshots may be near-identical vectors and completely unrelated saves.

**V1 pipeline (runs inside the capture flow; no separate model call):**

1. **Candidate set** = the retrieved memory cards from §9 (already computed — no extra retrieval, no extra embedding).
2. **Noise filter (code):** similarity floor (cosine < ~0.5 → drop; tune at implementation), self-connections impossible, existing connections excluded, RLS keeps it per-user.
3. **Relationship evaluation (the brain):** the GPT-OSS call (§5/§6) receives the candidates and outputs `candidate_connections` — each with `relationship_type`, `confidence`, and a `basis` string. A connection must be *justified*, not merely possible.
4. **Persistence (code):** `connections` rows, `state='suggested'`, `origin='ai'`, `basis` JSONB = {signals, reasoning, prompt_version}, deduped by the unique `(source, target, type)` constraint.
5. **Promotion (human):** only user confirmation → `confirmed`; dismissal → `dismissed` (kept as a negative learning signal, never hard-deleted — Phase 2 rule).

**Relationship types:** Phase 2's four — `same_subject`, `complementary`, `thematic`, `user_linked` — are **sufficient for V1** (evaluated against the brief's examples: perfume↔perfume = same_subject; laptop↔accessory = complementary; website↔website & AI-tool↔project-idea = thematic). A generic `similar` type is explicitly **rejected**: similarity is a retrieval signal, not a meaningful relationship.

**Thresholds:** connections below confidence ~0.6 are not even suggested (tune at implementation). A batch-level connection sweep over recent memories runs periodically alongside collection discovery (§13) — never N×N synchronous reasoning (§15).

## 13. Collection discovery

**Principle:** collections emerge from repeated patterns across memories — never from a single capture, never per-capture.

**When:** a periodic job (conceptually daily, or every ~20 new memories — cadence locked in Phase 4) + never in the capture path. The only per-capture collection touch is *membership candidates for already-accepted collections*, produced by the brain call (§6).

**Evidence model (deterministic-first, V1):**

- Topic frequency: ≥3 memories sharing a normalized topic within ~60 days
- Connection density: a `same_subject`/`thematic` cluster with ≥3 memories and ≥2 internal connections
- Intent×topic co-occurrence: ≥3 memories with the same intent in one topic (e.g., three `buy` intents in "fragrance" → "Fragrances to buy" candidate)

**What makes a pattern strong enough (V1 rule):** ≥3 distinct memories + ≥2 independent signal types + not already covered by an accepted collection (checked by embedding-similarity against existing collection descriptions).

**Suggestion generation:** **one** GPT-OSS call per discovery run — input: candidate pattern statistics + memory titles; output: `{name, description, member memory_ids, basis}` → `collections` row, `state='suggested'`, `origin='ai_suggested'` + `collection_members` rows (`suggested`). The user accepts, renames, merges, or dismisses (Phase 2 schema already supports all four).

**Deliberately not in V1:** clustering algorithms, embedding-space segmentation, auto-accepted collections. Observe → suggest → confirm.

## 14. Processing sequence (definitive)

```
USER ── screenshot + optional note
  ▼
[0] Upload → Supabase Storage (private) + `captures` row (pending)
     └── originals are safe BEFORE any AI call — the core failure invariant
  ▼
[1] VISION — Groq qwen/qwen3.8-27b (JSON mode) → visual analysis JSON
     └── fallback: OpenRouter qwen/qwen3-vl-8b-instruct
  ▼
[2] QUERY EMBEDDING — NVIDIA embed-vl (text: note + visual_description)   ← provisional query
  ▼
[3] RETRIEVAL — pgvector KNN(10) + topic/duplicate supplements → ≤12 memory cards
  ▼
[4] REASONING — Groq gpt-oss-120b (strict json_schema)
     inputs: note (verbatim) + vision + cards + learning signals + existing collections
     outputs: memory fields + candidate connections + collection membership candidates
     └── fallback: gpt-oss-20b → OpenRouter gpt-oss-120b
  ▼
[5] PERSIST (one transaction) — memories + initial memory_events + suggested connections
  ▼
[6] DOCUMENT EMBEDDING — NVIDIA embed-vl (image + canonical text) → memory_embeddings
  ▼
MEMORY SEARCHABLE (SQL + vector)

  ─ ─ ─ periodic (async; cadence in Phase 4) ─ ─ ─
  [P1] collection discovery job (SQL patterns + ≤1 reasoning call per run)
  [P2] connection sweep over recent memories
  [P3] embedding backfill (rows missing vectors due to failures)
  [P4] PA report composition (Phase 5) — SQL reads + at most 1 reasoning call
```

**Ordering rationale (deviation note):** this matches the brief's diagram with one deliberate addition — the **provisional query embedding** (step 2) must happen *before* the memory exists, because retrieval (step 3) needs a query vector and the memory's canonical embedding doesn't exist yet. The brief's diagram implied retrieval before GPT-OSS but didn't specify what powers it; this closes that gap. Vision-before-retrieval is also required: the query text includes the visual description. Everything else follows the brief's order.

**AI call schedule (explicit):**

| Moment | AI calls |
|---|---|
| **On capture** | 1 vision + 1 query embedding + 1 reasoning + 1 document embedding |
| **After memory creation** | None — connections were produced by the reasoning call; persistence is code |
| **After many memories exist** | Periodic only: collection discovery (≤1 reasoning/run), connection sweep (code, optional reasoning), embedding backfill |
| **During user correction** | 0 LLM calls (event append + denormalized update are code); ≤1 embedding call *if* semantic fields (topic/intent/action/title/summary) changed → canonical hash changed → re-embed |
| **During PA review** (Phase 5) | Mostly SQL; ≤1 reasoning call per report for composition |

**Cost estimate (list prices, Groq):** per capture ≈ vision ~2.4K in + ~0.7K out ≈ $0.005 · reasoning ~4K in + ~0.8K out ≈ $0.001 · embeddings negligible at personal scale (NVIDIA pricing to confirm at impl) → **≈ $0.006/capture; 100 captures ≈ $0.60**. This is why minimal-calls is affordable and why per-capture collection discovery would be waste.

## 15. Batch processing

- **Per-capture pipeline is constant** regardless of batch size: each screenshot independently goes through [1]–[6]. Batches fan out as independent jobs with a small concurrency cap (e.g., 5 — exact value Phase 4).
- **No N×N synchronous reasoning.** Cross-memory work happens (a) implicitly per capture via retrieved candidates, and (b) explicitly in the periodic batch jobs (connection sweep + collection discovery) over *recent* memories only.
- **Sizing:** 1 / 10 / 50 / 100 captures → 4 / 40 / 200 / 400 AI calls ≈ $0.01 / $0.06 / $0.30 / $0.60. Groq developer-tier limits (250K TPM, 1K RPM) absorb a 100-batch in minutes with the concurrency cap.
- **Duplicate shortcuts:** exact duplicates (same `file_hash`) in one batch skip vision (reuse the sibling's visual analysis? No — **re-run per capture in V1**; reuse is an optimization, not a correctness requirement; noted as implementation option).
- Queue/worker infrastructure: **Phase 4** (per the brief).

## 16. Failure handling

**Core invariant:** the screenshot and the verbatim note are persisted *before* any AI call. Every AI-derived artifact is re-creatable from `(screenshot + note)`. No AI failure can lose user data.

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| Vision call fails / times out | HTTP error, timeout | Capture stays `processing`; retry ×2 with backoff → OpenRouter fallback → `failed` | Screenshot + note intact; reprocess on demand |
| Vision returns invalid JSON | app-side schema validation | 1 repair retry (error fed back) → fallback model → `failed` | Same |
| Reasoning fails | HTTP error | Retry ×2 → `gpt-oss-20b` (same host, strict schema, cheaper/weaker) → OpenRouter → `failed` | Same |
| Strict-schema 400 (shouldn't happen — constrained decoding) | API error | Retry → best-effort mode with validation → fallback → `failed` | Same |
| Document embedding fails | HTTP error | **Memory persists without a vector** — searchable via SQL, not by similarity; row flagged | Periodic backfill job re-embeds missing rows |
| Query embedding fails | HTTP error | Proceed with empty retrieval context (reasoning still works, less personal) | Log; next captures unaffected |
| Retrieval (pgvector) fails | DB error | Same as above — degrade to SQL-only supplements | Log; PA/DB alerts |
| Connection/collection persistence fails | DB error | Transaction rolls back; memory itself retries independently | Jobs are idempotent (unique constraints) |
| Rate limit (429) | Header | Respect `Retry-After`; concurrency cap; personal V1 rarely hits limits | Automatic |

Nothing here chooses queue/worker infrastructure — that is Phase 4's decision. This section defines the *behavior contract* those workers will implement.

## 17. Model fallback strategy

Rule: a fallback must replace a primary task with a **contract-compatible** model, and earn its place. (Verified prices 2026-09-28.)

| Fallback | Replaces | Why it's needed | Contract compatibility | Quality / cost / latency | V1 verdict |
|---|---|---|---|---|---|
| **OpenRouter `qwen/qwen3-vl-8b-instruct`** ($0.117/$0.455) | Vision (Groq qwen3.8-27b) | Groq's only vision model is **preview**; the vision slot has churned 4× in 18 months | Same JSON contract; OpenRouter structured outputs (json_schema) ≥ Groq JSON-object mode | Similar cost; +1 provider/key; slightly slower | **Needed — designed in from day one** |
| **Groq `openai/gpt-oss-20b`** ($0.075/$0.30) | Reasoning (gpt-oss-120b) | Same-host insurance: zero new dependency, same strict structured outputs | Identical (same API, same strict mode) | Weaker reasoning; cheaper; faster | **Configured, automatic** |
| **OpenRouter `openai/gpt-oss-120b`** | Reasoning | Host-outage insurance (17+ providers, ~99.7% availability) | Identical weights → identical contract | Comparable cost | **Documented + config-ready, OFF by default** (privacy: fewer providers see data by default; enable consciously) |
| Self-host vLLM `llama-nemotron-embed-vl-1b-v2` | Embedding (NVIDIA hosted) | Identical weights, open license | Identical (same model) | Requires GPU infra | **Not V1** — documented escape hatch |
| Gemma 3 27B (NVIDIA catalog) | Vision (tertiary) | Exists, but structured-output support unverified; third contract surface | Unverified | Unknown | **Not in V1 chain** — kept as documented option |

Deliberately **no** embedding-model fallback in V1: embedding failure degrades gracefully (§16) and backfills later — a simpler architecture than a second embedding provider (which would fragment the vector space anyway: vectors from different models are not comparable, so a fallback embedder would force a full re-index; noted as a reason to stay single-model).

**Operational guardrail:** model IDs live in server config; startup smoke-tests the primary; Groq deprecation emails are watched (their history shows ~30-day windows); switching vision models is a config change + contract re-test, not a code change.

## 18. Privacy / provider considerations

**What leaves the machine:** the screenshot image (to the vision model and the embedding model) and derived text (note, visual analysis, memory cards — to the reasoning model). Never both the raw image *and* identity metadata together. All calls are server-side; AI keys never reach the frontend (Phase 2 baseline upheld).

- **Groq** (read 2026-09-28, console.groq.com/docs/your-data): customer data is **not retained by default**; inputs/outputs may be temporarily logged (≤30 days) only for reliability/abuse investigation; **Zero Data Retention is self-serve** in Data Controls; batch and fine-tuning features retain data (ScreenView uses neither); data resides in GCP US buckets. *Action at implementation:* enable ZDR; avoid retention-dependent features. The page we read governs retention; the broader privacy policy's training clause should be re-confirmed at implementation — no claim made here beyond what the page states.
- **NVIDIA hosted embedding** (model card, read 2026-09-28): trial governed by NVIDIA API Trial Terms; the model's privacy card states no personal data was used to create the model and user-interaction data was not used to train it. **Hosted-API retention specifics: not fully verified — confirm NVIDIA API terms before production use.** Mitigation: only the screenshot + derived text is sent; no identity metadata.
- **OpenRouter**: provider allowlists and custom data policies exist (homepage, verified); the detailed data policy page did not render for extraction — **verify before enabling** (it's OFF by default per §17).
- **Sensitive content stance:** screenshots and notes may contain private information (chats, banking, health). V1 consciously accepts external model calls — the personal-scale trade-off — with four structural mitigations: private-by-default storage, ZDR where available, minimal data per call, and one genuine architectural win: **the reasoning model never receives the raw image**, only its textual analysis (cost and privacy at once).

## 19. Prompt architecture (responsibilities — production prompts are written at implementation)

- **Qwen system prompt responsibilities:** perception only; describe what is visible objectively; report unknowns as empty rather than guessing; no interpretation of user purpose, importance, or meaning; output compact JSON per §4.
- **Qwen input structure:** `[image]` + fixed versioned instruction restating the schema.
- **Qwen output schema:** §4.
- **GPT-OSS system prompt responsibilities:** interpret the capture under the intent hierarchy (§8); the note is the user speaking — never reinterpret, paraphrase, or override it; distinguish fact-block from suggestion arrays; `unknown` is always acceptable; cite evidence for intent; respect existing collections; never invent memories or ids not present in the input.
- **GPT-OSS input structure:** the five delimited blocks of §5, under a versioned prompt-pack.
- **GPT-OSS output schema:** §6 (strict mode).
- **Connection reasoning I/O:** V1 — inside the GPT-OSS call (candidates in; typed, justified suggestions out). Standalone contract for future phases: input = two memory cards; output = `{relationship_type, confidence, basis}` or `none`.
- **Collection reasoning I/O:** periodic job — input = pattern statistics + memory titles; output = `{name, description, members, basis}` (§13).
- **Prompt versioning:** all prompts live in the repo, semantically versioned; the version is recorded in `memory_events.basis` / `connections.basis` for auditability and Phase 6 learning.

## 20. Definitive AI architecture diagram

(See §14 — the processing-sequence diagram **is** the definitive architecture diagram, including fallback branches, the persistence transaction, and the four periodic jobs.)

## 21. Decisions deferred to Phase 4

- Queue/worker infrastructure and job orchestration (where [1]–[6] and [P1]–[P4] execute; serverless vs long-running)
- API route surface, auth integration points, upload plumbing (signed URLs vs base64 to providers)
- Scheduling/cadence of periodic jobs (collection discovery, connection sweep, embedding backfill, PA)
- Concurrency caps and backoff specifics; rate-limit budget monitoring
- Image preprocessing pipeline (resize policy for the 20MB / embedding-model limits)
- Where the provider-agnostic model interface lives (single AI gateway module boundary)

## 22. Decisions deferred to implementation

- Final prompt text for all four contract roles (§19 defines responsibilities only)
- Decoding parameters (temperatures, max tokens) per call
- Exact thresholds: retrieval K (10 planned), similarity floor (~0.5 planned), connection confidence floor (~0.6 planned), collection evidence minimums (≥3 memories, ≥2 signals planned) — all to be tuned with real data in Phase 9
- HNSW index build parameters; canonical template v1 exact formatting
- NVIDIA API account provisioning, key management, and current pricing confirmation
- Model-ID pinning and upgrade policy (config values + smoke tests)
- Privacy re-verification checklist at go-live: Groq ZDR enabled, NVIDIA API terms confirmed, OpenRouter policy confirmed (if enabled)

---

_Phase 3 complete — architecture defined, nothing implemented, no API keys touched. Next: Phase 4 — Application & Processing Architecture (awaiting go-ahead)._
