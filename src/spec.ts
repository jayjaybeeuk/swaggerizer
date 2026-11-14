/* Loading Swagger 2.0 / OpenAPI 3.x files into a bundled OpenAPI 3 document (Node only). */
import fs from "node:fs";
import path from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { basePathsOf, buildCatalogue, serverUrlOf } from "./catalogue";
import { buildContract, type Contract } from "./contract";
import { isUrl } from "./paths";
import type { CatalogueOperation } from "./types";

export const SPEC_FILE_PATTERN = /\.(ya?ml|json)$/i;

export interface LoadedSpec {
  file: string;
  /** "2.0" for Swagger, otherwise the `openapi` version. */
  specVersion?: string;
  /** Bundled OpenAPI 3 document (Swagger 2 is converted). */
  doc: any;
  /** The bundled document as published (before any Swagger 2 conversion); what orval is given for URL specs. */
  raw?: any;
  warnings: string[];
}

export interface LoadSpecOptions {
  /** Request headers for spec URLs, e.g. `{ Authorization: "Bearer …" }` for a protected api-docs endpoint. */
  headers?: Record<string, string>;
  /** Give up on a spec URL after this many ms (default 30000). */
  timeout?: number;
}

/**
 * Reads spec URLs (and relative $refs on the same origin) with fetch. The parser's own HTTP
 * resolver refuses localhost and private addresses, which is where api-docs usually live
 * (`http://localhost:8080/v3/api-docs`, internal gateways), and cannot send auth headers.
 * $refs to any other origin still go through the parser's guarded resolver.
 */
function specUrlResolver(root: string, options: LoadSpecOptions) {
  const origin = new URL(root).origin;
  return {
    order: 1,
    canRead: (file: { url: string }) => {
      try {
        return /^https?:/i.test(file.url) && new URL(file.url).origin === origin;
      } catch {
        return false;
      }
    },
    read: async (file: { url: string }) => {
      const url = file.url.split("#")[0];
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Accept: "application/json, application/yaml;q=0.9, */*;q=0.5", ...(options.headers || {}) },
          signal: AbortSignal.timeout(options.timeout ?? 30000)
        });
      } catch (err: any) {
        const reason = err?.name === "TimeoutError" ? "timed out" : err?.cause?.code || err?.message || String(err);
        throw new Error(`Could not fetch ${url}: ${reason}`);
      }
      if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`.trim());
      return response.text();
    }
  };
}

async function convertSwagger2(api: any): Promise<{ doc: any; warnings: string[] }> {
  const mod: any = await import("swagger2openapi");
  const converter = mod.convertObj ? mod : mod.default;
  const options: any = { patch: true, warnOnly: true, resolve: false };
  const result = await converter.convertObj(api, options);
  const warnings = (options.warnings || result?.warnings || []).map((w: any) => (w?.message ? String(w.message) : String(w)));
  renameSwagger2Examples(result.openapi);
  return { doc: result.openapi, warnings };
}

/** swagger2openapi names a Swagger 2 response example "response"; call it "example" like OAS3's singular form. */
function renameSwagger2Examples(doc: any) {
  const visitResponses = (responses: any) => {
    for (const response of Object.values<any>(responses || {})) {
      for (const media of Object.values<any>(response?.content || {})) {
        const keys = media?.examples ? Object.keys(media.examples) : [];
        if (keys.length === 1 && keys[0] === "response") {
          media.examples = { example: media.examples.response };
        }
      }
    }
  };
  for (const item of Object.values<any>(doc?.paths || {})) {
    for (const op of Object.values<any>(item || {})) {
      if (op && typeof op === "object" && op.responses) visitResponses(op.responses);
    }
  }
  visitResponses(doc?.components?.responses);
}

/** Quick check used when scanning folders: is this YAML/JSON file an OpenAPI or Swagger document? */
export async function looksLikeSpec(file: string): Promise<boolean> {
  try {
    const head = (await fs.promises.readFile(file, "utf8")).slice(0, 4096);
    return /["']?(openapi|swagger)["']?\s*:/.test(head);
  } catch {
    return false;
  }
}

export async function listSpecFiles(folder: string): Promise<string[]> {
  const absolute = path.resolve(folder);
  const entries = await fs.promises.readdir(absolute, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile() && SPEC_FILE_PATTERN.test(e.name) && !e.name.startsWith("."))
    .map(e => path.join(absolute, e.name))
    .sort();
  const specs: string[] = [];
  for (const file of files) if (await looksLikeSpec(file)) specs.push(file);
  return specs;
}

export async function loadSpecFile(file: string, options: LoadSpecOptions = {}): Promise<LoadedSpec> {
  const remote = isUrl(file);
  const absolute = remote ? file : path.resolve(file);
  // bundle() resolves external $refs into internal ones but keeps the document acyclic.
  const bundled: any = remote
    ? await SwaggerParser.bundle(absolute, { resolve: { swaggerizer: specUrlResolver(absolute, options) } } as any)
    : await SwaggerParser.bundle(absolute);
  const raw = remote ? structuredClone(bundled) : undefined;
  const warnings: string[] = [];
  let doc = bundled;
  let specVersion: string | undefined;

  if (typeof bundled?.swagger === "string") {
    specVersion = bundled.swagger;
    const converted = await convertSwagger2(bundled);
    doc = converted.doc;
    warnings.push(...converted.warnings);
  } else if (typeof bundled?.openapi === "string") {
    specVersion = bundled.openapi;
  } else {
    throw new Error("Not an OpenAPI or Swagger document (missing `openapi` / `swagger` field).");
  }

  try {
    // Validate a copy: validation dereferences in place.
    await SwaggerParser.validate(structuredClone(bundled));
  } catch (err: any) {
    const details: any[] = Array.isArray(err?.details) ? err.details : [];
    if (details.length) {
      warnings.push(...details.slice(0, 10).map(d => `${d.message ?? d}${d.path ? ` at ${[].concat(d.path).join(".")}` : ""}`));
    } else {
      warnings.push(String(err?.message ?? err).split("\n")[0]);
    }
  }

  return { file: absolute, specVersion, doc, ...(raw ? { raw } : {}), warnings: warnings.slice(0, 20) };
}

/** Stable id for a spec file: its basename without extensions (`users.swagger.json` → `users`). */
export function specIdFor(file: string): string {
  const name = isUrl(file) ? new URL(file).pathname.split("/").filter(Boolean).pop() || new URL(file).hostname : file;
  return path
    .basename(name)
    .replace(SPEC_FILE_PATTERN, "")
    .replace(/\.(swagger|openapi|oas|spec)$/i, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-");
}

export interface AnalysedSpec extends LoadedSpec {
  id: string;
  operations: CatalogueOperation[];
  contract: Contract;
  basePaths: string[];
  serverUrl?: string;
}

export async function analyseSpecFile(file: string, id = specIdFor(file), options: LoadSpecOptions = {}): Promise<AnalysedSpec> {
  const loaded = await loadSpecFile(file, options);
  return {
    ...loaded,
    id,
    operations: buildCatalogue(loaded.doc, id),
    contract: buildContract(loaded.doc, id),
    basePaths: basePathsOf(loaded.doc),
    serverUrl: serverUrlOf(loaded.doc)
  };
}

/** Accepts a mix of spec files and folders and returns every spec file, folder contents sorted. */
export async function resolveSpecInputs(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const input of inputs) {
    if (isUrl(input)) {
      out.push(input);
      continue;
    }
    const absolute = path.resolve(input);
    const stat = await fs.promises.stat(absolute);
    if (stat.isDirectory()) out.push(...(await listSpecFiles(absolute)));
    else out.push(absolute);
  }
  return [...new Set(out)];
}
