import { describe, expect, it } from "vitest";
import {
  CompleteCaptureSchema,
  CorrectionSchema,
  InitCaptureSchema,
  isAllowedMime,
  MAX_FILE_BYTES,
} from "@/lib/validation";

describe("init capture validation", () => {
  it("accepts a valid png", () => {
    const parsed = InitCaptureSchema.safeParse({
      file_name: "a.png",
      mime_type: "image/png",
      size: 1024,
      note: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a gif", () => {
    const parsed = InitCaptureSchema.safeParse({
      file_name: "a.gif",
      mime_type: "image/gif",
      size: 10,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects oversize files", () => {
    const parsed = InitCaptureSchema.safeParse({
      file_name: "a.png",
      mime_type: "image/png",
      size: MAX_FILE_BYTES + 1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("complete capture validation", () => {
  it("requires a sha-256 hex digest", () => {
    expect(CompleteCaptureSchema.safeParse({ file_hash: "abc" }).success).toBe(false);
    expect(CompleteCaptureSchema.safeParse({ file_hash: "a".repeat(64) }).success).toBe(true);
  });
});

describe("corrections", () => {
  it("accepts a known field", () => {
    expect(CorrectionSchema.safeParse({ field: "intent", value: "research" }).success).toBe(true);
  });

  it("rejects an unknown field", () => {
    expect(CorrectionSchema.safeParse({ field: "title", value: "x" }).success).toBe(false);
  });
});

describe("mime allowlist", () => {
  it("checks mimes", () => {
    expect(isAllowedMime("image/webp")).toBe(true);
    expect(isAllowedMime("image/svg+xml")).toBe(false);
  });
});
