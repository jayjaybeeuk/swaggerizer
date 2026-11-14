/* Finding and loading swaggerizer.config.{ts,mts,js,mjs,json} (Node only). */
import fs from "node:fs";
import path from "node:path";
import type { SwaggerizerConfig } from "./config";

export const CONFIG_FILES = [
  "swaggerizer.config.ts",
  "swaggerizer.config.mts",
  "swaggerizer.config.js",
  "swaggerizer.config.mjs",
  "swaggerizer.config.json"
];

export function findConfigFile(cwd = process.cwd()): string | undefined {
  for (const name of CONFIG_FILES) {
    const file = path.join(cwd, name);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/** Strips // and /* *\/ comments and trailing commas outside strings, so tsconfig files parse as JSON. */
export function parseJsonc(text: string): any {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Module aliases from a tsconfig's `compilerOptions.paths`, so a config file can import fixtures
 * through workspace aliases such as `@online-banking/data-access/...` (Nx, path-mapped monorepos).
 */
export function aliasesFromTsconfig(tsconfigFile: string): Record<string, string> {
  if (!fs.existsSync(tsconfigFile)) return {};
  let json: any;
  try {
    json = parseJsonc(fs.readFileSync(tsconfigFile, "utf8"));
  } catch {
    return {};
  }
  const options = json?.compilerOptions || {};
  const baseDir = path.resolve(path.dirname(tsconfigFile), options.baseUrl || ".");
  const aliases: Record<string, string> = {};
  for (const [key, targets] of Object.entries<string[]>(options.paths || {})) {
    const target = Array.isArray(targets) ? targets[0] : undefined;
    if (!target) continue;
    if (key.endsWith("/*") && target.endsWith("/*")) {
      aliases[key.slice(0, -2)] = path.resolve(baseDir, target.slice(0, -2));
    } else if (!key.includes("*")) {
      aliases[key] = path.resolve(baseDir, target);
    }
  }
  return aliases;
}

export async function loadConfig(file?: string, cwd = process.cwd()): Promise<{ config: SwaggerizerConfig; file: string } | undefined> {
  const configFile = file ? path.resolve(cwd, file) : findConfigFile(cwd);
  if (!configFile) return undefined;
  if (!fs.existsSync(configFile)) throw new Error(`Config file not found: ${configFile}`);

  let config: any;
  if (configFile.endsWith(".json")) {
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } else {
    const dir = path.dirname(configFile);
    const peek = fs.readFileSync(configFile, "utf8");
    const declared = /tsconfig\s*:\s*["'`]([^"'`]+)["'`]/.exec(peek)?.[1];
    const tsconfig = [declared && path.resolve(dir, declared), path.join(dir, "tsconfig.base.json"), path.join(dir, "tsconfig.json")]
      .filter((f): f is string => Boolean(f))
      .find(f => fs.existsSync(f));
    const { createJiti } = await import("jiti");
    const jiti = createJiti(configFile, {
      alias: tsconfig ? aliasesFromTsconfig(tsconfig) : {},
      interopDefault: true,
      moduleCache: false
    });
    const mod: any = await jiti.import(configFile);
    config = mod?.default ?? mod;
  }

  if (!config || typeof config !== "object" || !config.specs || typeof config.specs !== "object") {
    throw new Error(`${configFile} must export a config with a \`specs\` object (use defineConfig).`);
  }
  // Paths in the config are relative to the config file, not the shell.
  const dir = path.dirname(configFile);
  const rel = (p?: string) => (p && !/^https?:\/\//i.test(p) ? path.resolve(dir, p) : p);
  for (const spec of Object.values<any>(config.specs)) {
    spec.file = rel(spec.file);
    spec.output = rel(spec.output);
    spec.mocksOutput = rel(spec.mocksOutput);
  }
  config.output = rel(config.output);
  config.stateFile = rel(config.stateFile);
  return { config: config as SwaggerizerConfig, file: configFile };
}
