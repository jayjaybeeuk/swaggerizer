/*
 * JSON-pointer resolution and deterministic sample generation for OpenAPI 3 schemas.
 * Specs are bundled (not dereferenced), so internal `$ref`s are followed lazily here with cycle
 * protection — that keeps documents JSON-serialisable even when schemas are recursive.
 */

export type Json = any;

export function decodePointerSegment(segment: string): string {
  return decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolves an internal `#/a/b` reference against `doc`. Returns undefined for anything else. */
export function resolvePointer(doc: Json, ref: string): Json {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  const parts = ref.replace(/^#\/?/, "").split("/").filter(p => p !== "");
  let node = doc;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[decodePointerSegment(part)];
  }
  return node;
}

/** Follows `$ref` chains on `node`, returning the target and the last ref name seen. */
export function deref(doc: Json, node: Json, seen: Set<string> = new Set()): { node: Json; ref?: string } {
  let current = node;
  let lastRef: string | undefined;
  while (current && typeof current === "object" && typeof current.$ref === "string") {
    const ref: string = current.$ref;
    if (seen.has(ref)) return { node: current, ref };
    seen.add(ref);
    lastRef = ref;
    current = resolvePointer(doc, ref);
  }
  return { node: current, ref: lastRef };
}

export function refName(ref?: string): string | undefined {
  if (!ref) return undefined;
  const parts = ref.split("/");
  return decodePointerSegment(parts[parts.length - 1]);
}

const FORMAT_SAMPLES: Record<string, unknown> = {
  "date-time": "2024-01-01T12:00:00Z",
  date: "2024-01-01",
  time: "12:00:00",
  email: "user@example.com",
  uuid: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  uri: "https://example.com",
  url: "https://example.com",
  hostname: "example.com",
  ipv4: "192.168.0.1",
  ipv6: "::1",
  byte: "U3dhZ2dlcml6ZXI=",
  binary: "",
  password: "********"
};

function primaryType(schema: Json): string | undefined {
  const t = schema?.type;
  if (Array.isArray(t)) return t.find((x: string) => x !== "null") ?? t[0];
  if (typeof t === "string") return t;
  if (schema?.properties || schema?.additionalProperties) return "object";
  if (schema?.items) return "array";
  return undefined;
}

interface SampleContext {
  doc: Json;
  stack: string[];
  depth: number;
}

const MAX_DEPTH = 8;

function sample(schemaIn: Json, ctx: SampleContext): Json {
  if (schemaIn === true || schemaIn === undefined || schemaIn === null) return {};
  if (ctx.depth > MAX_DEPTH) return undefined;

  let schema = schemaIn;
  let pushed: string | undefined;
  if (schema && typeof schema.$ref === "string") {
    if (ctx.stack.includes(schema.$ref)) return undefined; // recursive schema: stop here
    const ref: string = schema.$ref;
    pushed = ref;
    ctx.stack.push(ref);
    schema = resolvePointer(ctx.doc, ref) ?? {};
  }

  try {
    if (schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
    if (schema.const !== undefined) return schema.const;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

    const next = { ...ctx, depth: ctx.depth + 1 };

    if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
      let merged: Json = undefined;
      for (const part of schema.allOf) {
        const value = sample(part, next);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          merged = { ...(merged || {}), ...value };
        } else if (merged === undefined) {
          merged = value;
        }
      }
      if (schema.properties) {
        merged = { ...(merged || {}), ...sampleObject(schema, next) };
      }
      return merged;
    }

    const variants = schema.oneOf || schema.anyOf;
    if (Array.isArray(variants) && variants.length > 0) {
      const base = schema.properties ? sampleObject(schema, next) : undefined;
      const chosen = sample(variants[0], next);
      return base && chosen && typeof chosen === "object" ? { ...base, ...chosen } : chosen ?? base;
    }

    switch (primaryType(schema)) {
      case "object":
        return sampleObject(schema, next);
      case "array": {
        const item = sample(schema.items, next);
        if (item === undefined) return [];
        const count = Math.max(1, Math.min(Number(schema.minItems) || 1, 3));
        return Array.from({ length: count }, () => item);
      }
      case "string": {
        if (schema.format && schema.format in FORMAT_SAMPLES) return FORMAT_SAMPLES[schema.format];
        const min = Number(schema.minLength) || 0;
        const base = "string";
        return min > base.length ? base.padEnd(min, "x") : base;
      }
      case "integer":
        return clampNumber(schema, 1, true);
      case "number":
        return clampNumber(schema, 1.5, false);
      case "boolean":
        return true;
      case "null":
        return null;
      default:
        return schema.properties ? sampleObject(schema, next) : {};
    }
  } finally {
    if (pushed) ctx.stack.pop();
  }
}

function clampNumber(schema: Json, fallback: number, integer: boolean): number {
  let value = fallback;
  if (typeof schema.minimum === "number") value = Math.max(value, schema.minimum);
  if (typeof schema.exclusiveMinimum === "number") value = Math.max(value, schema.exclusiveMinimum + 1);
  if (typeof schema.maximum === "number") value = Math.min(value, schema.maximum);
  if (typeof schema.exclusiveMaximum === "number") value = Math.min(value, schema.exclusiveMaximum - 1);
  return integer ? Math.round(value) : value;
}

function sampleObject(schema: Json, ctx: SampleContext): Json {
  const out: Record<string, Json> = {};
  for (const [name, prop] of Object.entries<Json>(schema.properties || {})) {
    if (prop && (prop.writeOnly === true || prop.readOnly === "never")) continue;
    const value = sample(prop, ctx);
    if (value !== undefined) out[name] = value;
  }
  if (Object.keys(out).length === 0 && schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const value = sample(schema.additionalProperties, ctx);
    if (value !== undefined) out.key = value;
  }
  return out;
}

/** Builds a deterministic, schema-valid-ish example payload for `schema`. */
export function sampleFromSchema(schema: Json, doc: Json = {}): Json {
  const value = sample(schema, { doc, stack: [], depth: 0 });
  return value === undefined ? {} : value;
}
