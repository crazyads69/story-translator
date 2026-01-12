# story-trans

Story Translation with Vector Search and AI Reranking.

## Features

- **Vector Database**: LanceDB for fast similarity search
- **Hybrid Search**: Combines vector similarity + full-text search
- **Neural Reranking**: Jina AI Reranker for improved search relevance
- **Multilingual Support**: Works with 100+ languages via Jina's multilingual models

## Installation

```bash
bun install
```

## Environment Variables

```bash
# Required for embeddings
OPENROUTER_API_KEY=your_openrouter_api_key

# Required for reranking (optional but recommended)
JINA_API_KEY=your_jina_api_key

# Optional: customize paths
LANCEDB_PATH=./lancedb
LANCEDB_TABLE_NAME=story_chapters
ORIGINAL_CHAPTERS_PATH=./data/original
TRANSLATED_CHAPTERS_PATH=./data/translated
```

Get your API keys:
- OpenRouter: https://openrouter.ai/keys
- Jina AI: https://jina.ai/reranker/

## Usage

### Run Ingestion

```bash
bun run index.ts
```

### Example: Search with Reranking

```typescript
import { createLanceDBService } from "./src/ingest/vectordb";
import { createOpenRouterEmbeddings } from "./src/ingest/embedding";

// Initialize with reranker
const lancedb = createLanceDBService({ initReranker: true });
await lancedb.connect();

// Create embeddings
const embeddings = createOpenRouterEmbeddings();
const queryVector = await embeddings.embedText("Your search query");

// Hybrid search with Jina reranking
const results = await lancedb.hybridSearchWithRerank(
  "Your search query",
  queryVector,
  10  // limit
);

// Results are reranked by Jina AI for better relevance
console.log(results);
```

### Jina Reranker Models

| Model | Description |
|-------|-------------|
| `jina-reranker-v2-base-multilingual` | Best for multilingual (100+ languages) - Default |
| `jina-reranker-v1-base-en` | English only, legacy |
| `jina-reranker-v1-turbo-en` | Fast English reranking |
| `jina-reranker-v1-tiny-en` | Smallest, fastest English model |
| `jina-reranker-v3` | Latest model with improved performance |

### Search Methods

```typescript
// Standard hybrid search (vector + FTS)
await lancedb.hybridSearch(queryText, queryVector, { limit: 10 });

// Hybrid search with reranking enabled
await lancedb.hybridSearch(queryText, queryVector, { 
  limit: 10, 
  rerank: true,
  rerankCandidates: 30 // fetch more candidates for reranking
});

// Convenience method with auto-reranking
await lancedb.hybridSearchWithRerank(queryText, queryVector, 10);

// Standalone reranking for custom documents
await lancedb.rerankDocuments("query", ["doc1", "doc2", "doc3"], 2);
```

## Run Example

```bash
bun run src/ingest/example-reranker.ts
```

## Project Structure

```
src/ingest/
├── index.ts           # Main ingestion script
├── interface.ts       # Type definitions
├── embedding/         # OpenRouter embeddings
├── markdown-parser/   # Chapter parsing
├── vectordb/          # LanceDB + reranker integration
└── reranker/          # Jina AI Reranker service
```

This project was created using `bun init` in bun v1.3.5. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
