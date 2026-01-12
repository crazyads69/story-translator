#!/usr/bin/env bun
/**
 * Test Search Script with Hybrid Search + Jina Reranking
 * 
 * Usage: bun run test:search "your search query"
 * 
 * Example: bun run test:search "Haerin ngã"
 */

import { createLanceDBService, type SearchResult } from "./vectordb";
import { createOpenRouterEmbeddings } from "./embedding";

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
};

function printHeader(text: string) {
  console.log(`\n${colors.bgBlue}${colors.bright} ${text} ${colors.reset}`);
  console.log("─".repeat(60));
}

function printSubHeader(text: string) {
  console.log(`\n${colors.cyan}${colors.bright}▸ ${text}${colors.reset}`);
}

function printResult(idx: number, result: SearchResult, showFull: boolean = false) {
  const typeColor = result.content_type === "original" ? colors.green : colors.magenta;
  const typeLabel = result.content_type === "original" ? "ORIGINAL" : "TRANSLATED";
  
  console.log(`\n${colors.bright}${idx + 1}.${colors.reset} ${typeColor}[${typeLabel}]${colors.reset} ${colors.dim}${result.chapter_id}${colors.reset}`);
  
  // Show scores
  const scores: string[] = [];
  if (result._rerank_score !== undefined) {
    scores.push(`${colors.yellow}Rerank: ${(result._rerank_score * 100).toFixed(1)}%${colors.reset}`);
  }
  if (result._distance !== undefined) {
    scores.push(`${colors.dim}Distance: ${result._distance.toFixed(4)}${colors.reset}`);
  }
  if (scores.length > 0) {
    console.log(`   ${scores.join(" │ ")}`);
  }
  
  // Show text content
  const text = result.paragraph_text || "";
  const displayText = showFull ? text : truncateText(text, 200);
  console.log(`   ${colors.dim}───${colors.reset}`);
  console.log(`   ${displayText}`);
  
  // Show metadata
  if (result.metadata) {
    const meta: string[] = [];
    if (result.metadata.chapter_number) meta.push(`Ch.${result.metadata.chapter_number}`);
    if (result.metadata.word_count) meta.push(`${result.metadata.word_count} words`);
    if (result.language) meta.push(`Lang: ${result.language}`);
    if (meta.length > 0) {
      console.log(`   ${colors.dim}${meta.join(" • ")}${colors.reset}`);
    }
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

async function main() {
  // Get search query from command line arguments
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`${colors.red}❌ Error: Please provide a search query${colors.reset}`);
    console.log(`\nUsage: bun run test:search "your search query"`);
    console.log(`Example: bun run test:search "Haerin ngã"`);
    process.exit(1);
  }

  const searchQuery = args.join(" ");
  const limit = parseInt(process.env.SEARCH_LIMIT || "5", 10);
  const showFull = process.env.SHOW_FULL === "true";

  console.log(`\n${colors.bgGreen}${colors.bright} 🔍 Story Search Test ${colors.reset}`);
  console.log("═".repeat(60));
  console.log(`${colors.bright}Query:${colors.reset} "${searchQuery}"`);
  console.log(`${colors.bright}Limit:${colors.reset} ${limit} results per category`);

  // Check for required environment variables
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(`\n${colors.red}❌ OPENROUTER_API_KEY environment variable is required${colors.reset}`);
    process.exit(1);
  }

  const hasReranker = !!process.env.JINA_API_KEY;
  if (!hasReranker) {
    console.log(`${colors.yellow}⚠️  JINA_API_KEY not set - reranking disabled${colors.reset}`);
  }

  try {
    // Initialize services
    printSubHeader("Initializing services...");
    
    const lancedb = createLanceDBService({ initReranker: hasReranker });
    await lancedb.connect();
    
    const embeddings = createOpenRouterEmbeddings();

    // Get database stats
    const stats = await lancedb.getStats();
    console.log(`${colors.dim}Database: ${stats.total_documents} documents${colors.reset}`);

    // Generate embedding for query
    printSubHeader("Generating query embedding...");
    const startEmbed = Date.now();
    const queryVector = await embeddings.embedText(searchQuery);
    console.log(`${colors.dim}Embedding generated in ${Date.now() - startEmbed}ms${colors.reset}`);

    // ═══════════════════════════════════════════════════════════════
    // Search ORIGINAL content
    // ═══════════════════════════════════════════════════════════════
    printHeader("📖 ORIGINAL Content Results");
    
    const startOriginal = Date.now();
    const originalResults = await lancedb.hybridSearch(searchQuery, queryVector, {
      limit,
      filter: { content_type: "original" },
      rerank: hasReranker,
      rerankCandidates: limit * 3,
    });
    const originalTime = Date.now() - startOriginal;

    if (originalResults.length === 0) {
      console.log(`${colors.dim}No results found in original content${colors.reset}`);
    } else {
      console.log(`${colors.dim}Found ${originalResults.length} results in ${originalTime}ms${colors.reset}`);
      originalResults.forEach((result, idx) => printResult(idx, result, showFull));
    }

    // ═══════════════════════════════════════════════════════════════
    // Search TRANSLATED content
    // ═══════════════════════════════════════════════════════════════
    printHeader("🌐 TRANSLATED Content Results");
    
    const startTranslated = Date.now();
    const translatedResults = await lancedb.hybridSearch(searchQuery, queryVector, {
      limit,
      filter: { content_type: "translated" },
      rerank: hasReranker,
      rerankCandidates: limit * 3,
    });
    const translatedTime = Date.now() - startTranslated;

    if (translatedResults.length === 0) {
      console.log(`${colors.dim}No results found in translated content${colors.reset}`);
    } else {
      console.log(`${colors.dim}Found ${translatedResults.length} results in ${translatedTime}ms${colors.reset}`);
      translatedResults.forEach((result, idx) => printResult(idx, result, showFull));
    }

    // ═══════════════════════════════════════════════════════════════
    // Search ALL content (combined)
    // ═══════════════════════════════════════════════════════════════
    printHeader("🔄 ALL Content Results (Combined)");
    
    const startAll = Date.now();
    const allResults = await lancedb.hybridSearch(searchQuery, queryVector, {
      limit,
      rerank: hasReranker,
      rerankCandidates: limit * 3,
    });
    const allTime = Date.now() - startAll;

    if (allResults.length === 0) {
      console.log(`${colors.dim}No results found${colors.reset}`);
    } else {
      console.log(`${colors.dim}Found ${allResults.length} results in ${allTime}ms${colors.reset}`);
      allResults.forEach((result, idx) => printResult(idx, result, showFull));
    }

    // ═══════════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════════
    console.log("\n" + "═".repeat(60));
    console.log(`${colors.bright}📊 Summary${colors.reset}`);
    console.log("─".repeat(60));
    console.log(`Query: "${searchQuery}"`);
    console.log(`Original results: ${originalResults.length} (${originalTime}ms)`);
    console.log(`Translated results: ${translatedResults.length} (${translatedTime}ms)`);
    console.log(`All results: ${allResults.length} (${allTime}ms)`);
    console.log(`Reranking: ${hasReranker ? "✅ Enabled" : "❌ Disabled"}`);
    console.log("═".repeat(60) + "\n");

  } catch (error) {
    console.error(`\n${colors.red}❌ Error:${colors.reset}`, error);
    process.exit(1);
  }
}

// Run the script
main();
