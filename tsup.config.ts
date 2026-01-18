import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  banner: {
    js: "#!/usr/bin/env bun",
  },
});
