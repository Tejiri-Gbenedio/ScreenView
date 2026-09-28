# Phase 1 — Product Definition: ScreenView

| | |
|---|---|
| **Project** | ScreenView |
| **Phase** | 1 — Product Definition |
| **Status** | ✅ Complete |
| **Date** | 2026-09-28 |
| **Next phase** | Phase 2 — Data & Memory Architecture |

---

## 1. Product name

**ScreenView**

## 2. Product purpose

People capture more than ever — and remember less than ever. Screenshots pile up across phones and laptops, each one holding a moment that mattered: a product to buy, an idea to explore, a design to reference, a tool to try. Days later, most of them are noise — because the context that made them valuable (*why it was saved*) is gone.

ScreenView turns raw screenshots into a **personal memory system**. The user dumps a screenshot plus an optional note; the AI does the remembering: what it is, why it was saved, what it connects to, and what — if anything — should happen next.

**Tagline:** The screenshot tells us *what*. The note tells us *why*. ScreenView keeps both.

## 3. Core user problem

- The user saves screenshots constantly — from both phone and laptop — but those saves live in a graveyard where nothing is ever revisited.
- The problem is **not capture**; capture is easy. The problem is that the *why* is never recorded, so every save loses its purpose the moment it's made.
- "Why did I save this?" becomes unanswerable — and whatever was going to be done with it (a purchase, a project, a read, a try) never happens.
- Manual solutions (albums, folders, note apps, "organize as you go") demand organization at capture time — exactly the moment when the user won't do it. Friction kills the habit.
- Classic failure states: the perfume you meant to buy is lost among 4,000 pictures; the thing you "definitely wanted to research" is gone; the design inspiration never resurfaces.

In short: a screenshot gallery stores pixels. ScreenView stores **intent**.

## 4. Core product principle

> **"I shouldn't have to organize my life for the AI. I should just be able to dump things into it, and it should do the remembering and organizing for me."**

Design implications:

- **Zero required metadata at capture time** — no category, folder, project, intent, collection, or tags.
- **Organization is the system's job.** The user's only job is to dump.
- **User statements are authoritative**; AI output is always distinguishable from user facts (see §10).
- The system adapts to the user's life — the user's life does not adapt to the system.

## 5. Core mental model

**Capture → Memory → Connection → Collection → Action**

| Stage | What happens |
|---|---|
| **Capture** | Screenshot + optional note enters the system. One action, no decisions. |
| **Memory** | The system forms a structured memory: what it is, why it was saved, possible action, status, confidence. |
| **Connection** | Related memories are linked — even when their topics differ. |
| **Collection** | Meaningful groups emerge from memories and connections; a capture can belong to many. |
| **Action** | The system helps the user follow through (buy, research, try, build, read, …), surfaced by the PA at a calm cadence. |

## 6. Target V1 user

**The creator/user themselves.** One real person, real screenshots, real devices (phone + laptop), real usage.

- V1 is personal-first: no teams, no sharing, no multi-user onboarding, no enterprise concerns.
- Success criterion: *this user* actually relies on it and stops losing saved things.
- Generalizing to other users comes only after V1 proves itself.

## 7. Capture experience

The capture flow is the product's front door. It must be:

**Screenshot + optional note → Upload → Done**

- No category, folder, project, intent, collection, or tag selection at capture time. Ever.
- The note is optional — but valuable: it often carries the *why* (§9).
- Works from both phone and laptop (responsive web app / PWA direction).
- Capture must be near-instant. Any meaningful friction is a product bug, not a user problem.

## 8. What the system should understand

For every capture, the system should eventually understand — and store — the following:

| Question | Field | Derived mainly from |
|---|---|---|
| What is visible? | visible content | the screenshot |
| What is it about? | topic | the screenshot (+ note) |
| What did the user say? | user note | user input (kept verbatim) |
| Why was it saved? | intent | note → context → behavior → visual → inference (§10) |
| What could happen with it? | suggested action | intent + topic |
| What does it relate to? | connections | embeddings, topic, intent, time, behavior |
| Where does it fit? | collection candidates | patterns across memories |
| Where does it stand? | status | user + system lifecycle (§15) |
| How sure are we? | confidence | per field, and per source |
| Who decided that? | provenance | user vs AI — never merged silently |

## 9. Topic vs intent

These are two different questions, and ScreenView keeps them separate:

- **Topic** — "What is this about?" (e.g., *Fragrance* · *Running shoes* · *Laptop* · *Website design* · *AI tools*). Derived from the content; relatively stable.
- **Intent** — "Why did I save this?" (e.g., *buy* · *research* · *inspiration* · *remember to try*). Derived primarily from the user; free to change over time.

Same screenshot, different notes → different intents:

| Screenshot | Note | Topic | Intent |
|---|---|---|---|
| Perfume product page | "I want to buy this." | Fragrance | Buy |
| Perfume product page | "I saw this new perfume. I don't know if it's worth trying." | Fragrance | Research / Try |

Collapsing topic and intent (e.g., filing things into a "Buy" folder) destroys meaning: the second capture above is **not** a buy, even though its topic is identical to the first.

## 10. Intent hierarchy

When determining intent, evidence is weighted in this exact order (highest first):

1. **Explicit user statement** — what the user wrote or explicitly confirmed ("I want to buy this.").
2. **Strong contextual statement** — statements made around the capture that clearly frame it.
3. **Existing user behavior / pattern** — how the user has treated similar captures before.
4. **Visual inference** — what the content itself suggests (a checkout page hints at shopping).
5. **General AI inference** — weakest; default reasoning with no stronger signal.

Rules:

- The system must be able to answer **"unknown"** when intent cannot reasonably be determined — it never invents an intent to fill a gap.
- Every intent carries its **source** and **confidence**, so user-stated intent is never confused with AI inference.
- If new evidence contradicts a previous intent, the change follows §11 (history preserved).

## 11. Intent history

Intent is allowed to evolve — that's normal life. What is not allowed is *losing* the original.

- Example: saved as *Buy* → user later decides *Research only* → eventually *Purchased* or *Dropped*. Each transition is a recorded event.
- Preserved per change: previous intent, new intent, **when**, and **why** (user correction vs. AI revision).
- Intent history powers: honest answers to "why did I save this?", better personal learning (Phase 6), and accurate status/action tracking.
- History is append-only: nothing about the user's past reasoning is silently rewritten.

## 12. Connections

Memories relate to each other — and not only within a topic.

- Examples: a perfume screenshot, a gift-ideas screenshot, and an old "things to buy" note may all connect through the intent *Buy*. A website-design screenshot and an AI-tool screenshot may both connect as *inspiration*.
- Connection signals: same/similar topic, same intent, same action, shared collection candidates, visual similarity, temporal proximity, explicit user linking.
- AI proposes connections; they start as **suggestions** and can be confirmed, corrected, or removed by the user.

## 13. Collections

**Folders are not the fundamental structure.** Collections are dynamic, AI-assisted groupings that emerge from memories and connections:

- A capture can belong to **multiple** collections.
- Collections form, merge, split, or fade based on evidence and usage — not manual filing.
- The system **observes patterns first**: three website screenshots is not "a project". A project/collection is only *suggested* once enough evidence exists.
- Collections express significance, not storage: removing a collection never loses the underlying memories.
- The user can accept, rename, merge, or dismiss suggested collections — user intent always wins.

## 14. Actions

An **action** is what a memory may imply practically — the "what next" attached to an intent.

Initial action vocabulary (kept deliberately small; to be refined in later phases):

`Buy` · `Research` · `Try` · `Build` · `Read` · `Watch` · `Save for later` · `Compare` · `Contact` · …

- Do **not** hard-code a large action taxonomy now — the real list should emerge from V1 usage and be refined in Phase 2+.
- Actions always link back to the intent and its source: a user-stated "I want to buy this" can produce a *Buy* action; an AI guess stays a suggestion until confirmed.
- Actions have a lifecycle (open → done / dropped), handled via §15 status.

## 15. Status

A minimal lifecycle keeps the system honest without turning it into a task manager.

**Draft taxonomy:** `New` · `Active` · `Completed` · `Dismissed` · `Archived`

- Keep it minimal — expand only if real usage demands it.
- Status changes are user-driven or user-confirmed; the AI may suggest transitions (e.g., "this looks done — archive it?").
- Status transitions are recorded, consistent with §11's history principle.

## 16. Personal Assistant behavior

The PA is what turns memories into value over time — without becoming noise.

- **Quiet at capture time.** No banners, no interstitial suggestions, no "you might also want…" at upload.
- **Periodic, not constant.** Preferred cadence: **weekly or twice-weekly** reports. Explicitly *not* a daily notification system.
- Watches for: things needing attention, emerging patterns, stalled intents, resurfacing old saves, and follow-through moments.
- Everything it surfaces is framed as a **suggestion**, clearly distinguishable from what the user actually said (see §10); the user can dismiss or snooze freely.
- As the system learns (Phase 6), reports get more personal — not more frequent.

## 17. PA report structure

Every report follows the same conceptual structure:

1. **Immediate / Needs Attention** — time-sensitive or high-signal items (a price-drop moment, an expiring plan, a clearly pending action the user set).
2. **Emerging** — patterns forming across recent captures (a topic the user keeps saving; a collection candidate with growing evidence).
3. **Everything Else** — gentle resurfacing: older saves worth revisiting, slowly decaying interests, completed threads to archive.

Nothing in the report is a hard demand — it's a companion's summary, not a boss's backlog.

## 18. Examples

| # | Capture | User note | Topic | Intent | Action | Notes |
|---|---|---|---|---|---|---|
| 1 | Perfume product page | "I want to buy this." | Fragrance | Buy | Purchase | Explicit statement → top of hierarchy |
| 2 | Perfume product page | "I saw this new perfume. I don't know if it's worth trying." | Fragrance | Research / Try | Evaluate / Try | Must **not** become "Buy" |
| 3 | Running shoes | "For the marathon maybe" | Footwear / Running | Buy later | Purchase | "Later" keeps urgency low |
| 4 | Laptop listing | "Need to replace mine at some point" | Laptop / Tech | Buy later | Purchase | Long-horizon intent |
| 5 | Website screenshot | (none) | Web design | Inspiration | Reference | Visual inference only → low confidence, stays a suggestion |
| 6 | AI tool screenshot | "Looks useful for the course" | AI tools | Research | Evaluate | Contextual link to the user's own project |
| 7 | Project idea (post) | "Build this someday" | Product ideas | Build | Build | "Someday" ≠ now |
| 8 | Long article | "Read when I have time" | (varies) | Read / research | Read | Classic deferred intent |

## 19. Non-goals

ScreenView is **not**:

- a traditional folder or file manager,
- a note-taking app,
- a generic chatbot,
- an enterprise knowledge-management system,
- an automation workflow platform — **no n8n, Zapier, or Make in the architecture**,
- a social, sharing, or team product in V1 (personal-first),
- a multi-user SaaS with onboarding, admin panels, and billing (unless V1 proves the concept).

Equally important during build-out: **no premature implementation.** This document defines the product; implementation begins only when Phase 8's build plan is locked.

---

## Deferred to later phases (intentionally open)

- Exact data model for memories, intent history, connections, and collections → **Phase 2**
- Final AI model choices, prompt strategy, and embedding pipeline → **Phase 3**
- Application architecture, processing pipeline, and job orchestration → **Phase 4**
- PA scheduling, report delivery channel, and suggestion mechanics → **Phase 5**
- How the system learns from corrections and behavior → **Phase 6**
- Capture UI details (mobile capture, PWA, browser extension?) → **Phase 7**
- V1 build scope and milestones → **Phase 8**

---

_Phase 1 complete — implementation intentionally not started. Next: Phase 2 — Data & Memory Architecture (awaiting go-ahead)._
