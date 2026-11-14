/*
 * `swaggerizer generate`: runs orval for every spec (client + typed models + MSW handlers), then
 * writes a Swaggerizer wrapper that makes those MSW handlers follow the admin's scenario choices,
 * plus a contract snapshot used to warn about API changes before the next regeneration.
 */
import fs from "node:fs";
import path from "node:path";
import {
  diffContracts,
  exceedsThreshold,
  formatReport,
  type Contract,
  type FailOn
} from "./contract";
import { CONTRACT_FILE, INDEX_FILE, WRAPPER_FILE, outputDirs } from "./paths";
import { analyseSpecFile, resolveSpecInputs, specIdFor, type AnalysedSpec } from "./spec";
import { applyOverlays, unmatchedKeys, type SpecConfig, type SwaggerizerConfig } from "./config";
import type { ChangeReport, ScenarioMap, SwaggerizerManifest } from "./types";

export interface GenerateOptions {
  /** Spec files, folders and/or URLs. Optional when `config` declares the specs. */
  specs?: string | string[];
  /** Specs and per-spec settings from swaggerizer.config.ts. */
  config?: SwaggerizerConfig;
  /** Root folder for generated code; each spec gets its own sub-folder unless it sets `output`. */
  output?: string;
  /** orval client: fetch (default), axios, axios-functions, react-query, vue-query, svelte-query, swr, angular, hono, zod… */
  client?: string;
  /** Base URL baked into the generated client (orval `output.baseUrl`). */
  baseUrl?: string;
  /** Generate MSW handlers (default true). */
  mock?: boolean;
  /** Scenario choices saved by `swaggerizer serve --state-file` to embed as the mocks' defaults. */
  stateFile?: string;
  /** Change severity that needs confirmation before generating (default "breaking"). */
  failOn?: FailOn;
  /** Generate even when changes exceed `failOn`. */
  yes?: boolean;
  /** Only report changes; never write anything. */
  check?: boolean;
  /** Asked when changes exceed `failOn` and `yes` is not set. Resolve true to continue. */
  confirm?: (reports: ChangeReport[]) => Promise<boolean>;
  /** Module the generated code imports the runtime from (default "swaggerizer/msw"). A path starting with "." is resolved from the cwd. */
  runtimeImport?: string;
  /** Extra orval `output` options, merged over Swaggerizer's defaults. */
  orval?: Record<string, unknown>;
  verbose?: boolean;
  silent?: boolean;
  color?: boolean;
}

export interface GenerateResult {
  reports: ChangeReport[];
  /** Spec ids whose code was (re)generated. */
  generated: string[];
  /** True when generation was skipped (check mode, or changes were not confirmed). */
  skipped: boolean;
  blocked: boolean;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function pascal(text: string): string {
  const out = text
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return /^[0-9]/.test(out) ? `Api${out}` : out || "Api";
}

function camel(text: string): string {
  const p = pascal(text);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

/** Snapshots of specs that were generated before but are no longer among the inputs. */
function orphanSnapshots(output: string, ids: Set<string>): Contract[] {
  if (!fs.existsSync(output)) return [];
  const out: Contract[] = [];
  for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
    if (!entry.isDirectory() || ids.has(entry.name)) continue;
    const snapshot = readJson<Contract>(path.join(output, entry.name, CONTRACT_FILE));
    if (snapshot?.operations && Object.keys(snapshot.operations).length > 0) out.push(snapshot);
  }
  return out;
}

export interface SpecTarget {
  id: string;
  /** Local file or URL. */
  input: string;
  config: SpecConfig;
}

/** Every spec to work on: those declared in the config plus any extra files, folders or URLs. */
export async function resolveTargets(specInputs: string | string[] | undefined, config?: SwaggerizerConfig): Promise<SpecTarget[]> {
  const targets: SpecTarget[] = [];
  for (const [id, spec] of Object.entries(config?.specs || {})) {
    const input = spec.file && fs.existsSync(spec.file) ? spec.file : spec.source;
    if (!input) throw new Error(`Spec '${id}' needs a \`file\` that exists or a \`source\` URL (run \`swaggerizer pull\`).`);
    targets.push({ id, input, config: spec });
  }
  const extra = specInputs === undefined ? [] : ([] as string[]).concat(specInputs);
  if (extra.length) {
    const files = await resolveSpecInputs(extra);
    if (files.length === 0) throw new Error(`No OpenAPI / Swagger files found in ${extra.join(", ")}.`);
    for (const file of files) {
      const id = specIdFor(file);
      if (!targets.some(t => t.id === id)) targets.push({ id, input: file, config: config?.specs?.[id] || {} });
    }
  }
  if (targets.length === 0) throw new Error("No specs given: pass --folder or create swaggerizer.config.ts.");
  return targets;
}

async function analyseTarget(target: SpecTarget): Promise<AnalysedSpec & { config: SpecConfig }> {
  const spec = await analyseSpecFile(target.input, target.id);
  spec.operations = applyOverlays(spec.operations, target.config.scenarios);
  for (const key of unmatchedKeys(target.config.scenarios, spec.operations)) {
    spec.warnings.push(`Scenario overlay '${key}' matches no operation`);
  }
  return { ...spec, config: target.config };
}

/** Compares every spec with the snapshot saved at the last generation. */
export async function checkChanges(
  specInputs: string | string[] | undefined,
  output: string | undefined,
  config?: SwaggerizerConfig
): Promise<{ specs: Array<AnalysedSpec & { config: SpecConfig }>; reports: ChangeReport[] }> {
  const targets = await resolveTargets(specInputs, config);
  const specs: Array<AnalysedSpec & { config: SpecConfig }> = [];
  for (const target of targets) specs.push(await analyseTarget(target));
  const root = path.resolve(output ?? config?.output ?? "src/api");
  const reports: ChangeReport[] = [];
  for (const spec of specs) {
    const snapshot = readJson<Contract>(path.join(outputDirs(spec.id, root, spec.config).dir, CONTRACT_FILE));
    if (!snapshot) {
      reports.push({
        specId: spec.id,
        title: spec.contract.title,
        baseline: "snapshot",
        toVersion: spec.contract.version,
        added: Object.values(spec.contract.operations).map(o => `${o.method} ${o.route}`),
        removed: [],
        changed: [],
        changes: Object.values(spec.contract.operations).map(o => ({
          severity: "info" as const,
          kind: "operation-added" as const,
          operation: `${o.method} ${o.route}`,
          message: "New operation (first generation)"
        })),
        counts: { breaking: 0, warning: 0, info: Object.keys(spec.contract.operations).length }
      });
      continue;
    }
    reports.push(diffContracts(snapshot, spec.contract, "snapshot"));
  }
  for (const orphan of orphanSnapshots(root, new Set(specs.map(s => s.id)))) {
    // The spec file is gone: everything it declared will disappear from the generated code.
    const report = diffContracts(orphan, { ...orphan, operations: {} }, "snapshot");
    report.title = `${orphan.title ?? orphan.specId} (spec file removed)`;
    reports.push(report);
  }
  return { specs, reports };
}

function mergeOrval(...parts: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part || {})) {
      out[key] =
        value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object"
          ? mergeOrval(out[key], value as Record<string, unknown>)
          : value;
    }
  }
  return out;
}

async function runOrval(spec: AnalysedSpec & { config: SpecConfig }, dir: string, options: GenerateOptions): Promise<Record<string, unknown>> {
  const mod: any = await import("orval");
  const generate = mod.generate ?? mod.default;
  const output = mergeOrval(
    {
      target: path.join(dir, `${spec.id}.ts`),
      schemas: path.join(dir, "model"),
      client: options.client || options.config?.client || "fetch",
      mode: "split",
      mock: options.mock !== false,
      clean: true,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {})
    },
    options.orval,
    spec.config.orval
  );
  await generate(
    { input: { target: spec.file }, output },
    process.cwd(),
    { logLevel: options.silent ? "silent" : "warn" }
  );
  return output;
}

function relImport(fromDir: string, target: string): string {
  const rel = path.relative(fromDir, target).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Moves orval's MSW + faker files into the mocks folder (Nx-style repos keep mocks apart from
 * shipped code) and points their imports back at the models.
 */
export function moveMocks(id: string, dir: string, mocksDir: string): void {
  fs.mkdirSync(mocksDir, { recursive: true });
  const modelImport = relImport(mocksDir, path.join(dir, "model"));
  for (const name of [`${id}.msw.ts`, `${id}.faker.ts`]) {
    const from = path.join(dir, name);
    if (!fs.existsSync(from)) continue;
    const source = fs.readFileSync(from, "utf8").replace(/from (['"])\.\/model\1/g, `from $1${modelImport}$1`);
    fs.writeFileSync(path.join(mocksDir, name), source);
    fs.rmSync(from);
  }
}

/** Name of orval's aggregate `get<Title>Mock()` export in the generated `.msw.ts` file. */
export function findMockAggregate(source: string): string | undefined {
  const match = /export const (get\w*Mock)\s*=\s*\([^)]*\)\s*=>\s*\[/.exec(source);
  return match ? match[1] : undefined;
}

export function renderWrapper(spec: AnalysedSpec, manifest: SwaggerizerManifest, mockModule: string | undefined, aggregate: string | undefined, runtimeImport: string): string {
  const name = pascal(spec.contract.title || spec.id);
  const lines = [
    "/**",
    " * Generated by Swaggerizer — do not edit by hand. Re-run `swaggerizer generate` instead.",
    ` * ${spec.contract.title ?? spec.id}${spec.contract.version ? ` v${spec.contract.version}` : ""}`,
    " */",
    `import { createSwaggerizerMocks, type SwaggerizerManifest, type SwaggerizerMswOptions } from "${runtimeImport}";`
  ];
  if (mockModule && aggregate) lines.push(`import { ${aggregate} } from "./${mockModule}";`);
  lines.push(
    "",
    `export const manifest: SwaggerizerManifest = ${JSON.stringify(manifest, null, 2)};`,
    "",
    "/** orval's faker-based MSW handlers, used whenever a \"generated\" response is selected. */",
    mockModule && aggregate ? `export const fallbackHandlers = () => ${aggregate}();` : "export const fallbackHandlers = () => [];",
    "",
    `/** MSW handlers for ${spec.contract.title ?? spec.id} that follow the Swaggerizer scenario choices. */`,
    `export function create${name}Mocks(options: SwaggerizerMswOptions = {}) {`,
    "  return createSwaggerizerMocks({",
    "    ...options,",
    "    manifests: [manifest, ...(options.manifests ?? [])],",
    "    fallbackHandlers: [...fallbackHandlers(), ...(options.fallbackHandlers ?? [])]",
    "  });",
    "}",
    ""
  );
  return lines.join("\n");
}

export function renderIndex(entries: Array<{ id: string; clientModule: string }>, runtimeImport: string): string {
  const lines = [
    "/** Generated by Swaggerizer — do not edit by hand. Re-run `swaggerizer generate` instead. */",
    `import { createSwaggerizerMocks, type SwaggerizerMswOptions } from "${runtimeImport}";`
  ];
  for (const e of entries) {
    lines.push(`import { manifest as ${camel(e.id)}Manifest, fallbackHandlers as ${camel(e.id)}Fallback } from "./${e.id}/swaggerizer";`);
  }
  lines.push("");
  for (const e of entries) lines.push(`export * as ${camel(e.id)} from "./${e.id}/${e.clientModule}";`);
  lines.push(
    "",
    `export const manifests = [${entries.map(e => `${camel(e.id)}Manifest`).join(", ")}];`,
    "",
    "/**",
    " * One set of MSW handlers for every spec. Pass `server: \"http://localhost:8080/swaggerizer\"` to follow",
    " * the choices made in a running Swaggerizer admin page.",
    " */",
    "export function createMocks(options: SwaggerizerMswOptions = {}) {",
    "  return createSwaggerizerMocks({",
    "    ...options,",
    "    manifests: [...manifests, ...(options.manifests ?? [])],",
    `    fallbackHandlers: [${entries.map(e => `...${camel(e.id)}Fallback()`).join(", ")}, ...(options.fallbackHandlers ?? [])]`,
    "  });",
    "}",
    ""
  );
  return lines.join("\n");
}

/** Bare module names pass through; relative paths are resolved from the cwd and re-relativised per file. */
function runtimeImportFor(runtimeImport: string, fromDir: string): string {
  if (!runtimeImport.startsWith(".")) return runtimeImport;
  const rel = path.relative(fromDir, path.resolve(runtimeImport)).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function scenariosFor(spec: AnalysedSpec, saved?: ScenarioMap): ScenarioMap | undefined {
  if (!saved) return undefined;
  const keys = new Set(spec.operations.map(o => o.key));
  const picked = Object.fromEntries(Object.entries(saved).filter(([key]) => keys.has(key)));
  return Object.keys(picked).length ? picked : undefined;
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const say = (message: string) => {
    if (!options.silent) console.log(message);
  };
  const output = path.resolve(options.output ?? options.config?.output ?? "src/api");
  const failOn: FailOn = options.failOn ?? "breaking";
  const runtimeImport = options.runtimeImport ?? options.config?.runtimeImport ?? "swaggerizer/msw";

  const { specs, reports } = await checkChanges(options.specs, output, options.config);
  for (const report of reports) say(formatReport(report, { color: options.color, verbose: options.verbose }) + "\n");

  const blocked = reports.some(r => exceedsThreshold(r, failOn));
  if (options.check) return { reports, generated: [], skipped: true, blocked };

  if (blocked && !options.yes) {
    const ok = options.confirm ? await options.confirm(reports) : false;
    if (!ok) {
      say(`Generation cancelled: contract changes at or above '${failOn}' were not confirmed. Re-run with --yes to accept them.`);
      return { reports, generated: [], skipped: true, blocked };
    }
  }

  const saved = options.stateFile ? readJson<{ scenarios?: ScenarioMap }>(options.stateFile)?.scenarios : undefined;
  const generated: string[] = [];
  const entries: Array<{ id: string; clientModule: string }> = [];

  for (const spec of specs) {
    const { dir, mocksDir } = outputDirs(spec.id, output, spec.config);
    for (const warning of spec.warnings.filter(w => /matches no operation/.test(w))) say(`  ! ${spec.id}: ${warning}`);
    say(`Generating ${spec.id} → ${path.relative(process.cwd(), dir) || dir}`);
    const orvalOutput = await runOrval(spec, dir, options);
    if (mocksDir !== dir) {
      if (orvalOutput.mode === "split") moveMocks(spec.id, dir, mocksDir);
      else say(`  ! ${spec.id}: mocksOutput only works with orval mode "split"; mocks left in ${dir}.`);
    }

    const mockFile = path.join(mocksDir, `${spec.id}.msw.ts`);
    const aggregate = fs.existsSync(mockFile) ? findMockAggregate(fs.readFileSync(mockFile, "utf8")) : undefined;
    if (options.mock !== false && !aggregate) {
      say(`  ! Could not find orval's MSW handler list in ${mockFile}; "generated" responses will use Swaggerizer samples.`);
    }

    const manifest: SwaggerizerManifest = {
      specId: spec.id,
      title: spec.contract.title,
      version: spec.contract.version,
      basePaths: spec.basePaths,
      operations: spec.operations,
      ...(spec.config.aliases ? { aliases: spec.config.aliases } : {})
    };
    const scenarios = scenariosFor(spec, saved);
    if (scenarios) manifest.scenarios = scenarios;

    fs.mkdirSync(mocksDir, { recursive: true });
    fs.writeFileSync(
      path.join(mocksDir, WRAPPER_FILE),
      renderWrapper(spec, manifest, aggregate ? `${spec.id}.msw` : undefined, aggregate, runtimeImportFor(runtimeImport, mocksDir))
    );
    fs.writeFileSync(
      path.join(dir, CONTRACT_FILE),
      JSON.stringify({ ...spec.contract, generatedAt: new Date().toISOString() }, null, 2) + "\n"
    );
    generated.push(spec.id);
    // Only specs in the default layout (<output>/<id>/) go in the aggregate index.
    if (!spec.config.output && !spec.config.mocksOutput) entries.push({ id: spec.id, clientModule: spec.id });
  }

  // Specs whose file was removed: the removal has now been accepted, so record it in their
  // snapshot (it stops being reported) and leave the stale folder for the user to delete.
  for (const orphan of orphanSnapshots(output, new Set(specs.map(s => s.id)))) {
    const file = path.join(output, orphan.specId, CONTRACT_FILE);
    fs.writeFileSync(file, JSON.stringify({ ...orphan, operations: {}, removedAt: new Date().toISOString() }, null, 2) + "\n");
    say(`  ${orphan.specId}: spec file removed — ${path.join(path.relative(process.cwd(), output), orphan.specId)} is no longer used and can be deleted.`);
  }

  if (entries.length) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, INDEX_FILE), renderIndex(entries, runtimeImportFor(runtimeImport, output)));
  }
  say(entries.length === generated.length
    ? `Done: ${generated.length} spec(s) generated in ${path.relative(process.cwd(), output) || output}`
    : `Done: ${generated.length} spec(s) generated.`);
  return { reports, generated, skipped: false, blocked };
}
