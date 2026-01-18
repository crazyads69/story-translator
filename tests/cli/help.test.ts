import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

describe("cli", () => {
  it("prints help", () => {
    const res = spawnSync(
      "bun",
      ["run", "src/cli/index.ts", "--help"],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("story-trans");
    expect(res.stdout).toContain("translate");
  });
});

