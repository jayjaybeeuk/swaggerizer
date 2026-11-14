import path from "node:path";
import readline from "node:readline/promises";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { checkChanges, generate } from "./generate";
import { exceedsThreshold, formatReport, type FailOn } from "./contract";
import { startSwaggerizer } from "./server";
import type { ChangeReport } from "./types";
import type { SwaggerizerConfig } from "./config";
import { loadConfig } from "./load-config";
import { pull } from "./pull";

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

async function configFrom(file: string | undefined) {
  const loaded = await loadConfig(file);
  if (loaded && !process.env.SWAGGERIZER_QUIET) console.log(`Using ${path.relative(process.cwd(), loaded.file) || loaded.file}`);
  return loaded?.config;
}

function needSpecs(folder: unknown, config: SwaggerizerConfig | undefined) {
  if (!config && !(Array.isArray(folder) && folder.length)) {
    throw new Error("Pass --folder <specs…> or create a swaggerizer.config.ts (see the README).");
  }
}

const configOption = { type: "string", describe: "config file (default: ./swaggerizer.config.{ts,mts,js,mjs,json} when present)" } as const;
const folderOption = { alias: ["f", "specs"], type: "string", array: true, describe: "spec files, folders or URLs" } as const;

export async function run(argv = process.argv): Promise<void> {
  await yargs(hideBin(argv))
    .scriptName("swaggerizer")
    .command(
      ["serve", "$0"],
      "Serve mock APIs from OpenAPI/Swagger specs with a live admin page",
      y =>
        y
          .option("config", configOption)
          .option("folder", folderOption)
          .option("port", { alias: "p", type: "number", describe: "port to listen on (default 8080)" })
          .option("host", { type: "string", describe: "interface to bind (default: all)" })
          .option("endpoint", { type: "string", describe: "path of the admin API and page (default swaggerizer)" })
          .option("ui", { type: "boolean", default: true, describe: "serve the admin page (disable with --no-ui)" })
          .option("proxy", { type: "string", describe: "upstream base URL for 'Real API' mode (default: each spec's servers URL)" })
          .option("delay", { type: "number", describe: "default latency for every operation, in ms" })
          .option("fallback", { type: "string", describe: "proxy requests that match no operation to this URL" })
          .option("state-file", { type: "string", describe: "persist scenario choices to this JSON file" })
          .option("generated", { alias: "output", type: "string", describe: "generated code folder: warn when the specs drift from it" })
          .option("watch", { alias: "w", type: "boolean", default: false, describe: "reload specs when files change" })
          .option("silent", { type: "boolean", default: false }),
      async args => {
        const config = await configFrom(args.config);
        needSpecs(args.folder, config);
        await startSwaggerizer({
          config,
          specs: args.folder as string[] | undefined,
          port: args.port ?? config?.port ?? 8080,
          host: args.host ?? config?.host,
          endpoint: args.endpoint ?? config?.endpoint,
          ui: args.ui,
          proxy: args.proxy,
          delay: args.delay ?? config?.delay,
          fallback: args.fallback ?? config?.fallback,
          stateFile: args["state-file"] ?? config?.stateFile,
          generated: args.generated ?? config?.output,
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
          .option("config", configOption)
          .option("folder", folderOption)
          .option("output", { alias: "o", type: "string", describe: "folder for generated code (default src/api)" })
          .option("client", { type: "string", describe: "orval client: fetch (default), axios, axios-functions, react-query, swr, vue-query, angular…" })
          .option("base-url", { type: "string", describe: "base URL baked into the generated client" })
          .option("mock", { type: "boolean", default: true, describe: "generate MSW handlers (disable with --no-mock)" })
          .option("state-file", { type: "string", describe: "embed scenario choices saved by `serve --state-file` as mock defaults" })
          .option("fail-on", { choices: FAIL_ON, default: "breaking" as FailOn, describe: "change level that needs confirmation" })
          .option("yes", { alias: "y", type: "boolean", default: false, describe: "accept contract changes without asking" })
          .option("runtime-import", { type: "string", describe: "module the generated wrapper imports (default swaggerizer/msw)" })
          .option("verbose", { type: "boolean", default: false, describe: "list non-breaking details too" }),
      async args => {
        const config = await configFrom(args.config);
        needSpecs(args.folder, config);
        const result = await generate({
          config,
          specs: args.folder as string[] | undefined,
          output: args.output,
          client: args.client,
          baseUrl: args["base-url"],
          mock: args.mock,
          stateFile: args["state-file"] ?? config?.stateFile,
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
          .option("config", configOption)
          .option("folder", folderOption)
          .option("output", { alias: "o", type: "string", describe: "folder holding the generated code (default src/api)" })
          .option("fail-on", { choices: FAIL_ON, default: "breaking" as FailOn, describe: "exit 1 when changes reach this level" })
          .option("json", { type: "boolean", default: false, describe: "print the reports as JSON" })
          .option("verbose", { type: "boolean", default: false }),
      async args => {
        if (args.json) process.env.SWAGGERIZER_QUIET = "1";
        const config = await configFrom(args.config);
        needSpecs(args.folder, config);
        const { reports } = await checkChanges(args.folder as string[] | undefined, args.output, config);
        if (args.json) console.log(JSON.stringify(reports, null, 2));
        else for (const r of reports) console.log(formatReport(r, { color: useColor, verbose: args.verbose }) + "\n");
        if (reports.some(r => exceedsThreshold(r, args["fail-on"] as FailOn))) process.exitCode = 1;
      }
    )
    .command(
      "pull [ids..]",
      "Refresh committed spec files from the `source` URLs in swaggerizer.config.ts, showing what changed",
      y =>
        y
          .positional("ids", { type: "string", array: true, describe: "only these spec ids" })
          .option("config", configOption)
          .option("header", { type: "string", array: true, describe: "extra request header, e.g. --header 'Authorization: Bearer …'" })
          .option("verbose", { type: "boolean", default: false }),
      async args => {
        const config = await configFrom(args.config);
        if (!config) throw new Error("`pull` needs a swaggerizer.config.ts with `source` URLs.");
        const headers: Record<string, string> = {};
        for (const h of (args.header as string[] | undefined) ?? []) {
          const i = h.indexOf(":");
          if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
        }
        const result = await pull({ config, only: args.ids as string[] | undefined, headers, color: useColor, verbose: args.verbose });
        if (result.failed.length) process.exitCode = 1;
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
