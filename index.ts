import { TranslateService } from "./src/translate";
import { createMarkdownParser } from "./src/ingest/markdown-parser";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";

function print(s: string) {
  process.stdout.write(s + "\n");
}

function usage() {
  print("Usage:");
  print("  bun run index.ts ingest");
  print(
    "  bun run index.ts translate --chapter <path> --metadata <path> [--out <dir>]"
  );
  print(
    "  bun run index.ts auto [--orig <dir>] [--metaDir <dir>] [--out <dir>]"
  );
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const cmd = args[0];
  const map: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const k = args[i];
    const n = args[i + 1];
    if (k?.startsWith("--")) {
      map[k.replace(/^--/, "")] = n || "true";
      i++;
    }
  }
  return { cmd, options: map };
}

async function runIngest() {
  await import("./src/ingest/index.ts");
}

function loadMetadata(path?: string, fallbackChapterPath?: string) {
  if (path && existsSync(path)) {
    const s = readFileSync(path, "utf-8");
    return JSON.parse(s);
  }
  if (fallbackChapterPath) {
    const parser = createMarkdownParser();
    const ch = parser.parseFile(fallbackChapterPath);
    return {
      id:
        ch.metadata.story_id ||
        ch.metadata.id ||
        basename(fallbackChapterPath).replace(/\.[^/.]+$/, ""),
      title: ch.metadata.title || "",
      author: ch.metadata.author || "",
      category: "",
      originalLanguage: ch.metadata.language || "Unknown",
      targetLanguage: "Vietnamese",
      characters: [],
      description: "",
    };
  }
  return null;
}

function writeOutputs(
  outDir: string,
  chapterPath: string,
  data: {
    outputs: {
      index: number;
      original: string;
      translated: string;
      enhanced: string;
    }[];
    chapterId: string;
    title?: string;
  }
) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const base = basename(chapterPath).replace(/\.[^/.]+$/, "");
  const jsonPath = join(outDir, `translated_${base}.json`);
  const mdPath = join(outDir, `translated_${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
  const md = data.outputs.map((o) => o.enhanced).join("\n\n");
  writeFileSync(mdPath, md, "utf-8");
  print(`Wrote: ${jsonPath}`);
  print(`Wrote: ${mdPath}`);
}

async function runTranslate(opts: Record<string, string>) {
  const chapterPath = opts["chapter"];
  const metadataPath = opts["metadata"];
  const outDir = opts["out"] || "./data/translated";
  if (!chapterPath) {
    usage();
    process.exit(1);
  }
  const svc = new TranslateService();
  const meta = loadMetadata(metadataPath, chapterPath);
  if (!meta) {
    print("Missing metadata");
    process.exit(1);
  }
  const res = await svc.translateChapterFromMarkdown(chapterPath, meta);
  writeOutputs(outDir, chapterPath, res);
}

async function runAuto(opts: Record<string, string>) {
  const origDir =
    opts["orig"] || process.env.ORIGINAL_CHAPTERS_PATH || "./data/original";
  const metaDir = opts["metaDir"] || "./data/metadata";
  const outDir = opts["out"] || "./data/translated";
  await runIngest();
  const parser = createMarkdownParser();
  const files = parser.getMarkdownFiles(origDir);
  const svc = new TranslateService();
  for (const file of files) {
    const ch = parser.parseFile(file);
    const storyId =
      ch.metadata.story_id ||
      ch.metadata.id ||
      basename(file).replace(/\.[^/.]+$/, "");
    const metaPath = join(metaDir, `${storyId}.json`);
    const meta = loadMetadata(
      existsSync(metaPath) ? metaPath : undefined,
      file
    );
    if (!meta) {
      print(`Missing metadata for ${file}`);
      continue;
    }
    const res = await svc.translateChapterFromMarkdown(file, meta);
    const s = res.summary;
    print(`Chapter: ${file}`);
    print(`  Paragraphs: ${s.paragraphs}`);
    print(`  RAG original hits: ${s.ragOriginalHits}`);
    print(`  RAG translated hits: ${s.ragTranslatedHits}`);
    print(`  RAG queries: ${s.ragQueries}`);
    print(`  Ground truth queries: ${s.groundTruthQueries}`);
    print(`  Ground truth results: ${s.groundTruthResults}`);
    print(`  Ground truth merged count: ${s.groundTruthMergedCount}`);
    print(`  Linkage changes: ${s.linkageChanges}/${s.paragraphs}`);
    print(`  Languages searched: ${s.languagesSearched.join(", ")}`);
    writeOutputs(outDir, file, res);
  }
}

async function main() {
  const { cmd, options } = parseArgs(process.argv);
  if (!cmd) {
    usage();
    process.exit(1);
  }
  if (cmd === "ingest") {
    await runIngest();
    return;
  }
  if (cmd === "translate") {
    await runTranslate(options);
    return;
  }
  if (cmd === "auto") {
    await runAuto(options);
    return;
  }
  usage();
  process.exit(1);
}

main().catch((e) => {
  print(String(e));
  process.exit(1);
});
