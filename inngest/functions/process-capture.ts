import { env } from "@/lib/env";
import { sha256Hex } from "@/lib/hash";
import { inngest } from "../client";
import { analyzeImage, embedText, interpretMemory, toVectorLiteral } from "@/server/ai/providers";
import { buildCanonicalText, buildQueryText, type Perception } from "@/server/ai/contracts";
import { retrieveContext } from "@/server/services/retrieval";
import { persistConnectionCandidates } from "@/server/services/connections";
import { buildLearningContext } from "@/server/services/learning";
import * as persist from "@/server/services/persist";
import * as storage from "@/server/services/storage";

/**
 * capture/process — the durable M1 pipeline (Phase 3 §14 / Phase 4 §8):
 * claim → vision → query embedding → retrieval → reasoning → persist → document embedding.
 * DB-checkpointed: completed stages are not repeated on retry/resume.
 */
export const processCapture = inngest.createFunction(
  {
    id: "capture-process",
    name: "Process capture",
    retries: 2,
    concurrency: { limit: 4 },
    onFailure: async ({ event }: { event: any }) => {
      try {
        const captureId = event?.data?.event?.data?.captureId;
        const message = event?.data?.error?.message ?? "processing failed";
        if (captureId) {
          await persist.markCaptureFailed(String(captureId), String(message));
        }
      } catch (error) {
        console.error("onFailure handler failed:", (error as Error).message);
      }
    },
  },
  { event: "capture/complete" },
  async ({ event, step }) => {
    const captureId: string = event.data.captureId;

    if (env.processingPaused()) {
      return { skipped: "processing-paused" };
    }

    const claimed = await step.run("claim", async () => persist.claimCapture(captureId));
    if (!claimed) {
      return { skipped: "not-claimable" };
    }

    const capture = claimed as Record<string, any>;
    const userId = String(capture.user_id);
    const storagePath = String(capture.storage_path);
    const note = (capture.original_note as string | null) ?? null;
    const fileHash = (capture.file_hash as string | null) ?? null;

    // [1] Vision — reuse stored perception if it exists (resume safety)
    const vision = await step.run("vision", async () => {
      const existing = await persist.getMemoryByCapture(captureId);
      if (existing?.perception) {
        return { perception: existing.perception as Perception, reused: true };
      }
      const { buffer } = await storage.downloadObject(storagePath);
      const perception = await analyzeImage({
        imageBase64: buffer.toString("base64"),
        mimeType: String(capture.mime_type ?? "image/png"),
      });
      return { perception, reused: false };
    });
    const perception = vision.perception as Perception;

    // [2] Query embedding (non-fatal — degrades gracefully)
    const queryEmbedding = await step.run("query-embedding", async () => {
      try {
        return await embedText(
          buildQueryText({
            note,
            visual_description: perception.visual_description,
            content_type: perception.content_type,
          })
        );
      } catch (error) {
        console.error("query embedding failed:", (error as Error).message);
        return null;
      }
    });

    // [3] Retrieval (non-fatal)
    const cards = await step.run("retrieval", async () => {
      try {
        return await retrieveContext({ userId, captureId, fileHash, queryEmbedding });
      } catch (error) {
        console.error("retrieval failed:", (error as Error).message);
        return [];
      }
    });

    // [3b] Personal-context bundle for reasoning (M5 — deterministic; non-fatal).
    // Only the reasoning stage receives learning; vision/embeddings/retrieval stay objective.
    const learning = await step.run("learning-context", async () => {
      try {
        return await buildLearningContext(userId, {
          note,
          perceptionText: [
            perception.visual_description,
            perception.visible_text,
            ...(Array.isArray(perception.detected_entities) ? perception.detected_entities.map(String) : []),
          ]
            .filter(Boolean)
            .join(" "),
          cardTopics: cards.map((c) => c.topic).filter((t): t is string => Boolean(t)),
        });
      } catch (error) {
        console.error("learning context failed:", (error as Error).message);
        return { lines: [] as string[], patternIds: [] as string[] };
      }
    });

    // [4] Reasoning
    const interpretation = await step.run("reasoning", async () =>
      interpretMemory({ note, perception, cards, learningContext: learning.lines })
    );

    // [5] Persist memory + initial events (atomic RPC)
    const memoryId = await step.run("persist", async () =>
      persist.persistMemory({
        captureId,
        title: interpretation.title,
        summary: interpretation.summary,
        visualDescription: perception.visual_description,
        perception,
        topic: interpretation.topic,
        intent: interpretation.intent,
        intentSource: interpretation.intent_source,
        intentConfidence: interpretation.intent_confidence ?? null,
        action: interpretation.suggested_action,
        reason: interpretation.intent_reasoning ?? "",
      })
    );

    // [5b] Connections — persist the brain's justified candidate connections as
    // *suggested* (non-fatal; cosine similarity alone never creates a connection).
    const connections = await step.run("connections", async () => {
      try {
        return await persistConnectionCandidates({
          userId,
          newMemoryId: memoryId,
          allowedMemoryIds: cards.map((c) => c.memory_id),
          candidates: (interpretation.candidate_connections ?? []) as any[],
        });
      } catch (error) {
        console.error("connection persistence failed:", (error as Error).message);
        return { created: 0, skipped: 0 };
      }
    });

    // [6] Document embedding (non-fatal — backfill-able; never fabricated)
    const embedded = await step.run("document-embedding", async () => {
      try {
        const canonical = buildCanonicalText({
          title: interpretation.title,
          summary: interpretation.summary,
          topic: interpretation.topic,
          current_intent: interpretation.intent,
          suggested_action: interpretation.suggested_action,
          visual_description: perception.visual_description,
          note,
        });
        const vector = await embedText(canonical);
        await persist.upsertEmbedding({
          userId,
          memoryId,
          model: env.embeddingModelId(),
          embeddingLiteral: toVectorLiteral(vector),
          inputHash: sha256Hex(canonical),
        });
        return true;
      } catch (error) {
        console.error("document embedding failed:", (error as Error).message);
        return false;
      }
    });

    return { memoryId, embedded, connectionsCreated: connections.created };
  }
);
