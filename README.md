# story-trans

**Production-ready CLI for automated literary translation** using advanced multi-stage LLM pipelines with RAG context, ground truth research, and consistency verification.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vector%20Store-green)](https://lancedb.com/)
[![LangGraph](https://img.shields.io/badge/LangGraph-Orchestration-purple)](https://github.com/langchain-ai/langgraph)

## 🌟 Features

### 3-Stage Translation Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                     STAGE 1: PARALLEL DRAFTS                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────┐     ┌───────────────────┐                │
│  │   DeepSeek Chat   │     │  OpenRouter/MiMo  │                │
│  │   (Structured)    │────▶│   (Creative +     │                │
│  │                   │     │    Reasoning)     │                │
│  └─────────┬─────────┘     └─────────┬─────────┘                │
│            │                         │                          │
│            ▼                         ▼                          │
├─────────────────────────────────────────────────────────────────┤
│                    STAGE 2: SYNTHESIS & MERGE                    │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────┐              │
│  │           DeepSeek Reasoner (R1)              │              │
│  │  • Compare both drafts for accuracy           │              │
│  │  • Resolve conflicts, merge best parts        │              │
│  │  • Document decisions with evidence           │              │
│  └─────────────────────┬─────────────────────────┘              │
│                        │                                        │
│                        ▼                                        │
├─────────────────────────────────────────────────────────────────┤
│                    STAGE 3: LINKAGE FIX                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────┐              │
│  │              DeepSeek Chat                    │              │
│  │  • Check consistency with previous paragraphs │              │
│  │  • Verify pronouns, tone, timeline            │              │
│  │  • Enhance flow and natural transitions       │              │
│  └───────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### 2-Stage Smart Ingest

```
┌─────────────────────────────────────────────────────────────────┐
│                    INGEST ENRICHMENT PIPELINE                    │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────┐     ┌───────────────────┐                │
│  │  DeepSeek Chat    │     │  OpenRouter/MiMo  │                │
│  │  (Extraction)     │────▶│  (Deep Analysis)  │                │
│  └─────────┬─────────┘     └─────────┬─────────┘                │
│            │                         │                          │
│            └────────────┬────────────┘                          │
│                         ▼                                       │
│  ┌───────────────────────────────────────────────┐              │
│  │           DeepSeek (Merge & Refine)           │              │
│  │  • Combine structured + reasoning insights    │              │
│  │  • Generate embedding-optimized summaries     │              │
│  │  • Extract entities, tags, keywords           │              │
│  └───────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### Hybrid Retrieval System

- **Vector Search**: OpenRouter Embeddings (text-embedding-3-small)
- **Full-Text Search**: LanceDB FTS with BM25 ranking
- **Fusion**: Reciprocal Rank Fusion (RRF) combining both result sets
- **Reranking**: Jina Reranker v2 (multilingual) for final relevance scoring

### Smart Context Enrichment

| Feature | Description |
|---------|-------------|
| **Dynamic Glossary** | Automatically learns and propagates terms across the story |
| **RAG Context** | LLM-generated queries find similar passages for style consistency |
| **Ground Truth** | Brave Search with summarization for cultural/entity research |
| **Linkage Verification** | Last 3 paragraphs context ensures narrative flow |

### Production Reliability

- ✅ **Incremental Checkpointing**: Saves progress after every paragraph
- ✅ **Resume Capability**: Continue interrupted jobs seamlessly
- ✅ **Graceful Shutdown**: Safe exit on Ctrl+C
- ✅ **Visual Progress**: Real-time progress bar
- ✅ **Structured Logging**: Configurable log levels
- ✅ **Rate Limiting**: Configurable concurrency per provider
- ✅ **Retry Logic**: Exponential backoff with jitter

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/crazyads69/story-translator.git
cd story-translator

# Install dependencies
bun install

# Build
bun run build
```

## ⚙️ Configuration

### 1. Copy the example config

```bash
cp story-trans.config.example.yaml story-trans.config.yaml
```

### 2. Edit with your API keys

```yaml
# story-trans.config.yaml

logLevel: info

providers:
  deepseek:
    apiKey: "sk-..." # Required
    model: deepseek-chat
    concurrency: 2
  openrouter:
    apiKey: "sk-or-..." # Required for 2-stage enrichment
    model: "xiaomi/mimo-v2-flash:free"
    concurrency: 2

embeddings:
  model: "text-embedding-3-small"

vectordb:
  path: "./lancedb"
  table: "story_chunks"

ingest:
  originalChaptersPath: "./data/original"
  translatedChaptersPath: "./data/translated"
  taskChaptersPath: "./data/task"
  metadataPath: "./data/metadata"
  chunk:
    chunkSize: 1200
    chunkOverlap: 150
    strategy: paragraph  # Recommended for stories
    normalize: true
  llm:
    enabled: true # Enable 2-stage enrichment
  enrichment:
    enabled: false # Enable Brave web research during ingest
    maxUrls: 5

braveSearch:
  enabled: true
  apiKey: "BSA..." # For ground truth research

reranker:
  enabled: true
  jinaApiKey: "jina_..." # For hybrid search reranking
  model: "jina-reranker-v2-base-multilingual"
```

### Environment Variables

Alternatively, use environment variables:

```bash
export DEEPSEEK_API_KEY="sk-..."
export OPENROUTER_API_KEY="sk-or-..."
export BRAVE_API_KEY="BSA..."
export JINA_API_KEY="jina_..."
```

## 🚀 Usage

### Translate a Chapter

```bash
# Basic translation
bun dist/index.js translate \
  --input ./data/task/chapter_1.md \
  --language Vietnamese

# With metadata file
bun dist/index.js translate \
  --input ./data/task/chapter_1.md \
  --metadata ./data/metadata/my-story.json \
  --language Vietnamese

# With resume support
bun dist/index.js translate \
  --input ./data/task/chapter_1.md \
  --language Vietnamese \
  --resume

# Custom output
bun dist/index.js translate \
  --input ./data/task/chapter_1.md \
  --output ./output/chapter_1 \
  --format both \
  --verbose
```

### Auto Mode (Batch Translation)

```bash
# Discover and translate all chapters in data/task/
bun dist/index.js auto --verbose
```

**Options:**

| Flag | Description |
|------|-------------|
| `-i, --input <path>` | Input markdown/text file (required) |
| `-m, --metadata <path>` | Story metadata JSON file |
| `-l, --language <name>` | Target language (default: Vietnamese) |
| `-o, --output <path>` | Output path prefix |
| `--format <md\|json\|both>` | Output format (default: both) |
| `--resume` | Resume from checkpoint |
| `--config <path>` | Path to config file |
| `--verbose` | Enable verbose logging |
| `--debug` | Enable debug logging with stack traces |

### Ingest Documents

```bash
# Ingest all documents from configured paths
bun dist/index.js ingest \
  --config story-trans.config.yaml \
  --verbose

# Ingest with LangGraph orchestration
bun dist/index.js ingest \
  --mode hybrid \
  --verbose
```

### Search the Vector Database

```bash
# Semantic search
bun dist/index.js search \
  --query "character backstory" \
  --top-k 10

# With reranking
bun dist/index.js search \
  --query "emotional scene between characters" \
  --top-k 10 \
  --rerank
```

## 📁 Project Structure

```
story-trans/
├── src/
│   ├── application/           # Core business logic
│   │   ├── ingest/            # Ingest pipeline
│   │   │   ├── ingest-graph.ts      # LangGraph orchestration
│   │   │   ├── ingest-usecase.ts    # Simple ingest flow
│   │   │   └── enrich-chunk.ts      # 2-stage enrichment
│   │   ├── pipeline/          # Translation orchestration
│   │   │   └── orchestrator.ts      # 3-stage pipeline
│   │   ├── search/            # Retrieval services
│   │   │   ├── hybrid-search.ts     # Vector + FTS + RRF + Jina
│   │   │   └── lancedb-hybrid-retriever.ts
│   │   └── translate/         # Translation stages
│   │       ├── stage1-generate.ts   # Parallel drafts
│   │       ├── stage2-synthesize.ts # Merge with reasoning
│   │       ├── query-gen.ts         # RAG & ground truth queries
│   │       └── ground-truth-summarizer.ts
│   ├── cli/                   # CLI commands
│   │   └── commands/
│   │       ├── translate.ts         # translate & auto commands
│   │       ├── ingest.ts
│   │       └── search.ts
│   ├── domain/                # Domain models
│   │   ├── ingest/            # Chunk, enrichment schemas
│   │   └── translate/         # Translation schemas
│   ├── infrastructure/        # External integrations
│   │   ├── llm/               # LLM clients
│   │   │   ├── providers/     # DeepSeek, OpenRouter
│   │   │   ├── rate-limit/    # Concurrency limiter
│   │   │   └── retry/         # Retry with backoff
│   │   ├── embeddings/        # OpenRouter embeddings
│   │   ├── vectordb/          # LanceDB store
│   │   ├── rerank/            # Jina reranker
│   │   ├── research/          # Brave search
│   │   └── config/            # YAML config loader
│   ├── prompts/               # Prompt templates
│   │   └── v2/                # Current prompt version
│   │       ├── shared.system.ts     # Base system prompts
│   │       ├── stage1.generate.ts   # Draft generation
│   │       ├── stage2.synthesize.ts # Merge prompts
│   │       ├── stage3.linkage.ts    # Consistency check
│   │       └── ingest.*.ts          # Ingest prompts
│   └── utils/
├── data/
│   ├── original/              # Original chapters for RAG
│   ├── translated/            # Reference translations for RAG
│   ├── task/                  # Chapters to translate
│   └── metadata/              # Story metadata JSON files
├── lancedb/                   # Vector database
├── docs/
│   ├── TUTORIAL.md            # Comprehensive guide
│   ├── QUICK-START.md         # 5-minute guide
│   └── CHUNKING-API.md        # Chunking API reference
├── examples/templates/        # Template files
└── tests/
```

## 🔧 Technical Details

### Hybrid Search Implementation

The hybrid search combines:

1. **Vector Search**: Semantic similarity using embeddings
2. **Full-Text Search**: BM25 keyword matching via LanceDB FTS
3. **RRF Fusion**: `score(d) = Σ 1/(k + rank_i(d))` where k=60 (default)
4. **Jina Reranking**: Neural reranking for final relevance

```typescript
// Example: Hybrid search with reranking
const results = await hybridSearch.search("character emotion", {
  vectorTopK: 10,
  ftsTopK: 10,
  rrfK: 60,
  rerankTopK: 5,
});
```

### Translation Pipeline Flow

1. **Stage 1 (Parallel)**:
   - DeepSeek Chat: Structured, literal translation
   - OpenRouter/MiMo: Creative, reasoning-focused translation
   
2. **Stage 2 (Synthesis)**:
   - DeepSeek Reasoner compares and merges both drafts
   - Documents decisions with evidence sources

3. **Stage 3 (Linkage)**:
   - Verifies consistency with previous 3 paragraphs
   - Fixes pronoun inconsistencies, timeline errors
   - Enhances natural flow with Vietnamese connectors

### LanceDB Schema

```typescript
interface ChunkDocument {
  id: string;
  text: string;
  normalizedText: string;
  summaryForEmbedding: string;
  vector: number[];
  metadata: {
    sourceType: "file" | "url" | "web_research";
    sourceUri: string;
    contentType: "markdown" | "pdf" | "text" | "html";
    language: string;
    title?: string;
    chunkIndex: number;
    createdAtMs: number;
  };
}
```

## 🧪 Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/unit/hybrid-rrf.test.ts

# Run with coverage
bun test --coverage
```

## 📄 License

MIT

## 🙏 Acknowledgments

- [DeepSeek](https://deepseek.com/) - LLM provider
- [OpenRouter](https://openrouter.ai/) - Multi-model gateway
- [LanceDB](https://lancedb.com/) - Vector database
- [Jina AI](https://jina.ai/) - Reranking
- [Brave Search](https://brave.com/search/) - Web research
- [LangGraph](https://github.com/langchain-ai/langgraph) - Orchestration
