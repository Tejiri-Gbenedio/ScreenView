# Phase 7 — Interface & UX Architecture: ScreenView

| | |
|---|---|
| **Project** | ScreenView |
| **Phase** | 7 — Interface & UX Architecture |
| **Status** | ✅ Complete |
| **Date** | 2026-09-29 |
| **Next phase** | Phase 8 — Build Plan & V1 Implementation |

This document defines the complete user experience for ScreenView before implementation: navigation, capture flow, memory cards and detail, corrections, collections, connections, search, the PA surface, states, mobile/desktop behavior, and the first-session journey. **Architecture + UX design only** — no code, no components, no migrations, no dependencies. Phases 1–6 were inspected as the basis; one small documented refinement (R1 below) covers user note edits. The product principle governs everything here:

> *"I shouldn't have to organize my life for the AI. I should just be able to dump things into it, and it should do the remembering and organizing for me."*

The interface is a lightweight personal memory system — never a database admin panel, project-management tool, complicated notes app, folder manager, analytics dashboard, or a chatbot pretending to be the product.

### Refinements to earlier phases (documented, not executed)

- **R1 — `memory_events.event_type` gains `'note_change'`** (CHECK extension). Reason: users will fix typos or add context to their note; note edits must be recorded with history (old/new values already supported by the events table) so the original wording remains traceable. One-case, non-destructive.

---

## 1. UX principles

1. **Capture is frictionless.** Screenshot + optional note → done. No form, no required fields, no categorization, ever.
2. **Organization is invisible.** The user never picks a category, folder, topic, intent, or collection at capture time — the system does the organizing.
3. **Interpretation is inspectable.** What ScreenView thinks is always visible on the memory, in plain language.
4. **Corrections beat filing.** Changing what the AI thought takes one tap — always faster than manually organizing the item.
5. **Memory is discoverable.** Things can be found later without knowing where they were "stored" — search + surfaces do the work.
6. **The PA is quiet.** Useful items appear on a calm cadence; quiet periods produce nothing; no notification spam.
7. **Confidence in words, not scores.** "Likely" / "Not sure yet" — never percentages, logits, or model names.
8. **Facts and inferences never look identical.** "You said" vs "ScreenView thinks" is a visual language the whole app respects (§21–22).
9. **Screenshots stay prominent.** The visual artifact is the heart of every memory surface.
10. **Low navigation load.** The user understands the app in seconds: three areas + one capture action.

## 2. Information architecture

Primary areas (the smallest useful set; names chosen for the actual product model):

| Area | What it is | Notes |
|---|---|---|
| **Memories** (home) | Every memory, newest first; processing cards pinned at top; search + filters live here | Merges "Inbox/Recent" and "Memories" — one list, no folder concepts. Search is a mode of this screen, not a separate destination |
| **Collections** | AI-suggested and user-created groups, incl. projects | Suggestions pinned at top |
| **Assistant** | The PA: latest report + earlier reports | In-app only |
| **Capture** | A primary *action*, not a tab: center button (mobile), prominent button + drag-drop/paste (desktop) | Always one gesture away |
| **Settings** | Account, privacy line, learning controls, about | Via avatar menu — not a primary tab |

**Navigation:** mobile = bottom bar with 3 tabs + center Capture button; desktop = left sidebar (Memories, Collections, Assistant + Capture button on top; Settings in footer/avatar). No other navigation. No nested menus beyond detail screens.

## 3. Capture experience

**The ideal remains: screenshot + optional note → submit → done.**

**Desktop:**
- **Drag & drop** anywhere in the app (whole window is a drop target; dropzone overlay appears while dragging).
- **Paste** from clipboard anywhere (`Ctrl/Cmd+V`) — screenshots pasted straight into the tray.
- **"Add" button** (top-left) opens the file picker (multi-select).
- Files land in the **Capture tray** (a bottom-center modal): thumbnails, one optional note field (shared across a batch — a per-item note appears only when the user expands an item), primary **Save** button (Enter saves; Esc cancels). Upload of bytes starts as soon as files are added; Save finalizes the capture and kicks off processing.
- Cancellation: per-item ✕ while uploading; "Cancel all". Failed uploads: item shows "Upload didn't finish — Retry" and stays in the tray.

**Mobile:**
- **Capture button** (center of the bottom bar) opens the native picker: **photo library (multi-select) or camera**.
- Selected shots arrive in a **bottom sheet** with thumbnails and the same optional note field; one tap (**Save**) completes. Swipe down = cancel.
- Upload progress appears on thumbnails inside the sheet and continues in the Memories list after saving.
- **Share-sheet integration** (share a screenshot from another app directly into ScreenView) is a PWA enhancement evaluated at build time (Phase 8), not a V1 requirement.

**Rules:** no form; no required fields; the note field is always optional and always last; batch uploads are N independent captures sharing one optional note by default.

## 4. Capture states (what the user sees after submitting)

The capture lands in **Memories as a card** and never requires staying on any screen:

| State | Card shows | Notes |
|---|---|---|
| **Uploading** | Thumbnail with slim progress bar; "Uploading…" | Bytes go browser → storage directly |
| **Processing** | Thumbnail + gentle shimmer; "Understanding…" | One soft line; the card is tappable (opens a provisional view) |
| **Ready** | Card morphs in place into the memory card (chips fade in) | A small, satisfying reveal — the core product moment |
| **Failed** | "Couldn't finish understanding this." + **Retry** + "Your screenshot and note are safe." | Plain language; details behind "Why?" |
| **Retrying** | "Taking another pass…" (not an error state) | Only shown if the system is auto-retrying |

Never shown: model names, providers, embeddings, job IDs, pipeline steps, technical errors. (A hidden debug surface is a possible future admin feature — not V1.)

## 5. Memory card (primary list representation)

Not overloaded; three tiers:

- **Always visible:** thumbnail (the dominant element — large, rounded, consistent aspect); **title** (1 line, ellipsized); **intent chip** (icon + label — the product's soul); relative time ("2h ago").
- **Secondary (space permitting / desktop hover / slightly smaller):** topic chip; suggested-action chip when present; a **"N related"** indicator when connections exist; collection dots (up to 3).
- **Expandable (detail view):** everything else (summary, history, connections list, collections, corrections).

Treatment rules: processing states replace chips with the state line (§4); **completed** = subtle check + reduced contrast; **dismissed** = dimmed; **archived** = hidden behind an "Archived" filter; suggestion indicators (e.g., "1 suggestion") are small, outlined, never alarming. Screenshot stays visually important — when in doubt, fewer chips, not more.

## 6. Memory detail (full view)

Four stacked sections, in order:

1. **Original** — the full screenshot (tappable to zoom), **Your note** (verbatim, quoted, labeled *"You said"*), capture date.
2. **ScreenView's understanding** — title, summary, and the interpretation block: **Topic** (what it's about), **Intent** (why you saved it), **Action** (possible next step), **Status**. Everything here is labeled *"ScreenView thinks"* and is directly editable (§7–§8). A discreet **"Why?"** affordance explains the basis in plain language (§22).
3. **Context** — Related memories (connections with plain-language labels and states), Collections (chips), and (for projects) the project header.
4. **History** — a human-readable timeline from `memory_events`: *"Sep 3 — ScreenView: intent 'Buy' (from your note). Sep 12 — You changed intent to 'Research'. Oct 1 — Marked completed."* Corrections and changes only; nothing technical.

**The fundamental distinction is structural:** the Original section is *what you said*; the understanding section is *what ScreenView thinks*. Different labels, different type styles, different iconography (§21).

## 7. Corrections

Lightweight, one-tap-first:

- **Intent / Topic / Action / Status:** tap the chip (in detail) or long-press the card → a **bottom sheet picker** with plain-language options (e.g., Intent: "Buy", "Research", "Try", "Build", "Read", "Watch", "Save for later", "Compare", "Contact", "Inspiration", "Not sure yet"). Selecting = corrected instantly, with an optional "Add a reason" link (one line, optional).
- **Title / Summary:** small inline editors in detail (single field / small textarea) — not a full editor. Save = correction event.
- **Note edits (R1):** "Edit note" in the Original section; the previous versions are kept in history ("You edited your note on Sep 20"). The AI never touches the note.
- **Status:** same sheet pattern: Active / Completed / Dismissed / Archived.
- **Connection:** Confirm / Dismiss buttons on each related row.
- **Collection:** Accept / Rename / Dismiss on suggestions; add/remove membership in collection views.

Principles: corrections never require understanding the vocabulary's mechanics (display labels hide the internal values); every correction is instantly reflected + recorded (and feeds learning — Phase 6); an "Undo" isn't needed because any correction can simply be corrected again, and history shows everything. **Natural-language correction ("actually I just wanted to research it") is explicitly deferred** — V1 keeps the tap pickers.

## 8. Intent UX

Intent is the interface's most distinctive element — it answers "why did I save this?" and must never read as an arbitrary tag:

- Visual grammar in detail: **About** (topic) sits above; **Why you saved it** (intent) is the emphasized chip; **Next step** (action) sits below as a lighter suggestion. The relationship is explained once, visually, not with docs.
- Example rendered: `About: Fragrance` · **`Why: Research`** · `Next step: Evaluate`.
- The picker shows a one-line gloss per option ("Research — I want to look into this"; "Save for later — don't lose this, no action yet").
- `unknown` presents as **"Not sure yet"** with a gentle prompt: "What was this for?" — inviting a correction (§22 trust).
- On cards, intent is the only chip that is always shown. Topic/action stay secondary.

## 9. Collections

- **Collection view:** a list of cards — name, member count, a small collage of up to 3 thumbnails, and a **"Project"** badge where `kind='project'`. Suggested collections appear pinned at the top with a "Suggested" label and three actions: **Accept**, **Rename** (inline field), **Dismiss**.
- **Accept:** the collection becomes active; members (which are suggestions at the membership level too) become active together with it; the user lands on the collection view ("Nice — I'll keep this updated as you save more").
- **Rename:** inline editing of name and description.
- **Dismiss:** the suggestion disappears ("Okay — I'll stop suggesting this"); the pair-level rejection feeds learning.
- **Membership:** collection detail shows member memory cards (same cards as everywhere); per-member remove ("Remove from collection" — never deletes the memory); adding more via a search-select sheet.
- **Multiple membership:** shown as collection chips on the memory detail; on cards, up to 3 dots (no text).
- **Messaging:** empty and onboarding copy makes it clear collections are *suggestions and aids* — "Collections build themselves as you save related things" — never a filing system the user must maintain. Users may create their own collections (first-class), but the UI leads with AI-suggested ones.

## 10. Connections

- **Where they appear:** memory detail's **Related** section (primary); a small "N related" indicator on cards; PA pattern/project items; and through search.
- **How they read:** each related row shows the other memory's thumbnail + title and a plain-language relationship label: *Same subject* · *Complementary* · *Related theme* · *You linked this* — with **suggested** items showing Confirm / Dismiss buttons, and confirmed items reading as plain facts.
- **No graph visualization in V1** (explicitly): a force-directed map would be noise and complexity without pay-off. "Related" lists + counts carry the concept. (A lightweight visual map is a documented future possibility, not required by the architecture.)

## 11. Search & recall

Search is a core reason the product exists — it must work when the user doesn't remember exact words:

- **Entry:** search field at the top of Memories (desktop) / search icon in the top bar (mobile). Searching is a mode of the Memories screen.
- **Query types:** natural language ("what were those shoes I wanted to buy?") via semantic retrieval (Phase 3/4: query embedding + pgvector), combined with structured filters as chips: **Intent · Topic · Action · Status · Collection · Date range**. Filters and text compose ("AI tools I saved, intent: research").
- **Results:** the standard memory cards, ranked by relevance; a small "why it matched" line where useful ("matches: buying a perfume") is a nice-to-have, not required in V1. Filter chips reflect what was understood from the query where unambiguous.
- **Empty results:** "Nothing matched. Try fewer words — or browse this month." + a clear-filters link.
- **Search failure:** "Search is having trouble right now. Try again." — never a dead end; the browse list remains.
- **Recall vs search:** proactive recall lives in the PA (§12); search here is deliberate and user-initiated. Both run over the same memory corpus.

## 12. PA experience

The Assistant tab — quiet, in-app only, no chatbot:

- **Latest report** renders Phase 5's structure: **Needs Attention** (reminders) · **Emerging** (patterns + project candidates) · **Everything Else** (recall). Sections self-omit when empty; ≤5 items total.
- **Item anatomy:** a claim-type label (**You said** for facts — quoted; **ScreenView noticed** for inferences — hedged), one or two sentences, **evidence chips** (tappable members: "Based on: 3 memories"), and an action row. Inference items carry a quiet "AI observation" marker.
- **Quiet periods:** nothing appears, no badge, no notification; the Assistant tab simply shows "Nothing needs your attention right now — ScreenView is just remembering." (A calm statement, not an empty dashboard.)
- **Unseen indicator:** a small dot on the Assistant tab when a new report exists. No push, no email (Phase 5 decision).
- **History:** earlier reports collapse below the latest ("Earlier reports" → dates + item counts). Report items retain their grounding and resolve in place.

## 13. PA interactions

Simple vocabulary; every action ≤ 2 taps:

| Item type | Actions |
|---|---|
| **Reminder** | Open memory · Keep active · Snooze (sheet: 1 week / 1 month) · Mark completed · Dismiss |
| **Emerging pattern** | Explore memories (expand evidence) · Make a collection · Not useful |
| **Project candidate** | Inspect supporting memories · Make a project · Just a collection · Not now |
| **Proactive recall** | Open memory · Not useful |

After-action feedback: in-place resolution with a short confirmation ("Done — I'll stop reminding you about this." / "Snoozed for a month." / "Okay — noting that."). No follow-up dialogs. All of this feeds Phase 6 signals by construction.

## 14. Feedback

Feedback is captured where it is *meaningful* — never a button on everything:

- **PA items:** the item actions themselves are the feedback (complete/dismiss/snooze/useful/not useful).
- **Connections:** Confirm / Dismiss (the pair of buttons *is* the feedback).
- **Collections:** Accept / Rename / Dismiss.
- **Corrections:** the correction flow (field changes + optional reason).
- **"Not useful"** appears only on PA pattern/recall items and suggested collections — not on memories or ordinary UI.
- No ratings, no stars, no feedback nagging. The UI never says "rate this". The user's normal behavior is the feedback stream.

## 15. Processing UX

- The visible lifecycle is **Uploading → Understanding… → Ready** (or **Failed → Retry**), all rendered *in place* on the card; the user can leave the screen freely (status is server-side and restored on return; polling per Phase 4 — invisible to the user).
- The processing card is tappable to a provisional view: screenshot + note + "Understanding…" (interpretation sections fill in when ready).
- Timing expectations: usually seconds. If a capture takes unusually long, the copy stays calm ("Still working…") and the system's own health checks handle stuck cases; the user may see "Taking another pass…" (retrying) rather than an error.
- Nothing technical: no model names, provider names, embeddings, pipeline diagrams, or job IDs — ever (§4, §23).

## 16. Empty states

Every empty state teaches the product naturally (no fake example data):

| Surface | Empty state |
|---|---|
| **Memories (no captures)** | "Nothing saved yet. Screenshot something you don't want to forget — add a note if you want." + [Capture] button |
| **Memories (all archived/filtered)** | "Nothing here with these filters." + clear filters |
| **Collections** | "Collections build themselves as you save related things. Nothing yet — keep saving." |
| **Collection detail (no members)** | "I'll add related memories here as you save them." |
| **Search (no results)** | "Nothing matched. Try fewer words — or browse this month." |
| **Assistant (no report)** | "Nothing needs your attention right now — ScreenView is just remembering." |
| **Related section (none)** | "No related memories yet — more will emerge as you save." |
| **Learning (settings)** | "ScreenView hasn't learned anything specific yet. It picks things up from your corrections over time." |

## 17. Onboarding

**V1 onboarding is one screen, skippable, ≤15 seconds:**

1. One line: *"Dump screenshots. ScreenView remembers why."*
2. Three small points: *Screenshot it → Add a note if you feel like it → ScreenView remembers and organizes.*
3. **[Add your first screenshot]** (primary) — goes straight to capture; **Not now** (secondary).

Rules: no categories to configure, no intent setup, no preferences, no tour, no multi-step wizard; it never appears again after dismissal. Value is demonstrated by using, not by explaining.

## 18. Mobile UX

- **Bottom bar:** Memories · **Capture** (center, elevated) · Collections · Assistant… (three tabs + center action; settings via avatar in top bar).
- **Touch-optimized:** bottom sheets for pickers/corrections; large tap targets; swipe gestures (long-press card = quick actions; swipe PA item = dismiss/snooze — optional niceties, never the only path); photo library/camera picker for capture.
- **Layout:** single column; cards full-width with big thumbnails; detail = full-screen scroll; search = top icon → full-screen search view.
- **PWA-ready:** installable, share-target integration evaluated at build (Phase 8). Mobile is a first-class citizen, not a shrunken desktop.

## 19. Desktop UX

- **Sidebar:** Memories / Collections / Assistant; **Add screenshot** button at the top; Settings in the footer.
- **Two-pane memories:** list on the left, selected memory detail on the right (no page hops); search at the list's top.
- **Capture conveniences:** drag-drop anywhere, `Ctrl/Cmd+V` paste anywhere, file picker button.
- **Keyboard:** `C` new capture · `/` search · `↑/↓` move list selection · `Enter` open · `Esc` close/dismiss overlays. (Small, memorable set.)
- **Space used without becoming a dashboard:** larger screenshot previews in detail; secondary card info on hover; no metrics panels, no grids of stats.

## 20. Visual hierarchy

- **Primary action:** Capture — always one gesture away (center tab mobile; top button + drag/paste desktop). Everything else is secondary.
- **Screenshot prominence:** largest visual element on cards and in detail; consistent aspect; no heavy chrome around it.
- **Intent prominence:** the one interpretation chip always shown on cards; the emphasized chip in detail.
- **Topic:** secondary chip. **Status:** muted, low-contrast treatment (check for completed, dim for dismissed).
- **Suggestions vs facts:** outlined/questioned styling for anything proposed ("Want to…?" buttons, "Suggested" labels); solid styling for facts (quotes, confirmed states).
- **User-authored vs AI-generated (the core rule):**
  - *You said* → quoted, neutral/dark text, person icon, "Your note" label.
  - *ScreenView thinks / noticed* → sparkle icon, soft accent tint, explicit label.
  These never render identically wherever the distinction matters (detail, PA, correction surfaces).

## 21. Trust & transparency

Transparency appears **when the user needs it**, not as permanent noise:

- **"Why?" popovers** on interpretation chips: plain-language basis — *"From your note ('I want to buy this')"* · *"From the image + your past saves"* · *"You corrected this on Sep 12"*.
- **Confidence in words:** "Likely", "Maybe", "Not sure yet" — never numbers or model jargon. `unknown` intent is honest and invites correction.
- **Corrections:** instant, visible, recorded; history shows every change and who made it (You / ScreenView).
- **Suggestions:** always labeled ("Suggested", "AI observation") with evidence chips; never silently merged into facts.
- **PA items:** claim labels + evidence links + "from N memories" chips.
- The app never explains more than needed: one tap for "why", zero taps otherwise.

## 22. Loading & failure states

| Situation | UX |
|---|---|
| Upload failed | Card/tray: "Upload didn't finish." + **Retry** (file retained) |
| Processing failed (any step) | "ScreenView couldn't finish understanding this. **Your screenshot and note are safe.**" + **Retry**; "Why?" gives a plain-language hint ("a hiccup during understanding — retrying usually fixes it") |
| Partial processing (checkpointed) | Shows "Taking another pass…" — not failure until terminal; retries continue safely per Phase 4 |
| Embedding failed | Invisible to the user (search continues; the memory is still listed/found by text; backfill happens server-side) |
| Search failed | "Search is having trouble. Try again." + browse list remains usable |
| Network loss | Non-blocking banner: "You're offline — uploads will pause and resume." (Uploads retry; corrections queue or prompt retry) |
| Retry everywhere | One-tap retry on every failed surface; never a dead end |

**Rule:** the UX never implies the whole capture was lost when a step failed — the screenshot and note are safe, and the copy says so.

## 23. Data control

- **Delete a capture/memory:** detail menu → **Delete** → confirmation ("This removes the screenshot, its note, and everything connected to it. This can't be undone.") → deletion cascades (Phase 4 §24). One action in V1 (capture = memory 1:1).
- **Remove from collection ≠ delete:** membership removal only.
- **Dismiss a collection:** the suggestion/collection goes away; memories untouched.
- **Archive:** status change; hidden from default views; restorable.
- **Learned influence:** Settings → **"What ScreenView has learned"** — a minimal list (pattern summary + "why" line + count) with **Reset** per pattern and a global **Pause learning** toggle (Phase 6 user-control paths). Read-only otherwise in V1.
- **Account deletion / export:** not in V1 (justified: single-user personal app; export is a documented future item). Deleting the account (when built) removes everything incl. storage.

## 24. Privacy UX

- One line, where it counts: onboarding and Settings each state — *"Your screenshots are stored privately in your account and processed only by ScreenView's own pipeline."*
- Account boundary is implicit in the single-user model; no per-screen privacy banners, no repeated warnings.
- Deletion confirmations are explicit about what is removed (§23).
- "Why?" popovers may naturally mention "read from the image" — transparency in context, not as a warning.
- No privacy theater anywhere.

## 25. First-session experience

```
Open ScreenView
  → Welcome (3 lines, skippable) → [Add your first screenshot]
  → pick/drag a screenshot → optional note → Save
  → card appears: "Uploading…" → "Understanding…" (seconds)
  → card transforms: title, intent chip, thumbnail  — the core moment
  → a gentle first-time callout: "This is what ScreenView understood — change anything that's off."
  → user tries one correction (or not) → seen instantly in history
  → "Save another" or simply done
```

Total: under two minutes, zero configuration, and the product's entire promise (dump → remembered *why*) has been demonstrated. Nothing about categories, collections, or AI settings is asked.

## 26. Screen inventory (V1)

Eight screens + overlays (kept deliberately low):

| # | Screen | Purpose | Primary action | Mobile | Desktop |
|---|---|---|---|---|---|
| 1 | **Welcome** (first run only) | 15-second intro | Add first screenshot | Full screen | Modal/card |
| 2 | **Memories** | Browse/recall; processing items; filters; entry to search | Open memory / capture | Full list | List (left pane) |
| 3 | **Search** (mode of Memories) | Find by NL + filters | Open result | Full-screen search | Search bar + list |
| 4 | **Memory Detail** | Inspect original + interpretation + context + history; correct | Correct / act | Full screen | Right pane |
| 5 | **Collections** | Browse groups; handle suggestions | Accept/dismiss/open | List | List/grid |
| 6 | **Collection Detail** | Members, rename, add/remove | Manage members | Full screen | Right pane |
| 7 | **Assistant** | PA reports + history | Act on items | Full screen | Full width |
| 8 | **Settings** | Account, privacy line, learning controls, about | Adjust | Full screen | Full screen |

**Overlays/sheets:** Capture tray/sheet · Intent/Topic/Action/Status pickers · Snooze picker · Confirm dialogs (delete, etc.) · "Why?" popover · Toast confirmations.

**States per screen** (applies throughout; not repeated per row): empty states per §16; loading = skeletons/shimmer for lists, spinner-free calm copy for processing; errors per §22 with one-tap retry. **Key data per screen** = the surfaces defined in §§5–15; screens never add data beyond their purpose.

## 27. Core user journeys

- **A — First capture:** Welcome → Capture → pick file → Save → card states → memory appears → first-time callout → done. (No config.)
- **B — Capture with a note:** Capture → file → type "I want to buy this" → Save → memory ready with intent **Buy** sourced from the note (quote shown as "You said"). 
- **C — Correct an interpretation:** Open memory → tap intent chip → pick "Research" → instant update + event ("You changed intent…") → optional reason. Faster than filing it manually. 
- **D — Find an old memory:** Search "what were those shoes I wanted to buy?" → semantic results (cards) → filter chips if needed → open → note + history visible. 
- **E — Discover a connection:** Open a memory → Related section shows a suggested connection ("Same subject", evidence) → Confirm (or Dismiss) → appears as plain fact (or disappears; both feed learning). 
- **F — Accept/dismiss a collection:** Collections → pinned suggestion ("Suggested: 4 memories about AI tools") → Accept (lands in collection; membership active) or Dismiss ("Okay — I'll stop suggesting this"). 
- **G — Interact with a PA report:** Assistant (unseen dot) → Needs Attention item ("You said 'I want to buy this' — that was 3 weeks ago. Still interested?") → Open / Keep active / Snooze / Complete / Dismiss → item resolves in place with a short confirmation. 
- **H — Delete a memory:** Detail → ⋯ menu → Delete → confirmation → gone (cascaded); honest copy about scope. 
- **I — Mobile use:** Capture button → camera → snap → note → Save → background processing while browsing; long-press quick actions; swipe a PA item to snooze. 
- **J — Desktop use:** Drag three screenshots onto the window → note (shared) → Save → two-pane work: list updates live; `Ctrl/Cmd+V` pastes a fourth capture; `/` searches; detail sits beside the list with zero page changes.

## 28. UX boundaries (what V1 will NOT contain)

No full chat interface (grounded Q&A is a later phase) · no knowledge-graph visualization · no folder hierarchy · no task/project management (projects are labeled collections only) · no calendar · no email integration · no social/collaborative features · no analytics dashboards · no gamification/streaks · no excessive settings (Settings has ~4 sections) · no AI personality configuration · no natural-language correction input (deferred) · no export/account-deletion flows in V1 (documented future) · no notification infrastructure (in-app only, by design).

Only what the architecture genuinely requires ships.

## 29. Final UX architecture (the loop, exposed without manual management)

```
Capture (1 gesture anywhere)
   → Processing (in place on the card: Uploading → Understanding → Ready; calm, retryable)
      → Memory (card: screenshot + title + why-chip; detail: You said vs ScreenView thinks)
         → Correction (1 tap; instant; recorded; feeds learning)
         → Connections (Related list; suggested → confirm/dismiss)
         → Collections (suggested → accept/rename/dismiss; projects badged)
         → Search / Recall (NL + filters; works without exact words)
            → Assistant (Mon & Thu report; quiet periods silent; 4 item types; 1-tap actions)
               → User feedback (the actions above ARE the feedback)
                  → Learning (Phase 6; visible only as "What ScreenView has learned" + better future guesses)
                     → Better future interpretation ↺
```

The user only ever acts on **surfaces** (cards, chips, lists, items); every mechanism behind them — organization, connections, collections, summaries, reminders, learning — runs on its own. The interface's job is to make that loop *inspectable* (You said vs ScreenView thinks, Why? popovers, history) and *correctable* (one-tap fixes) — never to make the user manage it.

## 30. Implementation readiness

**Ready for Phase 8?** — checklist:

1. **Primary navigation defined** — ✅ (3 areas + capture action; avatar for settings).
2. **Capture UX defined** — ✅ (tray/sheet; drag-drop/paste/picker/picker-camera; shared note; single Save; cancellation + retry).
3. **Core screens defined** — ✅ (8 screens + overlays, §26).
4. **Memory cards/detail defined** — ✅ (§5–§6, incl. three-tier card and four-section detail).
5. **Corrections defined** — ✅ (§7–§8; one-tap pickers; R1 for note edits).
6. **Search/recall defined** — ✅ (§11; NL + filters; states covered).
7. **Collections/connections defined** — ✅ (§9–§10; no graph in V1).
8. **PA experience defined** — ✅ (§12–§14; quiet, in-app, 4 item types).
9. **Mobile behavior defined** — ✅ (§18).
10. **Desktop behavior defined** — ✅ (§19).
11. **Empty/loading/error states defined** — ✅ (§16, §22).
12. **V1 UX boundaries defined** — ✅ (§28).
13. **Unresolved architecture decisions before implementation** — none blocking. Small items carried forward: R1 (note_change event type) to apply in the initial migration; share-sheet integration depth, "why it matched" search lines, and swipe-gesture niceties are build-time choices, not architecture gaps.

**Verdict: ready for Phase 8** — with nothing implemented by this phase.

---

_Phase 7 complete — UX architecture defined, nothing implemented. Next: Phase 8 — Build Plan & V1 Implementation (awaiting go-ahead)._
