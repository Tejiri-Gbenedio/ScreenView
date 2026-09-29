import { z } from "zod";
import { ACTIONS, INTENTS, STATUSES } from "@/server/ai/contracts";

/** Shared request/file validation for API routes. */

export const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB — matches the vision provider's request cap

export const EXT_BY_MIME: Record<AllowedMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function isAllowedMime(mime: string): mime is AllowedMime {
  return (ALLOWED_MIME as readonly string[]).includes(mime);
}

export const InitCaptureSchema = z.object({
  file_name: z.string().min(1).max(300),
  mime_type: z.enum(ALLOWED_MIME),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
  note: z.string().max(2000).optional().nullable(),
});
export type InitCaptureInput = z.infer<typeof InitCaptureSchema>;

export const CompleteCaptureSchema = z.object({
  file_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "file_hash must be a sha-256 hex digest"),
});

export const CorrectionSchema = z.object({
  field: z.enum(["intent", "topic", "action", "status"]),
  value: z.string().min(1).max(200),
  reason: z.string().max(500).optional(),
});
export type CorrectionInput = z.infer<typeof CorrectionSchema>;

export const DAILY_CAPTURE_CAP = 200;

// ------------------------------------------------------------------ search

export const MAX_SEARCH_QUERY_LEN = 300;

/**
 * M2 search request: a natural-language query and/or deterministic filters.
 * Empty query with no filters is rejected (the UI shows normal browsing instead).
 */
export const SearchRequestSchema = z
  .object({
    query: z.string().max(MAX_SEARCH_QUERY_LEN).optional().default(""),
    intent: z.enum(INTENTS).optional(),
    topic: z.string().min(1).max(80).optional(),
    action: z.enum(ACTIONS).optional(),
    status: z.enum(STATUSES).optional(),
  })
  .refine((v) => v.query.trim().length > 0 || Boolean(v.intent || v.topic || v.action || v.status), {
    message: "Provide a query or at least one filter",
  });
export type SearchRequestInput = z.infer<typeof SearchRequestSchema>;
