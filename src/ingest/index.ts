
import { existsSync, mkdirSync } from "fs";
import { createOpenRouterEmbeddings } from "./embedding";
import { createLanceDBService } from "./vectordb";
import { createMarkdownParser } from "./markdown-parser";
import type { ParagraphDocument } from "./interface";

// Load environment variables
const env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small",
  LANCEDB_PATH: process.env.LANCEDB_PATH || "./lancedb",
  LANCEDB_TABLE_NAME: process.env.LANCEDB_TABLE_NAME || "story_chapters",
  ORIGINAL_CHAPTERS_PATH: process.env.ORIGINAL_CHAPTERS_PATH || "./data/original",
  TRANSLATED_CHAPTERS_PATH: process.env.TRANSLATED_CHAPTERS_PATH || "./data/translated",
};

async function main() {
  console.log("🔄 Story Chapter Embedder - Ingestion Script");
  console.log("=" .repeat(60));

  // Validate environment
  if (!env.OPENROUTER_API_KEY) {
    console.error("\n❌ Error: OPENROUTER_API_KEY is required");
    console.log("Get your API key at: https://openrouter.ai/keys");
    console.log("Then set it in .env file or environment variable");
    process.exit(1);
  }

  // Initialize services
  console.log("\n📦 Initializing services...");
  console.log(`  Embedding Model: ${env.EMBEDDING_MODEL}`);
  console.log(`  LanceDB Path: ${env.LANCEDB_PATH}`);
  console.log(`  Table Name: ${env.LANCEDB_TABLE_NAME}`);

  const embeddings = createOpenRouterEmbeddings();
  const lancedb = createLanceDBService();
  const parser = createMarkdownParser();

  // Ensure LanceDB directory exists
  if (!existsSync(env.LANCEDB_PATH)) {
    mkdirSync(env.LANCEDB_PATH, { recursive: true });
  }

  // Connect to LanceDB
  await lancedb.connect();
  await lancedb.ensureTable();

  // Process original chapters
  console.log("\n📖 Processing ORIGINAL chapters...");
  console.log(`  Source: ${env.ORIGINAL_CHAPTERS_PATH}`);
  
  if (!existsSync(env.ORIGINAL_CHAPTERS_PATH)) {
    console.log(`  ⚠️  Directory not found: ${env.ORIGINAL_CHAPTERS_PATH}`);
    console.log("  Creating directory...");
    mkdirSync(env.ORIGINAL_CHAPTERS_PATH, { recursive: true });
  }

  const originalChapters = parser.parseDirectory(env.ORIGINAL_CHAPTERS_PATH);
  console.log(`  Found ${originalChapters.length} original chapter(s)\n`);

  let chapterIndex = 0;
  for (const chapter of originalChapters) {
    chapterIndex++;
    console.log(`  [${chapterIndex}/${originalChapters.length}] Processing: ${chapter.filename}`);
    
    try {
      // Split chapter into paragraphs
      const paragraphs = parser.splitIntoParagraphs(chapter.content);
      console.log(`    Total paragraphs: ${paragraphs.length}`);
      
      // Group short paragraphs (optional, comment out if not needed)
      const groups = parser.groupShortParagraphs(paragraphs, 50, 3);
      const hasGrouping = groups.some(g => g.length > 1);
      if (hasGrouping) {
        console.log(`    Grouped ${groups.filter(g => g.length > 1).length} dialogue sections`);
      }
      
      // Detect language from metadata or default to 'en'
      const language = chapter.metadata.language || "en";
      
      // Extract chapter info
      const chapterId = chapter.metadata.id || chapter.filename.replace(/\.[^/.]+$/, "");
      const chapterNumber = chapter.metadata.chapter_number ?? 
                           parser.extractChapterNumber(chapter.filename) ?? undefined;

      // Process each paragraph/group
      const paragraphDocs: ParagraphDocument[] = [];
      
      for (const group of groups) {
        if (!group || group.length === 0) continue;
        
        const mainIndex = group[0]!; // Use first paragraph index as main
        
        // Get main paragraph text (combine if grouped)
        const paragraphText = group.map(idx => paragraphs[idx]).join("\n\n");
        
        // Skip very short paragraphs (unless grouped)
        if (paragraphText.length < 10 && group.length === 1) {
          console.log(`    [${mainIndex + 1}/${paragraphs.length}] Skipping (too short)`);
          continue;
        }
        
        console.log(`    [${mainIndex + 1}/${paragraphs.length}] Embedding${group.length > 1 ? ` group of ${group.length}` : ''}...`);
        
        // Build context window for embedding
        const { fullContext, prevContext, nextContext } = 
          parser.buildContextWindow(paragraphs, mainIndex, 1);
        
        // Truncate to token limit for safety
        const embeddingText = parser.truncateToTokenLimit(fullContext, 8000);
        
        // Generate embedding WITH context
        const vector = await embeddings.embedText(embeddingText);
        
        // Create paragraph document
        const doc: ParagraphDocument = {
          id: `${chapterId}_para_${mainIndex}`,
          chapter_id: chapterId,
          filename: chapter.filename,
          paragraph_index: mainIndex,
          paragraph_text: paragraphText, // Store main text only (for display)
          content_type: "original",
          language: language,
          vector: vector, // Embedding includes context
          metadata: {
            story_id: chapter.metadata.story_id,
            chapter_number: chapterNumber,
            chapter_title: chapter.metadata.title,
            author: chapter.metadata.author,
            total_paragraphs: paragraphs.length,
            word_count: parser.getWordCount(paragraphText),
            has_prev_context: prevContext.length > 0,
            has_next_context: nextContext.length > 0,
            is_grouped: group.length > 1,
            group_size: group.length,
          },
          created_at: new Date().toISOString(),
        };
        
        paragraphDocs.push(doc);
        
        // Small delay to avoid rate limits
        await sleep(300);
      }
      
      // Insert all paragraphs for this chapter in batch
      if (paragraphDocs.length > 0) {
        await lancedb.insertBatch(paragraphDocs);
      }
      
      console.log(`    ✓ Embedded ${paragraphDocs.length} paragraphs\n`);
    } catch (error) {
      console.error(`    ❌ Error processing ${chapter.filename}:`, error);
    }
  }

  // Process translated chapters
  console.log("\n🌐 Processing TRANSLATED chapters...");
  console.log(`  Source: ${env.TRANSLATED_CHAPTERS_PATH}`);
  
  if (!existsSync(env.TRANSLATED_CHAPTERS_PATH)) {
    console.log(`  ⚠️  Directory not found: ${env.TRANSLATED_CHAPTERS_PATH}`);
    console.log("  Creating directory...");
    mkdirSync(env.TRANSLATED_CHAPTERS_PATH, { recursive: true });
  }

  const translatedChapters = parser.parseDirectory(env.TRANSLATED_CHAPTERS_PATH);
  console.log(`  Found ${translatedChapters.length} translated chapter(s)\n`);

  let translatedIndex = 0;
  for (const chapter of translatedChapters) {
    translatedIndex++;
    console.log(`  [${translatedIndex}/${translatedChapters.length}] Processing: ${chapter.filename}`);
    
    try {
      // Split chapter into paragraphs
      const paragraphs = parser.splitIntoParagraphs(chapter.content);
      console.log(`    Total paragraphs: ${paragraphs.length}`);
      
      // Group short paragraphs (optional)
      const groups = parser.groupShortParagraphs(paragraphs, 50, 3);
      const hasGrouping = groups.some(g => g.length > 1);
      if (hasGrouping) {
        console.log(`    Grouped ${groups.filter(g => g.length > 1).length} dialogue sections`);
      }
      
      // Detect language from metadata or default to 'vi'
      const language = chapter.metadata.language || "vi";
      
      // Extract chapter info
      const chapterId = chapter.metadata.id || chapter.filename.replace(/\.[^/.]+$/, "");
      const chapterNumber = chapter.metadata.chapter_number ?? 
                           parser.extractChapterNumber(chapter.filename) ?? undefined;
    
      // Process each paragraph/group
      const paragraphDocs: ParagraphDocument[] = [];
      
      for (const group of groups) {
        if (!group || group.length === 0) continue;
        
        const mainIndex = group[0]!; // Use first paragraph index as main
        
        // Get main paragraph text (combine if grouped)
        const paragraphText = group.map(idx => paragraphs[idx]).join("\n\n");
        
        // Skip very short paragraphs (unless grouped)
        if (paragraphText.length < 10 && group.length === 1) {
          console.log(`    [${mainIndex + 1}/${paragraphs.length}] Skipping (too short)`);
          continue;
        }
        
        console.log(`    [${mainIndex + 1}/${paragraphs.length}] Embedding${group.length > 1 ? ` group of ${group.length}` : ''}...`);
        
        // Build context window for embedding
        const { fullContext, prevContext, nextContext } = 
          parser.buildContextWindow(paragraphs, mainIndex, 1);
        
        // Truncate to token limit for safety
        const embeddingText = parser.truncateToTokenLimit(fullContext, 8000);
        
        // Generate embedding WITH context
        const vector = await embeddings.embedText(embeddingText);
        
        // Create paragraph document with alignment to original
        const doc: ParagraphDocument = {
          id: `${chapterId}_para_${mainIndex}`,
          chapter_id: chapterId,
          filename: chapter.filename,
          paragraph_index: mainIndex,
          paragraph_text: paragraphText, // Store main text only (for display)
          content_type: "translated",
          language: language,
          vector: vector, // Embedding includes context
          metadata: {
            story_id: chapter.metadata.story_id,
            chapter_number: chapterNumber,
            chapter_title: chapter.metadata.title,
            translator: chapter.metadata.translator,
            total_paragraphs: paragraphs.length,
            word_count: parser.getWordCount(paragraphText),
            has_prev_context: prevContext.length > 0,
            has_next_context: nextContext.length > 0,
            is_grouped: group.length > 1,
            group_size: group.length,
          },
          created_at: new Date().toISOString(),
        };
        
        paragraphDocs.push(doc);
        
        // Small delay to avoid rate limits
        await sleep(300);
      }
      
      // Insert all paragraphs for this chapter in batch
      if (paragraphDocs.length > 0) {
        await lancedb.insertBatch(paragraphDocs);
      }
      
      console.log(`    ✓ Embedded ${paragraphDocs.length} paragraphs\n`);
    } catch (error) {
      console.error(`    ❌ Error processing ${chapter.filename}:`, error);
    }
  }

  // Create FTS index for hybrid search
  console.log("\n🔍 Creating Full-Text Search index...");
  try {
    await lancedb.createFTSIndex("paragraph_text");
  } catch (error) {
    console.log("  ⚠️  FTS index creation skipped (may already exist)");
  }

  // Show final statistics
  console.log("\n📊 Getting database statistics...");
  const stats = await lancedb.getStats();
  
  console.log("\n" + "=".repeat(60));
  console.log("✅ Ingestion Complete!");
  console.log("=".repeat(60));
  console.log(`Total documents: ${stats.total_documents}`);
  console.log("\nBy type:");
  Object.entries(stats.by_type).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });
  console.log("\nBy language:");
  Object.entries(stats.by_language).forEach(([lang, count]) => {
    console.log(`  ${lang}: ${count}`);
  });
  console.log("\n✨ All chapters embedded successfully!");
  console.log(`📁 Database location: ${env.LANCEDB_PATH}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the script
main().catch(error => {
  console.error("\n💥 Fatal error:", error);
  process.exit(1);
});