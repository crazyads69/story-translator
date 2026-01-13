/**
 * Character information for story context
 */
export interface CharacterInfo {
  name: string;
  description?: string;
  role?: string; // 'protagonist', 'antagonist', 'supporting', etc.
  aliases?: string[]; // Alternative names/nicknames
}

/**
 * Story metadata for translation context
 * Provides essential information to help LLM understand the story context
 */
export interface StoryMetadata {
  /** Story ID (must match story_id in vectordb) */
  id: string;
  /** Story title */
  title: string;
  /** Author name */
  author?: string;
  /** Story category/genre */
  category?: string; // 'romance', 'fantasy', 'action', 'drama', etc.
  /** Brief story description/synopsis */
  description?: string;
  /** Main characters in the story */
  characters?: CharacterInfo[];
  /** Original language of the story */
  originalLanguage?: string;
  /** Target translation language */
  targetLanguage?: string;
  /** Additional custom metadata */
  [key: string]: unknown;
}

/**
 * Enriched context from RAG search
 */
export interface EnrichedContext {
  original_similar_paragraphs: string[];
  translated_similar_paragraphs: string[];
  relevance_scores: number[];
  generated_queries: string[];
}
