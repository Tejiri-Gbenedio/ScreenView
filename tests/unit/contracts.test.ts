import { describe, expect, it } from "vitest";
import {
  buildCanonicalText,
  buildQueryText,
  InterpretationSchema,
  normalizePerception,
} from "@/server/ai/contracts";
import { INTENT_LABELS } from "@/lib/labels";

describe("perception normalization", () => {
  it("fills defaults for empty input", () => {
    const perception = normalizePerception(null, { model: "m", provider: "p" });
    expect(perception.content_type).toBe("other");
    expect(perception.visual_description).toBe("");
    expect(perception.visible_text).toBe("");
    expect(perception.detected_entities).toEqual([]);
  });

  it("flattens object-style visible_text", () => {
    const perception = normalizePerception(
      {
        content_type: "product_page",
        visible_text: { headings: ["H1"], body_snippets: ["a", "b"] },
      },
      { model: "m", provider: "p" }
    );
    expect(perception.content_type).toBe("product_page");
    expect(perception.visible_text).toContain("H1");
    expect(perception.visible_text).toContain("a | b");
  });
});

describe("interpretation validation", () => {
  const valid = {
    title: "Perfume",
    summary: "A fragrance product page.",
    topic: "Fragrance",
    intent: "buy" as const,
    intent_source: "user_statement" as const,
    intent_confidence: 0.95,
    suggested_action: "buy" as const,
    intent_reasoning: "note says buy",
    candidate_connections: [],
  };

  it("accepts a valid interpretation", () => {
    const parsed = InterpretationSchema.parse(valid);
    expect(parsed.intent).toBe("buy");
  });

  it("rejects an invalid intent", () => {
    expect(() => InterpretationSchema.parse({ ...valid, intent: "nonsense" })).toThrow();
  });

  it("allows unknown intent", () => {
    const parsed = InterpretationSchema.parse({
      ...valid,
      intent: "unknown",
      intent_source: "unknown",
    });
    expect(parsed.intent).toBe("unknown");
  });
});

describe("canonical text", () => {
  it("includes the note and skips nulls", () => {
    const text = buildCanonicalText({
      title: "T",
      summary: "S",
      topic: null,
      current_intent: "buy",
      suggested_action: "none",
      visual_description: null,
      note: "I want this",
    });
    expect(text).toContain("Intent: buy");
    expect(text).toContain("User note: I want this");
    expect(text).not.toContain("Topic:");
  });
});

describe("query text", () => {
  it("joins non-empty parts", () => {
    expect(
      buildQueryText({ note: null, visual_description: "a page", content_type: "product_page" })
    ).toBe("a page | product_page");
  });
});

describe("labels completeness", () => {
  it("has a label for every intent value", () => {
    for (const intent of [
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
    ]) {
      expect(INTENT_LABELS[intent]).toBeTruthy();
    }
  });
});
