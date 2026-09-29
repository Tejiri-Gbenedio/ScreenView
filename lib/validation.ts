import { z } from "zod";

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
