/*
 * Shared types. This file must stay free of Node imports: it is used by the server, the MSW
 * runtime (browser + node) and the in-page debug menu.
 */

export type HttpMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";

export const HTTP_METHODS: HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace"
];

/** Variant name used for a response that has a body but no explicit examples in the spec. */
export const GENERATED = "generated";
/** Variant name used for a response that declares no body at all. */
export const EMPTY = "empty";

/** How an operation is answered. */
export type ScenarioMode =
  /** Serve one of the responses declared in the spec (named example or generated sample). */
  | "mock"
  /** Serve a response typed in by hand in the admin page / debug menu. */
  | "custom"
  /** Forward the request to the real API (proxy on the server, `passthrough()` in MSW). */
  | "proxy";

export interface CustomResponse {
  status: number;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

/** What the admin has chosen for one method + route. Every field is optional: unset means default. */
export interface Scenario {
  code?: string;
  example?: string;
  mode?: ScenarioMode;
  custom?: CustomResponse;
  /** Artificial latency in milliseconds. */
  delay?: number;
}

export type ScenarioMap = Record<string, Scenario>;

/** A single named example (or synthesised payload) that a response can serve. */
export interface CatalogueExample {
  name: string;
  summary?: string;
  value: unknown;
}

/** One response code declared for an operation. */
export interface CatalogueResponse {
  /** As written in the spec: "200", "404", "2XX" or "default". */
  code: string;
  /** The HTTP status actually sent for this response. */
  status: number;
  description?: string;
  contentTypes: string[];
  hasBody: boolean;
  examples: CatalogueExample[];
  /** Deterministic sample synthesised from the schema; present when there are no explicit examples. */
  generated?: unknown;
}

/** One HTTP method on one route, as declared by a single spec file. */
export interface CatalogueOperation {
  /** `${method}:${route}` – the key used by the scenario planner. */
  key: string;
  method: HttpMethod;
  /** OpenAPI path template, e.g. `/pets/{petId}`. */
  route: string;
  specId: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated?: boolean;
  responses: CatalogueResponse[];
  defaultCode: string;
  defaultExample: string;
}

export interface OperationState extends CatalogueOperation {
  mode: ScenarioMode;
  selectedCode: string;
  /** The variant that will actually be served (falls back to the first variant of the code). */
  selectedExample: string;
  delay: number;
  custom?: CustomResponse;
  modified: boolean;
  /** False when the spec is disabled or another enabled spec already serves this method + route. */
  active: boolean;
  shadowedBy?: string;
}

/** The parts of a loaded spec the scenario planner needs. */
export interface PlannerSpec {
  id: string;
  enabled: boolean;
  error?: string;
  operations: CatalogueOperation[];
}

/** Everything the MSW runtime needs to know about one spec, embedded in generated code. */
export interface SwaggerizerManifest {
  specId: string;
  title?: string;
  version?: string;
  /** Path prefixes taken from `servers` (e.g. `/v1`); requests may arrive with or without them. */
  basePaths: string[];
  operations: CatalogueOperation[];
  /** Scenario defaults saved from the admin page when the code was generated. */
  scenarios?: ScenarioMap;
}

export interface SpecSummary {
  id: string;
  file: string;
  name: string;
  title?: string;
  version?: string;
  /** "2.0", "3.0.3", "3.1.0"… */
  specVersion?: string;
  enabled: boolean;
  loadedAt: string;
  error?: string;
  warnings: string[];
  basePaths: string[];
  proxyTarget?: string;
  operationCount: number;
}

export interface SwaggerizerState {
  endpoint: string;
  specs: SpecSummary[];
  operations: OperationState[];
  lastReload?: string;
  changes: ChangeReport[];
}

export interface ScenarioSelection extends Scenario {
  method: string;
  route: string;
}

export interface RequestLogEntry {
  id: number;
  time: string;
  method: string;
  path: string;
  route?: string;
  status: number;
  /** Variant served, or "custom" / "proxy" / "unmatched". */
  example: string;
  specId?: string;
  contentType?: string;
  /** "server" for the Node mock server, "msw" for requests reported by the MSW runtime. */
  source: "server" | "msw";
  ms?: number;
}

/* ------------------------------------------------------------------ contract change detection */

export type ChangeSeverity = "breaking" | "warning" | "info";

export type ChangeKind =
  | "operation-added"
  | "operation-removed"
  | "operation-renamed"
  | "operation-deprecated"
  | "parameter-added"
  | "parameter-removed"
  | "parameter-changed"
  | "request-body-added"
  | "request-body-removed"
  | "request-body-changed"
  | "response-added"
  | "response-removed"
  | "response-changed";

export interface ContractChange {
  severity: ChangeSeverity;
  kind: ChangeKind;
  /** e.g. `GET /pets/{petId}` */
  operation: string;
  /** e.g. `response 200 body.items[].name` */
  location?: string;
  message: string;
}

export interface ChangeReport {
  specId: string;
  title?: string;
  /** What the spec was compared against. */
  baseline: "snapshot" | "previous-load";
  fromVersion?: string;
  toVersion?: string;
  added: string[];
  removed: string[];
  changed: string[];
  changes: ContractChange[];
  counts: Record<ChangeSeverity, number>;
}
