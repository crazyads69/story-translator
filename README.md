# story-trans

Type-safe, production-ready CLI for automated literary translation using advanced LLM pipelines.

## Features

- **3-Stage Translation Pipeline**:
  - **Stage 1 (Draft)**: Parallel generation using DeepSeek (Structure) and OpenRouter/MiMo (Reasoning/Creativity).
  - **Stage 2 (Synthesize)**: DeepSeek Reasoner consolidates drafts into a high-quality version.
  - **Stage 3 (Linkage Fix)**: DeepSeek Chat verifies consistency (xưng hô, tone) against previous paragraphs.
- **Next-Gen Ingest**:
  - 2-Stage Enrichment: DeepSeek (Structure) + MiMo (Reasoning) -> Merge.
  - Hybrid Retrieval: LanceDB (Vector) + OpenRouter Embeddings + Jina Reranking.
- **Smart Context**:
  - **Dynamic Glossary**: Automatically learns and propagates terms across the story.
  - **Ground Truth**: Brave Search with LLM-based summarization for cultural/entity research.
  - **Linkage**: Passes the last 3 translated paragraphs as context to ensure flow.
- **Production Reliability**:
  - **Incremental Checkpointing**: Saves progress after every paragraph.
  - **Resume Capability**: Resume interrupted jobs seamlessly.
  - **Graceful Shutdown**: Safe exit on Ctrl+C.
  - **Visual Progress**: Real-time progress bar.

## Installation

```bash
bun install
```

## Configuration

Copy and edit:

```bash
cp story-trans.config.example.yaml story-trans.config.yaml
```

## Usage

### Translate

```bash
bun run build
bun dist/index.js translate --config story-trans.config.yaml --input ./data/ch1.md --language Vietnamese
```

**Options:**

- `--resume`: Resume from the last checkpoint (`.checkpoint.json`).
- `--output <path>`: Custom output path.
- `--format <md|json|both>`: Output format (default: both).

### Ingest

```bash
bun run build
bun dist/index.js ingest --config story-trans.config.yaml --mode hybrid --verbose
```

### Search

```bash
bun dist/index.js search --config story-trans.config.yaml -q "character backstory" -k 10 --rerank
```

## Design Docs

- Next-gen ingest + hybrid retrieval: `docs/nextgen-ingest-pipeline.md`
