/*
 * Request validation: checks a matched request against the operation's declared parameters and
 * request body, so a mock cannot answer `200` to a request the contract forbids.
 *
 * Node only. Ajv must never reach the browser entry points (`msw`, `debug-menu`, `config`), which is
 * why the shared types live in `./types` and this module is not re-exported from them.
 *
 * Specs are bundled but not dereferenced: every operation schema is compiled on its own, with its
 * internal `#/...` refs pointed at the registered document. That keeps recursive schemas valid.
 */
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { decodePointerSegment, deref } from "./schema";
import type { CatalogueOperation, ValidationIssue, ValidationMode, ValidationSummary } from "./types";

export const VALIDATION_HEADER = "x-swaggerizer-validation";

const MAX_ISSUES = 20;
const IGNORED_HEADER_PARAMS = new Set(["accept", "content-type", "authorization"]);
const PARAM_LOCATIONS = new Set(["path", "query", "header", "cookie"]);

const SKIP = Symbol("swaggerizer-skip");

export interface ValidationInput {
  /** Path parameters, already extracted for the matched route. */
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON or form fields; undefined when the request carried no body. */
  body?: unknown;
  /** Set when the body could not be parsed. Reported as an issue rather than guessed at. */
  bodyError?: string;
  contentType?: string;
}

export interface Validator {
  validateRequest: (op: CatalogueOperation, input: ValidationInput) => ValidationSummary;
  /** True when the operation declares any parameter or a request body. */
  hasRequestSchema: (op: CatalogueOperation) => boolean;
}

type ValidateFn = ((data: any) => boolean) & { errors?: any[] | null };
type ParamLocation = "path" | "query" | "header" | "cookie";

interface ParamPlan {
  name: string;
  in: ParamLocation;
  required: boolean;
  style: string;
  explode: boolean;
  schema: any;
  /** Declared through `content` with a JSON media type: the raw value is JSON text. */
  json: boolean;
  validate?: ValidateFn;
  problem?: string;
}

interface BodyPlan {
  required: boolean;
  content: Record<string, any>;
}

interface OperationPlan {
  params: ParamPlan[];
  body?: BodyPlan;
  problem?: string;
}

/* ------------------------------------------------------------------ schema preparation */

/** OpenAPI 3.0 spells nullability as `nullable: true`; JSON Schema wants a `null` type. */
function withoutNullable(node: any): any {
  if (Array.isArray(node)) return node.map(withoutNullable);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) out[key] = withoutNullable(value);
  if (out.nullable !== true) return out;
  delete out.nullable;
  if (typeof out.type === "string") out.type = [out.type, "null"];
  else if (Array.isArray(out.type)) {
    if (!out.type.includes("null")) out.type = [...out.type, "null"];
  } else if (out.$ref || out.allOf || out.oneOf || out.anyOf || out.not) {
    return { anyOf: [out, { type: "null" }] };
  }
  return out;
}

/** Points a schema's internal refs at the registered document so it can be compiled standalone. */
function withBaseRefs(value: any, base: string): any {
  if (Array.isArray(value)) return value.map(entry => withBaseRefs(entry, base));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = key === "$ref" && typeof entry === "string" && entry.startsWith("#") ? `${base}${entry}` : withBaseRefs(entry, base);
  }
  return out;
}

function createAjv(specVersion?: string): any {
  // OAS 3.1 is JSON Schema 2020-12, where `exclusiveMinimum` is a number; draft-07 would reject it.
  const Ctor: any = typeof specVersion === "string" && /^3\.[1-9]/.test(specVersion) ? Ajv2020 : Ajv;
  const ajv = new Ctor({
    strict: false,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    allowUnionTypes: true,
    validateFormats: true
  });
  addFormats(ajv);
  return ajv;
}

function typeOf(schema: any): string | undefined {
  const type = schema?.type;
  if (Array.isArray(type)) return type.find((entry: any) => entry !== "null") ?? type[0];
  if (typeof type === "string") return type;
  if (schema?.properties || schema?.additionalProperties) return "object";
  if (schema?.items) return "array";
  return undefined;
}

function headerValue(headers: ValidationInput["headers"], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined ? undefined : String(value);
}

/* ------------------------------------------------------------------ parameters */

/** Delimiter of a non-exploded array: `form` is comma-separated, the others say so in their name. */
function arrayDelimiter(style: string): string {
  if (style === "spaceDelimited") return " ";
  if (style === "pipeDelimited") return "|";
  return ",";
}

/**
 * Exploded `form` objects arrive as their own top-level keys (`?a=1&b=2`) and `deepObject` as
 * `name[key]=…`. Neither is rebuilt here, so such parameters are reported as skipped, not failed.
 */
function isSpreadObject(param: ParamPlan, type: string | undefined): boolean {
  return (
    !param.json &&
    type === "object" &&
    (param.in === "query" || param.in === "cookie") &&
    ((param.style === "form" && param.explode) || param.style === "deepObject")
  );
}

function hasDeepObjectKeys(query: URLSearchParams, name: string): boolean {
  for (const key of query.keys()) if (key.startsWith(`${name}[`)) return true;
  return false;
}

/** The value a parameter arrived as: repeated query keys for arrays, the last cookie for scalars. */
function rawParam(param: ParamPlan, input: ValidationInput, type: string | undefined): string | string[] | undefined {
  if (param.in === "path") return input.params[param.name];
  if (param.in === "query") {
    if (type === "array" && !param.json) return input.query.getAll(param.name);
    return input.query.get(param.name) ?? undefined;
  }
  if (param.in === "header") return headerValue(input.headers, param.name);
  const cookie = headerValue(input.headers, "cookie");
  if (!cookie) return undefined;
  const found: string[] = [];
  for (const part of cookie.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === param.name) found.push(part.slice(at + 1).trim());
  }
  if (found.length === 0) return undefined;
  return type === "array" ? found : found[found.length - 1];
}

function coerceScalar(doc: any, value: string, schemaIn: any): unknown {
  const { node: schema } = deref(doc, schemaIn);
  const type = typeOf(schema);
  if (type === "integer" || type === "number") {
    return /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value) ? Number(value) : value;
  }
  if (type === "boolean") return value === "true" ? true : value === "false" ? false : value;
  return value;
}

/**
 * HTTP hands us strings; the spec talks in types. Validation runs against a coerced copy, so
 * handlers keep receiving exactly what they always did.
 */
function coerceParam(doc: any, param: ParamPlan, raw: string | string[], summary: ValidationSummary): unknown {
  const { node: schema } = deref(doc, param.schema);
  const type = typeOf(schema);
  if (type === "array") {
    // Repeated keys (`ids=1&ids=2`) are already separate; a non-exploded value (`ids=1,2`) is split.
    const split = (value: string, delimiter: string) =>
      value.split(delimiter).map(part => part.trim()).filter(part => part !== "");
    const values = Array.isArray(raw)
      ? param.explode
        ? raw
        : raw.flatMap(value => split(value, arrayDelimiter(param.style)))
      : split(String(raw), ",");
    return values.map(value => coerceScalar(doc, value, schema?.items));
  }
  if (type === "object") {
    if (Array.isArray(raw)) return raw;
    if (isSpreadObject(param, type)) {
      summary.skipped ??= "object-style";
      return SKIP;
    }
    const out: Record<string, unknown> = {};
    for (const pair of String(raw).split(",")) {
      if (pair === "") continue;
      const at = pair.indexOf(":");
      if (at < 0) {
        out[pair.trim()] = true;
      } else {
        const key = pair.slice(0, at).trim();
        out[key] = coerceScalar(doc, pair.slice(at + 1).trim(), schema?.properties?.[key] ?? schema?.additionalProperties);
      }
    }
    return out;
  }
  return Array.isArray(raw) ? raw[raw.length - 1] : coerceScalar(doc, String(raw), schema);
}

function coerceForm(doc: any, body: unknown, schemaIn: any, summary: ValidationSummary): unknown {
  const { node: schema } = deref(doc, schemaIn);
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const properties: Record<string, any> = schema?.properties || {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const property = properties[key];
    const propertyType = typeOf(deref(doc, property).node);
    if (propertyType === "object") {
      // Deep form bodies need a parser this tool does not ship; report the gap instead of a false pass.
      summary.skipped ??= "form-nesting";
      out[key] = value;
      continue;
    }
    if (propertyType === "array" && typeof value === "string") {
      out[key] = value.split(",").map(entry => coerceScalar(doc, entry.trim(), deref(doc, property).node?.items));
      continue;
    }
    out[key] = typeof value === "string" ? coerceScalar(doc, value, property) : value;
  }
  return out;
}

/* ------------------------------------------------------------------ bodies */

export function normaliseContentType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const type = String(value).split(";")[0].trim().toLowerCase();
  if (!type) return undefined;
  return type === "*/*" || type === "*" || type === "application/*" ? "application/json" : type;
}

/** The declared media type this request should be checked against, if any. */
export function matchMediaType(declared: string[], actual: string | undefined): string | undefined {
  if (declared.length === 0) return undefined;
  const types = declared.map(key => ({ key, type: key.split(";")[0].trim().toLowerCase() }));
  const wanted = actual ?? "application/json";
  const exact = types.find(entry => entry.type === wanted);
  if (exact) return exact.key;
  if (wanted.endsWith("+json")) {
    const json = types.find(entry => entry.type === "application/json");
    if (json) return json.key;
  }
  const wildcard = types.find(entry => entry.type === "*/*" || entry.type === "application/*");
  return wildcard?.key;
}

const FORM_TYPE = "application/x-www-form-urlencoded";

/**
 * Bodies the server can parse: JSON (`+json` included) and urlencoded forms. No `Content-Type` means
 * JSON, as it always has. Multipart, octet-stream, text… are skipped rather than failed to parse.
 */
function readableMediaType(actual: string | undefined): boolean {
  if (!actual) return true;
  return actual === "application/json" || actual.endsWith("+json") || actual === FORM_TYPE;
}

/** True when the operation (or its path item) declares any parameter or a request body. */
export function hasRequestSchema(doc: any, op: Pick<CatalogueOperation, "route" | "method">): boolean {
  const item = doc?.paths?.[op.route];
  const node = item?.[op.method];
  return Boolean(
    (Array.isArray(item?.parameters) && item.parameters.length > 0) ||
      (Array.isArray(node?.parameters) && node.parameters.length > 0) ||
      node?.requestBody
  );
}

/* ------------------------------------------------------------------ issues */

function pointerPath(pointer: unknown): string {
  if (typeof pointer !== "string" || pointer === "") return "";
  return pointer.split("/").filter(Boolean).map(decodePointerSegment).join(".");
}

function issueFromError(error: any, prefix: string): ValidationIssue {
  const path = pointerPath(error?.instancePath);
  const missing = error?.keyword === "required" ? error?.params?.missingProperty : undefined;
  const location = [prefix, path, missing].filter(Boolean).join(".");
  return {
    location,
    message: String(error?.message ?? "is invalid"),
    ...(error?.keyword ? { keyword: String(error.keyword) } : {})
  };
}

function add(summary: ValidationSummary, issue: ValidationIssue): void {
  if (summary.request.length < MAX_ISSUES) summary.request.push(issue);
}

function runCheck(validate: ValidateFn | undefined, value: unknown): any[] {
  if (!validate) return [];
  return validate(value) ? [] : validate.errors ?? [];
}

/* ------------------------------------------------------------------ matching helpers */

/** `X-Swaggerizer-Validation: off | warn | enforce`; unknown values fall back to the configured mode. */
export function parseValidationMode(value: string | undefined): ValidationMode | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim().toLowerCase();
  return mode === "off" || mode === "warn" || mode === "enforce" ? mode : undefined;
}

/** True when one of `validateIgnore`'s operationIds or `"METHOD /route"` entries covers `op`. */
export function matchesIgnore(
  ignore: string[] | undefined,
  op: Pick<CatalogueOperation, "operationId" | "method" | "route" | "key">
): boolean {
  if (!ignore || ignore.length === 0) return false;
  return ignore.some(entry => {
    const value = String(entry).trim();
    return value === op.operationId || value === `${op.method.toUpperCase()} ${op.route}` || value === op.key;
  });
}

/** `validateIgnore` entries that match no operation, reported as a spec warning. */
export function unmatchedIgnore(ignore: string[] | undefined, operations: CatalogueOperation[]): string[] {
  if (!ignore || ignore.length === 0) return [];
  return ignore.filter(
    entry =>
      !operations.some(
        op =>
          entry === op.operationId ||
          entry === `${op.method.toUpperCase()} ${op.route}` ||
          entry === op.key
      )
  );
}

/** "query.limit: must be integer" — used for log tooltips and CLI output. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map(issue => `${issue.location}: ${issue.message}`).join("; ");
}

/* ------------------------------------------------------------------ the validator */

export function createValidator(doc: any, specId: string, specVersion?: string): Validator {
  const base = `urn:swaggerizer:${encodeURIComponent(specId)}`;
  const ajv = createAjv(specVersion);
  try {
    ajv.addSchema(withoutNullable(structuredClone(doc)), base);
  } catch {
    // A document Ajv refuses to register simply leaves every check skipped, never the mock broken.
  }

  const plans = new Map<string, OperationPlan>();
  const bodyChecks = new Map<string, ValidateFn | undefined>();

  function compile(schema: any): ValidateFn | undefined {
    try {
      // Inline operation schemas get the same `nullable` rewrite as the registered document.
      return ajv.compile(withBaseRefs(withoutNullable(schema), base)) as ValidateFn;
    } catch {
      return undefined;
    }
  }

  function buildPlan(op: CatalogueOperation): OperationPlan {
    const item = doc?.paths?.[op.route];
    const node = item?.[op.method];
    const plan: OperationPlan = { params: [] };
    // An operation-level parameter replaces a path-level one with the same name and location.
    const declared = new Map<string, any>();
    for (const entry of [
      ...(Array.isArray(item?.parameters) ? item.parameters : []),
      ...(Array.isArray(node?.parameters) ? node.parameters : [])
    ]) {
      const { node: param } = deref(doc, entry);
      if (!param || typeof param !== "object" || !param.name || typeof param.in !== "string") continue;
      const name = param.in === "header" ? String(param.name).toLowerCase() : String(param.name);
      declared.set(`${param.in}\u0000${name}`, param);
    }
    for (const param of declared.values()) {
      if (!PARAM_LOCATIONS.has(param.in)) continue;
      const where = param.in as ParamLocation;
      if (where === "header" && IGNORED_HEADER_PARAMS.has(String(param.name).toLowerCase())) continue;
      let schema = param.schema;
      let json = false;
      if (!schema && param.content && typeof param.content === "object") {
        // Only a JSON `content` parameter can be read; any other media type is left unchecked.
        const key = Object.keys(param.content).find(entry => /^application\/(.+\+)?json\b/i.test(entry.trim()));
        if (key) {
          schema = param.content[key]?.schema;
          json = true;
        }
      }
      if (!schema) continue;
      const style =
        typeof param.style === "string" ? param.style : where === "query" || where === "cookie" ? "form" : "simple";
      const compiled = compile(schema);
      plan.params.push({
        name: String(param.name),
        in: where,
        required: where === "path" || param.required === true,
        style,
        explode: typeof param.explode === "boolean" ? param.explode : style === "form",
        schema,
        json,
        ...(compiled ? { validate: compiled } : { problem: "invalid-schema" })
      });
    }

    const requestBody = node?.requestBody ? deref(doc, node.requestBody).node : undefined;
    if (requestBody && typeof requestBody === "object" && requestBody.content && typeof requestBody.content === "object") {
      plan.body = { required: requestBody.required === true, content: requestBody.content };
    }
    return plan;
  }

  function planFor(op: CatalogueOperation): OperationPlan {
    let plan = plans.get(op.key);
    if (!plan) {
      plan = buildPlan(op);
      plans.set(op.key, plan);
    }
    return plan;
  }

  function bodyCheck(op: CatalogueOperation, mediaKey: string, schema: any): ValidateFn | undefined {
    const key = `${op.key}\u0000${mediaKey}`;
    if (bodyChecks.has(key)) return bodyChecks.get(key);
    const compiled = compile(schema);
    bodyChecks.set(key, compiled);
    return compiled;
  }

  function validateRequest(op: CatalogueOperation, input: ValidationInput): ValidationSummary {
    const plan = planFor(op);
    const summary: ValidationSummary = { request: [] };

    for (const param of plan.params) {
      const { node: schema } = deref(doc, param.schema);
      const type = typeOf(schema);
      if (isSpreadObject(param, type)) {
        // `deepObject` keys can at least be seen; exploded form objects cannot be told from other keys.
        const deep = param.style === "deepObject" && param.in === "query";
        const present = deep && hasDeepObjectKeys(input.query, param.name);
        if (deep && !present && param.required) {
          add(summary, {
            location: `${param.in}.${param.name}`,
            message: `must have required parameter '${param.name}'`,
            keyword: "required"
          });
        } else if (present || param.required) {
          summary.skipped ??= "object-style";
        }
        continue;
      }
      const raw = rawParam(param, input, type);
      const missing = raw === undefined || (Array.isArray(raw) ? raw.length === 0 : raw === "");
      if (missing) {
        if (param.required) {
          add(summary, {
            location: `${param.in}.${param.name}`,
            message: `must have required parameter '${param.name}'`,
            keyword: "required"
          });
        }
        continue;
      }
      if (param.problem) {
        summary.skipped ??= param.problem;
        continue;
      }
      let value: unknown;
      if (param.json) {
        const text = Array.isArray(raw) ? raw[raw.length - 1] : String(raw);
        try {
          value = JSON.parse(text);
        } catch {
          add(summary, { location: `${param.in}.${param.name}`, message: "must be valid JSON", keyword: "parse" });
          continue;
        }
      } else {
        value = coerceParam(doc, param, raw as string | string[], summary);
      }
      if (value === SKIP) continue;
      for (const error of runCheck(param.validate, value)) {
        add(summary, issueFromError(error, `${param.in}.${param.name}`));
      }
    }

    if (plan.body) {
      const actual = normaliseContentType(input.contentType);
      const mediaKey = matchMediaType(Object.keys(plan.body.content), actual);
      if (!mediaKey || !readableMediaType(actual)) {
        summary.skipped ??= "unsupported-media-type";
      } else if (input.bodyError) {
        add(summary, { location: "body", message: input.bodyError, keyword: "parse" });
      } else if (input.body === undefined) {
        if (plan.body.required) {
          add(summary, { location: "body", message: "must have a request body", keyword: "required" });
        }
      } else {
        const schema = plan.body.content[mediaKey]?.schema;
        const check = schema ? bodyCheck(op, mediaKey, schema) : undefined;
        if (schema && !check) {
          summary.skipped ??= "invalid-schema";
        } else if (check) {
          const form = (actual ?? mediaKey.split(";")[0].trim().toLowerCase()) === FORM_TYPE;
          const value = form ? coerceForm(doc, input.body, schema, summary) : input.body;
          for (const error of runCheck(check, value)) {
            add(summary, issueFromError(error, "body"));
          }
        }
      }
    }

    return summary;
  }

  return { validateRequest, hasRequestSchema: op => hasRequestSchema(doc, op) };
}
