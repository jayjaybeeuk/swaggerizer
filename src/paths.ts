import path from "node:path";

/** File names Swaggerizer writes next to generated code. */
export const CONTRACT_FILE = "swaggerizer.contract.json";
export const WRAPPER_FILE = "swaggerizer.ts";
export const INDEX_FILE = "index.ts";

export const isUrl = (input: string) => /^https?:\/\//i.test(input);

/** Folders a spec's generated code lives in: client/models/contract, and mocks. */
export function outputDirs(id: string, root: string | undefined, spec: { output?: string; mocksOutput?: string } = {}) {
  const dir = path.resolve(spec.output ?? path.join(root ?? "src/api", id));
  return { dir, mocksDir: path.resolve(spec.mocksOutput ?? dir) };
}
