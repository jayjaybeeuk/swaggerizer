/*
 * The admin API and page. Every scenario switch is available three ways:
 *   GET  {base}/api/select?method=get&route=/pets&code=500        (links, bookmarks, a browser bar)
 *   POST {base}/api/select  JSON  {method, route, code?, example?, mode?, delay?, custom?}
 *   POST {base}/api/select  form  method=get&route=/pets&code=500  (plain HTML <form>)
 */
import type http from "node:http";
import { createUiAssetServer, type UiAsset } from "./ui-assets";
import type {
  OperationState,
  RequestLogEntry,
  ScenarioSelection,
  SpecSummary,
  SwaggerizerState,
  ValidationInfo,
  ValidationSummary
} from "./types";

export interface AdminContext {
  basePath: string;
  ui: boolean;
  getState: () => SwaggerizerState;
  select: (selection: ScenarioSelection | ScenarioSelection[]) => OperationState[];
  reset: (filter?: { method?: string; route?: string }) => number;
  setSpecEnabled: (id: string, enabled: boolean) => SpecSummary;
  reload: () => Promise<SwaggerizerState>;
  getRequestLog: (sinceId?: number) => RequestLogEntry[];
  recordRequest: (entry: Omit<RequestLogEntry, "id" | "time">) => RequestLogEntry;
  getSpecDocument: (id: string) => any;
  getValidation: () => ValidationInfo;
}

export interface AdminRequest {
  method: string;
  /** Path below the admin base, always starting with "/". */
  path: string;
  query: URLSearchParams;
  body: any;
  contentType?: string;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function blank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** MSW reports request summaries to the live log; keep only the fields the page renders. */
function toValidation(raw: any): ValidationSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const text = (value: unknown, max = 200): string | undefined =>
    typeof value === "string" && value !== "" ? value.slice(0, max) : undefined;
  const request = (Array.isArray(raw.request) ? raw.request : [])
    .slice(0, 20)
    .map((issue: any) => ({
      location: text(issue?.location, 120) ?? "request",
      message: text(issue?.message) ?? "is invalid",
      ...(text(issue?.keyword, 40) ? { keyword: text(issue?.keyword, 40) } : {})
    }));
  const skipped = text(raw.skipped, 60);
  if (request.length === 0 && !skipped) return undefined;
  return { request, ...(skipped ? { skipped } : {}) };
}

/**
 * Turns a flat record (query string, form post or JSON) into a selection. Accepts the ramlizer
 * names (`nextResponseCode`, `nextExampleName`) and flat custom fields (`status`, `body`, `contentType`).
 */
export function toSelection(raw: Record<string, any>): ScenarioSelection {
  const selection: ScenarioSelection = {
    method: raw?.method,
    route: raw?.route,
    code: raw?.code ?? raw?.nextResponseCode,
    example: raw?.example ?? raw?.nextExampleName
  };
  if (!blank(raw?.mode)) selection.mode = raw.mode;
  if (!blank(raw?.delay)) selection.delay = Number(raw.delay);
  if (raw?.custom && typeof raw.custom === "object") {
    selection.custom = raw.custom;
  } else if (!blank(raw?.status)) {
    selection.custom = {
      status: Number(raw.status),
      ...(raw.body !== undefined ? { body: raw.body } : {}),
      ...(!blank(raw.contentType) ? { contentType: raw.contentType } : {})
    };
  }
  for (const key of Object.keys(selection) as Array<keyof ScenarioSelection>) {
    if (blank(selection[key])) delete selection[key];
  }
  return selection;
}

export function registerAdmin(ctx: AdminContext) {
  const assets = createUiAssetServer(ctx.basePath);
  const assetFor: Record<string, UiAsset> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/app.css": "app.css"
  };

  async function handle(req: AdminRequest, res: http.ServerResponse): Promise<boolean> {
    const { method, path, query } = req;
    const isForm = Boolean(req.contentType && /x-www-form-urlencoded/i.test(req.contentType));

    // Form posts from a plain HTML page can ask to be sent back somewhere afterwards.
    const finish = (payload: unknown) => {
      const redirect = (req.body && req.body.redirect) || query.get("redirect");
      if (isForm && typeof redirect === "string" && redirect.startsWith("/")) {
        res.statusCode = 303;
        res.setHeader("Location", redirect);
        res.end();
        return;
      }
      sendJson(res, 200, payload);
    };

    try {
      // ramlizer-compatible configuration endpoint.
      if (method === "POST" && path === "/") {
        const operations = ctx.select(toSelection(req.body || {}));
        finish({ route: req.body?.route, operations });
        return true;
      }

      if (method === "GET" && path === "/api/state") {
        sendJson(res, 200, ctx.getState());
        return true;
      }

      if (path === "/api/select" && (method === "GET" || method === "POST")) {
        const source = method === "GET" ? Object.fromEntries(query) : req.body;
        const selection = Array.isArray(source) ? source.map(toSelection) : toSelection(source || {});
        finish({ operations: ctx.select(selection) });
        return true;
      }

      if (path === "/api/reset" && (method === "GET" || method === "POST")) {
        const source = method === "GET" ? Object.fromEntries(query) : req.body || {};
        const reset = ctx.reset({ method: source.method || undefined, route: source.route || undefined });
        finish({ reset, state: ctx.getState() });
        return true;
      }

      if (method === "POST" && path === "/api/spec") {
        const { id } = req.body || {};
        const enabled = req.body?.enabled === true || req.body?.enabled === "true";
        if (typeof id !== "string" || (req.body?.enabled === undefined)) {
          throw new Error('Expected a body of {"id": string, "enabled": boolean}.');
        }
        const spec = ctx.setSpecEnabled(id, enabled);
        finish({ spec, state: ctx.getState() });
        return true;
      }

      if (method === "POST" && path === "/api/reload") {
        sendJson(res, 200, await ctx.reload());
        return true;
      }

      if (method === "GET" && path === "/api/changes") {
        sendJson(res, 200, { changes: ctx.getState().changes });
        return true;
      }

      if (method === "GET" && path === "/api/validation") {
        sendJson(res, 200, ctx.getValidation());
        return true;
      }

      if (path === "/api/log") {
        if (method === "GET") {
          const since = Number(query.get("since") || 0);
          sendJson(res, 200, { entries: ctx.getRequestLog(Number.isFinite(since) ? since : 0) });
          return true;
        }
        if (method === "POST") {
          // Lets the MSW runtime report requests it answered in the browser or in tests.
          const items: any[] = Array.isArray(req.body) ? req.body : [req.body];
          const entries = items.slice(0, 50).map(item => {
            const validation = toValidation(item?.validation);
            return ctx.recordRequest({
              method: String(item?.method || "GET").toUpperCase(),
              path: String(item?.path || ""),
              ...(item?.route ? { route: String(item.route) } : {}),
              status: Number(item?.status) || 0,
              example: String(item?.example || ""),
              ...(item?.specId ? { specId: String(item.specId) } : {}),
              ...(item?.ms !== undefined ? { ms: Number(item.ms) } : {}),
              ...(validation ? { validation } : {}),
              source: "msw"
            });
          });
          sendJson(res, 200, { recorded: entries.length });
          return true;
        }
      }

      const openapi = /^\/api\/openapi\/([^/]+?)(\.json)?$/.exec(path);
      if (method === "GET" && openapi) {
        const doc = ctx.getSpecDocument(decodeURIComponent(openapi[1]));
        if (!doc) {
          sendJson(res, 404, { error: `No spec with id '${openapi[1]}' is loaded.` });
        } else {
          sendJson(res, 200, doc);
        }
        return true;
      }

      if (ctx.ui && method === "GET" && assetFor[path]) {
        assets.serve(assetFor[path], res);
        return true;
      }
    } catch (err: any) {
      sendJson(res, 400, { error: err?.message ? String(err.message) : String(err) });
      return true;
    }

    if (path.startsWith("/api/")) {
      sendJson(res, 404, { error: `Unknown admin route ${method} ${ctx.basePath}${path}` });
      return true;
    }
    return false;
  }

  return { handle, uiAvailable: ctx.ui && assets.available };
}
