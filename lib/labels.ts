/** Display labels for internal vocabularies (keep in sync with DB CHECK constraints). */

export const INTENT_LABELS: Record<string, string> = {
  buy: "Buy",
  research: "Research",
  try: "Try",
  build: "Build",
  read: "Read",
  watch: "Watch",
  save_for_later: "Save for later",
  compare: "Compare",
  contact: "Contact",
  inspiration: "Inspiration",
  unknown: "Not sure yet",
};

export const ACTION_LABELS: Record<string, string> = {
  buy: "Buy",
  evaluate: "Evaluate",
  test: "Test",
  build: "Build",
  read: "Read",
  watch: "Watch",
  compare: "Compare",
  contact: "Contact",
  save_for_reference: "For reference",
  none: "—",
};

export const STATUS_LABELS: Record<string, string> = {
  new: "New",
  active: "Active",
  completed: "Completed",
  dismissed: "Dismissed",
  archived: "Archived",
};

export const RELATIONSHIP_LABELS: Record<string, string> = {
  same_subject: "Same subject",
  complementary: "Complementary",
  thematic: "Thematic",
  user_linked: "You linked these",
};

export const INTENT_OPTIONS = Object.keys(INTENT_LABELS);
export const ACTION_OPTIONS = Object.keys(ACTION_LABELS);
export const STATUS_OPTIONS = Object.keys(STATUS_LABELS);

/** Plain-language context for pickers. */
export const INTENT_HINTS: Record<string, string> = {
  buy: "I want to buy this",
  research: "I want to look into this",
  try: "I want to try/use this",
  build: "I want to build something like this",
  read: "I want to read this",
  watch: "I want to watch this",
  save_for_later: "Don't lose this — no action yet",
  compare: "I'm comparing options",
  contact: "I want to reach out",
  inspiration: "This is inspiration",
  unknown: "Not sure yet",
};

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(1, Math.floor((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}
