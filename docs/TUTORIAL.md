# Story-Trans Tutorial

A comprehensive guide to using story-trans for automated literary translation.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Understanding the Architecture](#understanding-the-architecture)
3. [Preparing Your Content](#preparing-your-content)
4. [Configuration Guide](#configuration-guide)
5. [Translation Pipeline Deep Dive](#translation-pipeline-deep-dive)
6. [Ingest Pipeline & RAG](#ingest-pipeline--rag)
7. [Hybrid Search Explained](#hybrid-search-explained)
8. [Best Practices](#best-practices)
9. [Troubleshooting](#troubleshooting)

---

## Quick Start

### 1. Install Dependencies

```bash
bun install
bun run build
```

### 2. Set Up API Keys

Create a `.env` file or export environment variables:

```bash
export DEEPSEEK_API_KEY="sk-..."
export OPENROUTER_API_KEY="sk-or-..."
export BRAVE_API_KEY="BSA..."
export JINA_API_KEY="jina_..."
```

### 3. Create Configuration

```bash
cp story-trans.config.example.yaml story-trans.config.yaml
# Edit with your settings
```

### 4. Prepare Your Chapter

Place your source chapter in `data/original/`:

```bash
mkdir -p data/original
cp your-chapter.md data/original/chapter_1.md
```

### 5. Translate

```bash
bun dist/index.js translate \
  --input ./data/original/chapter_1.md \
  --language Vietnamese
```

---

## Understanding the Architecture

### 3-Stage Translation Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                     STAGE 1: PARALLEL DRAFTS                     │
│  • DeepSeek Chat: Structured, literal translation               │
│  • OpenRouter/MiMo: Creative, reasoning-focused translation     │
├─────────────────────────────────────────────────────────────────┤
│                    STAGE 2: SYNTHESIS & MERGE                    │
│  • DeepSeek Reasoner (R1): Compare, resolve conflicts, merge    │
│  • Documents decisions with evidence sources                    │
├─────────────────────────────────────────────────────────────────┤
│                    STAGE 3: LINKAGE FIX                          │
│  • DeepSeek Chat: Verify consistency with previous paragraphs   │
│  • Fix pronouns, tone, timeline, enhance flow                   │
└─────────────────────────────────────────────────────────────────┘
```

### Why Two Parallel Branches?

Different LLMs have different strengths:

| Provider | Strength | Best For |
|----------|----------|----------|
| **DeepSeek Chat** | Structured, follows instructions precisely | Literal accuracy, glossary adherence |
| **OpenRouter/MiMo** | Extended reasoning, creative expression | Natural flow, cultural adaptation |

By running both in parallel and then merging with DeepSeek Reasoner, we get the best of both worlds.

### 2-Stage Ingest Enrichment

```
┌─────────────────────────────────────────────────────────────────┐
│  Stage 1 (Parallel):                                            │
│  • DeepSeek: Structured extraction (entities, metadata)         │
│  • MiMo: Deep reasoning analysis (themes, context)              │
├─────────────────────────────────────────────────────────────────┤
│  Stage 2 (Merge):                                               │
│  • DeepSeek: Combine insights, generate embedding-optimized     │
│    summaries with both structured and reasoning context         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Preparing Your Content

### Chapter Format

Chapters should be Markdown files with YAML frontmatter:

```markdown
---
id: chapter-001
title: "Chapter 1: The Beginning"
author: "Your Name"
story_id: "my-story"
chapter_number: 1
language: "English"
---

# Chapter 1: The Beginning

First paragraph of your story...

Second paragraph continues the narrative...

"Dialogue should be on its own line," the character said.
```

### Metadata File (Optional but Recommended)

Create a JSON file with story metadata:

```json
{
  "id": "my-story",
  "title": "My Epic Story",
  "author": "Author Name",
  "category": "Fantasy",
  "originalLanguage": "English",
  "targetLanguage": "Vietnamese",
  "glossary": [
    {
      "source": "The Dark Tower",
      "target": "Tháp Đen",
      "type": "location"
    }
  ],
  "characters": [
    {
      "name": "Elena",
      "role": "protagonist",
      "gender": "female",
      "pronouns": {
        "firstPerson": "tôi",
        "secondPerson": "cậu"
      }
    }
  ]
}
```

### Directory Structure

The project uses a specific directory structure for managing content:

```
your-project/
├── story-trans.config.yaml
├── data/
│   ├── original/           # Original chapters for RAG knowledge base
│   │   ├── chapter_1.md
│   │   ├── chapter_2.md
│   │   └── ...
│   ├── translated/         # Manually translated chapters for RAG style reference
│   │   ├── chapter_1.md    # (if you have reference translations)
│   │   └── ...
│   ├── task/               # Chapters waiting to be translated
│   │   ├── chapter_3.md
│   │   └── ...
│   └── metadata/           # Story metadata JSON files
│       └── my-story.json
└── lancedb/
    └── (vector database, auto-created)
```

**Directory Purposes:**
- `data/original/` - Original language chapters to ingest into RAG for context retrieval
- `data/translated/` - User's manual translations to ingest for style reference (optional)
- `data/task/` - Chapters you want to translate (use `auto` command to process all)
- `data/metadata/` - Story metadata JSON files (one per story, e.g., `my-story.json`)

---

## Configuration Guide

### Minimal Configuration

```yaml
logLevel: info

providers:
  deepseek:
    apiKey: ${DEEPSEEK_API_KEY}
    model: deepseek-chat

embeddings:
  model: text-embedding-3-small

vectordb:
  path: ./lancedb
  table: story_chunks

ingest:
  originalChaptersPath: ./data/original
  translatedChaptersPath: ./data/translated
  taskChaptersPath: ./data/task
  metadataPath: ./data/metadata
  chunk:
    strategy: paragraph
```

### Full Configuration

See [examples/templates/config-template.yaml](examples/templates/config-template.yaml) for all options.

### Key Configuration Options

#### Chunking Strategy

```yaml
ingest:
  chunk:
    strategy: paragraph  # Recommended for stories
```

| Strategy | Description | Best For |
|----------|-------------|----------|
| `paragraph` | Split by blank lines, includes prev/next context for embeddings | Stories, novels |
| `markdown` | Split by headings, then recursively | Documentation, articles |
| `recursive` | Split by size with separators | Generic text |

The `paragraph` strategy includes a **context window** (like the old code):
- **Previous context**: 500 characters from preceding paragraphs
- **Next context**: 300 characters from following paragraphs
- This gives embeddings better semantic understanding of narrative flow

#### Model Selection

```yaml
providers:
  deepseek:
    model: deepseek-chat  # Fast, accurate
    # model: deepseek-reasoner  # For complex reasoning (Stage 2)

  openrouter:
    model: xiaomi/mimo-v2-flash:free  # Free with reasoning
    # model: google/gemini-flash-1.5-8b:free
    # model: deepseek/deepseek-r1-0528:free
```

---

## Translation Pipeline Deep Dive

### Stage 1: Draft Generation

Both providers receive:
- **Source paragraph**: The text to translate
- **Story metadata**: Title, author, characters, etc.
- **RAG context**: Similar paragraphs from the vector database
- **Ground truth**: Web research results for unfamiliar terms
- **Glossary**: Existing term translations to maintain consistency

Example prompt structure:

```
TRANSLATION REQUEST

Target Language: Vietnamese

STORY CONTEXT
Title: My Epic Story
Author: Alice Smith

SOURCE PARAGRAPH
"The ancient tower loomed before them, its shadow stretching across..."

RAG CONTEXT (Similar passages from this story)
[r1] "The Dark Tower had stood for millennia..."
[r2] "Elena approached the structure with caution..."

GROUND TRUTH (Research results)
[g1] Vietnamese translation of "loom" typically uses "sừng sững"...

EXISTING GLOSSARY
- The Dark Tower: Tháp Đen
- Elena: Elena
```

### Stage 2: Merge & Synthesis

DeepSeek Reasoner receives both drafts and must:
1. Compare accuracy of each translation
2. Identify conflicting interpretations
3. Merge the best parts
4. Document decisions with evidence

Output includes:
```json
{
  "translation": "Final merged translation...",
  "decisions": [
    {
      "aspect": "pronoun choice",
      "chosen": "deepseek",
      "reason": "More consistent with established character relationships"
    }
  ],
  "glossary": [
    { "source": "ancient", "target": "cổ xưa" }
  ]
}
```

### Stage 3: Linkage Verification

Ensures consistency by checking:
- **Pronoun consistency**: Same characters use same pronouns throughout
- **Timeline accuracy**: Events don't contradict previous paragraphs
- **Tone continuity**: Narrative voice remains consistent
- **Entity references**: Names and places match established translations

Output includes:
```json
{
  "report": {
    "issues": [],
    "linkableTerms": [
      { "term": "Elena", "decision": "keep", "note": "Character name" }
    ],
    "consistencyChecks": [
      { "aspect": "pronoun", "status": "ok" }
    ]
  },
  "result": {
    "enhancedParagraph": "Final polished translation...",
    "changesSummary": ["Added transitional phrase for flow"],
    "connectorSuggestions": ["rồi", "sau đó"]
  }
}
```

---

## Ingest Pipeline & RAG

### Why Ingest Matters

Before translating, you should ingest your source material to build a knowledge base:

1. **Similar passage retrieval**: Find relevant context from the same story
2. **Style consistency**: Learn from already-translated chapters
3. **Entity tracking**: Maintain consistent names and terms

### Running Ingest

```bash
# Ingest all documents
bun dist/index.js ingest --config story-trans.config.yaml

# Ingest with verbose output
bun dist/index.js ingest --verbose

# Ingest specific files
bun dist/index.js ingest --files ./data/original/chapter_1.md
```

### Paragraph Context Window

The ingest pipeline uses a **context window** for each paragraph:

```
Previous paragraphs (up to 500 chars)
↓
[CURRENT PARAGRAPH]
↓
Next paragraphs (up to 300 chars)
```

This is embedded together, so searches find paragraphs with similar narrative context.

Example: A paragraph about "Elena entering the tower" will match not just other "tower" mentions, but also "approaching" and "entering" paragraphs from the story.

### LLM Enrichment

When enabled, each chunk goes through:

1. **DeepSeek extraction**: Language, entities, tags, normalized text
2. **MiMo analysis**: Deep thematic understanding
3. **Merge**: Combined summary optimized for embeddings

This produces better search results than raw text embeddings.

---

## Hybrid Search Explained

### What is Hybrid Search?

Combines two search methods:

1. **Vector Search**: Semantic similarity using embeddings
   - Finds conceptually similar content
   - "character feels sad" matches "protagonist was heartbroken"

2. **Full-Text Search (FTS)**: BM25 keyword matching
   - Finds exact term matches
   - "Elena" matches all paragraphs mentioning "Elena"

### Reciprocal Rank Fusion (RRF)

Combines results using:

```
score(d) = Σ 1/(k + rank_i(d))
```

Where `k=60` (default). Documents ranked highly by both methods get boosted.

### Jina Reranking

Final neural reranking step:
- Takes top candidates from RRF
- Uses cross-encoder to score (query, document) pairs
- Provides most relevant results

Configuration:
```yaml
reranker:
  enabled: true
  model: jina-reranker-v2-base-multilingual
  topN: 10
```

---

## Best Practices

### 1. Ingest Before Translating

```bash
# Always ingest first
bun dist/index.js ingest

# Then translate
bun dist/index.js translate --input ...
```

### 2. Build Your Glossary

Create a glossary of important terms:

```json
{
  "glossary": [
    { "source": "The Dark Lord", "target": "Chúa tể Bóng tối" },
    { "source": "magic wand", "target": "đũa phép" }
  ]
}
```

### 3. Use Checkpoints for Long Chapters

The `--resume` flag saves progress:

```bash
# If translation is interrupted
bun dist/index.js translate --input ... --resume
```

### 4. Review and Iterate

After translation:
1. Review the output in `data/translated/`
2. Fix any issues manually
3. Re-ingest the corrected translation
4. Future translations will learn from corrections

### 5. Paragraph Strategy for Stories

Use `strategy: paragraph` for narrative content:

```yaml
ingest:
  chunk:
    strategy: paragraph  # Not markdown or recursive
```

This preserves paragraph boundaries and adds context windows.

---

## Troubleshooting

### "OpenRouter config is required for embeddings"

Add OpenRouter configuration:

```yaml
providers:
  openrouter:
    apiKey: ${OPENROUTER_API_KEY}
    model: xiaomi/mimo-v2-flash:free
```

### Translations are too literal

1. Enable 2-stage enrichment:
   ```yaml
   ingest:
     llm:
       enabled: true
   ```

2. Ensure OpenRouter is configured (provides creative branch)

### Inconsistent pronouns

1. Make sure previous chapters are ingested
2. Check your glossary for character pronoun rules
3. Stage 3 linkage should fix most issues automatically

### Out of memory

Reduce concurrency:

```yaml
providers:
  deepseek:
    concurrency: 1
  openrouter:
    concurrency: 1
embeddings:
  concurrency: 2
```

### API rate limits

Add delays between requests:

```yaml
providers:
  deepseek:
    maxRetries: 3  # Will retry with backoff
```

---

## Example Workflow

Complete workflow for translating a novel:

```bash
# 1. Set up project
mkdir my-novel && cd my-novel
cp -r /path/to/story-trans/examples/templates/* .

# 2. Configure
cp config-template.yaml story-trans.config.yaml
# Edit config with your API keys

# 3. Set up directory structure
mkdir -p data/original     # RAG knowledge base (original chapters)
mkdir -p data/translated   # Reference translations (if you have any)
mkdir -p data/task         # Chapters you want to translate
mkdir -p data/metadata     # Story metadata JSON files

# 4. Add reference chapters (for RAG)
cp /path/to/original-chapters/*.md data/original/

# 5. Add chapters to translate
cp /path/to/chapters-to-translate/*.md data/task/

# 6. Create story metadata
cp story-metadata.json data/metadata/my-story.json
# Edit with your story info, glossary, characters

# 7. Ingest (build knowledge base)
bun /path/to/story-trans/dist/index.js ingest --verbose

# 8. Option A: Translate single chapter
bun /path/to/story-trans/dist/index.js translate \
  --input ./data/task/chapter_1.md \
  --metadata ./data/metadata/my-story.json \
  --language Vietnamese \
  --resume

# 8. Option B: Use auto mode to discover all chapters
bun /path/to/story-trans/dist/index.js auto --verbose

# 9. Review output
cat data/translated/translated_chapter_1.md

# 10. (Optional) Ingest your corrected translations for future reference
# After reviewing and fixing translations, move them to data/translated/
# and re-run ingest to add them to the RAG knowledge base
mv data/task/chapter_1.translated.md data/translated/chapter_1.md
bun /path/to/story-trans/dist/index.js ingest
```

### Workflow Summary

```
┌─────────────────────────────────────────────────────────────────┐
│  1. PREPARE                                                     │
│     data/original/    → Original chapters (for RAG)             │
│     data/translated/  → Reference translations (optional)       │
│     data/task/        → Chapters to translate                   │
│     data/metadata/    → Story JSON files (glossary, characters) │
├─────────────────────────────────────────────────────────────────┤
│  2. INGEST                                                      │
│     bun dist/index.js ingest                                    │
│     → Builds vector database from original + translated         │
├─────────────────────────────────────────────────────────────────┤
│  3. TRANSLATE                                                   │
│     bun dist/index.js translate -i ./data/task/ch1.md           │
│     OR: bun dist/index.js auto                                  │
│     → Uses RAG + Ground Truth + 3-stage pipeline                │
├─────────────────────────────────────────────────────────────────┤
│  4. ITERATE                                                     │
│     Review → Fix → Move to data/translated/ → Re-ingest         │
│     → Future translations learn from your corrections           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Further Reading

- [README.md](../README.md) - Project overview
- [nextgen-ingest-pipeline.md](nextgen-ingest-pipeline.md) - Technical architecture
- [old_code.md](old_code.md) - Reference implementation

---

*Happy translating! 🌏📚*
