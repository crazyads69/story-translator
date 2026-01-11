// For mapping chapter metadata from markdown files
export interface ChapterMetadata {
  id?: string;
  story_id?: string;
  chapter_number?: number;
  title?: string;
  author?: string;
  language?: string;
  [key: string]: any;
}

// For parsing data from markdown files
export interface ParsedChapter {
  filename: string;
  filepath: string;
  content: string; // Full text content
  metadata: ChapterMetadata;
}

// Paragraph-specific metadata (extends chapter info)
export interface ParagraphMetadata {
  story_id?: string;
  chapter_number?: number;
  author?: string;
  chapter_title?: string; // Maps from ChapterMetadata.title
  translator?: string;
  total_paragraphs?: number;
  word_count?: number;
  has_prev_context?: boolean; // Whether previous context was included
  has_next_context?: boolean; // Whether next context was included
  is_grouped?: boolean; // If this is a group of short paragraphs
  group_size?: number; // Number of paragraphs in group
  [key: string]: unknown;
}

// Interface for store each embedding with its associated metadata
export interface ParagraphDocument {
  id: string;
  chapter_id: string;
  filename: string;
  paragraph_index: number;
  paragraph_text: string; // Main paragraph only (for display/retrieval)
  content_type: "original" | "translated";
  language: string; // 'en', 'vi', 'zh', etc.
  vector: number[]; // Embedding vector (includes context window)
  metadata?: ParagraphMetadata;
  created_at: string;
  // Index signature for LanceDB compatibility
  [key: string]: unknown;
}
