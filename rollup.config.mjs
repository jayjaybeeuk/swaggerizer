import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import { builtinModules } from "node:module";
import { readFileSync, readdirSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const externals = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})];
const builtins = [...builtinModules, ...builtinModules.map(m => `node:${m}`)];

const isExternal = id =>
  builtins.includes(id) || id.startsWith("node:") || externals.some(dep => id === dep || id.startsWith(dep + "/"));

// Ships the static admin page (src/ui) next to the bundles as dist/ui.
const copyAdminUi = () => ({
  name: "copy-admin-ui",
  buildStart() {
    for (const file of readdirSync("src/ui")) this.addWatchFile(`src/ui/${file}`);
  },
  generateBundle() {
    for (const file of readdirSync("src/ui")) {
      this.emitFile({ type: "asset", fileName: `ui/${file}`, source: readFileSync(`src/ui/${file}`) });
    }
  }
});

const input = { index: "src/index.ts", msw: "src/msw.ts", "debug-menu": "src/debug-menu.ts", config: "src/config.ts" };

export default [
  {
    input,
    external: isExternal,
    output: [
      { dir: "dist", format: "cjs", exports: "named", sourcemap: true, entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
      { dir: "dist", format: "es", sourcemap: true, entryFileNames: "[name].mjs", chunkFileNames: "chunks/[name]-[hash].mjs" }
    ],
    plugins: [
      resolve({ preferBuiltins: true }),
      typescript({ tsconfig: "./tsconfig.json", declaration: true, declarationDir: "./dist", outDir: "./dist" }),
      copyAdminUi()
    ]
  },
  {
    input: "src/cli.ts",
    external: isExternal,
    output: { file: "dist/cli.js", format: "cjs", banner: "#!/usr/bin/env node\n", sourcemap: true },
    plugins: [
      resolve({ preferBuiltins: true }),
      typescript({ tsconfig: "./tsconfig.json", declaration: false, declarationMap: false, outDir: "./dist" })
    ]
  }
];
