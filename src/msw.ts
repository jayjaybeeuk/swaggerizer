/*
 * swaggerizer/msw — runtime for the MSW handlers Swaggerizer generates on top of orval.
 *
 * Every operation gets an MSW handler that answers with the scenario chosen for it: a named
 * example, a custom response, or `passthrough()` to the real API. When a "generated" response is
 * selected the request falls through to orval's faker-based handler. Choices come from:
 *   - a running Swaggerizer server (`server` option) — the admin page drives your browser mocks;
 *   - otherwise local state, persisted in localStorage and editable with the debug menu or API.
 *
 * Works with `setupWorker` (msw/browser) and `setupServer` (msw/node).
 */
import { bypass, delay as mswDelay, getResponse, http, HttpResponse, passthrough } from "msw";
import type { RequestHandler } from "msw";
import {
  applySelection,
  buildOperationStates,
  encodeBody,
  operationKey,
  parseScenarioHeader,
  resolveResponse,
  routeSpecificity,
  scenarioFromState,
  SCENARIO_HEADER,
  toMswPath
} from "./scenario";
import {
  GENERATED,
  type OperationState,
  type ScenarioMap,
  type ScenarioSelection,
  type SwaggerizerManifest,
  type SwaggerizerState
} from "./types";

export * from "./types";
export { operationKey, variantsOf, SCENARIO_HEADER } from "./scenario";

export interface SwaggerizerMswOptions {
  manifests?: SwaggerizerManifest[];
  /** Handlers tried after Swaggerizer's — normally orval's generated `get<Api>Mock()` handlers. */
  fallbackHandlers?: RequestHandler[];
  /** Origin (and optional path) the API is called on, e.g. "https://api.example.com". Default: any origin. */
  baseUrl?: string;
  /** A running Swaggerizer admin endpoint, e.g. "http://localhost:8080/swaggerizer". */
  server?: string;
  /** How long a fetched server state is reused, in ms (default 1000). */
  syncInterval?: number;
  /** Report answered requests to the server's live request log (default true when `server` is set). */
  reportRequests?: boolean;
  /** localStorage key for local choices (browser only). Default "swaggerizer:scenarios"; false disables. */
  storageKey?: string | false;
  /** Initial choices, merged over any saved in the manifests. */
  scenarios?: ScenarioMap;
}

export interface SwaggerizerMocks {
  /** Pass these to `setupWorker(...)` / `setupServer(...)`. */
  handlers: RequestHandler[];
  manifests: SwaggerizerManifest[];
  /** Current state of every operation. */
  operations: () => OperationState[];
  /** Switch one or more operations. In server mode the change is sent to the server too. */
  select: (selection: ScenarioSelection | ScenarioSelection[]) => Promise<OperationState[]>;
  /** Restore defaults for every operation, or one method + route. */
  reset: (filter?: { method?: string; route?: string }) => Promise<void>;
  scenarios: () => ScenarioMap;
  /** Called after every change (local or pulled from the server). Returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Pull the latest choices from the server now. */
  sync: () => Promise<void>;
  readonly server?: string;
}

function hasStorage(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage !== null;
  } catch {
    return false;
  }
}

function loadStored(key: string | false): ScenarioMap {
  if (!key || !hasStorage()) return {};
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") || {};
  } catch {
    return {};
  }
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

export function createSwaggerizerMocks(options: SwaggerizerMswOptions = {}): SwaggerizerMocks {
  const manifests = options.manifests ?? [];
  const fallbackHandlers = options.fallbackHandlers ?? [];
  const server = options.server?.replace(/\/+$/, "");
  const storageKey = options.storageKey === undefined ? "swaggerizer:scenarios" : options.storageKey;
  const syncInterval = options.syncInterval ?? 1000;
  const report = options.reportRequests ?? Boolean(server);
  const base = (options.baseUrl ?? "*").replace(/\/+$/, "");

  const defaults: ScenarioMap = {};
  for (const m of manifests) Object.assign(defaults, m.scenarios || {});
  let scenarios: ScenarioMap = { ...defaults, ...(options.scenarios || {}), ...(server ? {} : loadStored(storageKey)) };

  const planner = manifests.map(m => ({ id: m.specId, enabled: true, operations: m.operations }));
  const listeners = new Set<() => void>();
  let lastSync = 0;
  let syncing: Promise<void> | null = null;
  let remoteStates: OperationState[] | null = null;

  const notify = () => listeners.forEach(fn => {
    try {
      fn();
    } catch {
      // listeners must not break request handling
    }
  });

  const persist = () => {
    if (server || !storageKey || !hasStorage()) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(scenarios));
    } catch {
      // storage full or blocked: choices stay in memory
    }
  };

  function operations(): OperationState[] {
    const local = buildOperationStates(planner, scenarios);
    if (!remoteStates) return local;
    const byKey = new Map(remoteStates.filter(s => s.active).map(s => [s.key, s]));
    return local.map(op => {
      const remote = byKey.get(op.key);
      return remote ? { ...op, ...pickScenario(remote), active: op.active } : op;
    });
  }

  function pickScenario(s: OperationState) {
    return {
      mode: s.mode,
      selectedCode: s.selectedCode,
      selectedExample: s.selectedExample,
      delay: s.delay,
      custom: s.custom,
      modified: s.modified
    };
  }

  async function serverFetch(path: string, init?: RequestInit): Promise<any> {
    const response = await fetch(bypass(joinUrl(server!, path), init));
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error || `Swaggerizer server answered ${response.status}`);
    return json;
  }

  async function sync(): Promise<void> {
    if (!server) return;
    if (!syncing) {
      syncing = serverFetch("/api/state")
        .then((state: SwaggerizerState) => {
          const before = JSON.stringify(remoteStates);
          remoteStates = state.operations;
          lastSync = Date.now();
          if (JSON.stringify(remoteStates) !== before) notify();
        })
        .catch(() => {
          // Server unreachable: keep serving the last known (or local default) choices.
          lastSync = Date.now();
        })
        .finally(() => {
          syncing = null;
        });
    }
    return syncing;
  }

  async function freshOperations(): Promise<OperationState[]> {
    if (server && Date.now() - lastSync > syncInterval) await sync();
    return operations();
  }

  function reportRequest(entry: Record<string, unknown>) {
    if (!report || !server) return;
    serverFetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry)
    }).catch(() => undefined);
  }

  async function select(selection: ScenarioSelection | ScenarioSelection[]): Promise<OperationState[]> {
    const list = Array.isArray(selection) ? selection : [selection];
    if (server) {
      const result = await serverFetch("/api/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(list)
      });
      lastSync = 0;
      await sync();
      return result.operations;
    }
    const current = operations();
    const next = { ...scenarios };
    const keys: string[] = [];
    for (const item of list) {
      const key = operationKey(item.method, item.route);
      const op = current.find(o => o.key === key && o.active) || current.find(o => o.key === key);
      if (!op) throw new Error(`No operation ${String(item.method).toUpperCase()} ${item.route} in the manifests.`);
      next[key] = applySelection(op, item, scenarios[key] ?? scenarioFromState(op));
      keys.push(key);
    }
    scenarios = next;
    persist();
    notify();
    const after = operations();
    return keys.map(k => after.find(o => o.key === k)!);
  }

  async function reset(filter: { method?: string; route?: string } = {}): Promise<void> {
    if (server) {
      await serverFetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filter)
      });
      lastSync = 0;
      await sync();
      return;
    }
    const next: ScenarioMap = {};
    for (const [key, value] of Object.entries(scenarios)) {
      const [method, ...rest] = key.split(":");
      const matches =
        (!filter.method || method === String(filter.method).toLowerCase()) &&
        (!filter.route || rest.join(":") === filter.route);
      if (!matches) next[key] = value;
    }
    // Reset means "spec default", not "generated-time default": drop manifest scenarios too.
    scenarios = next;
    persist();
    notify();
  }

  const allOps = manifests.flatMap(m => m.operations.map(op => ({ op, manifest: m })));
  const seen = new Set<string>();
  const unique = allOps.filter(({ op }) => (seen.has(op.key) ? false : (seen.add(op.key), true)));
  unique.sort((a, b) => routeSpecificity(a.op, b.op));

  // orval's handler for each operation, so a "generated" response is produced by exactly that
  // handler — not by whichever less specific route happens to match next in the chain.
  const shapeOf = (p: unknown) => (typeof p === "string" ? p.replace(/^\*/, "").replace(/:[^/]+/g, ":") : undefined);
  const fallbackFor = new Map<string, RequestHandler>();
  for (const { op } of unique) {
    const shape = toMswPath(op.route).replace(/:[^/]+/g, ":");
    const candidates = fallbackHandlers.filter(h => String((h as any).info?.method ?? "").toLowerCase() === op.method);
    const found =
      candidates.find(h => shapeOf((h as any).info?.path) === shape) ||
      candidates.find(h => shapeOf((h as any).info?.path)?.endsWith(shape));
    if (found) fallbackFor.set(op.key, found);
  }

  const ownHandlers: RequestHandler[] = unique.map(({ op }) => {
    const path = `${base}${toMswPath(op.route)}`;
    const factory = (http as any)[op.method] as typeof http.get;
    return factory(path, async ({ request }) => {
      const started = Date.now();
      const state = (await freshOperations()).find(o => o.key === op.key && o.active);
      if (!state) return undefined;
      const override = parseScenarioHeader(request.headers.get(SCENARIO_HEADER));
      const resolved = resolveResponse(state, override);
      if (resolved.delay > 0) await mswDelay(resolved.delay);
      const url = new URL(request.url);
      const entry = { method: request.method, path: url.pathname + url.search, route: op.route, specId: op.specId };

      if (resolved.kind === "proxy") {
        reportRequest({ ...entry, status: 0, example: "proxy", ms: Date.now() - started });
        return passthrough();
      }

      const fallback = fallbackFor.get(op.key);
      if (fallback && resolved.variant === GENERATED && resolved.status >= 200 && resolved.status < 300) {
        // Let orval's faker handler for this operation produce the body.
        const response = await getResponse([fallback], request.clone());
        if (response) {
          reportRequest({ ...entry, status: response.status, example: "generated (orval)", ms: Date.now() - started });
          return response;
        }
      }

      const headers: Record<string, string> = { ...(resolved.headers || {}), "X-Swaggerizer-Scenario": `${resolved.code}:${resolved.variant}` };
      const noBody = resolved.status === 204 || resolved.status === 304 || request.method === "HEAD";
      const payload = noBody ? undefined : encodeBody(resolved.body, resolved.contentType);
      if (payload !== undefined && resolved.contentType) headers["Content-Type"] = resolved.contentType;
      reportRequest({ ...entry, status: resolved.status, example: resolved.variant, ms: Date.now() - started });
      return new HttpResponse(payload ?? null, { status: resolved.status, headers });
    });
  });

  if (server) void sync();

  return {
    handlers: [...ownHandlers, ...fallbackHandlers],
    manifests,
    operations,
    select,
    reset,
    scenarios: () => ({ ...scenarios }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync: async () => {
      lastSync = 0;
      await sync();
    },
    server
  };
}
