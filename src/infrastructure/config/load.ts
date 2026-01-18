import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ConfigError, ValidationError } from "../../domain/common/errors";
import { AppConfigSchema, type AppConfig } from "./schema";

export type LoadConfigArgs = {
  configPath?: string;
  overrides?: Partial<AppConfig>;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: UnknownRecord, next: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const prior = out[key];
    if (isRecord(prior) && isRecord(value)) {
      out[key] = deepMerge(prior, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function envString(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : undefined;
}

function envInt(name: string): number | undefined {
  const raw = envString(name);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function envBool(name: string): boolean | undefined {
  const raw = envString(name);
  if (!raw) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

function configFromEnv(): UnknownRecord {
  const deepseekApiKey = envString("DEEPSEEK_API_KEY");
  const openrouterApiKey = envString("OPENROUTER_API_KEY");

  const envConfig: UnknownRecord = {
    logLevel: envString("LOG_LEVEL"),
    providers: {
      deepseek: {
        apiKey: deepseekApiKey,
        baseUrl: envString("DEEPSEEK_BASE_URL"),
        model: envString("DEEPSEEK_MODEL"),
        timeoutMs: envInt("DEEPSEEK_TIMEOUT_MS"),
        maxRetries: envInt("DEEPSEEK_MAX_RETRIES"),
        concurrency: envInt("DEEPSEEK_CONCURRENCY"),
      },
      openrouter: openrouterApiKey
        ? {
            apiKey: openrouterApiKey,
            baseUrl: envString("OPENROUTER_BASE_URL"),
            model: envString("OPENROUTER_MODEL"),
            timeoutMs: envInt("OPENROUTER_TIMEOUT_MS"),
            maxRetries: envInt("OPENROUTER_MAX_RETRIES"),
            concurrency: envInt("OPENROUTER_CONCURRENCY"),
            app: {
              httpReferer: envString("OPENROUTER_HTTP_REFERER"),
              title: envString("OPENROUTER_X_TITLE"),
            },
          }
        : undefined,
    },
    embeddings: {
      model: envString("EMBEDDING_MODEL"),
      concurrency: envInt("EMBEDDING_CONCURRENCY"),
    },
    vectordb: {
      path: envString("LANCEDB_PATH"),
      table: envString("LANCEDB_TABLE_NAME"),
    },
    ingest: {
      originalChaptersPath: envString("ORIGINAL_CHAPTERS_PATH"),
      translatedChaptersPath: envString("TRANSLATED_CHAPTERS_PATH"),
      chunk: {
        chunkSize: envInt("INGEST_CHUNK_SIZE"),
        chunkOverlap: envInt("INGEST_CHUNK_OVERLAP"),
        strategy: envString("INGEST_CHUNK_STRATEGY"),
        normalize: envBool("INGEST_NORMALIZE"),
      },
      enrichment: {
        enabled: envBool("INGEST_ENRICHMENT_ENABLED"),
        maxUrls: envInt("INGEST_ENRICHMENT_MAX_URLS"),
        maxCharsPerUrl: envInt("INGEST_ENRICHMENT_MAX_CHARS_PER_URL"),
        maxConcurrentFetches: envInt(
          "INGEST_ENRICHMENT_MAX_CONCURRENT_FETCHES",
        ),
      },
      llm: {
        enabled: envBool("INGEST_LLM_ENABLED"),
        model: envString("INGEST_LLM_MODEL"),
      },
      indexing: {
        createVectorIndex: envBool("INGEST_CREATE_VECTOR_INDEX"),
        createFtsIndex: envBool("INGEST_CREATE_FTS_INDEX"),
        ftsColumn: envString("INGEST_FTS_COLUMN"),
        vectorColumn: envString("INGEST_VECTOR_COLUMN"),
      },
    },
    braveSearch: {
      apiKey: envString("BRAVE_SEARCH_API_KEY"),
      enabled: envBool("BRAVE_SEARCH_ENABLED"),
      baseUrl: envString("BRAVE_SEARCH_BASE_URL"),
      country: envString("BRAVE_SEARCH_COUNTRY"),
      searchLang: envString("BRAVE_SEARCH_LANG"),
      count: envInt("BRAVE_SEARCH_COUNT"),
      extraSnippets: envBool("BRAVE_SEARCH_EXTRA_SNIPPETS"),
      timeoutMs: envInt("BRAVE_SEARCH_TIMEOUT_MS"),
      maxRetries: envInt("BRAVE_SEARCH_MAX_RETRIES"),
    },
    reranker: {
      jinaApiKey: envString("JINA_API_KEY"),
      enabled: envBool("RERANKER_ENABLED"),
      baseUrl: envString("RERANKER_BASE_URL"),
      model: envString("RERANKER_MODEL"),
      topN: envInt("RERANKER_TOP_N"),
      maxDocuments: envInt("RERANKER_MAX_DOCUMENTS"),
      timeoutMs: envInt("RERANKER_TIMEOUT_MS"),
      maxRetries: envInt("RERANKER_MAX_RETRIES"),
      concurrency: envInt("RERANKER_CONCURRENCY"),
    },
  };

  return envConfig;
}

async function readConfigFile(configPath: string): Promise<UnknownRecord> {
  const abs = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (error) {
    throw new ConfigError(`Failed to read config file: ${abs}`, error);
  }

  const ext = path.extname(abs).toLowerCase();
  try {
    if (ext === ".yaml" || ext === ".yml") {
      const parsed = YAML.parse(raw) as unknown;
      return isRecord(parsed) ? parsed : {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new ConfigError(`Failed to parse config file: ${abs}`, error);
  }
}

export async function loadConfig(
  args: LoadConfigArgs = {},
): Promise<AppConfig> {
  const fileConfig = args.configPath
    ? await readConfigFile(args.configPath)
    : {};
  const envConfig = configFromEnv();
  const merged = deepMerge(
    deepMerge(fileConfig, envConfig),
    (args.overrides ?? {}) as UnknownRecord,
  );

  const parsed = AppConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ValidationError(
      `Invalid configuration:\n${issues}`,
      parsed.error,
    );
  }
  return parsed.data;
}
