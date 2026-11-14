/* `swaggerizer pull`: refresh committed spec files from their source URLs (Node only). */
import fs from "node:fs";
import path from "node:path";
import { diffContracts, formatReport } from "./contract";
import type { SwaggerizerConfig } from "./config";
import { analyseSpecFile } from "./spec";
import type { ChangeReport } from "./types";

export interface PullOptions {
  config: SwaggerizerConfig;
  /** Only these spec ids (default: every spec with a `source`). */
  only?: string[];
  /** Extra request headers, e.g. an Authorization header for a private catalogue. */
  headers?: Record<string, string>;
  silent?: boolean;
  color?: boolean;
  verbose?: boolean;
}

export interface PullResult {
  pulled: Array<{ id: string; file: string; changed: boolean; report?: ChangeReport }>;
  failed: Array<{ id: string; error: string }>;
}

/** JSON is re-indented so diffs of committed specs stay readable; YAML is kept as served. */
export function normaliseSpecText(text: string): { text: string; ext: "json" | "yaml" } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2) + "\n", ext: "json" };
  }
  return { text: trimmed + "\n", ext: "yaml" };
}

export async function pull(options: PullOptions): Promise<PullResult> {
  const say = (m: string) => {
    if (!options.silent) console.log(m);
  };
  const result: PullResult = { pulled: [], failed: [] };
  const entries = Object.entries(options.config.specs).filter(
    ([id, spec]) => spec.source && (!options.only?.length || options.only.includes(id))
  );
  if (entries.length === 0) {
    say("Nothing to pull: no spec in the config has a `source` URL.");
    return result;
  }

  for (const [id, spec] of entries) {
    try {
      const response = await fetch(spec.source!, {
        headers: {
          Accept: "application/json, application/yaml;q=0.9, */*;q=0.5",
          ...(options.config.headers || {}),
          ...(spec.headers || {}),
          ...(options.headers || {})
        },
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) throw new Error(`${spec.source} answered ${response.status}`);
      const { text, ext } = normaliseSpecText(await response.text());
      const file = path.resolve(spec.file ?? path.join("specs", `${id}.${ext}`));
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
      if (before === text) {
        say(`${id}: unchanged`);
        result.pulled.push({ id, file, changed: false });
        continue;
      }

      // Compare contracts so a pull says what moved, not just that bytes changed.
      // Same extension as the target so the parser picks the right format.
      const tmp = path.join(path.dirname(file), `.pulling-${path.basename(file)}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, text);
      let report: ChangeReport | undefined;
      try {
        const next = await analyseSpecFile(tmp, id);
        if (before !== undefined) {
          try {
            const previous = await analyseSpecFile(file, id);
            report = diffContracts(previous.contract, next.contract, "previous-load");
          } catch {
            // The old file did not parse: nothing meaningful to compare against.
          }
        }
      } catch (err) {
        // Never replace a working spec with one that does not parse.
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      fs.renameSync(tmp, file);
      say(before === undefined ? `${id}: saved ${path.relative(process.cwd(), file)}` : `${id}: updated ${path.relative(process.cwd(), file)}`);
      if (report) say(formatReport(report, { color: options.color, verbose: options.verbose }).replace(/^/gm, "  ") + "\n");
      result.pulled.push({ id, file, changed: true, ...(report ? { report } : {}) });
    } catch (err: any) {
      const error = err?.message ? String(err.message) : String(err);
      say(`${id}: could not pull – ${error}`);
      result.failed.push({ id, error });
    }
  }
  return result;
}
