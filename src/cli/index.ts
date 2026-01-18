import { Command } from "commander";
import { registerTranslateCommand } from "./commands/translate";
import { registerIngestCommand } from "./commands/ingest";
import { registerSearchCommand } from "./commands/search";

const program = new Command();

const version = process.env.npm_package_version ?? "0.1.0";
program
  .name("story-trans")
  .description("Production-ready translation CLI")
  .version(version);

registerTranslateCommand(program);
registerIngestCommand(program);
registerSearchCommand(program);

program.parseAsync(process.argv);
