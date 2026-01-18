import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Document } from "@langchain/core/documents";
import type { AppConfig } from "../../infrastructure/config/schema";
import { OpenRouterEmbeddings } from "../../infrastructure/embeddings/openrouter";
import { FileLoader } from "../../infrastructure/loaders/file-loader";
import { UrlLoader } from "../../infrastructure/loaders/url-loader";
import { chunkText } from "../../infrastructure/splitting/chunking";
import { normalizeTextForSearch } from "../../infrastructure/text/normalize";
import { sha256HexUtf8 } from "../../infrastructure/crypto/hash";
import { LanceDbChunkStore } from "../../infrastructure/vectordb/lancedb";
import type {
  ChunkDocument,
  ContentType,
  SourceType,
} from "../../domain/ingest/chunk";
import { BraveSearchClient } from "../../infrastructure/research/brave-search";
import { isSafePublicHttpUrl } from "../../infrastructure/http/url-safety";
import { enrichChunk } from "./enrich-chunk";
import { createLlmClients } from "../../infrastructure/llm/factory";

export type IngestStats = {
  sources: number;
  documentsLoaded: number;
  chunksStored: number;
  webResearchFetched: number;
};

type LoadedSource = {
  sourceType: SourceType;
  sourceUri: string;
  contentType: ContentType;
  docs: Document[];
};

async function listFiles(dir: string): Promise<string[]> {
  const abs = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  const entries = await readdir(abs, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(abs, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function inferContentTypeFromPath(p: string): ContentType {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".mdx") return "markdown";
  if (ext === ".txt") return "text";
  return "unknown";
}

function makeChunkId(
  sourceId: string,
  chunkIndex: number,
  normalizedText: string,
): string {
  return sha256HexUtf8(`${sourceId}:${chunkIndex}:${normalizedText}`);
}

export async function ingestFromConfig(
  config: AppConfig,
): Promise<IngestStats> {
  const openrouter = config.providers.openrouter;
  if (!openrouter) {
    throw new Error(
      "OpenRouter config is required for embeddings during ingest",
    );
  }

  const store = new LanceDbChunkStore({
    path: config.vectordb.path,
    table: config.vectordb.table,
  });
  await store.connect();
  await store.ensureIndexes({
    vectorColumn: config.ingest.indexing.vectorColumn,
    textColumn: config.ingest.indexing.ftsColumn,
    createVectorIndex: config.ingest.indexing.createVectorIndex,
    createFtsIndex: config.ingest.indexing.createFtsIndex,
  });

  const embeddings = new OpenRouterEmbeddings({
    apiKey: openrouter.apiKey,
    baseUrl: openrouter.baseUrl,
    model: config.embeddings.model,
    timeoutMs: openrouter.timeoutMs,
  });

  const brave =
    config.braveSearch.enabled && config.braveSearch.apiKey
      ? new BraveSearchClient({
          apiKey: config.braveSearch.apiKey,
          baseUrl: config.braveSearch.baseUrl,
          country: config.braveSearch.country,
          searchLang: config.braveSearch.searchLang,
          count: config.braveSearch.count,
          extraSnippets: config.braveSearch.extraSnippets,
          timeoutMs: config.braveSearch.timeoutMs,
          maxRetries: config.braveSearch.maxRetries,
        })
      : undefined;

  const llmClients = createLlmClients(config);
  const llmEnabled = config.ingest.llm.enabled;
  const llmModel = config.ingest.llm.model ?? config.providers.deepseek.model;

  const inputFiles = [
    ...(await listFiles(config.ingest.originalChaptersPath)),
    ...(await listFiles(config.ingest.translatedChaptersPath)),
  ].filter((p) =>
    [".md", ".mdx", ".txt", ".pdf"].includes(path.extname(p).toLowerCase()),
  );

  const loaded: LoadedSource[] = [];
  for (const file of inputFiles) {
    const ct = inferContentTypeFromPath(file);
    const loader = new FileLoader(file, {
      contentType:
        ct === "unknown"
          ? "text"
          : ct === "pdf"
            ? "pdf"
            : ct === "markdown"
              ? "markdown"
              : "text",
    });
    const docs = await loader.load();
    loaded.push({ sourceType: "file", sourceUri: file, contentType: ct, docs });
  }

  const researchUrls: string[] = [];
  if (config.ingest.enrichment.enabled && brave) {
    for (const src of loaded) {
      const seed = src.docs[0]?.pageContent?.slice(0, 500) ?? "";
      const query = seed.length > 0 ? seed : path.basename(src.sourceUri);
      const results = await brave.webSearch(query);
      for (const r of results) {
        if (isSafePublicHttpUrl(r.url)) researchUrls.push(r.url);
      }
      if (researchUrls.length >= config.ingest.enrichment.maxUrls) break;
    }
  }

  let webResearchFetched = 0;
  for (const url of researchUrls.slice(0, config.ingest.enrichment.maxUrls)) {
    const loader = new UrlLoader(url, {
      timeoutMs: config.ingest.enrichment.enabled
        ? config.braveSearch.timeoutMs
        : 20_000,
      maxBytes: config.ingest.enrichment.maxCharsPerUrl * 2,
    });
    const docs = await loader.load();
    loaded.push({
      sourceType: "web_research",
      sourceUri: url,
      contentType: "html",
      docs,
    });
    webResearchFetched++;
  }

  let chunksStored = 0;
  for (const src of loaded) {
    const sourceId = sha256HexUtf8(`${src.sourceType}:${src.sourceUri}`);
    for (const doc of src.docs) {
      const chunks = chunkText(doc.pageContent, {
        chunkSize: config.ingest.chunk.chunkSize,
        chunkOverlap: config.ingest.chunk.chunkOverlap,
        strategy: config.ingest.chunk.strategy,
      });

      const batchSize = 24;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const slice = chunks.slice(i, i + batchSize);
        const normalized = slice.map((c) =>
          config.ingest.chunk.normalize
            ? normalizeTextForSearch(c.text)
            : c.text,
        );

        const summaries: string[] = [];
        const languages: string[] = [];
        const titles: Array<string | undefined> = [];
        const contentTypes: ContentType[] = [];

        for (let j = 0; j < normalized.length; j++) {
          const t = normalized[j]!;
          if (llmEnabled) {
            try {
              const out = await enrichChunk({
                client: llmClients.deepseek,
                model: llmModel,
                input: {
                  sourceUri: src.sourceUri,
                  contentTypeHint: src.contentType,
                  chunkText: t,
                },
              });
              summaries.push(out.summaryForEmbedding);
              languages.push(out.language);
              titles.push(out.title);
              contentTypes.push(out.contentType);
              normalized[j] = out.normalizedText;
              continue;
            } catch {}
          }
          // Use textWithContext for better embeddings if available (paragraph strategy)
          const chunk = slice[j]!;
          const textForEmbedding = chunk.textWithContext ?? t;
          summaries.push(textForEmbedding.slice(0, 2_000));
          languages.push("unknown");
          titles.push(undefined);
          contentTypes.push(src.contentType);
        }

        const vectors = await embeddings.embedBatch(summaries);
        const rows: ChunkDocument[] = normalized.map((text, j) => {
          const chunk = slice[j]!;
          const chunkIndex = chunk.paragraphIndex ?? (i + j);
          const id = makeChunkId(sourceId, chunkIndex, text);
          return {
            id,
            text,
            normalizedText: text,
            summaryForEmbedding: summaries[j]!,
            vector: vectors[j]!,
            metadata: {
              sourceType: src.sourceType,
              sourceId,
              sourceUri: src.sourceUri,
              contentType: contentTypes[j]!,
              language: languages[j]!,
              title: titles[j],
              sectionPath: chunk.sectionPath ?? [],
              chunkIndex,
              // Context window metadata (like old_code.md)
              hasPrevContext: chunk.hasPrevContext,
              hasNextContext: chunk.hasNextContext,
              createdAtMs: Date.now(),
              version: "v1",
              hash: sha256HexUtf8(text),
            },
          };
        });
        await store.upsertChunks(rows);
        chunksStored += rows.length;
      }
    }
  }

  return {
    sources: loaded.length,
    documentsLoaded: loaded.reduce((a, b) => a + b.docs.length, 0),
    chunksStored,
    webResearchFetched,
  };
}
