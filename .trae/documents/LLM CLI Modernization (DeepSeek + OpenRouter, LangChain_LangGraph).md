# Technical Design Doc (Pre-Implementation)

## Current State (What We’re Replacing)
- `src/ingest` and `src/translate` contain a working but tightly-coupled pipeline with distributed env-config, minimal CLI parsing, no tests, and a hard dependency on Gemini in `LinkableVerify` ([linkable-verify](file:///Users/tri.le/Personal/story-trans/src/translate/linkable-verify/index.ts#L8-L150)).
- Gemini is pulled in via `@google/generative-ai` ([package.json](file:///Users/tri.le/Personal/story-trans/package.json#L16-L23)) and must be removed completely.

## Tooling Research (Official Capabilities & Constraints)

### DeepSeek API
- **API shape**: OpenAI-compatible Chat Completions (OpenAI SDK works by setting `base_url=https://api.deepseek.com`) [1].
- **Models**: `deepseek-chat` (non-thinking) and `deepseek-reasoner` (thinking) [1].
- **Structured output**: Supports `response_format: { type: "json_object" }`, but you *must still instruct the model to output JSON* or it can stream whitespace until token limit [2].
- **Streaming**: SSE supported with `stream: true` [2].
- **Rate limiting behavior**: Docs state no explicit user rate limit, but under load requests may wait; server may emit empty lines / `: keep-alive` comments; server closes connection if inference hasn’t started after 10 minutes [3].
- **Error codes**: Standard HTTP errors including 402 (insufficient balance) and 429 (rate limit reached) [4].

### OpenRouter
- **API shape**: OpenAI-chat-compatible “normalized schema across models and providers” [5].
- **Routing/fallback**: Supports routing options (e.g., provider preferences, fallback routing) in request schema [5].
- **Structured output**: Supports `response_format?: { type: 'json_object' }` in request schema (model support varies) [5].
- **Rate limits**: Documented per-key and per-model behavior; free models (`:free`) have specific request/min and daily caps; key info endpoint `GET /api/v1/key` returns usage/credits metadata [6].
- **Error handling**: Errors can appear either as HTTP status codes or embedded in a 200 body / SSE event if failure occurs mid-generation; requires careful parsing for reliability [7].

### LangChain (JS/TS)
- **Strengths**: Prompt templating, composable “pipes/chains”, streaming, and multiple structured-output strategies (Zod + output parsers / function-calling style bindings) (Context7 sources from LangChainJS repo and docs).
- **Fit for this project**: Ideal for reusable prompt builders + schema-bound output parsing + model abstraction adapters.
- **Limitations**: Not inherently “durable execution” (resuming partial runs) without extra orchestration; complex multi-step workflows can become harder to trace than explicit graphs.

### LangGraph (JS/TS)
- **Strengths**: Typed state graphs, fan-out/fan-in parallelism, reducers for deterministic merges, explicit edges, and structured orchestration (examples show parallel nodes and deterministic aggregation patterns) (Context7 sources from LangGraphJS docs).
- **Fit for this project**: A two-stage parallel-then-synthesis pipeline maps naturally to a graph. It provides a clean place to implement retries, fallbacks, state capture, and deterministic merges.
- **Limitations**: Added conceptual overhead; if the workflow remains simple (2 stages only), a plain `Promise.all` orchestrator can be sufficient.

### Modern Prompt / Context / Grounding Best Practices (Applied)
- **Structured prompting**: Use `system` for non-negotiable constraints; `developer` for product rules; `user` for task-specific content.
- **Token-aware construction**: Build prompts as segments with budgets (instructions, schema, grounding, history); prune/compact per segment.
- **Grounding injection**: Provide source text + optional retrieved references and metadata; label each snippet with provenance.
- **Relevance filtering**: Retrieval produces many candidates; use lightweight heuristics + optional LLM “rerank” step; include only top-k, deduplicated.
- **Structured output**: Always enforce Zod schema; use provider `response_format` where supported and also explicitly instruct JSON (per DeepSeek warning) [2].
- **Prompt versioning**: Prompts are immutable artifacts with a version id; pipeline outputs include prompt ids for reproducibility.

## DeepSeek vs OpenRouter Comparison (Production-Relevant)

### Authentication
- **DeepSeek**: `Authorization: Bearer ${DEEPSEEK_API_KEY}` [1].
- **OpenRouter**: `Authorization: Bearer ${OPENROUTER_API_KEY}` (documented across OpenRouter API examples) [5].

### Rate Limits / Backpressure
- **DeepSeek**: No explicit per-user limit stated; backpressure manifests as delayed scheduling and keep-alives; can still return 429 and other HTTP errors [3][4].
- **OpenRouter**: Explicit published rate-limit policy for free tiers and model-dependent constraints; also provides key usage introspection endpoint [6]. Mid-stream errors may be delivered in-body with HTTP 200, so you must parse response payload carefully [7].

### Pricing / Credits (Non-Numeric, Doc-Driven)
- **DeepSeek**: Balance-based usage; 402 indicates insufficient balance [4].
- **OpenRouter**: Credits-based; key endpoint exposes usage counters and remaining limits [6].
- Implementation principle: treat both as “metered providers”; build robust budgeting/caching and surface cost/usage (where available) in verbose/debug output.

### Response Formats / Structured Output
- **DeepSeek**: OpenAI-compatible response objects; supports `response_format.json_object` but warns you must explicitly instruct JSON generation or risk whitespace streaming [2].
- **OpenRouter**: OpenAI-like normalized schema; supports `response_format` with model-specific availability [5]. Errors may be in-band (HTTP 200 + error body / SSE event) [7].

## LangChain vs LangGraph Justification
- **Use LangChain for**: prompt templates, schema-bound output parsing/validation (Zod), provider model adapters, streaming, and reusable “call + parse + validate” building blocks.
- **Use LangGraph when** (architecturally justified):
  - parallel execution with explicit fan-out/fan-in,
  - deterministic merging via reducers,
  - workflow-level retries/fallback and state tracking,
  - future expansion to multi-step workflows (e.g., additional verifiers, HITL review, resumable checkpoints).
- **Decision for this refactor**: Use **LangChain for all LLM calls + parsing**, and use **LangGraph as the orchestration layer** for Stage 1 parallelism + Stage 2 synthesis (kept behind an `Orchestrator` interface so we can swap to a simpler implementation later).

---

# Target Architecture

## High-Level Flow (Two-Stage LLM Pipeline)

```text
                 ┌────────────────────────────────────┐
                 │                CLI                 │
                 │ config + args + logging + exitcode │
                 └────────────────────────────────────┘
                                  │
                                  ▼
                 ┌────────────────────────────────────┐
                 │      Input Normalization Layer     │
                 │ chapters/paras + metadata + RAG ctx │
                 └────────────────────────────────────┘
                                  │
                                  ▼
          ┌─────────────────────────────────────────────────┐
          │                 STAGE 1 (Parallel)              │
          │  ┌──────────────────┐   ┌───────────────────┐  │
          │  │ DeepSeek Generate │   │ OpenRouter Generate│  │
          │  │ (same input)      │   │ (same input)       │  │
          │  └─────────┬────────┘   └─────────┬──────────┘  │
          │            ▼                      ▼             │
          │     Normalize to shared schema (Zod validated)  │
          └──────────────────────────┬──────────────────────┘
                                     │
                                     ▼
                 ┌────────────────────────────────────┐
                 │           STAGE 2 (Synthesis)       │
                 │ DeepSeek resolves conflicts, merges │
                 │ context, emits final structured JSON│
                 └────────────────────────────────────┘
                                     │
                                     ▼
                 ┌────────────────────────────────────┐
                 │ Output writers (md/json), caching   │
                 │ metrics, traces, deterministic logs │
                 └────────────────────────────────────┘
```

## Determinism & Reproducibility
- Default inference parameters: `temperature: 0`, `presence_penalty: 0`, `frequency_penalty: 0`; use `seed` where available (OpenRouter supports `seed` in schema [5]).
- Stable merges: always sort providers by a fixed key before synthesis input; include prompt version ids and provider model ids in output metadata.

## Extensibility (Model Swapping)
- Provider-agnostic interface: `LLMProvider` (invoke/stream, supportsJsonMode, modelId).
- Prompt registry: `PromptId` + templates stored as immutable artifacts.
- Orchestrator interface: `PipelineOrchestrator` (LangGraph-backed by default).

---

# Refactored Folder Structure (Proposed)

```text
src/
  cli/
    commands/
      ingest.ts
      translate.ts
      pipeline.ts
    index.ts
    exit-codes.ts
  domain/
    ingest/
      paragraph.ts
      document.ts
    translate/
      schemas.ts
      translation.ts
    common/
      result.ts
      errors.ts
  application/
    ingest/
      ingest-usecase.ts
    translate/
      translate-usecase.ts
      stage1-generate.ts
      stage2-synthesize.ts
    pipeline/
      orchestrator.ts
      telemetry.ts
  infrastructure/
    llm/
      providers/
        deepseek.ts
        openrouter.ts
      langchain/
        chat-models.ts
        structured.ts
      rate-limit/
        limiter.ts
      retry/
        backoff.ts
      cache/
        cache.ts
    vectordb/
      lancedb.ts
    retrieval/
      embed.ts
      rerank.ts
    config/
      config.ts
      schema.ts
      load.ts
  prompts/
    v1/
      stage1.generate.ts
      stage2.synthesize.ts
      shared.system.ts
  tests/
    unit/
    integration/
```

---

# Key TypeScript Design (Examples)

## Shared Normalized Output Schema (Stage 1)
```ts
import { z } from "zod";

export const Stage1DraftSchema = z.object({
  provider: z.enum(["deepseek", "openrouter"]),
  model: z.string(),
  language: z.string(),
  translation: z.string(),
  glossary: z.array(z.object({ source: z.string(), target: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
  evidence: z.array(z.object({
    kind: z.enum(["source", "rag", "ground_truth"]),
    id: z.string(),
    snippet: z.string(),
  })).default([]),
});
export type Stage1Draft = z.infer<typeof Stage1DraftSchema>;
```

## Final Output Schema (Stage 2)
```ts
import { z } from "zod";

export const FinalTranslationSchema = z.object({
  language: z.string(),
  translation: z.string(),
  decisions: z.array(z.object({
    issue: z.string(),
    resolution: z.string(),
    chosen_from: z.enum(["deepseek", "openrouter", "merged"]),
  })).default([]),
  glossary: z.array(z.object({ source: z.string(), target: z.string() })).default([]),
  metadata: z.object({
    promptVersion: z.string(),
    providers: z.array(z.object({ provider: z.string(), model: z.string() })),
  }),
});
export type FinalTranslation = z.infer<typeof FinalTranslationSchema>;
```

## Orchestration Skeleton (LangGraph)
```ts
// Pseudocode-level structure (implementation will use @langchain/langgraph state annotations)
// START -> (deepseekStage1 || openrouterStage1) -> synthesizeDeepseek -> END
```

---

# Prompt Templates (Versioned)

## System Prompt (Shared)
```text
SYSTEM (v1)
You are a professional literary translator.
You must follow the output schema exactly.
If JSON is required, output ONLY valid JSON with no markdown fences.
```

## Stage 1 Prompt (Generator)
```text
DEVELOPER (v1)
Task: produce a draft translation and glossary suggestions.
Constraints: deterministic tone, preserve named entities, keep paragraph boundaries.
Output: JSON matching Stage1DraftSchema.

USER (v1)
{metadata}

SOURCE_PARAGRAPH:
{source}

GROUNDING:
{rag_snippets}
{ground_truth_snippets}
```

## Stage 2 Prompt (Synthesis)
```text
DEVELOPER (v1)
You will receive two draft translations (DeepSeek + OpenRouter).
Resolve conflicts, merge the best parts, and emit FINAL JSON matching FinalTranslationSchema.
Explain key decisions in `decisions`.

USER (v1)
SOURCE:
{source}

DRAFTS:
- deepseek: {draft_deepseek_json}
- openrouter: {draft_openrouter_json}
```

---

# Config & CLI Contract

## Config Schema (Zod)
- Support env + file config (YAML/JSON). CLI `--config` overrides env.
- Provider sections: keys, default models, timeouts, retry policy, rate limit.

Example (shape):
```ts
import { z } from "zod";

export const AppConfigSchema = z.object({
  logLevel: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  providers: z.object({
    deepseek: z.object({
      apiKey: z.string().min(1),
      baseUrl: z.string().default("https://api.deepseek.com"),
      model: z.string().default("deepseek-chat"),
      timeoutMs: z.number().int().positive().default(120_000),
      maxRetries: z.number().int().min(0).default(3),
    }),
    openrouter: z.object({
      apiKey: z.string().min(1),
      baseUrl: z.string().default("https://openrouter.ai/api/v1"),
      model: z.string().min(1),
      timeoutMs: z.number().int().positive().default(120_000),
      maxRetries: z.number().int().min(0).default(3),
    }),
  }),
});
```

## CLI UX Requirements
- Commands: `ingest`, `translate`, `pipeline` (run both).
- Flags: `--help`, `--config`, `--verbose`, `--debug`.
- Argument validation via Zod; UNIX exit codes via a single mapping module.

---

# Reliability Plan
- Centralized error types: `ConfigError`, `ProviderError`, `ValidationError`, `IOError`.
- Retry: exponential backoff + jitter for transient errors (429/5xx/timeouts).
- Provider degradation: if OpenRouter Stage 1 fails, Stage 2 synthesizes using remaining draft; output includes `metadata.providers` with missing provider flagged.
- Streaming: support when provider returns SSE; ensure we ignore keep-alives (DeepSeek mentions keep-alives) [3] and handle in-band mid-stream errors (OpenRouter) [7].

---

# Performance & Scalability Plan
- Concurrency control per provider (separate pools).
- Payload minimization: include only top-k grounded snippets; prune context by budget.
- Caching:
  - embeddings cache (hash of input text + model)
  - stage1/stage2 output cache keyed by (promptVersion + providerModel + input hash)

---

# Testing Strategy
- Unit tests:
  - prompt builders (snapshot tests)
  - token-budget trimming
  - config loading + precedence (env vs file vs CLI)
  - structured-output parsing/validation and repair logic
- Integration tests:
  - mocked DeepSeek/OpenRouter HTTP (including streaming and in-band error patterns)
  - pipeline stage1 parallel + stage2 synthesis happy path and degraded path
- CLI tests:
  - spawn CLI, validate exit codes and stderr messages

---

# Implementation Plan (Next Step After Approval)

## Phase 0 — Safety & Baseline
- Identify and remove Gemini usage and dependency graph.
- Establish a test runner and CI-friendly scripts.

## Phase 1 — New Architecture Skeleton
- Introduce `domain/application/infrastructure/cli` boundaries.
- Implement centralized config loading + Zod validation.

## Phase 2 — Provider Clients + Structured Output
- Implement DeepSeek + OpenRouter clients with consistent retry/backoff.
- Add LangChain-based structured output utilities (Zod-bound).

## Phase 3 — Two-Stage Pipeline
- Implement Stage 1 parallel generation and schema normalization.
- Implement Stage 2 DeepSeek synthesis.
- Add deterministic merge + metadata.

## Phase 4 — CLI Polish + Docs
- Replace ad-hoc arg parsing with a proper CLI framework.
- Add `--verbose/--debug` logging, help text, examples.
- Write README: install/config/usage/architecture/prompting/FAQ.

## Phase 5 — Tests & Hardening
- Add unit + integration + CLI tests with mocked providers.
- Validate streaming, retries, rate limiting, caching.

---

## Citations
[1] https://api-docs.deepseek.com/ 
[2] https://api-docs.deepseek.com/api/create-chat-completion 
[3] https://api-docs.deepseek.com/quick_start/rate_limit 
[4] https://api-docs.deepseek.com/quick_start/error_codes 
[5] https://openrouter.ai/docs/api/reference/overview 
[6] https://openrouter.ai/docs/api/reference/limits 
[7] https://openrouter.ai/docs/api/reference/errors-and-debugging 
