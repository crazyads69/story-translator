import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../../src/infrastructure/config/load";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("loadConfig", () => {
  it("loads YAML config and validates", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const dir = await writeTempDir();
    const configPath = path.join(dir, "cfg.yaml");
    await writeFile(
      configPath,
      [
        "logLevel: info",
        "providers:",
        "  deepseek:",
        "    apiKey: test-deepseek",
        "    baseUrl: https://api.deepseek.com",
        "    model: deepseek-chat",
        "    timeoutMs: 120000",
        "    maxRetries: 0",
        "embeddings:",
        "  model: text-embedding-3-small",
        "  concurrency: 2",
        "vectordb:",
        "  path: lancedb",
        "  table: paragraph_documents",
        "ingest:",
        "  originalChaptersPath: data/original",
        "  translatedChaptersPath: data/translated",
        "braveSearch:",
        "  enabled: false",
        "reranker:",
        "  enabled: false",
        "",
      ].join("\n"),
      "utf8",
    );

    const cfg = await loadConfig({ configPath });
    expect(cfg.providers.deepseek.apiKey).toBe("test-deepseek");
    expect(cfg.embeddings.concurrency).toBe(2);
  });

  it("applies env overrides over file config", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const dir = await writeTempDir();
    const configPath = path.join(dir, "cfg.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          logLevel: "error",
          providers: {
            deepseek: {
              apiKey: "test-deepseek",
              baseUrl: "https://api.deepseek.com",
              model: "deepseek-chat",
              timeoutMs: 120000,
              maxRetries: 0,
            },
          },
          embeddings: { model: "text-embedding-3-small", concurrency: 2 },
          vectordb: { path: "lancedb", table: "paragraph_documents" },
          ingest: {
            originalChaptersPath: "data/original",
            translatedChaptersPath: "data/translated",
          },
          braveSearch: { enabled: false },
          reranker: { enabled: false },
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.LOG_LEVEL = "debug";
    const cfg = await loadConfig({ configPath });
    expect(cfg.logLevel).toBe("debug");
  });
});

async function writeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "story-trans-"));
}
