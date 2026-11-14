// Bundles the browser demo into examples/browser/dist and serves it on http://localhost:5173.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(here, "main.ts")],
  bundle: true,
  format: "esm",
  outfile: path.join(dist, "main.js"),
  sourcemap: true,
  logLevel: "info"
});
copyFileSync(path.join(here, "index.html"), path.join(dist, "index.html"));
copyFileSync(path.join(here, "..", "..", "node_modules", "msw", "lib", "mockServiceWorker.js"), path.join(dist, "mockServiceWorker.js"));

if (process.argv.includes("--build-only")) process.exit(0);

const types = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json" };
const port = Number(process.env.PORT || 5173);
http
  .createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const file = path.join(dist, url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
    try {
      const body = readFileSync(file);
      res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  })
  .listen(port, () => console.log(`Browser demo on http://localhost:${port}`));
