/*
 * swaggerizer/config — the `swaggerizer.config.ts` shape, scenario overlays and custom handlers.
 * Browser-safe: a config file (and the fixtures it imports) can be shared with the MSW runtime.
 */
import { operationKey } from "./scenario";
import { GENERATED, type CatalogueOperation, type CatalogueResponse, type OperationState } from "./types";

/** One named scenario added to an operation from code, e.g. an existing typed fixture. */
export interface ScenarioOverlay {
  /** HTTP status; the scenario is filed under this response code (created if the spec lacks it). */
  status: number;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  summary?: string;
}

/** Overlays for one spec: `{ getBusinessRewards: { populated: {...}, empty: {...} } }`. Keys are operationIds or `"GET /route"`. */
export type ScenarioOverlays = Record<string, Record<string, ScenarioOverlay>>;

export interface HandlerResult {
  readonly __swaggerizer: "result";
  status: number;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface HandlerContext {
  operation: OperationState;
  method: string;
  /** Request path as received. */
  path: string;
  /** Path parameters by name, e.g. `{ businessId: "123" }`. */
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** Parsed JSON request body, or the raw text when it is not JSON. */
  body: unknown;
  /** State shared by every handler; cleared by "Reset all". */
  store: Map<string, unknown>;
  /** Respond with JSON (or any body). */
  json: (body: unknown, status?: number, headers?: Record<string, string>) => HandlerResult;
  /** Respond with a status and no body. */
  empty: (status?: number, headers?: Record<string, string>) => HandlerResult;
}

/**
 * Custom behaviour for one operation: paging, stateful journeys, data-dependent answers.
 * Runs only while the operation serves its default scenario (not switched in the admin page or
 * by header). Return `undefined` to fall back to the normal response.
 */
export type CustomHandler = (ctx: HandlerContext) => HandlerResult | undefined | void | Promise<HandlerResult | undefined | void>;

export type CustomHandlers = Record<string, CustomHandler>;

export interface SpecConfig {
  /** Local spec file (committed). Written by `swaggerizer pull` when `source` is set. */
  file?: string;
  /** URL to pull the spec from (or to load directly when there is no `file`), e.g. springdoc's `/v3/api-docs`. */
  source?: string;
  /** Request headers for `source`, e.g. `{ Authorization: \`Bearer ${process.env.API_DOCS_TOKEN}\` }`. */
  headers?: Record<string, string>;
  /** Request path prefixes rewritten before matching: `{ "/online-banking/bff/v4/": "/v4/online-banking/" }`. */
  aliases?: Record<string, string>;
  /** Folder for the generated client, models and contract snapshot. Default `<output>/<id>`. */
  output?: string;
  /** Folder for the generated MSW handlers, faker data and Swaggerizer wrapper. Default: `output`. */
  mocksOutput?: string;
  /** Extra orval `output` options for this spec (client, mode, override.mutator…). */
  orval?: Record<string, unknown>;
  /** Upstream for "Real API" mode. Default: the spec's first absolute `servers` URL. */
  proxy?: string;
  scenarios?: ScenarioOverlays;
  handlers?: CustomHandlers;
}

export interface SwaggerizerConfig {
  specs: Record<string, SpecConfig>;
  port?: number;
  host?: string;
  endpoint?: string;
  /** Default latency for every operation, in ms. */
  delay?: number;
  /** Request headers for every spec URL (a spec's own `headers` win). */
  headers?: Record<string, string>;
  /** Requests that match no operation are proxied here (e.g. a legacy mock server during migration). */
  fallback?: string;
  stateFile?: string;
  /** Root folder for generated code when a spec has no `output`. */
  output?: string;
  /** orval client for every spec (default "fetch"). */
  client?: string;
  runtimeImport?: string;
  /** tsconfig whose `paths` are used to resolve imports in this config file (default ./tsconfig.base.json or ./tsconfig.json). */
  tsconfig?: string;
}

export function defineConfig(config: SwaggerizerConfig): SwaggerizerConfig {
  return config;
}

export function result(body: unknown, status = 200, headers?: Record<string, string>, contentType?: string): HandlerResult {
  return {
    __swaggerizer: "result",
    status,
    ...(body !== undefined ? { body } : {}),
    ...(headers ? { headers } : {}),
    ...(contentType ? { contentType } : {})
  };
}

export function isHandlerResult(value: unknown): value is HandlerResult {
  return Boolean(value && typeof value === "object" && (value as any).__swaggerizer === "result");
}

/** Finds the entry for an operation in a map keyed by operationId or `"METHOD /route"`. */
export function lookupByOperation<T>(map: Record<string, T> | undefined, op: Pick<CatalogueOperation, "operationId" | "method" | "route">): T | undefined {
  if (!map) return undefined;
  if (op.operationId && map[op.operationId] !== undefined) return map[op.operationId];
  const spaced = `${op.method.toUpperCase()} ${op.route}`;
  if (map[spaced] !== undefined) return map[spaced];
  return map[operationKey(op.method, op.route)];
}

/** Keys in an overlay or handler map that match no operation (typos, removed operations). */
export function unmatchedKeys(map: Record<string, unknown> | undefined, operations: CatalogueOperation[]): string[] {
  if (!map) return [];
  return Object.keys(map).filter(
    key =>
      !operations.some(
        op => op.operationId === key || `${op.method.toUpperCase()} ${op.route}` === key || op.key === key
      )
  );
}

/**
 * Adds overlay scenarios to the catalogue. They come first, so the first overlay of a success
 * code becomes the default. A synthesised body stays available as "generated".
 */
export function applyOverlays(operations: CatalogueOperation[], overlays: ScenarioOverlays | undefined): CatalogueOperation[] {
  if (!overlays) return operations;
  return operations.map(op => {
    const named = lookupByOperation(overlays, op);
    if (!named || Object.keys(named).length === 0) return op;
    const responses: CatalogueResponse[] = op.responses.map(r => ({ ...r, examples: [...r.examples] }));
    const added = new Map<string, CatalogueResponse>();

    for (const [name, overlay] of Object.entries(named)) {
      const code = String(overlay.status);
      let response = responses.find(r => r.code === code) ?? responses.find(r => r.status === overlay.status);
      if (!response) {
        response = {
          code,
          status: overlay.status,
          description: "Scenario overlay",
          contentTypes: overlay.body !== undefined ? [overlay.contentType ?? "application/json"] : [],
          hasBody: overlay.body !== undefined,
          examples: []
        };
        responses.push(response);
      }
      if (!added.has(response.code)) {
        added.set(response.code, response);
        // Keep the schema-generated body selectable once named examples exist.
        if (response.examples.length === 0 && response.generated !== undefined) {
          response.examples.push({ name: GENERATED, value: response.generated });
        }
      }
      const overlayExamples = response.examples.filter(e => e.overlay);
      const rest = response.examples.filter(e => !e.overlay && e.name !== name);
      response.examples = [
        ...overlayExamples,
        {
          name,
          value: overlay.body,
          overlay: true,
          ...(overlay.summary ? { summary: overlay.summary } : {}),
          ...(overlay.contentType ? { contentType: overlay.contentType } : {}),
          ...(overlay.headers ? { headers: overlay.headers } : {})
        },
        ...rest
      ];
      if (overlay.body !== undefined) response.hasBody = true;
    }

    responses.sort((a, b) => a.status - b.status || a.code.localeCompare(b.code));
    const success = responses.find(r => r.status >= 200 && r.status < 300) ?? responses[0];
    const defaultCode = success ? success.code : op.defaultCode;
    const defaultExample = success?.examples[0]?.name ?? op.defaultExample;
    return { ...op, responses, defaultCode, defaultExample };
  });
}

/** Path parameters of `route` in `path` (path relative to any base path). */
export function extractParams(route: string, path: string): Record<string, string> {
  const names = [...route.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
  if (names.length === 0) return {};
  const pattern = route
    .split(/(\{[^}]+\})/)
    .map(part => (/^\{[^}]+\}$/.test(part) ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  const match = new RegExp(`^${pattern}/?$`).exec(path);
  if (!match) return {};
  return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
}

export function createHandlerContext(base: Omit<HandlerContext, "json" | "empty">): HandlerContext {
  return {
    ...base,
    json: (body, status = 200, headers) => result(body, status, headers),
    empty: (status = 204, headers) => result(undefined, status, headers)
  };
}
