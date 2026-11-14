import readline from "node:readline/promises";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { checkChanges, generate } from "./generate";
import { exceedsThreshold, formatReport, type FailOn } from "./contract";
import { startSwaggerizer } from "./server";
import type { ChangeReport } from "./types";

const FAIL_ON = ["breaking", "warning", "any", "none"] as const;
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

async function confirm(reports: ChangeReport[]): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const breaking = reports.reduce((n, r) => n + r.counts.breaking, 0);
  const warnings = reports.reduce((n, r) => n + r.counts.warning, 0);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\nThe specs contain ${breaking} breaking change(s) and ${warnings} warning(s) compared with the generated code.\n` +
        "Regenerate the client, models and mocks anyway? [y/N] "
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function run(argv = process.argv): Promise<void> {
  await yargs(hideBin(argv))
    .scriptName("swaggerizer")
    .command(
      ["serve", "$0"],
      "Serve mock APIs from OpenAPI/Swagger specs with a live admin page",
      y =>
        y
          .option("folder", { alias: ["f", "specs"], type: "string", array: true, describe: "spec files or folders to mock", demandOption: true })
          .option("port", { alias: "p", type: "number", default: 8080, describe: "port to listen on" })
          .option("host", { type: "string", describe: "interface to bind (default: all)" })
          .option("endpoint", { type: "string", default: "swaggerizer", describe: "path of the admin API and page" })
          .option("ui", { type: "boolean", default: true, describe: "serve the admin page (disable with --no-ui)" })
          .option("proxy", { type: "string", describe: "upstream base URL for 'Real API' mode (default: each spec's servers URL)" })
          .option("state-file", { type: "string", describe: "persist scenario choices to this JSON file" })
          .option("generated", { alias: "output", type: "string", describe: "generated code folder: warn when the specs drift from it" })
          .option("watch", { alias: "w", type: "boolean", default: false, describe: "reload specs when files change" })
          .option("silent", { type: "boolean", default: false }),
      async args => {
        await startSwaggerizer({
          specs: args.folder as string[],
          port: args.port,
          host: args.host,
          endpoint: args.endpoint,
          ui: args.ui,
          proxy: args.proxy,
          stateFile: args["state-file"],
          generated: args.generated,
          watch: args.watch,
          silent: args.silent
        });
      }
    )
    .command(
      "generate",
      "Generate a typed client, models and MSW mocks with orval — after warning about contract changes",
      y =>
        y
          .option("folder", { alias: ["f", "specs"], type: "string", array: true, demandOption: true, describe: "spec files or folders" })
          .option("output", { alias: "o", type: "string", default: "src/api", describe: "folder for generated code" })
          .option("client", { type: "string", default: "fetch", describe: "orval client (fetch, axios, react-query, swr, vue-query, angular…)" })
          .option("base-url", { type: "string", describe: "base URL baked into the generated client" })
          .option("mock", { type: "boolean", default: true, describe: "generate MSW handlers (disable with --no-mock)" })
          .option("state-file", { type: "string", describe: "embed scenario choices saved by `serve --state-file` as mock defaults" })
          .option("fail-on", { choices: FAIL_ON, default: "breaking" as FailOn, describe: "change level that needs confirmation" })
          .option("yes", { alias: "y", type: "boolean", default: false, describe: "accept contract changes without asking" })
          .option("runtime-import", { type: "string", default: "swaggerizer/msw", describe: "module the generated wrapper imports" })
          .option("verbose", { type: "boolean", default: false, describe: "list non-breaking details too" }),
      async args => {
        const result = await generate({
          specs: args.folder as string[],
          output: args.output,
          client: args.client,
          baseUrl: args["base-url"],
          mock: args.mock,
          stateFile: args["state-file"],
          failOn: args["fail-on"] as FailOn,
          yes: args.yes,
          runtimeImport: args["runtime-import"],
          verbose: args.verbose,
          color: useColor,
          confirm
        });
        if (result.skipped) process.exitCode = 1;
      }
    )
    .command(
      ["diff", "check"],
      "Report new, removed and changed APIs compared with the last generated code (no files written)",
      y =>
        y
          .option("folder", { alias: ["f", "specs"], type: "string", array: true, demandOption: true, describe: "spec files or folders" })
          .option("output", { alias: "o", type: "string", default: "src/api", describe: "folder holding the generated code" })
          .option("fail-on", { choices: FAIL_ON, default: "breaking" as FailOn, describe: "exit 1 when changes reach this level" })
          .option("json", { type: "boolean", default: false, describe: "print the reports as JSON" })
          .option("verbose", { type: "boolean", default: false }),
      async args => {
        const { reports } = await checkChanges(args.folder as string[], args.output);
        if (args.json) console.log(JSON.stringify(reports, null, 2));
        else for (const r of reports) console.log(formatReport(r, { color: useColor, verbose: args.verbose }) + "\n");
        if (reports.some(r => exceedsThreshold(r, args["fail-on"] as FailOn))) process.exitCode = 1;
      }
    )
    .strict()
    .showHelpOnFail(false)
    .help()
    .parseAsync();
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
