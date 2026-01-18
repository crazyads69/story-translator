import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../../src/application/search/hybrid-search";

describe("reciprocalRankFusion", () => {
  it("fuses rankings and prefers overlaps", () => {
    const vec: any[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const fts: any[] = [{ id: "b" }, { id: "d" }, { id: "a" }];

    const out = reciprocalRankFusion(vec as any, fts as any, 60);
    const ids = out.map((r) => r.row.id);

    expect(ids.includes("a")).toBe(true);
    expect(ids.includes("b")).toBe(true);
    expect(ids[0] === "a" || ids[0] === "b").toBe(true);
  });
});

