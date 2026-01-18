# Next-Generation Ingest + Hybrid Retrieval Pipeline (Design + Implementation)

This repository now includes a production-oriented ingest and retrieval stack in TypeScript/Bun:
- Ingest: file/URL loading → chunking → optional web enrichment → optional LLM enrichment → OpenRouter embeddings → LanceDB storage
- Retrieval: dense + keyword → fusion (RRF) → optional Jina reranking
- Orchestration: LangGraph stateful workflow for ingest
- Interfaces: CLI for `ingest` and `search`

---

## 1) Research Summary (with URLs)

### OpenRouter (Embeddings)
- Docs: https://openrouter.ai/docs/api/reference/embeddings
- Key points:
  - Embeddings endpoint is `POST /embeddings` and supports single input or batch input arrays.
  - OpenRouter provides a “unified API” across providers; embedding models are discoverable via the models catalog.
- Best practices:
  - Batch inputs for throughput; cap per-text length to control costs and provider limits.
  - Keep embeddings deterministic by avoiding prompt-time variability (embeddings are not sampled, but upstream text normalization matters).
  - Use timeouts and retries for 429/5xx.
- Limitations:
  - Model dimensions vary by provider/model; store dimension implicitly via the vector length or explicitly in metadata.

### LanceDB (Vector store + Full-Text Search)
- Hybrid search concepts: https://lancedb.com/docs/search/hybrid-search/
- TypeScript SDK reference (installed): `@lancedb/lancedb` provides:
  - `table.search(vector, "vector")` for ANN vector search
  - `table.search(text, "fts", columns)` for full-text/BM25 search
  - `table.createIndex(column, { config: Index.fts() })` to enable FTS (see SDK types in `node_modules/@lancedb/lancedb/dist/*`)
- Best practices:
  - Store stable chunk IDs + hashes to support idempotent ingest/versioning.
  - Build FTS indexes on normalized text fields.
  - Prefer rank-based fusion (e.g., RRF) for combining dense distance and BM25 scores without brittle normalization.
- Limitations:
  - FTS index creation can be expensive; do it once per table, not on every run.

### LangChain (Loaders, Documents, Retrievers)
- Docs: https://docs.langchain.com/oss/javascript/
- Key points:
  - LangChain “Document” is a standard container for text + metadata.
  - Retrievers standardize query → relevant documents for downstream RAG chains.
- Best practices:
  - Keep loader outputs typed, metadata-rich, and stable across reruns.
  - Avoid over-chunking; tune chunk sizes to your target LLM context window + latency constraints.

### LangGraph (Workflow orchestration)
- Concepts (low-level): https://langchain-ai.github.io/langgraphjs/concepts/low_level/
- API reference: https://langchain-ai.github.io/langgraphjs/reference/classes/langgraph.StateGraph.html
- Key points:
  - `StateGraph` uses a typed state schema (Annotation.Root) to pass data between nodes.
  - Multiple outgoing edges can execute in parallel (fan-out).
- Best practices:
  - Build nodes as pure-ish functions where possible; isolate side effects (network/storage).
  - Use concurrency limiters for outbound calls; treat 429/5xx as retryable.

### Jina (Reranking)
- Reranker API + example request: https://jina.ai/reranker/
- Key points:
  - `POST https://api.jina.ai/v1/rerank` with `query`, `documents`, `top_n`, and optional model.
  - For v1/v2 rerankers: long docs may be chunked and max-pooled; query is truncated (see Jina docs).
- Best practices:
  - Use a two-stage approach: retrieve top K cheaply (vector/FTS), then rerank a smaller set (e.g., 20–100).
  - Cap document length, and prefer embedding summaries when chunk text is noisy.
- Safety + cost:
  - Reranking is more expensive than ANN; apply it only to a bounded candidate set.

### Contextual research augmentation (Web search)
- Brave Search API overview + parameters/auth examples: https://brave.com/search/api/
- Web Search documentation: https://api-dashboard.search.brave.com/app/documentation/web-search/query
- Key points:
  - Auth via `X-Subscription-Token` header.
  - Query parameters include `q`, `count`, `country`, `search_lang`, and `extra_snippets`.
- Safety implications:
  - Web fetching requires SSRF defenses, strict timeouts, response size caps, and content-type checks.
  - Treat web content as untrusted; protect downstream prompt pipelines from prompt injection.

---

## 2) Architecture Diagram

```text
                 ┌──────────────────────────────┐
                 │              CLI             │
                 │ ingest/search + config + logs│
                 └───────────────┬──────────────┘
                                 │
                                 ▼
           ┌─────────────────────────────────────────────┐
           │              LangGraph Ingest               │
           │  load → (optional web enrich) → chunk →     │
           │  (optional LLM enrich) → embed → store      │
           └─────────────────────────┬───────────────────┘
                                     │
                                     ▼
    ┌────────────────────────────────────────────────────────┐
    │                        LanceDB                          │
    │  chunks(id, text, normalizedText, summary, vector, meta)│
    │  - vector index (ANN)                                   │
    │  - FTS index (BM25)                                     │
    └───────────────────────────────────┬────────────────────┘
                                        │
                                        ▼
        ┌─────────────────────────────────────────────────┐
        │                Hybrid Retriever                  │
        │  vector topK + fts topK → RRF → (Jina rerank)    │
        └─────────────────────────────────────────────────┘
```

---

## 3) Ingest Pipeline Flow (Steps)

1. **Input resolution**
   - sources from config directories or explicit `--source` CLI args
2. **Document loading**
   - file loader: markdown/txt, optional pdf parsing
   - URL loader: HTML-to-text + size/timeout caps
3. **Optional web enrichment**
   - Brave web search → fetch top URLs → ingest as `sourceType=web_research`
4. **Chunking**
   - markdown headings first, then recursive splits with overlap
5. **Optional LLM enrichment**
   - normalize text, detect language/type, create summary for embedding
6. **Embeddings**
   - OpenRouter `/embeddings` batch request using embedding summary
7. **Storage**
   - write chunk rows into LanceDB
   - ensure vector index and FTS index exist

---

## 4) Hybrid Search Logic (Scoring)

### Reciprocal Rank Fusion (RRF)

For each candidate document `d` and for each retrieval list `i` (dense + sparse):

```
RRF(d) = Σ_i 1 / (k + rank_i(d))
```

- `rank_i(d)` starts at 1 for the top result.
- `k` is typically 60 (reduces dominance of rank 1).

We then take the top `K` candidates by RRF score and optionally rerank via Jina.

---

## 5) Implementation Map (Code References)

- Ingest LangGraph workflow: `IngestGraph`
  - [ingest-graph.ts](file:///Users/tri.le/Personal/story-trans/src/application/ingest/ingest-graph.ts)
- Loaders (LangChain):
  - [file-loader.ts](file:///Users/tri.le/Personal/story-trans/src/infrastructure/loaders/file-loader.ts)
  - [url-loader.ts](file:///Users/tri.le/Personal/story-trans/src/infrastructure/loaders/url-loader.ts)
- Chunking:
  - [chunking.ts](file:///Users/tri.le/Personal/story-trans/src/infrastructure/splitting/chunking.ts)
- Embeddings (OpenRouter):
  - [openrouter.ts](file:///Users/tri.le/Personal/story-trans/src/infrastructure/embeddings/openrouter.ts)
- Vector store (LanceDB):
  - [lancedb.ts](file:///Users/tri.le/Personal/story-trans/src/infrastructure/vectordb/lancedb.ts)
- Hybrid search + RRF + optional Jina rerank:
  - [hybrid-search.ts](file:///Users/tri.le/Personal/story-trans/src/application/search/hybrid-search.ts)
  - [jina.ts](file:///Users/tri.le/Personal/story-trans/src/infrastructure/rerank/jina.ts)
- LangChain retriever wrapper:
  - [lancedb-hybrid-retriever.ts](file:///Users/tri.le/Personal/story-trans/src/application/search/lancedb-hybrid-retriever.ts)
- Prompt templates:
  - [ingest.chunk-enrich.ts](file:///Users/tri.le/Personal/story-trans/src/prompts/v1/ingest.chunk-enrich.ts)
  - [ingest.normalize.ts](file:///Users/tri.le/Personal/story-trans/src/prompts/v1/ingest.normalize.ts)
  - [ingest.metadata-extract.ts](file:///Users/tri.le/Personal/story-trans/src/prompts/v1/ingest.metadata-extract.ts)
  - [ingest.content-classify.ts](file:///Users/tri.le/Personal/story-trans/src/prompts/v1/ingest.content-classify.ts)
  - [ingest.summary-for-embedding.ts](file:///Users/tri.le/Personal/story-trans/src/prompts/v1/ingest.summary-for-embedding.ts)

---

## 6) CLI Examples

```bash
# Ingest directories from config (optionally with Brave enrichment and LLM chunk cleanup)
bun run build
bun dist/index.js ingest --config story-trans.config.yaml --mode hybrid --verbose

# Ingest explicit sources (local files + URLs)
bun dist/index.js ingest --config story-trans.config.yaml \
  --source ./data/ch1.md https://example.com/page \
  --mode hybrid --chunk-size 1400 --chunk-overlap 200 --verbose

# Query retrieval (optionally rerank)
bun dist/index.js search --config story-trans.config.yaml -q "character backstory" -k 10 --rerank
```

---

## 7) Testing

- Unit tests:
  - RRF fusion: `tests/unit/hybrid-rrf.test.ts`
- Integration tests:
  - OpenRouter client error handling: `tests/integration/openrouter-client.test.ts`
  - Brave parsing via injected fetch: `tests/integration/brave-search.test.ts`
  - Jina rerank parsing via injected fetch: `tests/integration/jina-reranker.test.ts`
- CLI smoke test:
  - `tests/cli/help.test.ts`

