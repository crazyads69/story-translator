import { z } from "zod";
import type { Command } from "commander";
import { loadConfig } from "../../infrastructure/config/load";
import { createLogger } from "../logging";
import { ExitCode } from "../exit-codes";
import { LanceDbChunkStore } from "../../infrastructure/vectordb/lancedb";
import { OpenRouterEmbeddings } from "../../infrastructure/embeddings/openrouter";
import { HybridSearchService } from "../../application/search/hybrid-search";
import { JinaRerankerClient } from "../../infrastructure/rerank/jina";

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .description("Run hybrid retrieval (vector + keyword) with optional Jina reranking")
    .requiredOption("-q, --query <text>", "Query text")
    .option("-k, --top-k <n>", "Top K candidates", "10")
    .option("--rerank", "Enable Jina reranking (requires config.reranker)")
    .option("--config <path>", "Path to YAML/JSON config file")
    .option("--verbose", "Verbose logs")
    .option("--debug", "Debug logs (includes stack traces)")
    .action(async (opts) => {
      const parsed = z
        .object({
          query: z.string().min(1),
          topK: z.coerce.number().int().positive().default(10),
          rerank: z.boolean().optional(),
          config: z.string().optional(),
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
        const config = await loadConfig({ configPath: args.config, overrides: { logLevel } });
        const logger = createLogger(config);

        const openrouter = config.providers.openrouter;
        if (!openrouter) throw new Error("OpenRouter config is required for query embeddings");

        const store = new LanceDbChunkStore({ path: config.vectordb.path, table: config.vectordb.table });
        await store.connect();

        const embeddings = new OpenRouterEmbeddings({
          apiKey: openrouter.apiKey,
          baseUrl: openrouter.baseUrl,
          model: config.embeddings.model,
          timeoutMs: openrouter.timeoutMs,
        });

        const reranker =
          args.rerank && config.reranker.enabled && config.reranker.jinaApiKey
            ? new JinaRerankerClient({
                apiKey: config.reranker.jinaApiKey,
                baseUrl: config.reranker.baseUrl,
                model: config.reranker.model,
                timeoutMs: config.reranker.timeoutMs,
                maxRetries: config.reranker.maxRetries,
              })
            : undefined;

        const hybrid = new HybridSearchService({ store, embeddings, reranker });
        const results = await hybrid.search(args.query, {
          vectorTopK: args.topK,
          ftsTopK: args.topK,
          rrfK: 60,
          rerankTopK: reranker ? Math.min(config.reranker.maxDocuments, args.topK) : args.topK,
          ftsColumns: config.ingest.indexing.ftsColumn,
        });

        for (const [i, r] of results.entries()) {
          logger.info(
            `${i + 1}. score(rrf)=${r.scores.rrf.toFixed(4)}${r.scores.jina !== undefined ? ` score(jina)=${r.scores.jina.toFixed(4)}` : ""} source=${r.metadata.sourceUri}`,
          );
          process.stdout.write(`${r.text}\n\n`);
        }

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

