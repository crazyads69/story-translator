# Quick Start Guide

Get story-trans running in 5 minutes.

## Prerequisites

- [Bun](https://bun.sh/) installed
- API keys for at least DeepSeek

## 1. Clone & Install

```bash
git clone https://github.com/crazyads69/story-translator.git
cd story-translator
bun install
bun run build
```

## 2. Set API Keys

```bash
export DEEPSEEK_API_KEY="sk-..."
export OPENROUTER_API_KEY="sk-or-..."  # Optional but recommended
export BRAVE_API_KEY="BSA..."           # Optional for ground truth
export JINA_API_KEY="jina_..."          # Optional for reranking
```

## 3. Create Config

```bash
cp story-trans.config.example.yaml story-trans.config.yaml
```

Minimal config:

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

## 4. Set Up Directory Structure

```bash
mkdir -p data/original    # Chapters for RAG knowledge base
mkdir -p data/translated  # Reference translations (optional)
mkdir -p data/task        # Chapters to translate
mkdir -p data/metadata    # Story metadata JSON files
```

## 5. Add Your Content

**For translation:** Place chapters in `data/task/`:

```bash
cp your-chapter.md data/task/chapter_1.md
```

**For RAG knowledge base:** Place reference chapters in `data/original/`:

```bash
cp your-original-chapters/*.md data/original/
```

**Create story metadata** in `data/metadata/my-story.json`:

```json
{
  "id": "my-story",
  "title": "My Story Title",
  "author": "Author Name",
  "originalLanguage": "English",
  "targetLanguage": "Vietnamese",
  "glossary": [
    { "source": "The Dark Tower", "target": "Tháp Đen" }
  ]
}
```

## 6. Ingest & Translate

```bash
# Build knowledge base (recommended first)
bun dist/index.js ingest

# Translate a single chapter
bun dist/index.js translate \
  --input ./data/task/chapter_1.md \
  --metadata ./data/metadata/my-story.json \
  --language Vietnamese

# Or use auto mode to discover all chapters in data/task
bun dist/index.js auto --verbose
```

Output will be in `data/translated/`.

## Command Reference

| Command | Description |
|---------|-------------|
| `translate -i <file>` | Translate a single chapter |
| `translate -m <json>` | Specify story metadata file |
| `translate --resume` | Resume from checkpoint |
| `auto` | Discover & translate all chapters in data/task |
| `ingest` | Build vector database from data/original & data/translated |
| `search --query "text"` | Search ingested content |

## Next Steps

- Read [TUTORIAL.md](TUTORIAL.md) for detailed guide
- See [examples/templates/](../examples/templates/) for template files
- Check [README.md](../README.md) for architecture overview

---

*Happy translating! 🚀*
