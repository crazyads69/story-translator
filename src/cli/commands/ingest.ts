import type { Command } from "commander";
import { z } from "zod";
import { loadConfig } from "../../infrastructure/config/load";
import { IngestGraph } from "../../application/ingest/ingest-graph";
import { ExitCode } from "../exit-codes";
import { createLogger } from "../logging";

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest")
    .description("Ingest documents into LanceDB (supports hybrid search + reranking)")
    .option("--config <path>", "Path to YAML/JSON config file")
    .option("-s, --source <source...>", "File path or URL (repeatable)")
    .option("--mode <vector|hybrid>", "Retrieval mode", "hybrid")
    .option("--chunk-size <n>", "Chunk size (chars)")
    .option("--chunk-overlap <n>", "Chunk overlap (chars)")
    .option("--embedding-model <name>", "OpenRouter embedding model name")
    .option("--rerank-top-n <n>", "Top N results to keep after rerank")
    .option("--web-enrich", "Enable Brave-based web enrichment")
    .option("--verbose", "Verbose logs")
    .option("--debug", "Debug logs (includes stack traces)")
    .action(async (opts) => {
      const parsed = z
        .object({
          config: z.string().optional(),
          source: z.array(z.string()).optional(),
          mode: z.enum(["vector", "hybrid"]).default("hybrid"),
          chunkSize: z.coerce.number().int().positive().optional(),
          chunkOverlap: z.coerce.number().int().min(0).optional(),
          embeddingModel: z.string().optional(),
          rerankTopN: z.coerce.number().int().positive().optional(),
          webEnrich: z.boolean().optional(),
          verbose: z.boolean().optional(),
          debug: z.boolean().optional(),
        })
        .safeParse(opts);
      if (!parsed.success) {
        console.error(parsed.error.issues.map((i) => i.message).join("\n"));
        process.exit(ExitCode.usage);
      }
      const args = parsed.data;
      const logLevel = args.debug ? "debug" : args.verbose ? "info" : "error";

      try {
        const overrides: any = {
          logLevel,
          embeddings: args.embeddingModel ? { model: args.embeddingModel } : undefined,
          ingest: {
            chunk: {
              chunkSize: args.chunkSize,
              chunkOverlap: args.chunkOverlap,
            },
            enrichment: args.webEnrich ? { enabled: true } : undefined,
            indexing:
              args.mode === "vector"
                ? { createFtsIndex: false }
                : undefined,
            llm: {
              enabled: args.webEnrich ? true : undefined,
            },
          },
          reranker:
            args.mode === "hybrid" && args.rerankTopN
              ? { topN: args.rerankTopN }
              : undefined,
        };

        const config = await loadConfig({
          configPath: args.config,
          overrides,
        });
        const logger = createLogger(config);
        logger.info("Starting ingest");
        const graph = new IngestGraph();
        const stats = await graph.run(config, args.source ?? []);
        logger.info(
          `Ingest complete: sources=${stats.sources} docs=${stats.documentsLoaded} chunks=${stats.chunksStored} web=${stats.webResearchFetched} elapsedMs=${stats.elapsedMs}`,
        );
        process.exit(ExitCode.success);
      } catch (error) {
        if (args.debug && error instanceof Error) {
          console.error(error.stack ?? error.message);
        } else {
          console.error(error instanceof Error ? error.message : String(error));
        }
        process.exit(ExitCode.failure);
      }
    });
}
