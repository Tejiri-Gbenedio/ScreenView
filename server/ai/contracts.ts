import { z } from "zod";

/** AI contracts — Phases 3/6. Perception = "the eyes"; Interpretation = "the brain". */

export const INTENTS = [
  "buy",
  "research",
  "try",
  "build",
  "read",
  "watch",
  "save_for_later",
  "compare",
  "contact",
  "inspiration",
  "unknown",
] as const;

export const ACTIONS = [
  "buy",
  "evaluate",
  "test",
  "build",
  "read",
  "watch",
  "compare",
  "contact",
  "save_for_reference",
  "none",
] as const;

export const INTENT_SOURCES = [
  "user_statement",
  "strong_context",
  "user_behavior",
  "visual_inference",
  "ai_inference",
  "unknown",
] as const;

const lenient = z.unknown().optional();

export const PerceptionSchema = z.object({
  content_type: z.preprocess((v) => (typeof v === "string" && v ? v : "other"), z.string()),
  visual_description: z.preprocess((v) => (typeof v === "string" ? v : ""), z.string()),
  visible_text: lenient,
  detected_entities: lenient,
  prices: lenient,
  urls: lenient,
  dates: lenient,
  important_visual_details: lenient,
});

export type Perception = {
  content_type: string;
  visual_description: string;
  visible_text: string;
  detected_entities: unknown[];
  prices: unknown[];
  urls: string[];
  dates: string[];
  important_visual_details: string[];
  meta?: { model: string; provider: string };
};

/** Coerce raw model output into the stored perception shape. */
export function normalizePerception(raw: unknown, meta: { model: string; provider: string }): Perception {
  const p = PerceptionSchema.parse(raw ?? {});
  const textParts: string[] = [];
  const vt = p.visible_text;
  if (typeof vt === "string") {
    textParts.push(vt);
  } else if (vt && typeof vt === "object") {
    for (const val of Object.values(vt as Record<string, unknown>)) {
      if (Array.isArray(val)) {
        textParts.push(val.filter((x) => typeof x === "string").join(" | "));
      } else if (typeof val === "string") {
        textParts.push(val);
      }
    }
  }
  return {
    content_type: p.content_type,
    visual_description: p.visual_description,
    visible_text: textParts.join(" ").slice(0, 4000).trim(),
    detected_entities: Array.isArray(p.detected_entities) ? p.detected_entities : [],
    prices: Array.isArray(p.prices) ? p.prices : [],
    urls: Array.isArray(p.urls) ? (p.urls as unknown[]).filter((x) => typeof x === "string") : [],
    dates: Array.isArray(p.dates) ? (p.dates as unknown[]).filter((x) => typeof x === "string") : [],
    important_visual_details: Array.isArray(p.important_visual_details)
      ? (p.important_visual_details as unknown[]).filter((x) => typeof x === "string")
      : [],
    meta,
  };
}

export const InterpretationSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(1200),
  topic: z.string().min(1).max(80),
  intent: z.enum(INTENTS),
  intent_source: z.enum(INTENT_SOURCES),
  intent_confidence: z.number().min(0).max(1),
  intent_reasoning: z.string().max(600).optional().default(""),
  suggested_action: z.enum(ACTIONS),
  candidate_connections: z
    .array(
      z.object({
        memory_id: z.string(),
        relationship_type: z.enum(["same_subject", "complementary", "thematic"]),
        confidence: z.number().min(0).max(1),
        basis: z.string().max(300).optional().default(""),
      })
    )
    .optional()
    .default([]),
  collection_membership_candidates: z.array(z.unknown()).optional().default([]),
});

export type Interpretation = z.infer<typeof InterpretationSchema>;

/** Canonical text for the embedding "signature" (Phase 3 §11). */
export type MemoryCard = {
  memory_id: string;
  title: string | null;
  topic: string | null;
  current_intent: string | null;
  suggested_action: string | null;
  status: string | null;
  created_at: string;
  similarity?: number;
};

export function buildCanonicalText(m: {
  title: string;
  summary: string;
  topic: string | null;
  current_intent: string | null;
  suggested_action: string | null;
  visual_description: string | null;
  note: string | null;
}): string {
  return [
    `Title: ${m.title}`,
    `Summary: ${m.summary}`,
    m.topic ? `Topic: ${m.topic}` : null,
    m.current_intent ? `Intent: ${m.current_intent}` : null,
    m.suggested_action ? `Action: ${m.suggested_action}` : null,
    m.visual_description ? `Visual: ${m.visual_description}` : null,
    m.note ? `User note: ${m.note}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Query text used before the memory exists (capture-time retrieval). */
export function buildQueryText(parts: {
  note: string | null;
  visual_description: string;
  content_type: string;
}): string {
  return [parts.note, parts.visual_description, parts.content_type]
    .filter((x) => x && String(x).trim().length > 0)
    .join(" | ")
    .slice(0, 3000);
}
