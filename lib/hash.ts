import crypto from "crypto";

/** Server-only hashing helpers. */

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
