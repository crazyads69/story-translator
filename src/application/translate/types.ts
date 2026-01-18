export type TranslationInput = {
  language: string;
  source: string;
  metadata?: Record<string, any>;
  ragSnippets?: Array<{ id: string; snippet: string }>;
  groundTruthSnippets?: Array<{ id: string; snippet: string }>;
  existingGlossary?: Array<{ source: string; target: string }>;
};

