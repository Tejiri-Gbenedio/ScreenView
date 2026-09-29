/**
 * Server-side environment access.
 * Values are read lazily so that builds and previews don't require secrets.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export const env = {
  supabaseUrl: () => requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => requireEnv("SUPABASE_SERVICE_ROLE_KEY"),

  groqApiKey: () => requireEnv("GROQ_API_KEY"),
  nvidiaApiKey: () => requireEnv("NVIDIA_API_KEY"),
  openrouterApiKey: () => process.env.OPENROUTER_API_KEY ?? null,

  inngestEventKey: () => process.env.INNGEST_EVENT_KEY ?? null,
  inngestSigningKey: () => process.env.INNGEST_SIGNING_KEY ?? null,

  appUrl: () => process.env.APP_URL ?? "http://localhost:3000",

  // Model IDs are configuration, never hard-coded (Phase 3).
  visionModelId: () => process.env.VISION_MODEL_ID ?? "qwen/qwen3.8-27b",
  reasoningModelId: () => process.env.REASONING_MODEL_ID ?? "openai/gpt-oss-120b",
  // Verified 2026-09-29: available via OpenRouter as `…-v2:free` (2048-d, $0;
  // free tier logs inputs — swap host or variant for stricter privacy).
  embeddingModelId: () =>
    process.env.EMBEDDING_MODEL_ID ?? "nvidia/llama-nemotron-embed-vl-1b-v2:free",

  processingPaused: () => process.env.PROCESSING_PAUSED === "1",
};
