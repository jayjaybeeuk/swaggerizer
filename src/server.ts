/* The Swaggerizer mock server: serves every loaded spec and exposes the admin API + page. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { registerAdmin, type AdminRequest } from "./admin";
import { diffContracts, type Contract } from "./contract";
import {
  applySelection,
  buildOperationStates,
  encodeBody,
  candidatePaths,
  matchOperation,
  operationKey,
  relativeToBase,
  parseScenarioHeader,
  resolveResponse,
  SCENARIO_HEADER
} from "./scenario";
import { analyseSpecFile, listSpecFiles, specIdFor, type AnalysedSpec } from "./spec";
import {
  createValidator,
  hasRequestSchema,
  matchesIgnore,
  parseValidationMode,
  unmatchedIgnore,
  VALIDATION_HEADER,
  type Validator
} from "./validate";
import { CONTRACT_FILE, isUrl, outputDirs } from "./paths";
import {
  applyOverlays,
  createHandlerContext,
  extractParams,
  isHandlerResult,
  lookupByOperation,
  unmatchedKeys,
  type HandlerResult,
  type SpecConfig,
  type SwaggerizerConfig
} from "./config";
import type {
  ChangeReport,
  OperationState,
  RequestLogEntry,
  ScenarioMap,
  ScenarioSelection,
  SpecSummary,
  SwaggerizerState,
  ValidationInfo,
  ValidationMode,
  ValidationSummary
} from "./types";

const REQUEST_LOG_LIMIT = 300;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface SwaggerizerOptions {
  /** Spec files, folders and/or URLs to load. */
  specs?: string | string[];
  /** Request headers for spec URLs (a spec config's own `headers` win). */
  headers?: Record<string, string>;
  /** Path of the admin API and page (default `swaggerizer`, served at `/swaggerizer`). */
  endpoint?: string;
  /** Serve the admin page (default true). The admin API is always available. */
  ui?: boolean;
  /** Upstream base URL for "proxy" mode. Defaults to each spec's first absolute `servers` URL. */
  proxy?: string;
  /** Persist scenario choices to this JSON file and restore them on start. */
  stateFile?: string;
  /** Folder of generated code: specs are compared against its contract snapshots. */
  generated?: string;
  /** Re-read specs automatically when files in the spec folders change. */
  watch?: boolean;
  /** Add permissive CORS headers (default true). */
  cors?: boolean;
  /** Per-spec settings (aliases, overlays, handlers, proxy) keyed by spec id. */
  specConfigs?: Record<string, SpecConfig>;
  /** Default latency for every operation, in ms. */
  delay?: number;
  /** Requests that match no operation are proxied here (e.g. a legacy mock server during migration). */
  fallback?: string;
  /** Validate matched requests against the spec: "off" (default), "warn" or "enforce". */
  validate?: ValidationMode;
  /** Per-spec validation modes, keyed by spec id. */
  specValidation?: Record<string, ValidationMode>;
  silent?: boolean;
}

interface SpecRecord extends AnalysedSpec {
  enabled: boolean;
  loadedAt: string;
  error?: string;
}

type Source = { kind: "folder" | "file" | "url"; path: string; id?: string };

export interface Swaggerizer {
  /** Node `http` request listener; also works as Express/Connect middleware. */
  handler: (req: http.IncomingMessage, res: http.ServerResponse, next?: () => void) => void;
  load: (inputs: string | string[]) => Promise<SwaggerizerState>;
  /** Load every spec declared in a swaggerizer.config.ts. */
  loadConfig: (config: SwaggerizerConfig) => Promise<SwaggerizerState>;
  reload: () => Promise<SwaggerizerState>;
  getState: () => SwaggerizerState;
  select: (selection: ScenarioSelection | ScenarioSelection[]) => OperationState[];
  reset: (filter?: { method?: string; route?: string }) => number;
  setSpecEnabled: (id: string, enabled: boolean) => SpecSummary;
  getRequestLog: (sinceId?: number) => RequestLogEntry[];
  recordRequest: (entry: Omit<RequestLogEntry, "id" | "time">) => RequestLogEntry;
  getSpecDocument: (id: string) => any;
  /** Active validation mode and which operations declare something to check. */
  getValidationInfo: () => ValidationInfo;
  listen: (port?: number, host?: string) => Promise<http.Server>;
  close: () => Promise<void>;
  readonly endpoint: string;
  readonly scenarios: ScenarioMap;
}

function log(silent: boolean, message: string) {
  if (!silent) console.log(`\x1b[36m[swaggerizer]\x1b[0m ${message}`);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function parseRequestBody(raw: Buffer, contentType: string | undefined): any {
  const text = raw.toString("utf8");
  if (!text.trim()) return {};
  if (contentType && /application\/x-www-form-urlencoded/i.test(contentType)) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function createSwaggerizer(options: SwaggerizerOptions = {}): Swaggerizer {
  const silent = Boolean(options.silent);
  const endpoint = (options.endpoint || "swaggerizer").replace(/^\/+|\/+$/g, "") || "swaggerizer";
  const basePath = `/${endpoint}`;

  const specs = new Map<string, SpecRecord>();
  const sources: Source[] = [];
  const scenarios: ScenarioMap = {};
  const requestLog: RequestLogEntry[] = [];
  const previousReports = new Map<string, ChangeReport>();
  let snapshotReports: ChangeReport[] = [];
  let requestSeq = 0;
  let lastReload: string | undefined;
  let reloadChain: Promise<unknown> = Promise.resolve();
  const watchers: fs.FSWatcher[] = [];
  const servers = new Set<http.Server>();
  const specConfigs: Record<string, SpecConfig> = { ...(options.specConfigs || {}) };
  const store = new Map<string, unknown>();
  let configHeaders: Record<string, string> = {};
  const configFor = (id: string): SpecConfig => specConfigs[id] || {};

  /* ------------------------------------------------------------------ persistence */

  function restoreState() {
    if (!options.stateFile || !fs.existsSync(options.stateFile)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(options.stateFile, "utf8"));
      Object.assign(scenarios, saved?.scenarios || {});
      log(silent, `Restored ${Object.keys(scenarios).length} scenario(s) from ${options.stateFile}`);
    } catch (err: any) {
      log(silent, `Could not read state file ${options.stateFile}: ${err?.message ?? err}`);
    }
  }

  function saveState() {
    if (!options.stateFile) return;
    const disabled = [...specs.values()].filter(s => !s.enabled).map(s => s.id);
    fs.mkdirSync(path.dirname(path.resolve(options.stateFile)), { recursive: true });
    fs.writeFileSync(options.stateFile, JSON.stringify({ scenarios, disabledSpecs: disabled }, null, 2) + "\n");
  }

  function savedDisabledSpecs(): Set<string> {
    if (!options.stateFile || !fs.existsSync(options.stateFile)) return new Set();
    try {
      return new Set(JSON.parse(fs.readFileSync(options.stateFile, "utf8"))?.disabledSpecs || []);
    } catch {
      return new Set();
    }
  }

  /* ------------------------------------------------------------------ state */

  const ordered = () => [...specs.values()];
  const states = () => buildOperationStates(ordered(), scenarios, { defaultDelay: options.delay });

  /* ------------------------------------------------------------------ request validation */

  const validators = new Map<string, Validator>();

  function validatorFor(spec: SpecRecord): Validator {
    let validator = validators.get(spec.id);
    if (!validator) {
      validator = createValidator(spec.doc, spec.id, spec.specVersion);
      validators.set(spec.id, validator);
    }
    return validator;
  }

  /** Header override, then `validateIgnore`, then the spec's mode, then the server's. */
  function validationModeFor(op: OperationState, header: string | string[] | undefined): ValidationMode {
    const fromHeader = parseValidationMode(Array.isArray(header) ? header[0] : header);
    if (fromHeader) return fromHeader;
    const cfg = configFor(op.specId);
    if (matchesIgnore(cfg.validateIgnore, op)) return "off";
    return cfg.validate ?? options.specValidation?.[op.specId] ?? options.validate ?? "off";
  }

  function validationInfo(operations: OperationState[] = states()): ValidationInfo {
    const perSpec: Record<string, ValidationMode> = { ...(options.specValidation || {}) };
    for (const [id, cfg] of Object.entries(specConfigs)) if (cfg.validate) perSpec[id] = cfg.validate;
    return {
      mode: options.validate ?? "off",
      perSpec,
      operations: operations.map(op => {
        const spec = specs.get(op.specId);
        // Read straight from the document: reporting this must not build an Ajv instance while validation is off.
        return { specId: op.specId, key: op.key, hasRequestSchema: spec ? hasRequestSchema(spec.doc, op) : false };
      })
    };
  }

  function summarise(spec: SpecRecord): SpecSummary {
    return {
      id: spec.id,
      file: spec.file,
      name: path.basename(spec.file),
      title: spec.doc?.info?.title,
      version: spec.doc?.info?.version !== undefined ? String(spec.doc.info.version) : undefined,
      specVersion: spec.specVersion,
      enabled: spec.enabled,
      loadedAt: spec.loadedAt,
      ...(spec.error ? { error: spec.error } : {}),
      warnings: spec.warnings,
      basePaths: spec.basePaths,
      ...(configFor(spec.id).aliases ? { aliases: configFor(spec.id).aliases } : {}),
      ...(isUrl(spec.file) ? { source: spec.file } : {}),
      proxyTarget: configFor(spec.id).proxy || options.proxy || spec.serverUrl,
      operationCount: spec.operations.length
    };
  }

  function getState(): SwaggerizerState {
    const changes = [
      ...snapshotReports,
      ...[...previousReports.values()].filter(r => r.changes.length > 0)
    ];
    const operations = states();
    return {
      endpoint,
      ...(options.delay ? { defaultDelay: options.delay } : {}),
      ...(options.fallback ? { fallback: options.fallback } : {}),
      specs: ordered().map(summarise),
      operations,
      lastReload,
      changes,
      validation: validationInfo(operations)
    };
  }

  function servingOperation(method: string, route: string): OperationState | undefined {
    const key = operationKey(method, route);
    const all = states();
    return all.find(s => s.key === key && s.active) || all.find(s => s.key === key);
  }

  function select(selection: ScenarioSelection | ScenarioSelection[]): OperationState[] {
    const list = Array.isArray(selection) ? selection : [selection];
    if (list.length === 0) throw new Error("Selection list cannot be empty.");
    // Validate everything before applying anything.
    const next: Array<[string, ReturnType<typeof applySelection>]> = [];
    for (const item of list) {
      if (!item || typeof item.method !== "string" || typeof item.route !== "string") {
        throw new Error("Each selection needs a string `method` and `route`.");
      }
      const op = servingOperation(item.method, item.route);
      if (!op) throw new Error(`No operation ${item.method.toUpperCase()} ${item.route} is loaded.`);
      next.push([op.key, applySelection(op, item, scenarios[op.key])]);
    }
    for (const [key, scenario] of next) scenarios[key] = scenario;
    saveState();
    const after = states();
    return next.map(([key]) => after.find(s => s.key === key && s.active) || after.find(s => s.key === key)!);
  }

  function reset(filter: { method?: string; route?: string } = {}): number {
    let count = 0;
    for (const key of Object.keys(scenarios)) {
      const [method, ...rest] = key.split(":");
      const route = rest.join(":");
      if (filter.method && method !== String(filter.method).toLowerCase()) continue;
      if (filter.route && route !== filter.route) continue;
      delete scenarios[key];
      count++;
    }
    // "Reset all" also empties the state custom handlers keep.
    if (!filter.method && !filter.route) store.clear();
    saveState();
    return count;
  }

  function setSpecEnabled(id: string, enabled: boolean): SpecSummary {
    const spec = specs.get(id);
    if (!spec) throw new Error(`No spec with id '${id}' is loaded.`);
    spec.enabled = Boolean(enabled);
    saveState();
    log(silent, `${spec.id} ${spec.enabled ? "enabled" : "disabled"}`);
    return summarise(spec);
  }

  function recordRequest(entry: Omit<RequestLogEntry, "id" | "time">): RequestLogEntry {
    const full = { id: ++requestSeq, time: new Date().toISOString(), ...entry };
    requestLog.push(full);
    if (requestLog.length > REQUEST_LOG_LIMIT) requestLog.splice(0, requestLog.length - REQUEST_LOG_LIMIT);
    return full;
  }

  function getRequestLog(sinceId = 0): RequestLogEntry[] {
    if (sinceId > 0 && requestLog.length > 0 && requestLog[requestLog.length - 1].id < sinceId) return [];
    return requestLog.filter(e => e.id > sinceId);
  }

  /* ------------------------------------------------------------------ loading */

  function readSnapshot(specId: string): Contract | undefined {
    const cfg = configFor(specId);
    if (!options.generated && !cfg.output) return undefined;
    const file = path.join(outputDirs(specId, options.generated, cfg).dir, CONTRACT_FILE);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  }

  function refreshSnapshotReports() {
    snapshotReports = [];
    for (const spec of ordered()) {
      if (spec.error) continue;
      const snapshot = readSnapshot(spec.id);
      if (!snapshot) continue;
      const report = diffContracts(snapshot, spec.contract, "snapshot");
      if (report.changes.length) snapshotReports.push(report);
    }
  }

  async function wantedFiles(): Promise<Array<{ file: string; id?: string }>> {
    const files: Array<{ file: string; id?: string }> = [];
    for (const source of sources) {
      if (source.kind === "folder") {
        try {
          files.push(...(await listSpecFiles(source.path)).map(file => ({ file })));
        } catch {
          // folder vanished
        }
      } else if (source.kind === "url" || fs.existsSync(source.path)) {
        files.push({ file: source.path, id: source.id });
      }
    }
    const seen = new Set<string>();
    return files.filter(f => (seen.has(f.file) ? false : (seen.add(f.file), true)));
  }

  async function doReload(): Promise<SwaggerizerState> {
    const previous = new Map(ordered().map(s => [s.file, s]));
    const disabled = savedDisabledSpecs();
    const next = new Map<string, SpecRecord>();
    const usedIds = new Set<string>();

    for (const { file, id: configuredId } of await wantedFiles()) {
      const before = previous.get(file);
      let id = configuredId ?? before?.id ?? specIdFor(file);
      for (let n = 2; usedIds.has(id); n++) id = `${specIdFor(file)}-${n}`;
      usedIds.add(id);
      try {
        const analysed = await analyseSpecFile(file, id, { headers: { ...configHeaders, ...(options.headers || {}), ...(configFor(id).headers || {}) } });
        const cfg = configFor(id);
        analysed.operations = applyOverlays(analysed.operations, cfg.scenarios);
        for (const key of unmatchedKeys(cfg.scenarios, analysed.operations)) {
          analysed.warnings.push(`Scenario overlay '${key}' matches no operation`);
        }
        for (const key of unmatchedKeys(cfg.handlers, analysed.operations)) {
          analysed.warnings.push(`Custom handler '${key}' matches no operation`);
        }
        for (const key of unmatchedIgnore(cfg.validateIgnore, analysed.operations)) {
          analysed.warnings.push(`validateIgnore entry '${key}' matches no operation`);
        }
        const enabled = before ? before.enabled : !disabled.has(id);
        next.set(id, { ...analysed, enabled, loadedAt: new Date().toISOString() });
        if (before && !before.error) {
          const report = diffContracts(before.contract, analysed.contract, "previous-load");
          if (report.changes.length) {
            previousReports.set(id, report);
            log(silent, `${id}: ${report.counts.breaking} breaking, ${report.counts.warning} warning(s) since last load`);
          }
        }
        log(silent, `Loaded ${isUrl(file) ? file : path.basename(file)} (${analysed.specVersion}) – ${analysed.operations.length} operation(s)`);
      } catch (err: any) {
        const message = err?.message ? String(err.message).split("\n")[0] : String(err);
        log(silent, `Could not load ${file}: ${message}`);
        next.set(id, before
          ? { ...before, error: message }
          : {
              id,
              file,
              doc: {},
              warnings: [],
              operations: [],
              contract: { swaggerizer: 1, specId: id, operations: {} },
              basePaths: [],
              enabled: true,
              loadedAt: new Date().toISOString(),
              error: message
            });
      }
    }

    specs.clear();
    // Compiled validators hold the old documents; rebuild them lazily against the new ones.
    validators.clear();
    for (const [id, spec] of next) specs.set(id, spec);
    for (const id of previousReports.keys()) if (!specs.has(id)) previousReports.delete(id);
    refreshSnapshotReports();
    for (const report of snapshotReports) {
      log(silent, `${report.specId} differs from the generated client: ${report.counts.breaking} breaking, ${report.counts.warning} warning(s), ${report.added.length} new, ${report.removed.length} removed`);
    }
    lastReload = new Date().toISOString();
    return getState();
  }

  function reload(): Promise<SwaggerizerState> {
    const run = reloadChain.then(doReload, doReload);
    reloadChain = run.catch(() => undefined);
    return run;
  }

  function watch(target: string) {
    if (!options.watch) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const watcher = fs.watch(target, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          log(silent, "Spec change detected – reloading");
          reload().catch(() => undefined);
        }, 200);
      });
      watchers.push(watcher);
    } catch {
      // watching is best effort
    }
  }

  async function load(inputs: string | string[]): Promise<SwaggerizerState> {
    for (const input of ([] as string[]).concat(inputs)) {
      if (isUrl(input)) {
        if (!sources.some(s => s.path === input)) sources.push({ kind: "url", path: input });
        continue;
      }
      const absolute = path.resolve(input);
      const stat = await fs.promises.stat(absolute);
      const kind = stat.isDirectory() ? "folder" : "file";
      if (!sources.some(s => s.path === absolute)) {
        sources.push({ kind, path: absolute });
        watch(absolute);
      }
    }
    return reload();
  }

  async function loadConfig(config: SwaggerizerConfig): Promise<SwaggerizerState> {
    configHeaders = { ...(config.headers || {}) };
    for (const [id, spec] of Object.entries(config.specs || {})) {
      specConfigs[id] = spec;
      const local = spec.file ? path.resolve(spec.file) : undefined;
      if (local && fs.existsSync(local)) {
        if (!sources.some(s => s.path === local)) {
          sources.push({ kind: "file", path: local, id });
          watch(local);
        }
      } else if (spec.source) {
        if (!sources.some(s => s.path === spec.source)) sources.push({ kind: "url", path: spec.source, id });
      } else {
        throw new Error(`Spec '${id}' needs a \`file\` that exists or a \`source\` URL (run \`swaggerizer pull\`).`);
      }
    }
    return reload();
  }

  /* ------------------------------------------------------------------ mock serving */

  async function proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: string,
    relativePath: string,
    search: string,
    bufferedBody?: Buffer
  ): Promise<number> {
    const upstream = target.replace(/\/+$/, "") + relativePath + search;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (["host", "connection", "content-length", "accept-encoding", SCENARIO_HEADER, VALIDATION_HEADER].includes(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const method = (req.method || "GET").toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : bufferedBody ?? (await readBody(req));
    const response = await fetch(upstream, { method, headers, body: body && body.length ? new Uint8Array(body) : undefined, redirect: "manual" });
    const out = Buffer.from(await response.arrayBuffer());
    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)) return;
      if (name.startsWith("access-control-")) return;
      res.setHeader(name, value);
    });
    res.setHeader("X-Swaggerizer-Proxied", upstream);
    res.end(out);
    return response.status;
  }

  async function serveMock(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const started = Date.now();
    const method = (req.method || "GET").toLowerCase();
    const enabledSpecs = ordered().filter(s => s.enabled && !s.error);
    const allBasePaths = [...new Set(enabledSpecs.flatMap(s => s.basePaths))];
    const allAliases = Object.assign({}, ...enabledSpecs.map(s => configFor(s.id).aliases || {}));
    const op = matchOperation(states(), method, url.pathname, allBasePaths, allAliases);
    if (!op) return false;

    const spec = specs.get(op.specId)!;
    const cfg = configFor(op.specId);
    const override = parseScenarioHeader(req.headers[SCENARIO_HEADER] as string | undefined);
    const mode = validationModeFor(op, req.headers[VALIDATION_HEADER]);
    const resolved = resolveResponse(op, override);
    const custom = lookupByOperation(cfg.handlers, op);
    const wantsHandler = Boolean(custom) && !override && !op.modified;
    const sendsBody = method !== "get" && method !== "head";
    // The request stream can only be read once: buffer it when validation, a custom handler or the
    // proxy needs it, then hand the same buffer to each of them.
    const buffered = sendsBody && (mode !== "off" || wantsHandler || resolved.kind === "proxy")
      ? await readBody(req)
      : undefined;
    const contentType = req.headers["content-type"] as string | undefined;

    // What a custom handler has always received: parsed JSON, or the raw text when it is not JSON.
    let handlerBody: unknown;
    if (buffered && buffered.length > 0) {
      const text = buffered.toString("utf8");
      try {
        handlerBody = text.trim() ? JSON.parse(text) : undefined;
      } catch {
        handlerBody = text;
      }
    }

    let validationBody: unknown;
    let bodyError: string | undefined;
    // A whitespace-only body is no body, for validation as for the handler.
    if (mode !== "off" && buffered && buffered.toString("utf8").trim() !== "") {
      try {
        validationBody = parseRequestBody(buffered, contentType);
      } catch (err: any) {
        bodyError = err?.message ? String(err.message) : String(err);
      }
    }

    const pathParams = candidatePaths(url.pathname, spec.basePaths, cfg.aliases || {})
      .map(p => extractParams(op.route, p))
      .find(p => Object.keys(p).length > 0) ?? {};

    let summary: ValidationSummary | undefined;
    if (mode !== "off") {
      summary = validatorFor(spec).validateRequest(op, {
        params: pathParams,
        query: url.searchParams,
        headers: req.headers,
        ...(validationBody !== undefined ? { body: validationBody } : {}),
        ...(bodyError ? { bodyError } : {}),
        ...(contentType ? { contentType } : {})
      });
      if (summary.request.length === 0 && !summary.skipped) summary = undefined;
    }

    const entry = {
      method: method.toUpperCase(),
      path: url.pathname + url.search,
      route: op.route,
      specId: op.specId,
      source: "server" as const,
      ...(summary ? { validation: summary } : {})
    };

    if (summary && mode === "enforce" && summary.request.length > 0) {
      res.setHeader("X-Swaggerizer-Validation", "failed");
      sendJson(res, 400, {
        error: "Request validation failed",
        operation: `${op.method.toUpperCase()} ${op.route}`,
        specId: op.specId,
        issues: summary.request
      });
      recordRequest({ ...entry, status: 400, example: "validation", ms: Date.now() - started });
      return true;
    }
    if (summary) res.setHeader("X-Swaggerizer-Validation", "warning");

    if (custom && wantsHandler) {
      const body = handlerBody;
      const params = pathParams;
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])
      );
      let outcome: HandlerResult | undefined | void;
      try {
        outcome = await custom(createHandlerContext({ operation: op, method: method.toUpperCase(), path: url.pathname, params, query: url.searchParams, headers, body, store }));
      } catch (err: any) {
        sendJson(res, 500, { error: `Custom handler for ${op.operationId ?? op.key} threw: ${err?.message ?? err}` });
        recordRequest({ ...entry, status: 500, example: "handler error", ms: Date.now() - started });
        return true;
      }
      if (isHandlerResult(outcome)) {
        if (op.delay > 0) await sleep(op.delay);
        const contentType = outcome.contentType ?? (outcome.body !== undefined ? (typeof outcome.body === "string" ? "text/plain" : "application/json") : undefined);
        res.statusCode = outcome.status;
        for (const [name, value] of Object.entries(outcome.headers || {})) res.setHeader(name, value);
        res.setHeader("X-Swaggerizer-Scenario", `${outcome.status}:handler`);
        const payload = outcome.status === 204 || outcome.status === 304 ? undefined : encodeBody(outcome.body, contentType);
        if (payload !== undefined && contentType) res.setHeader("Content-Type", contentType);
        res.end(payload);
        recordRequest({ ...entry, status: outcome.status, example: "handler", contentType, ms: Date.now() - started });
        return true;
      }
    }

    if (resolved.delay > 0) await sleep(resolved.delay);

    if (resolved.kind === "proxy") {
      const target = cfg.proxy || options.proxy || spec.serverUrl;
      if (!target) {
        sendJson(res, 502, { error: `No upstream for ${op.specId}: pass --proxy or declare an absolute URL in servers.` });
        recordRequest({ ...entry, status: 502, example: "proxy", ms: Date.now() - started });
        return true;
      }
      const relative = relativeToBase(url.pathname, spec.basePaths, cfg.aliases || {});
      try {
        const status = await proxy(req, res, target, relative, url.search, buffered);
        recordRequest({ ...entry, status, example: "proxy", ms: Date.now() - started });
      } catch (err: any) {
        sendJson(res, 502, { error: `Proxy to ${target} failed: ${err?.message ?? err}` });
        recordRequest({ ...entry, status: 502, example: "proxy", ms: Date.now() - started });
      }
      return true;
    }

    res.statusCode = resolved.status;
    for (const [name, value] of Object.entries(resolved.headers || {})) res.setHeader(name, value);
    res.setHeader("X-Swaggerizer-Scenario", `${resolved.code}:${resolved.variant}`);
    const payload = resolved.status === 204 || resolved.status === 304 || method === "head"
      ? undefined
      : encodeBody(resolved.body, resolved.contentType);
    if (payload !== undefined && resolved.contentType) res.setHeader("Content-Type", resolved.contentType);
    res.end(payload);
    recordRequest({ ...entry, status: resolved.status, example: resolved.variant, contentType: resolved.contentType, ms: Date.now() - started });
    return true;
  }

  function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
  }

  const admin = registerAdmin({
    basePath,
    ui: options.ui !== false,
    getState,
    select,
    reset,
    setSpecEnabled,
    reload,
    getRequestLog,
    recordRequest,
    getSpecDocument: id => specs.get(id)?.doc,
    getValidation: validationInfo
  });

  function handler(req: http.IncomingMessage, res: http.ServerResponse, next?: () => void) {
    if (options.cors !== false) {
      res.setHeader("Access-Control-Allow-Origin", (req.headers.origin as string) || "*");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Expose-Headers", "X-Swaggerizer-Scenario, X-Swaggerizer-Proxied, X-Swaggerizer-Validation");
      if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", (req.headers["access-control-request-headers"] as string) || "*");
        res.setHeader("Access-Control-Max-Age", "600");
        res.statusCode = 204;
        res.end();
        return;
      }
    }

    const url = new URL(req.url || "/", "http://localhost");
    const isAdmin = url.pathname === basePath || url.pathname.startsWith(basePath + "/");

    (async () => {
      if (isAdmin) {
        let body: any = {};
        if (req.method === "POST" || req.method === "PUT") {
          body = parseRequestBody(await readBody(req), req.headers["content-type"]);
        }
        const request: AdminRequest = {
          method: (req.method || "GET").toUpperCase(),
          path: url.pathname.slice(basePath.length) || "/",
          query: url.searchParams,
          body,
          contentType: req.headers["content-type"]
        };
        if (await admin.handle(request, res)) return;
      } else if (await serveMock(req, res, url)) {
        return;
      } else if (options.fallback) {
        const started = Date.now();
        const method = (req.method || "GET").toUpperCase();
        try {
          const status = await proxy(req, res, options.fallback, url.pathname, url.search);
          recordRequest({ method, path: url.pathname + url.search, status, example: "fallback", source: "server", ms: Date.now() - started });
        } catch (err: any) {
          sendJson(res, 502, { error: `Fallback to ${options.fallback} failed: ${err?.message ?? err}` });
          recordRequest({ method, path: url.pathname + url.search, status: 502, example: "fallback", source: "server", ms: Date.now() - started });
        }
        return;
      }

      if (next) return next();
      const method = (req.method || "GET").toUpperCase();
      sendJson(res, 404, { error: `No operation matches ${method} ${url.pathname}` });
      if (!isAdmin) recordRequest({ method, path: url.pathname + url.search, status: 404, example: "unmatched", source: "server" });
    })().catch(err => {
      if (!res.headersSent) sendJson(res, 400, { error: err?.message ? String(err.message) : String(err) });
      else res.end();
    });
  }

  function listen(port = 8080, host?: string): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => handler(req, res));
      server.once("error", reject);
      server.listen(port, host, () => {
        servers.add(server);
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        log(silent, `Mock API on http://localhost:${actual}`);
        if (options.ui !== false) log(silent, `Admin page at http://localhost:${actual}${basePath}/`);
        resolve(server);
      });
    });
  }

  async function close() {
    for (const w of watchers.splice(0)) w.close();
    await Promise.all(
      [...servers].map(s => new Promise<void>(resolve => {
        s.closeAllConnections?.();
        s.close(() => resolve());
      }))
    );
    servers.clear();
  }

  restoreState();

  return {
    handler,
    load,
    loadConfig,
    reload,
    getState,
    select,
    reset,
    setSpecEnabled,
    getRequestLog,
    recordRequest,
    getSpecDocument: id => specs.get(id)?.doc,
    getValidationInfo: validationInfo,
    listen,
    close,
    endpoint,
    scenarios
  };
}

/** CLI entry point: load specs and listen. */
export async function startSwaggerizer(options: SwaggerizerOptions & { port?: number; host?: string; config?: SwaggerizerConfig }) {
  const swaggerizer = createSwaggerizer(options);
  if (options.config) await swaggerizer.loadConfig(options.config);
  if (options.specs) await swaggerizer.load(options.specs);
  const server = await swaggerizer.listen(options.port ?? 8080, options.host);
  return { ...swaggerizer, server };
}
