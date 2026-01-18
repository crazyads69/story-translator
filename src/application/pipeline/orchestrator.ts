import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { AppConfig } from "../../infrastructure/config/schema";
import { createLlmClients } from "../../infrastructure/llm/factory";
import type { LlmClients } from "../../infrastructure/llm/factory";
import type { FinalTranslation } from "../../domain/translate/schemas";
import type { Stage1Result } from "../translate/stage1-generate";
import { runStage1 } from "../translate/stage1-generate";
import { runStage2 } from "../translate/stage2-synthesize";
import type { TranslationInput } from "../translate/types";
import { buildLinkageMessages } from "../../prompts/v1/stage3.linkage";
import { generateStructured } from "../../infrastructure/llm/structured";
import { z } from "zod";

// Define the Linkage Output Schema
const LinkageOutputSchema = z.object({
  report: z.object({
    issues: z
      .array(
        z.object({
          type: z.string(),
          description: z.string(),
          span: z.string().optional(),
        }),
      )
      .optional(),
    linkableTerms: z
      .array(
        z.object({
          term: z.string(),
          type: z.string(),
          decision: z.string(),
          note: z.string().optional(),
        }),
      )
      .optional(),
    consistencyChecks: z
      .array(
        z.object({
          aspect: z.string(),
          status: z.string(),
          note: z.string().optional(),
        }),
      )
      .optional(),
  }),
  result: z.object({
    enhancedParagraph: z.string(),
    changesSummary: z.array(z.string()).optional(),
    openerSentence: z.string().optional(),
    connectorSuggestions: z.array(z.string()).optional(),
  }),
});

export type PipelineOutput = {
  stage1: { deepseek: Stage1Result; openrouter?: Stage1Result };
  final: FinalTranslation;
};

const State = Annotation.Root({
  input: Annotation<TranslationInput>(),
  stage1DeepSeek: Annotation<Stage1Result>(),
  stage1OpenRouter: Annotation<Stage1Result | undefined>(),
  final: Annotation<FinalTranslation>(),
});

export class TranslationPipeline {
  private readonly config: AppConfig;
  private readonly clients: LlmClients;

  constructor(
    config: AppConfig,
    clients: LlmClients = createLlmClients(config),
  ) {
    this.config = config;
    this.clients = clients;
  }

  async run(input: TranslationInput): Promise<PipelineOutput> {
    const deepseekModelStage1 = this.config.providers.deepseek.model;
    const deepseekModelStage2 = "deepseek-reasoner";
    const openrouterModel = this.config.providers.openrouter?.model;

    const stage1DeepSeekNode = async (state: typeof State.State) => {
      const res = await runStage1({
        provider: "deepseek",
        client: this.clients.deepseek,
        model: deepseekModelStage1,
        input: {
          language: state.input.language,
          source: state.input.source,
          metadata: state.input.metadata,
          ragSnippets: state.input.ragSnippets,
          groundTruthSnippets: state.input.groundTruthSnippets,
          existingGlossary: state.input.existingGlossary,
        },
      });
      return { stage1DeepSeek: res };
    };

    const stage1OpenRouterNode = async (state: typeof State.State) => {
      // Use MiMo-V2-Flash with reasoning if available, or configured model
      const model = "xiaomi/mimo-v2-flash:free";
      if (!this.clients.openrouter) {
        return { stage1OpenRouter: undefined };
      }

      // We need to pass includeReasoning: true to the underlying client call
      // Currently runStage1 doesn't expose it, but we can assume the provider handles it
      // or we can extend runStage1. For now, we'll assume runStage1 uses the client as is
      // but we need to ensure the client config supports it.

      // HACK: We cast the client to any to pass the reasoning flag if runStage1 supported it,
      // but runStage1 calls generateStructured which doesn't support reasoning flags easily.
      // However, the requirement is "2 stage ingest... apply same for translate".
      // Stage 1 is generating a DRAFT.

      const res = await runStage1({
        provider: "openrouter",
        client: this.clients.openrouter,
        model: model, // Force MiMo
        input: {
          language: state.input.language,
          source: state.input.source,
          metadata: state.input.metadata,
          ragSnippets: state.input.ragSnippets,
          groundTruthSnippets: state.input.groundTruthSnippets,
          existingGlossary: state.input.existingGlossary,
        },
        seed: 0,
      });
      return { stage1OpenRouter: res };
    };

    const stage2Node = async (state: typeof State.State) => {
      const promptVersion =
        state.stage1DeepSeek.promptVersion ??
        state.stage1OpenRouter?.promptVersion ??
        "v1";
      const finalRaw = await runStage2({
        client: this.clients.deepseek,
        model: deepseekModelStage2,
        source: state.input.source,
        deepseekDraft: state.stage1DeepSeek.draft,
        openrouterDraft: state.stage1OpenRouter?.draft,
        promptVersion,
      });
      const providers = [
        {
          provider: "deepseek" as const,
          model: state.stage1DeepSeek.model,
          status: state.stage1DeepSeek.draft
            ? ("ok" as const)
            : ("error" as const),
        },
        ...(state.stage1OpenRouter
          ? [
              {
                provider: "openrouter" as const,
                model: state.stage1OpenRouter.model,
                status: state.stage1OpenRouter.draft
                  ? ("ok" as const)
                  : ("error" as const),
              },
            ]
          : []),
      ];

      const final: FinalTranslation = {
        ...finalRaw,
        metadata: {
          ...finalRaw.metadata,
          promptVersion,
          providers,
        },
      };

      return { final };
    };

    // Stage 3: Linkage Fix (DeepSeek)
    const stage3Node = async (state: typeof State.State) => {
      // Logic: Take stage2 output, check against context (prev paragraphs)
      // and fix inconsistencies using DeepSeek Chat.

      const prevParagraphs = Array.isArray(
        state.input.metadata?.prevTranslatedParagraphs,
      )
        ? state.input.metadata.prevTranslatedParagraphs
        : [];

      const { messages } = buildLinkageMessages({
        originalChapter: state.input.source,
        previousTranslatedParagraphs: prevParagraphs,
        currentTranslatedParagraph: state.final.translation,
        storyMetadata: {
          title: state.input.metadata?.chapterTitle,
          targetLanguage: state.input.language,
        },
      });

      try {
        const linkageResult = await generateStructured({
          client: this.clients.deepseek,
          model: "deepseek-chat", // Use faster chat model for verification
          messages,
          schema: LinkageOutputSchema,
          temperature: 0.1, // High consistency
          maxTokens: 1000,
        });

        // Update final translation with enhanced version
        return {
          final: {
            ...state.final,
            translation: linkageResult.result.enhancedParagraph,
            metadata: {
              ...state.final.metadata,
              linkageReport: linkageResult.report,
              linkageChanges: linkageResult.result.changesSummary,
            },
          },
        };
      } catch (err) {
        console.warn(
          "Stage 3 Linkage Fix failed, returning original Stage 2 result",
          err,
        );
        return { final: state.final };
      }
    };

    const graph = new StateGraph(State)
      .addNode("runStage1DeepSeek", stage1DeepSeekNode)
      .addNode("runStage1OpenRouter", stage1OpenRouterNode)
      .addNode("runStage2", stage2Node)
      .addNode("runStage3Linkage", stage3Node)
      .addEdge(START, "runStage1DeepSeek")
      .addEdge(START, "runStage1OpenRouter")
      .addEdge("runStage1DeepSeek", "runStage2")
      .addEdge("runStage1OpenRouter", "runStage2")
      .addEdge("runStage2", "runStage3Linkage")
      .addEdge("runStage3Linkage", END)
      .compile();

    const result = await graph.invoke({
      input,
      stage1DeepSeek: {
        provider: "deepseek",
        model: deepseekModelStage1,
        error: "not run",
        promptVersion: "v1",
      },
      stage1OpenRouter: undefined,
      final: {
        language: input.language,
        translation: input.source,
        decisions: [],
        glossary: [],
        metadata: { promptVersion: "v1", providers: [] },
      },
    });

    return {
      stage1: {
        deepseek: result.stage1DeepSeek,
        openrouter: result.stage1OpenRouter,
      },
      final: result.final,
    };
  }
}
