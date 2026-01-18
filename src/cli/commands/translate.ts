import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { loadConfig } from "../../infrastructure/config/load";
import { TranslationPipeline } from "../../application/pipeline/orchestrator";
import { ExitCode } from "../exit-codes";
import { createLogger } from "../logging";
import { parseMarkdownFile } from "../../infrastructure/markdown/parse";
import { LanceDbChunkStore } from "../../infrastructure/vectordb/lancedb";
import { OpenRouterEmbeddings } from "../../infrastructure/embeddings/openrouter";
import { JinaRerankerClient } from "../../infrastructure/rerank/jina";
import { HybridSearchService } from "../../application/search/hybrid-search";
import { BraveSearchClient } from "../../infrastructure/research/brave-search";
import { createLlmClients } from "../../infrastructure/llm/factory";
import {
  generateRagQueries,
  generateGroundTruthQueries,
} from "../../application/translate/query-gen";
import { summarizeGroundTruth } from "../../application/translate/ground-truth-summarizer";

const TranslateArgsSchema = z.object({
  config: z.string().optional(),
  input: z.string().min(1),
  language: z.string().min(1).default("Vietnamese"),
  output: z.string().optional(),
  format: z.enum(["md", "json", "both"]).default("both"),
  resume: z.boolean().optional(),
  verbose: z.boolean().optional(),
  debug: z.boolean().optional(),
});

export function registerTranslateCommand(program: Command): void {
  program
    .command("translate")
    .description("Translate a text file using the two-stage pipeline")
    .requiredOption("-i, --input <path>", "Input text/markdown file")
    .option("-l, --language <name>", "Target language (default: Vietnamese)")
    .option("-o, --output <path>", "Output path (default: alongside input)")
    .option("--format <md|json|both>", "Output format", "both")
    .option("--resume", "Resume from checkpoint if available")
    .option("--config <path>", "Path to YAML/JSON config file")
    .option("--verbose", "Verbose logs")
    .option("--debug", "Debug logs (includes stack traces)")
    .action(async (opts) => {
      const parsed = TranslateArgsSchema.safeParse(opts);
      if (!parsed.success) {
        console.error(parsed.error.issues.map((i) => i.message).join("\n"));
        process.exit(ExitCode.usage);
      }

      const args = parsed.data;
      const logLevel = args.debug ? "debug" : args.verbose ? "info" : "error";

      try {
        const config = await loadConfig({
          configPath: args.config,
          overrides: { logLevel },
        });
        const logger = createLogger(config);

        const inputPath = path.isAbsolute(args.input)
          ? args.input
          : path.join(process.cwd(), args.input);

        // Use markdown parser to get semantic paragraphs
        const parsedMd = await parseMarkdownFile(inputPath);
        const paragraphs = parsedMd.paragraphs;

        // Initialize retrieval services
        let hybridSearch: HybridSearchService | undefined;
        let braveSearch: BraveSearchClient | undefined;

        // 1. Setup Hybrid Search (LanceDB + OpenRouter Embeddings + Jina Rerank)
        if (config.vectordb && config.providers.openrouter) {
          try {
            const store = new LanceDbChunkStore({
              path: config.vectordb.path,
              table: config.vectordb.table,
            });
            await store.connect();

            const embeddings = new OpenRouterEmbeddings({
              apiKey: config.providers.openrouter.apiKey,
              baseUrl: config.providers.openrouter.baseUrl,
              model: config.embeddings.model,
              timeoutMs: config.providers.openrouter.timeoutMs,
            });

            let reranker: JinaRerankerClient | undefined;
            if (config.reranker.enabled && config.reranker.jinaApiKey) {
              reranker = new JinaRerankerClient({
                apiKey: config.reranker.jinaApiKey,
                baseUrl: config.reranker.baseUrl,
                model: config.reranker.model,
                timeoutMs: config.reranker.timeoutMs,
                maxRetries: config.reranker.maxRetries,
              });
            }

            hybridSearch = new HybridSearchService({
              store,
              embeddings,
              reranker,
            });
            logger.info("Context retrieval (hybrid search) enabled");
          } catch (e) {
            logger.warn(`Failed to initialize hybrid search: ${e}`);
          }
        }

        // 2. Setup Ground Truth (Brave Search)
        if (config.braveSearch.enabled && config.braveSearch.apiKey) {
          braveSearch = new BraveSearchClient({
            apiKey: config.braveSearch.apiKey,
            baseUrl: config.braveSearch.baseUrl,
            country: config.braveSearch.country,
            searchLang: config.braveSearch.searchLang,
            count: config.braveSearch.count,
            extraSnippets: config.braveSearch.extraSnippets,
            timeoutMs: config.braveSearch.timeoutMs,
            maxRetries: config.braveSearch.maxRetries,
          });
          logger.info("Ground truth (Brave search) enabled");
        }

        const llmClients = createLlmClients(config);
        const pipeline = new TranslationPipeline(config, llmClients);
        const outputs: Array<{ source: string; translation: string }> = [];
        const glossary = new Map<string, string>();

        // Determine checkpoint path
        const outBase =
          args.output ??
          path.join(
            path.dirname(inputPath),
            `${path.basename(inputPath, path.extname(inputPath))}.translated`,
          );
        const checkpointPath = `${outBase}.checkpoint.json`;
        let startIndex = 0;

        // Graceful Shutdown Handler
        let isShuttingDown = false;
        process.on("SIGINT", async () => {
          if (isShuttingDown) return;
          isShuttingDown = true;
          logger.info("\nGraceful shutdown initiated. Saving checkpoint...");
          // Checkpoint logic is inside the loop, but we can force a final save here if needed.
          // Since we save after each paragraph, we just need to stop the loop.
          // We can't easily break the loop from here, so we set a flag.
        });

        if (args.resume && existsSync(checkpointPath)) {
          try {
            const content = await readFile(checkpointPath, "utf8");
            const checkpoint = JSON.parse(content);
            // Basic validation
            if (
              checkpoint.input === path.basename(inputPath) &&
              checkpoint.language === args.language &&
              Array.isArray(checkpoint.paragraphs)
            ) {
              outputs.push(...checkpoint.paragraphs);
              startIndex = checkpoint.paragraphs.length;

              // Load glossary if available
              if (Array.isArray(checkpoint.glossary)) {
                checkpoint.glossary.forEach(
                  (g: { source: string; target: string }) =>
                    glossary.set(g.source, g.target),
                );
              }

              logger.info(
                `Resuming from checkpoint: ${startIndex} paragraphs completed. Glossary size: ${glossary.size}`,
              );
            } else {
              logger.warn(
                "Checkpoint found but mismatched input/language. Starting from scratch.",
              );
            }
          } catch (e) {
            logger.warn(`Failed to read checkpoint: ${e}`);
          }
        }

        for (let i = startIndex; i < paragraphs.length; i++) {
          if (isShuttingDown) {
            break;
          }

          const p = paragraphs[i]!;
          logger.info(
            `Translating paragraph ${i + 1}/${paragraphs.length} (${p.length} chars)`,
          );

          const storyMetadata = {
            title: parsedMd.frontmatter["title"] as string | undefined,
            author: parsedMd.frontmatter["author"] as string | undefined,
            description: parsedMd.frontmatter["description"] as
              | string
              | undefined,
            originalLanguage: "Unknown", // Can be inferred or config
            targetLanguage: args.language,
          };

          // 1. Context Retrieval (RAG)
          let ragSnippets: string[] = [];
          if (hybridSearch) {
            try {
              // Smart Query Generation
              const ragQueries = await generateRagQueries(
                llmClients.deepseek,
                config.providers.deepseek.model,
                { paragraph: p, storyMetadata },
              );

              logger.debug(
                `Generated RAG queries: ${JSON.stringify(ragQueries)}`,
              );

              // Search with each query and deduplicate
              const allResults = await Promise.all(
                ragQueries.map((q) =>
                  hybridSearch!.search(q, {
                    vectorTopK: 5,
                    ftsTopK: 5,
                    rrfK: 60,
                    rerankTopK: 2, // Strict top-K per query
                    ftsColumns: config.ingest.indexing.ftsColumn,
                  }),
                ),
              );

              // Flatten and dedupe by text
              const uniqueResults = new Map<string, string>();
              allResults.flat().forEach((r) => {
                uniqueResults.set(
                  r.text,
                  `[${r.metadata.language.toUpperCase()}] ${r.text}`,
                );
              });

              ragSnippets = Array.from(uniqueResults.values()).slice(0, 5); // Cap total context
            } catch (err) {
              logger.warn(
                `Context retrieval failed for paragraph ${i}: ${err}`,
              );
            }
          }

          // 2. Ground Truth Retrieval (Web)
          let groundTruthSnippets: string[] = [];
          if (braveSearch) {
            try {
              // Smart Query Generation
              const gtQueries = await generateGroundTruthQueries(
                llmClients.deepseek,
                config.providers.deepseek.model,
                { paragraph: p, storyMetadata, maxQueries: 3 },
              );

              logger.debug(
                `Generated GroundTruth queries: ${JSON.stringify(gtQueries)}`,
              );

              // Execute searches sequentially to be nice to rate limits
              for (const q of gtQueries) {
                const results = await braveSearch.webSearch(q.query, {
                  searchLang: q.searchLang,
                  count: 3,
                });
                // Filter for English/Vietnamese snippets or relevant info
                const snippets = results
                  .slice(0, 2)
                  .map(
                    (r) =>
                      `[${q.category.toUpperCase()}] ${r.title}: ${r.description}`,
                  );
                groundTruthSnippets.push(...snippets);
              }
              // Cap snippets for summarization
              const allSnippets = groundTruthSnippets.slice(0, 10);

              if (allSnippets.length > 0) {
                // Summarize into guidance
                const guidance = await summarizeGroundTruth(
                  llmClients.deepseek,
                  config.providers.deepseek.model,
                  {
                    paragraph: p,
                    searchResults: allSnippets,
                    storyMetadata,
                  },
                );

                // Convert guidance back to snippet strings for the pipeline
                // Note: Ideally pipeline accepts structured guidance, but current prompt uses snippets list
                groundTruthSnippets = [
                  ...guidance.keepOriginal.map((t) => `[Keep Original]: ${t}`),
                  ...Object.entries(guidance.suggestedTranslations).map(
                    ([k, v]) => `[Suggest]: ${k} -> ${v}`,
                  ),
                  ...guidance.culturalNotes.map((n) => `[Culture]: ${n}`),
                  ...(guidance.toneGuidance
                    ? [`[Tone]: ${guidance.toneGuidance}`]
                    : []),
                ];
              } else {
                groundTruthSnippets = [];
              }
            } catch (err) {
              logger.warn(
                `Ground truth retrieval failed for paragraph ${i}: ${err}`,
              );
            }
          }

          const result = await pipeline.run({
            language: args.language,
            source: p,
            metadata: {
              input: path.basename(inputPath),
              chapterTitle:
                (parsedMd.frontmatter["title"] as string | undefined) ??
                "Untitled",
              prevParagraph: paragraphs[i - 1] ?? "",
              nextParagraph: paragraphs[i + 1] ?? "",
              // Pass the last 3 translated paragraphs as context
              prevTranslatedParagraphs: outputs
                .slice(-3)
                .map((o) => o.translation),
            },
            ragSnippets: ragSnippets.map((s, idx) => ({
              id: `rag-${idx}`,
              snippet: s,
            })),
            groundTruthSnippets: groundTruthSnippets.map((s, idx) => ({
              id: `gt-${idx}`,
              snippet: s,
            })),
            existingGlossary: Array.from(glossary.entries()).map(([k, v]) => ({
              source: k,
              target: v,
            })),
          });
          outputs.push({ source: p, translation: result.final.translation });

          // Update dynamic glossary
          if (result.final.glossary && Array.isArray(result.final.glossary)) {
            result.final.glossary.forEach((entry) => {
              if (entry.source && entry.target) {
                glossary.set(entry.source, entry.target);
              }
            });
          }

          // Manual Progress Indicator
          const progress = Math.round(((i + 1) / paragraphs.length) * 100);
          const barLength = 20;
          const filled = Math.round((barLength * progress) / 100);
          const bar = "=".repeat(filled) + "-".repeat(barLength - filled);
          process.stdout.write(
            `\rProgress: [${bar}] ${progress}% (${i + 1}/${paragraphs.length})`,
          );
          if (i === paragraphs.length - 1) process.stdout.write("\n");

          // Incremental Save (Checkpointing)
          if (args.output || args.input) {
            // Append to .part.md file
            await writeFile(
              `${outBase}.part.md`,
              result.final.translation + "\n\n",
              { flag: "a" },
            );

            // Also update the full JSON/MD periodically or at end?
            // For production robustness, we should save the full state to a .checkpoint.json
            const checkpoint = {
              input: path.basename(inputPath),
              language: args.language,
              progress: { current: i + 1, total: paragraphs.length },
              paragraphs: outputs,
              glossary: Array.from(glossary.entries()).map(([k, v]) => ({
                source: k,
                target: v,
              })),
            };
            await writeFile(
              `${outBase}.checkpoint.json`,
              JSON.stringify(checkpoint, null, 2),
              "utf8",
            );
          }
        }

        const mdOut = outputs.map((o) => o.translation).join("\n\n");
        const jsonOut = JSON.stringify(
          {
            input: path.basename(inputPath),
            language: args.language,
            paragraphs: outputs,
          },
          null,
          2,
        );

        if (args.format === "md" || args.format === "both") {
          await writeFile(`${outBase}.md`, mdOut, "utf8");
        }
        if (args.format === "json" || args.format === "both") {
          await writeFile(`${outBase}.json`, jsonOut, "utf8");
        }

        logger.info("Done");
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
