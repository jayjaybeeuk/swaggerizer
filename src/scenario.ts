/*
 * The scenario planner: which response each operation serves. Pure and browser-safe — shared by
 * the Node mock server, the MSW runtime and the in-page debug menu so they all behave the same.
 */
import {
  EMPTY,
  GENERATED,
  type CatalogueOperation,
  type CatalogueResponse,
  type CustomResponse,
  type OperationState,
  type PlannerSpec,
  type Scenario,
  type ScenarioMap,
  type ScenarioMode,
  type ScenarioSelection
} from "./types";

export const SCENARIO_HEADER = "x-swaggerizer-scenario";
const MODES: ScenarioMode[] = ["mock", "custom", "proxy"];
const MAX_DELAY_MS = 120_000;

export function operationKey(method: string, route: string): string {
  return `${String(method).toLowerCase()}:${route}`;
}

export interface Variant {
  code: string;
  example: string;
  /** "example" for a named example, "generated" for a synthesised body, "empty" for no body. */
  kind: "example" | "generated" | "empty";
  value: unknown;
  response: CatalogueResponse;
}

/** Every selectable (code, example) pair for an operation. */
export function variantsOf(op: CatalogueOperation): Variant[] {
  const list: Variant[] = [];
  for (const response of op.responses) {
    if (response.examples.length > 0) {
      for (const ex of response.examples) {
        list.push({ code: response.code, example: ex.name, kind: "example", value: ex.value, response });
      }
    } else if (response.hasBody) {
      list.push({ code: response.code, example: GENERATED, kind: "generated", value: response.generated, response });
    } else {
      list.push({ code: response.code, example: EMPTY, kind: "empty", value: undefined, response });
    }
  }
  return list;
}

function findResponse(op: CatalogueOperation, code: string): CatalogueResponse | undefined {
  return (
    op.responses.find(r => r.code === code) ||
    op.responses.find(r => String(r.status) === code) ||
    op.responses.find(r => r.code.toUpperCase() === code.toUpperCase())
  );
}

/** The variant that will actually be served for a code + requested example name. */
export function effectiveExample(op: CatalogueOperation, code: string, requested?: string): string {
  const variants = variantsOf(op).filter(v => v.code === code);
  if (variants.length === 0) return EMPTY;
  return (variants.find(v => v.example === requested) || variants[0]).example;
}

/**
 * Combines every loaded spec with the scenario map. Specs are evaluated in order, so when two
 * enabled specs declare the same method + route the first one serves it and the others are
 * reported as shadowed.
 */
export function buildOperationStates(specs: PlannerSpec[], scenarios: ScenarioMap): OperationState[] {
  const servedBy = new Map<string, string>();
  const states: OperationState[] = [];
  for (const spec of specs) {
    for (const op of spec.operations) {
      let active = spec.enabled && !spec.error;
      let shadowedBy: string | undefined;
      if (active) {
        const owner = servedBy.get(op.key);
        if (owner) {
          active = false;
          shadowedBy = owner;
        } else {
          servedBy.set(op.key, spec.id);
        }
      }
      states.push({ ...stateOf(op, scenarios[op.key]), active, ...(shadowedBy ? { shadowedBy } : {}) });
    }
  }
  return states;
}

export function stateOf(op: CatalogueOperation, scenario: Scenario = {}): OperationState {
  const response = scenario.code ? findResponse(op, scenario.code) : undefined;
  const selectedCode = response ? response.code : op.defaultCode;
  const selectedExample = effectiveExample(op, selectedCode, scenario.example);
  const mode: ScenarioMode = scenario.mode && MODES.includes(scenario.mode) ? scenario.mode : "mock";
  const delay = Math.max(0, Number(scenario.delay) || 0);
  const modified =
    mode !== "mock" ||
    delay > 0 ||
    selectedCode !== op.defaultCode ||
    selectedExample !== effectiveExample(op, op.defaultCode, op.defaultExample);
  return {
    ...op,
    mode,
    selectedCode,
    selectedExample,
    delay,
    ...(scenario.custom ? { custom: scenario.custom } : {}),
    modified,
    active: true
  };
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function normaliseCustom(raw: any, label: string): CustomResponse {
  if (!raw || typeof raw !== "object") throw new Error(`${label}: custom must be an object with a status.`);
  const status = Number(raw.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`${label}: custom.status must be an HTTP status between 100 and 599.`);
  }
  let body = raw.body;
  let contentType = isSet(raw.contentType) ? String(raw.contentType) : undefined;
  // Bodies typed into a form arrive as strings: keep JSON as data so it is re-serialised cleanly.
  if (typeof body === "string" && (!contentType || /json/i.test(contentType))) {
    const trimmed = body.trim();
    if (trimmed === "") body = undefined;
    else {
      try {
        body = JSON.parse(trimmed);
      } catch {
        if (contentType) throw new Error(`${label}: custom.body is not valid JSON.`);
        // Not JSON and no content type given: send it exactly as typed.
        contentType = "text/plain";
      }
    }
  }
  const headers: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === "object") {
    for (const [k, v] of Object.entries(raw.headers)) headers[k] = String(v);
  }
  return {
    status,
    ...(body !== undefined ? { body } : {}),
    ...(contentType ? { contentType } : {}),
    ...(Object.keys(headers).length ? { headers } : {})
  };
}

/**
 * Validates a selection against an operation and returns the complete scenario to store. Throws a
 * readable error for unknown codes, examples or modes. Unset fields keep their current value.
 */
export function applySelection(op: CatalogueOperation, selection: Partial<ScenarioSelection>, current: Scenario = {}): Scenario {
  const label = `${op.method.toUpperCase()} ${op.route}`;
  const next: Scenario = { ...current };

  if (isSet(selection.mode)) {
    const mode = String(selection.mode) as ScenarioMode;
    if (!MODES.includes(mode)) throw new Error(`${label}: mode must be one of ${MODES.join(", ")}.`);
    next.mode = mode;
  }

  let code = isSet(selection.code) ? String(selection.code) : undefined;
  const example = isSet(selection.example) ? String(selection.example) : undefined;

  if (!code && example) {
    // Allow `?example=notFound` on its own: find the response that declares it.
    const owner = variantsOf(op).find(v => v.example === example);
    if (!owner) throw new Error(`${label} has no example named '${example}'.`);
    code = owner.code;
  }

  if (code) {
    const response = findResponse(op, code);
    if (!response) throw new Error(`${label} does not declare a ${code} response.`);
    code = response.code;
    if (example) {
      const known = variantsOf(op).some(v => v.code === code && v.example === example);
      if (!known) throw new Error(`The ${code} response of ${label} has no example named '${example}'.`);
    }
    next.code = code;
    next.example = example ?? effectiveExample(op, code);
    if (!isSet(selection.mode)) next.mode = "mock";
  }

  if (selection.custom !== undefined && selection.custom !== null) {
    next.custom = normaliseCustom(selection.custom, label);
    if (!isSet(selection.mode)) next.mode = "custom";
  }

  if (next.mode === "custom" && !next.custom) {
    // Start the editor from whatever is currently being served.
    const state = stateOf(op, current);
    const variant = variantsOf(op).find(v => v.code === state.selectedCode && v.example === state.selectedExample);
    next.custom = {
      status: variant?.response.status ?? 200,
      ...(variant?.value !== undefined ? { body: variant.value } : {})
    };
  }

  if (isSet(selection.delay)) {
    const delay = Number(selection.delay);
    if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_MS) {
      throw new Error(`${label}: delay must be between 0 and ${MAX_DELAY_MS} ms.`);
    }
    next.delay = Math.round(delay);
  }

  if (next.mode === "mock") delete next.mode;
  if (!next.delay) delete next.delay;
  return next;
}

/** Parses the per-request override header: `404`, `404:notFound`, `notFound`, `proxy`, `custom`. */
export function parseScenarioHeader(value: string | null | undefined): Partial<Scenario> | undefined {
  if (!value) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if ((MODES as string[]).includes(raw)) return { mode: raw as ScenarioMode };
  const [first, ...rest] = raw.split(":");
  if (/^(\d{3}|[1-5]XX|default)$/i.test(first)) {
    return { code: first, ...(rest.length ? { example: rest.join(":") } : {}), mode: "mock" };
  }
  return { example: raw, mode: "mock" };
}

export type ResolvedResponse =
  | { kind: "proxy"; delay: number }
  | {
      kind: "respond";
      status: number;
      contentType?: string;
      headers?: Record<string, string>;
      body: unknown;
      /** Variant name served: an example name, "generated", "empty" or "custom". */
      variant: string;
      code: string;
      delay: number;
    };

/** Decides what to send for one request to an operation. */
export function resolveResponse(op: OperationState, override?: Partial<Scenario>): ResolvedResponse {
  let state = op;
  if (override) {
    try {
      state = { ...op, ...stateOf(op, applySelection(op, override, scenarioFromState(op))) };
    } catch {
      // An override that does not fit this operation is ignored rather than failing the request.
    }
  }

  if (state.mode === "proxy") return { kind: "proxy", delay: state.delay };

  if (state.mode === "custom" && state.custom) {
    return {
      kind: "respond",
      status: state.custom.status,
      contentType: state.custom.contentType ?? (state.custom.body !== undefined ? "application/json" : undefined),
      headers: state.custom.headers,
      body: state.custom.body,
      variant: "custom",
      code: String(state.custom.status),
      delay: state.delay
    };
  }

  const variant = variantsOf(state).find(v => v.code === state.selectedCode && v.example === state.selectedExample);
  if (!variant) {
    return { kind: "respond", status: 200, body: {}, contentType: "application/json", variant: EMPTY, code: "200", delay: state.delay };
  }
  const contentType =
    variant.response.contentTypes.find(t => /json/i.test(t)) || variant.response.contentTypes[0];
  return {
    kind: "respond",
    status: variant.response.status,
    contentType,
    body: variant.kind === "empty" ? undefined : variant.value,
    variant: variant.example,
    code: variant.code,
    delay: state.delay
  };
}

export function scenarioFromState(op: OperationState): Scenario {
  return {
    code: op.selectedCode,
    example: op.selectedExample,
    ...(op.mode !== "mock" ? { mode: op.mode } : {}),
    ...(op.custom ? { custom: op.custom } : {}),
    ...(op.delay ? { delay: op.delay } : {})
  };
}

/** Serialises a resolved body for the wire. */
export function encodeBody(body: unknown, contentType?: string): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string" && contentType && !/json/i.test(contentType)) return body;
  return JSON.stringify(body);
}

/* ------------------------------------------------------------------ routing */

interface CompiledRoute {
  regex: RegExp;
  statics: number;
  params: number;
}

const routeCache = new Map<string, CompiledRoute>();

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileRoute(route: string): CompiledRoute {
  const cached = routeCache.get(route);
  if (cached) return cached;
  let statics = 0;
  let params = 0;
  const pattern = route
    .split("/")
    .map(segment => {
      if (!segment) return "";
      if (/\{[^}]+\}/.test(segment)) {
        params++;
        return segment
          .split(/(\{[^}]+\})/)
          .map(part => (/^\{[^}]+\}$/.test(part) ? "([^/]+)" : escapeRegex(part)))
          .join("");
      }
      statics++;
      return escapeRegex(segment);
    })
    .join("/");
  const compiled = { regex: new RegExp(`^${pattern || "/"}/?$`), statics, params };
  routeCache.set(route, compiled);
  return compiled;
}

/** Converts `/pets/{petId}` to the `/pets/:petId` syntax used by MSW. */
export function toMswPath(route: string): string {
  return route.replace(/\{([^}]+)\}/g, (_m, name: string) => `:${name.replace(/[^A-Za-z0-9_]/g, "_")}`);
}

/** Static segments beat templated ones, so `/pets/mine` wins over `/pets/{petId}`. */
export function routeSpecificity(a: { route: string }, b: { route: string }): number {
  const ra = compileRoute(a.route);
  const rb = compileRoute(b.route);
  return rb.statics - ra.statics || ra.params - rb.params || a.route.localeCompare(b.route);
}

export interface Routable {
  method: string;
  route: string;
  active: boolean;
}

/**
 * Finds the active operation that serves `method` + `pathname`, trying the path as-is and with
 * each known base path (from `servers`) stripped.
 */
export function matchOperation<T extends Routable>(
  operations: T[],
  method: string,
  pathname: string,
  basePaths: string[] = []
): T | undefined {
  const m = method.toLowerCase();
  const candidates = operations.filter(op => op.active && op.method === m).sort(routeSpecificity);
  const paths = [pathname];
  for (const base of basePaths) {
    if (base && (pathname === base || pathname.startsWith(base + "/"))) {
      paths.push(pathname.slice(base.length) || "/");
    }
  }
  for (const path of paths) {
    const found = candidates.find(op => compileRoute(op.route).regex.test(path));
    if (found) return found;
  }
  return undefined;
}
