/*
 * Flattens an OpenAPI 3 document into one entry per method + route, recording every response code
 * and named example so they can be listed and switched from the admin page and debug menu.
 */
import { deref, sampleFromSchema, type Json } from "./schema";
import { operationKey } from "./scenario";
import {
  EMPTY,
  GENERATED,
  HTTP_METHODS,
  type CatalogueExample,
  type CatalogueOperation,
  type CatalogueResponse
} from "./types";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** HTTP status to send for a response key: "404" → 404, "2XX" → 200, "default" → 500. */
export function statusForCode(code: string): number {
  if (/^\d{3}$/.test(code)) return Number(code);
  const range = /^([1-5])XX$/i.exec(code);
  if (range) return Number(range[1]) * 100;
  return 500;
}

function preferredContentType(types: string[]): string | undefined {
  return (
    types.find(t => /^application\/json/i.test(t)) ||
    types.find(t => /\+json/i.test(t)) ||
    types.find(t => /json/i.test(t)) ||
    types[0]
  );
}

export function extractExamples(media: Json, doc: Json): CatalogueExample[] {
  if (!media || typeof media !== "object") return [];
  const examples: CatalogueExample[] = [];

  if (media.examples && typeof media.examples === "object") {
    for (const [name, raw] of Object.entries<Json>(media.examples)) {
      const { node } = deref(doc, raw);
      if (node && typeof node === "object" && "value" in node) {
        examples.push({ name, summary: text(node.summary), value: node.value });
      } else if (node && typeof node === "object" && node.externalValue) {
        examples.push({ name, summary: text(node.summary) ?? `external: ${node.externalValue}`, value: null });
      }
    }
  }

  if (examples.length === 0 && media.example !== undefined) {
    examples.push({ name: "example", value: media.example });
  }

  if (examples.length === 0 && media.schema) {
    const { node: schema } = deref(doc, media.schema);
    if (schema && schema.example !== undefined) {
      examples.push({ name: "example", value: schema.example });
    } else if (schema && Array.isArray(schema.examples) && schema.examples.length > 0) {
      schema.examples.forEach((value: unknown, i: number) =>
        examples.push({ name: i === 0 ? "example" : `example${i + 1}`, value })
      );
    }
  }

  return examples;
}

export function buildResponse(code: string, raw: Json, doc: Json): CatalogueResponse {
  const { node: response } = deref(doc, raw);
  const content = response?.content && typeof response.content === "object" ? response.content : {};
  const contentTypes = Object.keys(content);
  const preferred = preferredContentType(contentTypes);
  const media = preferred ? content[preferred] : undefined;
  const examples = extractExamples(media, doc);

  const result: CatalogueResponse = {
    code,
    status: statusForCode(code),
    description: text(response?.description),
    contentTypes,
    hasBody: contentTypes.length > 0,
    examples
  };
  if (media && examples.length === 0) {
    result.generated = media.schema ? sampleFromSchema(media.schema, doc) : {};
  }
  return result;
}

function sortCodes(a: string, b: string): number {
  return statusForCode(a) - statusForCode(b) || a.localeCompare(b);
}

export function defaultVariant(responses: CatalogueResponse[]): { code: string; example: string } {
  const sorted = [...responses].sort((a, b) => sortCodes(a.code, b.code));
  const response = sorted.find(r => r.status >= 200 && r.status < 300) || sorted[0];
  if (!response) return { code: "200", example: EMPTY };
  return { code: response.code, example: firstVariantName(response) };
}

export function firstVariantName(response: CatalogueResponse): string {
  if (response.examples.length > 0) return response.examples[0].name;
  return response.hasBody ? GENERATED : EMPTY;
}

export function buildCatalogue(doc: Json, specId: string): CatalogueOperation[] {
  const operations: CatalogueOperation[] = [];
  for (const [route, rawItem] of Object.entries<Json>(doc?.paths || {})) {
    const { node: item } = deref(doc, rawItem);
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      const responses = Object.entries<Json>(op.responses || {})
        .sort(([a], [b]) => sortCodes(a, b))
        .map(([code, raw]) => buildResponse(code, raw, doc));
      const def = defaultVariant(responses);
      operations.push({
        key: operationKey(method, route),
        method,
        route,
        specId,
        operationId: text(op.operationId),
        summary: text(op.summary),
        description: text(op.description) ?? text(item.description),
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        ...(op.deprecated ? { deprecated: true } : {}),
        responses,
        defaultCode: def.code,
        defaultExample: def.example
      });
    }
  }
  return operations;
}

/** Path prefixes from `servers`, e.g. `https://api.example.com/v1` → `/v1`. */
export function basePathsOf(doc: Json): string[] {
  const out = new Set<string>();
  for (const server of Array.isArray(doc?.servers) ? doc.servers : []) {
    const url = typeof server?.url === "string" ? server.url : "";
    // Substitute server variables with their defaults.
    const resolved = url.replace(/\{([^}]+)\}/g, (_m: string, name: string) => {
      const value = server?.variables?.[name]?.default;
      return value !== undefined ? String(value) : "";
    });
    let pathname: string;
    try {
      pathname = new URL(resolved, "http://localhost").pathname;
    } catch {
      continue;
    }
    pathname = pathname.replace(/\/+$/, "");
    if (pathname && pathname !== "/") out.add(pathname);
  }
  return [...out];
}

/** The first absolute http(s) server URL, used as the default proxy target. */
export function serverUrlOf(doc: Json): string | undefined {
  for (const server of Array.isArray(doc?.servers) ? doc.servers : []) {
    const url = typeof server?.url === "string" ? server.url : "";
    const resolved = url.replace(/\{([^}]+)\}/g, (_m: string, name: string) =>
      String(server?.variables?.[name]?.default ?? "")
    );
    if (/^https?:\/\//i.test(resolved)) return resolved.replace(/\/+$/, "");
  }
  return undefined;
}
