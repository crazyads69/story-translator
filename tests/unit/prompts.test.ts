import { describe, expect, it } from "vitest";
import { buildStage1Messages } from "../../src/prompts/v1/stage1.generate";
import { buildStage2Messages } from "../../src/prompts/v1/stage2.synthesize";

describe("prompt builders", () => {
  it("builds stage1 messages", () => {
    const out = buildStage1Messages({
      language: "Vietnamese",
      source: "Hello world",
      metadata: { story: "x" },
      ragSnippets: [{ id: "r1", snippet: "ref" }],
      groundTruthSnippets: [{ id: "g1", snippet: "web" }],
    });
    expect(out.promptVersion).toBe("v1");
    expect(out.messages.length).toBe(3);
    expect(out.messages[2]?.content).toContain("SOURCE_PARAGRAPH");
  });

  it("builds stage2 messages", () => {
    const out = buildStage2Messages({
      source: "Hello",
      deepseekDraftJson: "{\"translation\":\"a\"}",
      openrouterDraftJson: "{\"translation\":\"b\"}",
    });
    expect(out.promptVersion).toBe("v1");
    expect(out.messages.length).toBe(3);
    expect(out.messages[2]?.content).toContain("DRAFTS:");
  });
});

