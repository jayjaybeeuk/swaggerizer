/*
 * Contract snapshots and change detection.
 *
 * A contract is a normalised, acyclic summary of an OpenAPI document: every operation with its
 * parameters, request body and response schemas. Swaggerizer saves one next to the generated code
 * and compares new specs against it, so you are warned about new, removed and changed APIs —
 * and which of those changes break the generated client — before you regenerate.
 */
import { deref, refName, type Json } from "./schema";
import {
  HTTP_METHODS,
  type ChangeKind,
  type ChangeReport,
  type ChangeSeverity,
  type ContractChange
} from "./types";

export interface ContractSchema {
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  items?: ContractSchema;
  properties?: Record<string, ContractSchema>;
  required?: string[];
  additionalProperties?: boolean | ContractSchema;
  oneOf?: ContractSchema[];
  /** Name of a recursive schema that was not expanded again. */
  circular?: string;
}

export interface ContractParameter {
  name: string;
  in: string;
  required: boolean;
  schema?: ContractSchema;
}

export interface ContractOperation {
  method: string;
  route: string;
  operationId?: string;
  deprecated?: boolean;
  parameters: Record<string, ContractParameter>;
  requestBody?: { required: boolean; contentTypes: string[]; schema?: ContractSchema };
  responses: Record<string, { contentTypes: string[]; schema?: ContractSchema }>;
}

export interface Contract {
  swaggerizer: 1;
  specId: string;
  title?: string;
  version?: string;
  generatedAt?: string;
  operations: Record<string, ContractOperation>;
}

/* ------------------------------------------------------------------ normalisation */

const MAX_DEPTH = 12;

function normaliseSchema(doc: Json, raw: Json, stack: string[] = [], depth = 0): ContractSchema | undefined {
  if (raw === undefined || raw === null || raw === true) return undefined;
  if (depth > MAX_DEPTH) return { circular: "max-depth" };

  let schema = raw;
  let pushed: string | undefined;
  if (typeof raw.$ref === "string") {
    if (stack.includes(raw.$ref)) return { circular: refName(raw.$ref) ?? raw.$ref };
    const ref: string = raw.$ref;
    pushed = ref;
    stack.push(ref);
    schema = deref(doc, raw).node ?? {};
  }

  try {
    const next = (s: Json) => normaliseSchema(doc, s, stack, depth + 1);
    const out: ContractSchema = {};

    let type: string | undefined;
    let nullable = schema.nullable === true;
    if (Array.isArray(schema.type)) {
      nullable = nullable || schema.type.includes("null");
      const nonNull = schema.type.filter((t: string) => t !== "null");
      type = nonNull.length === 1 ? nonNull[0] : nonNull.sort().join("|") || undefined;
    } else if (typeof schema.type === "string") {
      type = schema.type;
    }

    // allOf: merge into a single object shape.
    if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
      const merged: ContractSchema = { type: "object", properties: {}, required: [] };
      for (const part of schema.allOf) {
        const p = next(part);
        if (!p) continue;
        if (p.properties) Object.assign(merged.properties!, p.properties);
        if (p.required) merged.required!.push(...p.required);
        if (p.type && p.type !== "object") merged.type = p.type;
        if (p.nullable) merged.nullable = true;
      }
      const own = schema.properties ? next({ ...schema, allOf: undefined }) : undefined;
      if (own?.properties) Object.assign(merged.properties!, own.properties);
      if (own?.required) merged.required!.push(...own.required);
      merged.required = [...new Set(merged.required)].sort();
      if (nullable) merged.nullable = true;
      return tidy(merged);
    }

    const variants = schema.oneOf || schema.anyOf;
    if (Array.isArray(variants) && variants.length > 0) {
      out.oneOf = variants.map((v: Json) => next(v) ?? {});
      if (variants.some((v: Json) => v?.type === "null")) nullable = true;
    }

    if (!type) {
      if (schema.properties || schema.additionalProperties) type = "object";
      else if (schema.items) type = "array";
    }
    if (type) out.type = type;
    if (typeof schema.format === "string") out.format = schema.format;
    if (nullable) out.nullable = true;
    if (Array.isArray(schema.enum)) out.enum = [...schema.enum].filter(v => v !== null);
    if (type === "array" && schema.items) out.items = next(schema.items) ?? {};
    if (schema.properties && typeof schema.properties === "object") {
      out.properties = {};
      for (const [name, prop] of Object.entries<Json>(schema.properties)) {
        out.properties[name] = next(prop) ?? {};
      }
      out.required = Array.isArray(schema.required) ? [...schema.required].sort() : [];
    }
    if (schema.additionalProperties !== undefined) {
      out.additionalProperties =
        typeof schema.additionalProperties === "object"
          ? next(schema.additionalProperties) ?? true
          : Boolean(schema.additionalProperties);
    }
    return tidy(out);
  } finally {
    if (pushed) stack.pop();
  }
}

function tidy(schema: ContractSchema): ContractSchema {
  if (schema.required && schema.required.length === 0) delete schema.required;
  if (schema.properties && Object.keys(schema.properties).length === 0 && schema.type !== "object") {
    delete schema.properties;
  }
  return schema;
}

function preferredMedia(content: Json): { types: string[]; media?: Json } {
  const types = Object.keys(content || {}).sort();
  const preferred = types.find(t => /json/i.test(t)) || types[0];
  return { types, media: preferred ? content[preferred] : undefined };
}

/** Normalises route templates so renaming `{id}` to `{petId}` is not reported as remove + add. */
export function contractKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${route.replace(/\{[^}]+\}/g, "{}")}`;
}

export function buildContract(doc: Json, specId: string): Contract {
  const operations: Record<string, ContractOperation> = {};
  for (const [route, rawItem] of Object.entries<Json>(doc?.paths || {})) {
    const item = deref(doc, rawItem).node;
    if (!item || typeof item !== "object") continue;
    const pathParams: Json[] = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;

      const parameters: Record<string, ContractParameter> = {};
      const routeParamNames = [...route.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
      for (const rawParam of [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = deref(doc, rawParam).node;
        if (!p || typeof p !== "object" || !p.name || !p.in) continue;
        // Path parameters are positional: key them by position so renames are not changes.
        const index = p.in === "path" ? routeParamNames.indexOf(p.name) : -1;
        const id = p.in === "path" && index >= 0 ? `path:#${index}` : `${p.in}:${p.name}`;
        parameters[id] = {
          name: p.name,
          in: p.in,
          required: p.in === "path" ? true : Boolean(p.required),
          schema: normaliseSchema(doc, p.schema ?? (p.content ? preferredMedia(p.content).media?.schema : undefined))
        };
      }

      let requestBody: ContractOperation["requestBody"];
      if (op.requestBody) {
        const body = deref(doc, op.requestBody).node;
        const { types, media } = preferredMedia(body?.content);
        requestBody = {
          required: Boolean(body?.required),
          contentTypes: types,
          schema: normaliseSchema(doc, media?.schema)
        };
      }

      const responses: ContractOperation["responses"] = {};
      for (const [code, rawResponse] of Object.entries<Json>(op.responses || {})) {
        const response = deref(doc, rawResponse).node;
        const { types, media } = preferredMedia(response?.content);
        responses[code] = { contentTypes: types, schema: normaliseSchema(doc, media?.schema) };
      }

      operations[contractKey(method, route)] = {
        method: method.toUpperCase(),
        route,
        ...(typeof op.operationId === "string" ? { operationId: op.operationId } : {}),
        ...(op.deprecated ? { deprecated: true } : {}),
        parameters,
        ...(requestBody ? { requestBody } : {}),
        responses
      };
    }
  }

  return {
    swaggerizer: 1,
    specId,
    title: typeof doc?.info?.title === "string" ? doc.info.title : undefined,
    version: doc?.info?.version !== undefined ? String(doc.info.version) : undefined,
    operations
  };
}

/* ------------------------------------------------------------------ diffing */

type Direction = "request" | "response";

class Collector {
  changes: ContractChange[] = [];
  constructor(private operation: string) {}
  add(severity: ChangeSeverity, kind: ChangeKind, message: string, location?: string) {
    this.changes.push({ severity, kind, operation: this.operation, ...(location ? { location } : {}), message });
  }
}

function describeType(s?: ContractSchema): string {
  if (!s) return "any";
  if (s.circular) return s.circular;
  if (s.oneOf) return `oneOf(${s.oneOf.length})`;
  const base = s.type === "array" ? `${describeType(s.items)}[]` : s.type || "any";
  return s.nullable ? `${base} | null` : base;
}

function compareSchema(
  a: ContractSchema | undefined,
  b: ContractSchema | undefined,
  dir: Direction,
  location: string,
  out: Collector,
  kind: ChangeKind
) {
  if (!a && !b) return;
  if (!a || !b) {
    if (!a) out.add(dir === "response" ? "info" : "warning", kind, `Schema added`, location);
    else out.add("breaking", kind, `Schema removed`, location);
    return;
  }
  if (a.circular || b.circular) {
    if (a.circular !== b.circular) out.add("warning", kind, `Recursive type changed from ${describeType(a)} to ${describeType(b)}`, location);
    return;
  }

  if ((a.type || "any") !== (b.type || "any")) {
    out.add("breaking", kind, `Type changed from ${describeType(a)} to ${describeType(b)}`, location);
    return;
  }
  if ((a.format || "") !== (b.format || "")) {
    out.add("warning", kind, `Format changed from '${a.format ?? "none"}' to '${b.format ?? "none"}'`, location);
  }
  if (!a.nullable && b.nullable) {
    out.add(dir === "response" ? "breaking" : "info", kind, `Can now be null`, location);
  } else if (a.nullable && !b.nullable) {
    out.add(dir === "request" ? "breaking" : "info", kind, `Can no longer be null`, location);
  }

  if (a.enum || b.enum) {
    const before = new Set((a.enum || []).map(v => JSON.stringify(v)));
    const after = new Set((b.enum || []).map(v => JSON.stringify(v)));
    const removed = [...before].filter(v => !after.has(v));
    const added = [...after].filter(v => !before.has(v));
    if (!a.enum && b.enum) {
      out.add(dir === "request" ? "breaking" : "info", kind, `Now restricted to ${[...after].join(", ")}`, location);
    } else if (a.enum && !b.enum) {
      out.add(dir === "response" ? "warning" : "info", kind, `No longer restricted to a fixed set of values`, location);
    } else {
      if (removed.length) {
        out.add(dir === "request" ? "breaking" : "info", kind, `Enum value(s) removed: ${removed.join(", ")}`, location);
      }
      if (added.length) {
        out.add(dir === "response" ? "warning" : "info", kind, `Enum value(s) added: ${added.join(", ")}`, location);
      }
    }
  }

  if (a.oneOf || b.oneOf) {
    const la = a.oneOf?.length ?? 0;
    const lb = b.oneOf?.length ?? 0;
    if (la !== lb) {
      out.add(lb > la && dir === "response" ? "warning" : lb < la && dir === "request" ? "breaking" : "info", kind,
        `Number of oneOf/anyOf variants changed from ${la} to ${lb}`, location);
    }
    const n = Math.min(la, lb);
    for (let i = 0; i < n; i++) compareSchema(a.oneOf![i], b.oneOf![i], dir, `${location}<${i}>`, out, kind);
  }

  if (a.type === "array" || b.type === "array") {
    compareSchema(a.items, b.items, dir, `${location}[]`, out, kind);
  }

  if (a.properties || b.properties) {
    const pa = a.properties || {};
    const pb = b.properties || {};
    const ra = new Set(a.required || []);
    const rb = new Set(b.required || []);
    for (const name of Object.keys(pa)) {
      const where = `${location}.${name}`;
      if (!(name in pb)) {
        out.add(dir === "response" ? "breaking" : "warning", kind, `Property '${name}' removed`, where);
        continue;
      }
      if (ra.has(name) && !rb.has(name)) {
        out.add(dir === "response" ? "breaking" : "info", kind, `Property '${name}' is no longer required`, where);
      } else if (!ra.has(name) && rb.has(name)) {
        out.add(dir === "request" ? "breaking" : "info", kind, `Property '${name}' is now required`, where);
      }
      compareSchema(pa[name], pb[name], dir, where, out, kind);
    }
    for (const name of Object.keys(pb)) {
      if (name in pa) continue;
      const required = rb.has(name);
      out.add(dir === "request" && required ? "breaking" : "info", kind,
        `${required ? "Required" : "Optional"} property '${name}' added`, `${location}.${name}`);
    }
  }
}

function isSuccess(code: string): boolean {
  return /^2/.test(code);
}

function compareOperation(key: string, a: ContractOperation, b: ContractOperation): ContractChange[] {
  const label = `${b.method} ${b.route}`;
  const out = new Collector(label);

  if ((a.operationId || "") !== (b.operationId || "")) {
    out.add("breaking", "operation-renamed",
      `operationId changed from '${a.operationId ?? "none"}' to '${b.operationId ?? "none"}' — generated function names will change`);
  }
  if (!a.deprecated && b.deprecated) out.add("warning", "operation-deprecated", "Operation is now deprecated");

  for (const [id, pa] of Object.entries(a.parameters)) {
    const pb = b.parameters[id];
    const where = `${pa.in} parameter '${pa.name}'`;
    if (!pb) {
      out.add(pa.in === "path" ? "breaking" : "warning", "parameter-removed", `Parameter removed`, where);
      continue;
    }
    if (!pa.required && pb.required) out.add("breaking", "parameter-changed", "Parameter is now required", where);
    if (pa.required && !pb.required) out.add("info", "parameter-changed", "Parameter is now optional", where);
    compareSchema(pa.schema, pb.schema, "request", where, out, "parameter-changed");
  }
  for (const [id, pb] of Object.entries(b.parameters)) {
    if (a.parameters[id]) continue;
    out.add(pb.required ? "breaking" : "info", "parameter-added",
      `${pb.required ? "Required" : "Optional"} parameter added`, `${pb.in} parameter '${pb.name}'`);
  }

  if (!a.requestBody && b.requestBody) {
    out.add(b.requestBody.required ? "breaking" : "info", "request-body-added",
      `${b.requestBody.required ? "Required" : "Optional"} request body added`, "request body");
  } else if (a.requestBody && !b.requestBody) {
    out.add("warning", "request-body-removed", "Request body removed", "request body");
  } else if (a.requestBody && b.requestBody) {
    if (!a.requestBody.required && b.requestBody.required) {
      out.add("breaking", "request-body-changed", "Request body is now required", "request body");
    }
    const lost = a.requestBody.contentTypes.filter(t => !b.requestBody!.contentTypes.includes(t));
    if (lost.length) out.add("breaking", "request-body-changed", `Content type(s) no longer accepted: ${lost.join(", ")}`, "request body");
    compareSchema(a.requestBody.schema, b.requestBody.schema, "request", "request body", out, "request-body-changed");
  }

  for (const [code, ra] of Object.entries(a.responses)) {
    const rb = b.responses[code];
    if (!rb) {
      out.add(isSuccess(code) ? "breaking" : "warning", "response-removed", `Response ${code} removed`, `response ${code}`);
      continue;
    }
    const lost = ra.contentTypes.filter(t => !rb.contentTypes.includes(t));
    if (lost.length) out.add("breaking", "response-changed", `Content type(s) no longer returned: ${lost.join(", ")}`, `response ${code}`);
    compareSchema(ra.schema, rb.schema, "response", `response ${code} body`, out, "response-changed");
  }
  for (const code of Object.keys(b.responses)) {
    if (a.responses[code]) continue;
    out.add(isSuccess(code) ? "warning" : "info", "response-added", `Response ${code} added`, `response ${code}`);
  }

  void key;
  return out.changes;
}

const SEVERITY_ORDER: Record<ChangeSeverity, number> = { breaking: 0, warning: 1, info: 2 };

/** Compares two contracts and reports added, removed and changed operations. */
export function diffContracts(
  before: Contract | undefined,
  after: Contract,
  baseline: ChangeReport["baseline"] = "snapshot"
): ChangeReport {
  const a = before?.operations || {};
  const b = after.operations;
  const changes: ContractChange[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, op] of Object.entries(a)) {
    if (!b[key]) {
      removed.push(`${op.method} ${op.route}`);
      changes.push({ severity: "breaking", kind: "operation-removed", operation: `${op.method} ${op.route}`, message: "Operation removed" });
    }
  }
  for (const [key, op] of Object.entries(b)) {
    const label = `${op.method} ${op.route}`;
    if (!a[key]) {
      if (before) {
        added.push(label);
        changes.push({ severity: "info", kind: "operation-added", operation: label, message: "New operation" });
      }
      continue;
    }
    const opChanges = compareOperation(key, a[key], op);
    if (opChanges.length) {
      changed.push(label);
      changes.push(...opChanges);
    }
  }

  changes.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || x.operation.localeCompare(y.operation));
  const counts: Record<ChangeSeverity, number> = { breaking: 0, warning: 0, info: 0 };
  for (const c of changes) counts[c.severity]++;

  return {
    specId: after.specId,
    title: after.title,
    baseline,
    ...(before?.version !== undefined ? { fromVersion: before.version } : {}),
    ...(after.version !== undefined ? { toVersion: after.version } : {}),
    added,
    removed,
    changed,
    changes,
    counts
  };
}

export function hasChanges(report: ChangeReport): boolean {
  return report.changes.length > 0;
}

export type FailOn = "breaking" | "warning" | "any" | "none";

/** True when the report contains changes at or above the given threshold. */
export function exceedsThreshold(report: ChangeReport, failOn: FailOn): boolean {
  switch (failOn) {
    case "none":
      return false;
    case "any":
      return report.changes.length > 0;
    case "warning":
      return report.counts.breaking + report.counts.warning > 0;
    default:
      return report.counts.breaking > 0;
  }
}

/** Plain-text rendering of a change report, for terminals and CI logs. */
export function formatReport(report: ChangeReport, options: { color?: boolean; verbose?: boolean } = {}): string {
  const c = options.color
    ? {
        red: (s: string) => `\x1b[31m${s}\x1b[0m`,
        yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
        green: (s: string) => `\x1b[32m${s}\x1b[0m`,
        dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
        bold: (s: string) => `\x1b[1m${s}\x1b[0m`
      }
    : { red: (s: string) => s, yellow: (s: string) => s, green: (s: string) => s, dim: (s: string) => s, bold: (s: string) => s };

  const lines: string[] = [];
  const version =
    report.fromVersion !== undefined && report.toVersion !== undefined && report.fromVersion !== report.toVersion
      ? ` (${report.fromVersion} → ${report.toVersion})`
      : "";
  lines.push(c.bold(`${report.title ?? report.specId}${version}`));
  if (report.changes.length === 0) {
    lines.push(c.green("  No contract changes."));
    return lines.join("\n");
  }
  lines.push(
    `  ${c.red(`${report.counts.breaking} breaking`)}, ${c.yellow(`${report.counts.warning} warning(s)`)}, ${report.counts.info} info · ` +
      `${report.added.length} new, ${report.removed.length} removed, ${report.changed.length} changed operation(s)`
  );
  const icon = { breaking: c.red("✖ BREAKING"), warning: c.yellow("▲ WARNING "), info: c.dim("● info    ") };
  for (const change of report.changes) {
    if (change.severity === "info" && !options.verbose && change.kind !== "operation-added") continue;
    const where = change.location ? c.dim(` [${change.location}]`) : "";
    lines.push(`  ${icon[change.severity]} ${change.operation} — ${change.message}${where}`);
  }
  const hiddenInfo = options.verbose ? 0 : report.changes.filter(x => x.severity === "info" && x.kind !== "operation-added").length;
  if (hiddenInfo) lines.push(c.dim(`  …and ${hiddenInfo} non-breaking detail(s); use --verbose to list them.`));
  return lines.join("\n");
}
