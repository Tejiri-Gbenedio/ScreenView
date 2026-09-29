/**
 * AI providers — all calls are server-side (Phase 3/4).
 *
 * Vision (Groq qwen3.8-27b, fallback OpenRouter qwen3-vl-8b) ·
 * Reasoning (Groq gpt-oss-120b strict JSON, fallback gpt-oss-20b) ·
 * Embeddings (OpenRouter-hosted NVIDIA llama-nemotron-embed-vl-1b-v2).
 *
 * NOTE: the `:free` embedding endpoint is a DEVELOPMENT/TESTING provider —
 * its free tier logs inputs. Not for real private data long-term; the host is
 * config-swappable (same model → same vector space, no schema change).
 */

import { env } from "@/lib/env";
import {
  ACTIONS,
  INTENTS,
  INTENT_SOURCES,
  InterpretationSchema,
  normalizePerception,
  type Interpretation,
  type MemoryCard,
  type Perception,
} from "./contracts";

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const FALLBACK_VISION_MODEL = "qwen/qwen3-vl-8b-instruct";
const FALLBACK_REASONING_MODEL = "openai/gpt-oss-20b";

export const EMBEDDING_PROVIDER_NOTE = "development/testing only (free endpoint logs inputs)";

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 60000
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    /* fall through */
  }
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(input.slice(start, end + 1));
  }
  throw new Error("model did not return valid JSON");
}

// ---------------------------------------------------------------- vision

const VISION_SYSTEM = `You are the visual perception module of ScreenView, a personal memory system. Describe ONLY what is visible in the image. Never decide the user's intent, importance, collections, or what anything "means to the user". If you cannot tell something, use empty values.

Respond with a single JSON object (no markdown, no commentary) with EXACTLY these keys:
{
  "content_type": "product_page" | "article" | "social_post" | "website_ui" | "app_ui" | "chat_conversation" | "advertisement" | "photo" | "document" | "other",
  "visual_description": "1-3 objective sentences describing what is visible",
  "visible_text": "condensed key readable text (empty string if none)",
  "detected_entities": ["products, brands, people, apps, websites as short strings"],
  "prices": [{"amount": "", "currency": "", "context": ""}],
  "urls": ["..."],
  "dates": ["..."],
  "important_visual_details": ["layout, charts, key UI elements"]
}`;

async function callVision(
  model: string,
  url: string,
  headers: Record<string, string>,
  imageBase64: string,
  mimeType: string
): Promise<unknown> {
  const messages: any[] = [
    { role: "system", content: VISION_SYSTEM },
    {
      role: "user",
      content: [
        { type: "text", text: "Analyze this screenshot. Return only the JSON object." },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
      ],
    },
  ];
  const body = {
    model,
    messages,
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 1200,
  };
  try {
    const res = await postJson(url, headers, body, 60000);
    const content = res?.choices?.[0]?.message?.content ?? "";
    return parseJsonLoose(typeof content === "string" ? content : JSON.stringify(content));
  } catch {
    // one repair retry
    const retry = await postJson(
      url,
      headers,
      {
        ...body,
        messages: [
          ...messages,
          { role: "user", content: "Your previous reply was not valid JSON. Reply again with ONLY the JSON object." },
        ],
      },
      60000
    );
    const content = retry?.choices?.[0]?.message?.content ?? "";
    return parseJsonLoose(typeof content === "string" ? content : JSON.stringify(content));
  }
}

export async function analyzeImage(input: {
  imageBase64: string;
  mimeType: string;
}): Promise<Perception> {
  try {
    const raw = await callVision(
      env.visionModelId(),
      GROQ_CHAT_URL,
      { Authorization: "Bearer " + env.groqApiKey() },
      input.imageBase64,
      input.mimeType
    );
    return normalizePerception(raw, { model: env.visionModelId(), provider: "groq" });
  } catch (primaryError) {
    const orKey = env.openrouterApiKey();
    if (!orKey) throw primaryError;
    const raw = await callVision(
      FALLBACK_VISION_MODEL,
      OPENROUTER_CHAT_URL,
      { Authorization: "Bearer " + orKey, "HTTP-Referer": env.appUrl(), "X-Title": "ScreenView" },
      input.imageBase64,
      input.mimeType
    );
    return normalizePerception(raw, { model: FALLBACK_VISION_MODEL, provider: "openrouter" });
  }
}

// ---------------------------------------------------------------- reasoning

const INTERPRETATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "summary",
    "topic",
    "intent",
    "intent_source",
    "intent_confidence",
    "suggested_action",
    "intent_reasoning",
    "candidate_connections",
  ],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    topic: { type: "string" },
    intent: { type: "string", enum: [...INTENTS] },
    intent_source: { type: "string", enum: [...INTENT_SOURCES] },
    intent_confidence: { type: "number" },
    suggested_action: { type: "string", enum: [...ACTIONS] },
    intent_reasoning: { type: "string" },
    candidate_connections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["memory_id", "relationship_type", "confidence", "basis"],
        properties: {
          memory_id: { type: "string" },
          relationship_type: { type: "string", enum: ["same_subject", "complementary", "thematic"] },
          confidence: { type: "number" },
          basis: { type: "string" },
        },
      },
    },
  },
} as const;

const REASONING_SYSTEM = `You are the memory interpreter of ScreenView, a personal memory system for one user.

RULES:
- The user's note is verbatim and authoritative. If it states a reason, the intent MUST reflect it with intent_source="user_statement". Never paraphrase or override it.
- Intent = why the user saved it: buy, research, try, build, read, watch, save_for_later, compare, contact, inspiration, unknown.
- Action = the practical next step: buy, evaluate, test, build, read, watch, compare, contact, save_for_reference, none. Intent and action may differ (e.g. intent=research with action=buy for "worth buying?" notes).
- Intent hierarchy: user_statement > strong_context > user_behavior > visual_inference > ai_inference. Never invent intent — use "unknown" when evidence is insufficient.
- intent_confidence: 0.9+ for explicit user statements; lower for inference; use intent_source honestly.
- candidate_connections: ONLY use memory_id values from the provided RETRIEVED_MEMORIES. Propose only genuinely meaningful relationships (same_subject / complementary / thematic / none) with a short basis. An empty array is fine — similarity alone is not a relationship.
- Return only the JSON object per the schema.`;

export async function interpretMemory(input: {
  note: string | null;
  perception: Perception;
  cards: MemoryCard[];
}): Promise< Interpretation> {
  const userPayload = [
    "ORIGINAL_USER_NOTE (verbatim; may be null):",
    input.note === null ? "null" : JSON.stringify(input.note),
    "",
    "VISUAL_ANALYSIS (JSON):",
    JSON.stringify({
      content_type: input.perception.content_type,
      visual_description: input.perception.visual_description,
      visible_text: input.perception.visible_text,
      detected_entities: input.perception.detected_entities,
      prices: input.perception.prices,
      urls: input.perception.urls,
      dates: input.perception.dates,
      important_visual_details: input.perception.important_visual_details,
    }),
    "",
    "RETRIEVED_MEMORIES (may be empty):",
    JSON.stringify(
      input.cards.map((c) => ({
        memory_id: c.memory_id,
        title: c.title,
        topic: c.topic,
        intent: c.current_intent,
        status: c.status,
        created_at: c.created_at,
      }))
    ),
    "",
    "LEARNING_SIGNALS: none (Phase 6 not yet implemented)",
    "EXISTING_COLLECTIONS: none (Phase 5/7 not yet implemented)",
  ].join("\n");

  const baseBody = {
    model: env.reasoningModelId(),
    messages: [
      { role: "system", content: REASONING_SYSTEM },
      { role: "user", content: userPayload },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "memory_interpretation", strict: true, schema: INTERPRETATION_JSON_SCHEMA },
    },
    temperature: 0.3,
    max_tokens: 1500,
  };

  try {
    const res = await postJson(GROQ_CHAT_URL, { Authorization: "Bearer " + env.groqApiKey() }, baseBody, 90000);
    return validateInterpretation(res);
  } catch {
    const res2 = await postJson(
      GROQ_CHAT_URL,
      { Authorization: "Bearer " + env.groqApiKey() },
      { ...baseBody, model: FALLBACK_REASONING_MODEL },
      90000
    );
    return validateInterpretation(res2);
  }
}

function validateInterpretation(res: any): Interpretation {
  const content = res?.choices?.[0]?.message?.content ?? "";
  const raw = typeof content === "string" ? parseJsonLoose(content) : content;
  return InterpretationSchema.parse(raw);
}

// ---------------------------------------------------------------- embeddings

export async function embedText(text: string): Promise<number[]> {
  const key = env.openrouterApiKey();
  if (!key) throw new Error("OPENROUTER_API_KEY missing (embeddings)");
  const headers = {
    Authorization: "Bearer " + key,
    "HTTP-Referer": env.appUrl(),
    "X-Title": "ScreenView",
  };
  const body = { model: env.embeddingModelId(), input: text };

  const attempt = async (): Promise<number[]> => {
    const res = await postJson(OPENROUTER_EMBEDDINGS_URL, headers, body, 45000);
    const emb = res?.data?.[0]?.embedding;
    if (!Array.isArray(emb) || emb.length !== 2048) {
      throw new Error("unexpected embedding shape");
    }
    return emb as number[];
  };

  try {
    return await attempt();
  } catch {
    return await attempt(); // single retry
  }
}

export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// ---------------------------------------------------------------- collections

const COLLECTION_SYSTEM = `You name and describe a group of related memories for ScreenView, a personal memory system for one user.

RULES:
- Synthesize ONLY from the provided evidence (member titles/topics/intents/actions and the detected signals). Never invent facts, plans, or intentions the evidence does not support.
- Hedged observation tone: "These saves look like..." / "A group around...". Never say "you want", "you plan to", "you're interested in".
- name: 2-6 words, concrete, no quotes, no trailing period. If it is a project candidate, name it like "Something to build: X".
- description: ONE short sentence describing what the group is (max 160 chars).
- Return only a JSON object with keys { "name": string, "description": string }.`;

export async function synthesizeCollection(input: {
  members: Array<{ title: string | null; topic: string | null; intent: string | null; action: string | null }>;
  signals: string[];
  isProject: boolean;
}): Promise<{ name: string; description: string }> {
  const payload = [
    "DETECTED_SIGNALS (deterministic, from code):",
    JSON.stringify(input.signals),
    `PROJECT_CANDIDATE: ${input.isProject ? "yes" : "no"}`,
    "MEMBER_MEMORIES:",
    JSON.stringify(input.members.slice(0, 12)),
  ].join("\n");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "description"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
    },
  } as const;

  const body = {
    model: env.reasoningModelId(),
    messages: [
      { role: "system", content: COLLECTION_SYSTEM },
      { role: "user", content: payload },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "collection_synthesis", strict: true, schema },
    },
    temperature: 0.4,
    max_tokens: 300,
  };

  let res: any;
  try {
    res = await postJson(GROQ_CHAT_URL, { Authorization: "Bearer " + env.groqApiKey() }, body, 45000);
  } catch {
    res = await postJson(
      GROQ_CHAT_URL,
      { Authorization: "Bearer " + env.groqApiKey() },
      { ...body, model: FALLBACK_REASONING_MODEL },
      45000
    );
  }
  const content = res?.choices?.[0]?.message?.content ?? "";
  const raw = typeof content === "string" ? parseJsonLoose(content) : content;
  const parsed = raw as { name?: unknown; description?: unknown };
  const name = typeof parsed?.name === "string" ? parsed.name.trim().slice(0, 60) : "";
  const description =
    typeof parsed?.description === "string" ? parsed.description.trim().slice(0, 200) : "";
  if (!name) throw new Error("collection synthesis returned no name");
  return { name, description };
}
