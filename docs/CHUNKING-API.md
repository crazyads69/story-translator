# Chunking & Context Window API

This document explains the paragraph-based chunking system with context windows.

## Overview

The chunking system splits documents into semantic units (paragraphs) while including surrounding context for better embeddings. This approach is inspired by the original `buildContextWindow` pattern and is optimized for narrative content.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    PARAGRAPH CHUNKING                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Document Text                                                  │
│  ┌─────────────────────────────────────────────────────────────┐
│  │ Paragraph 1: "The sun set over the mountains..."           │
│  │                                                             │
│  │ Paragraph 2: "Elena stood at the edge of the cliff..."     │
│  │                                                             │
│  │ Paragraph 3: "She knew the journey would be dangerous..."  │
│  └─────────────────────────────────────────────────────────────┘
│                                                                 │
│  For Paragraph 2, the context window is:                       │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐
│  │ [Previous Context: up to 500 chars from Paragraph 1]       │
│  │                                                             │
│  │ [MAIN: Paragraph 2 text]                                   │
│  │                                                             │
│  │ [Next Context: up to 300 chars from Paragraph 3]           │
│  └─────────────────────────────────────────────────────────────┘
│                                                                 │
│  Stored:                                                       │
│  • text: "Elena stood at the edge..."  (main paragraph only)   │
│  • textWithContext: [prev + main + next]  (for embedding)     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## API Reference

### ChunkingConfig

```typescript
type ChunkingConfig = {
  chunkSize: number;      // Max chars per chunk (for recursive strategy)
  chunkOverlap: number;   // Overlap between chunks (for recursive strategy)
  strategy: "markdown" | "recursive" | "paragraph";
};
```

### ContextWindowConfig

```typescript
type ContextWindowConfig = {
  /** Number of characters to include from previous paragraphs */
  prevContextChars: number;  // Default: 500
  
  /** Number of characters to include from next paragraphs */
  nextContextChars: number;  // Default: 300
  
  /** Whether to include context in the chunk text (for embedding) */
  includeContext: boolean;   // Default: true
};

const DEFAULT_CONTEXT_CONFIG: ContextWindowConfig = {
  prevContextChars: 500,
  nextContextChars: 300,
  includeContext: true,
};
```

### Chunk Type

```typescript
type Chunk = {
  /** The main paragraph text (for display/retrieval) */
  text: string;
  
  /** Section path from markdown headings */
  sectionPath: string[];
  
  /** Index of this paragraph in the document */
  paragraphIndex?: number;
  
  /** Total number of paragraphs in the document */
  totalParagraphs?: number;
  
  /** Text with context window for embedding (includes prev/next context) */
  textWithContext?: string;
  
  /** Whether this chunk has previous context */
  hasPrevContext?: boolean;
  
  /** Whether this chunk has next context */
  hasNextContext?: boolean;
};
```

### Functions

#### chunkText

```typescript
function chunkText(
  input: string,
  config: ChunkingConfig,
  contextConfig?: ContextWindowConfig
): Chunk[]
```

Main entry point for chunking text.

**Parameters:**
- `input`: The text to chunk
- `config`: Chunking configuration (strategy, size, overlap)
- `contextConfig`: Optional context window configuration (for paragraph strategy)

**Returns:** Array of Chunk objects

**Example:**

```typescript
import { chunkText, DEFAULT_CONTEXT_CONFIG } from "./infrastructure/splitting/chunking";

const text = `
First paragraph about the beginning.

Second paragraph with action.

Third paragraph concluding.
`;

const chunks = chunkText(
  text,
  { chunkSize: 1000, chunkOverlap: 100, strategy: "paragraph" },
  DEFAULT_CONTEXT_CONFIG
);

// chunks[1] contains:
// {
//   text: "Second paragraph with action.",
//   textWithContext: "First paragraph...\n\nSecond paragraph with action.\n\nThird paragraph...",
//   paragraphIndex: 1,
//   totalParagraphs: 3,
//   hasPrevContext: true,
//   hasNextContext: true
// }
```

## Chunking Strategies

### 1. Paragraph Strategy (Recommended for Stories)

```typescript
{ strategy: "paragraph" }
```

- Splits on blank lines (`\n\n`)
- Preserves complete paragraphs
- Includes context window for embeddings
- Best for narrative content

**Example:**

```typescript
const chunks = chunkText(storyText, { strategy: "paragraph" });

// Each chunk includes:
// - text: just the paragraph (for display)
// - textWithContext: paragraph + surrounding context (for embedding)
```

### 2. Markdown Strategy

```typescript
{ strategy: "markdown", chunkSize: 1200, chunkOverlap: 150 }
```

- Splits on headings first
- Then recursively splits oversized sections
- Preserves section hierarchy
- Best for documentation

**Example:**

```typescript
const chunks = chunkText(docText, {
  strategy: "markdown",
  chunkSize: 1200,
  chunkOverlap: 150
});

// Chunks include sectionPath:
// { text: "...", sectionPath: ["Chapter 1", "Section 1.1"] }
```

### 3. Recursive Strategy

```typescript
{ strategy: "recursive", chunkSize: 1000, chunkOverlap: 200 }
```

- Splits on separators: `\n\n` → `\n` → `. ` → ` ` → ``
- Respects size limits with overlap
- Generic fallback for any text

## Context Window Details

### How It Works

For paragraph at index `i`:

1. **Previous Context**: Gather text from paragraphs `i-1`, `i-2`, ... until reaching `prevContextChars` limit
2. **Current**: Include full paragraph text
3. **Next Context**: Gather text from paragraphs `i+1`, `i+2`, ... until reaching `nextContextChars` limit

### Truncation Behavior

When a paragraph exceeds the remaining character budget:

- **Previous**: Truncates from the beginning, adds "..."
- **Next**: Truncates from the end, adds "..."

### Why Context Windows?

1. **Better Embeddings**: Semantic meaning often depends on surrounding context
2. **Narrative Flow**: "She" makes more sense when you know who "she" refers to
3. **Search Quality**: Queries like "when Elena entered the tower" match paragraphs that mention entering even if "Elena" is in the previous paragraph

## Usage in Ingest Pipeline

The ingest pipeline automatically uses context windows:

```typescript
// In ingest-graph.ts / ingest-usecase.ts

// 1. Chunk with context
const chunks = chunkText(doc.pageContent, config.ingest.chunk);

// 2. Use textWithContext for embeddings
const summaryForEmbedding = chunk.textWithContext ?? chunk.text;

// 3. Store metadata
metadata: {
  hasPrevContext: chunk.hasPrevContext,
  hasNextContext: chunk.hasNextContext,
  // ...
}
```

## Configuration in story-trans.config.yaml

```yaml
ingest:
  chunk:
    strategy: paragraph  # Use paragraph strategy
    chunkSize: 1200      # Ignored for paragraph
    chunkOverlap: 150    # Ignored for paragraph
    normalize: true      # Normalize text before chunking

# Context window settings (future: expose in config)
# contextWindow:
#   prevContextChars: 500
#   nextContextChars: 300
#   includeContext: true
```

## Comparison with Old Code

### Old Code (old_code.md)

```typescript
// MarkdownParser.buildContextWindow()
buildContextWindow(paragraphs, index, prevChars, nextChars) {
  // Includes previous paragraphs + current + next paragraphs for embedding
}
```

### New Code

```typescript
// chunking.ts
function buildContextWindow(
  paragraphs: string[],
  index: number,
  prevChars: number,
  nextChars: number
): { contextWindow: string; hasPrev: boolean; hasNext: boolean }
```

**Improvements:**
- Type-safe implementation
- Configurable via ContextWindowConfig
- Metadata tracking (hasPrevContext, hasNextContext)
- Integrated into Chunk type

## Best Practices

### 1. Use Paragraph Strategy for Stories

```yaml
ingest:
  chunk:
    strategy: paragraph
```

### 2. Adjust Context Size for Your Content

- **Short paragraphs**: Increase context (700/500)
- **Long paragraphs**: Decrease context (300/200)
- **Dialogue-heavy**: More context helps track speakers

### 3. Monitor Chunk Metadata

```typescript
// In your code, check context availability
if (chunk.hasPrevContext && chunk.hasNextContext) {
  // Full context available - high quality embedding
}
```

### 4. Normalize Before Chunking

```yaml
ingest:
  chunk:
    normalize: true  # Removes extra whitespace, etc.
```
