import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  CONTRACT_FILE,
  aliasesFromTsconfig,
  analyseSpecFile,
  applyOverlays,
  candidatePaths,
  createSwaggerizer,
  generate,
  loadConfig,
  normaliseMediaType,
  pull,
  variantsOf,
  type Swaggerizer,
  type SwaggerizerConfig
} from "../src/index";

const fixtureDir = path.join(__dirname, "fixtures", "bff");
const configFile = path.join(fixtureDir, "swaggerizer.config.ts");

async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const postJson = (url: string, body: unknown) =>
  call(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("config loading", () => {
  test("reads tsconfig paths from a commented tsconfig with trailing commas", () => {
    const aliases = aliasesFromTsconfig(path.join(fixtureDir, "tsconfig.base.json"));
    assert.equal(aliases["@example/fixtures/rewards"], path.join(fixtureDir, "fixtures", "rewards.ts"));
    assert.equal(aliases["@example/fixtures"], path.join(fixtureDir, "fixtures"));
  });

  test("loads a TypeScript config that imports fixtures through path aliases", async () => {
    const loaded = await loadConfig(configFile);
    assert.ok(loaded);
    const spec = loaded!.config.specs.bff;
    assert.equal(spec.file, path.join(fixtureDir, "example-bff.json"), "paths resolve relative to the config file");
    assert.deepEqual((spec.scenarios!.getBusinessRewards.populated.body as any).totals[0].cashback, 681.38);
    assert.equal(typeof spec.handlers!.searchTransactions, "function");
  });

  test("finds swaggerizer.config.* in the working directory and reports a missing file", async () => {
    assert.equal(await loadConfig(undefined, os.tmpdir()), undefined);
    await assert.rejects(loadConfig("nope.config.ts", os.tmpdir()), /Config file not found/);
  });
});

describe("springdoc-style specs", () => {
  test("wildcard media types are served as JSON", async () => {
    assert.equal(normaliseMediaType("*/*"), "application/json");
    assert.equal(normaliseMediaType("application/xml"), "application/xml");
    const spec = await analyseSpecFile(path.join(fixtureDir, "example-bff.json"));
    const rewards = spec.operations.find(o => o.operationId === "getBusinessRewards")!;
    assert.deepEqual(rewards.responses[0].contentTypes, ["application/json"]);
    assert.deepEqual(spec.basePaths, ["/v4"]);
  });

  test("aliases expand a request path into every spelling worth matching", () => {
    assert.deepEqual(
      candidatePaths("/banking/bff/v4/businesses/1/rewards", ["/v4"], { "/banking/bff/v4/": "/v4/banking/" }),
      ["/banking/bff/v4/businesses/1/rewards", "/v4/banking/businesses/1/rewards", "/banking/businesses/1/rewards"]
    );
  });

  test("overlays add named scenarios, become the default and keep the generated body", async () => {
    const spec = await analyseSpecFile(path.join(fixtureDir, "example-bff.json"));
    const [op] = applyOverlays(
      spec.operations.filter(o => o.operationId === "getBusinessRewards"),
      { getBusinessRewards: { populated: { status: 200, body: { a: 1 } }, limit: { status: 422, body: { code: "X" } } } }
    );
    assert.deepEqual(variantsOf(op).map(v => `${v.code}:${v.example}`), ["200:populated", "200:generated", "422:limit", "500:generated"]);
    assert.equal(op.defaultExample, "populated");
    assert.equal(op.responses.find(r => r.code === "422")!.description, "Scenario overlay");
  });
});

describe("server driven by swaggerizer.config.ts", () => {
  let sw: Swaggerizer;
  let base: string;
  let upstream: http.Server;
  let config: SwaggerizerConfig;

  before(async () => {
    upstream = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ legacy: true, url: req.url }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
    config = (await loadConfig(configFile))!.config;
    sw = createSwaggerizer({ silent: true, fallback: `http://127.0.0.1:${(upstream.address() as any).port}`, delay: 60 });
    await sw.loadConfig(config);
    const server = await sw.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  after(async () => {
    await sw.close();
    upstream.close();
  });

  test("serves the gateway route and the aliased route as JSON, using the overlay default", async () => {
    for (const p of ["/v4/banking/businesses/b1/rewards", "/banking/bff/v4/businesses/b1/rewards"]) {
      const res = await call(base + p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get("content-type"), "application/json");
      assert.equal(res.headers.get("x-swaggerizer-scenario"), "200:populated");
      assert.equal(res.json.totals[0].cashback, 681.38);
    }
  });

  test("overlay scenarios switch by name, including codes the spec does not declare", async () => {
    await call(`${base}/swaggerizer/api/select?method=get&route=/banking/businesses/{businessId}/rewards&example=accountLimitExceeded`);
    const res = await call(`${base}/banking/bff/v4/businesses/b1/rewards`);
    assert.equal(res.status, 422);
    assert.deepEqual(res.json, { code: "ACCOUNT_LIMIT_EXCEEDED" });
    await postJson(`${base}/swaggerizer/api/reset`, {});
  });

  test("unknown overlay and handler keys are reported as spec warnings", () => {
    const spec = sw.getState().specs.find(s => s.id === "bff")!;
    assert.ok(spec.warnings.includes("Scenario overlay 'notAnOperation' matches no operation"));
    assert.deepEqual(spec.aliases, { "/banking/bff/v4/": "/v4/banking/" });
  });

  test("custom handlers page on the request body", async () => {
    const page1 = await postJson(`${base}/v4/banking/businesses/b1/transactions/search`, {});
    assert.deepEqual(page1.json, { items: ["a", "b"], nextCursor: "page-2" });
    assert.equal(page1.headers.get("x-swaggerizer-scenario"), "200:handler");
    const page2 = await postJson(`${base}/v4/banking/businesses/b1/transactions/search`, { cursor: "page-2" });
    assert.deepEqual(page2.json.nextCursor, null);
  });

  test("custom handlers share a store keyed by path parameters, cleared by Reset all", async () => {
    assert.deepEqual((await call(`${base}/v4/banking/businesses/b1/expenses`)).json, []);
    const created = await postJson(`${base}/v4/banking/businesses/b1/expenses`, { id: "e1", amount: 9 });
    assert.equal(created.status, 201);
    assert.deepEqual((await call(`${base}/v4/banking/businesses/b1/expenses`)).json, [{ id: "e1", amount: 9 }]);
    assert.deepEqual((await call(`${base}/v4/banking/businesses/b2/expenses`)).json, []);
    await postJson(`${base}/swaggerizer/api/reset`, {});
    assert.deepEqual((await call(`${base}/v4/banking/businesses/b1/expenses`)).json, []);
  });

  test("switching an operation bypasses its handler", async () => {
    await postJson(`${base}/swaggerizer/api/select`, { method: "get", route: "/banking/businesses/{businessId}/expenses", custom: { status: 503, body: { down: true } } });
    assert.equal((await call(`${base}/v4/banking/businesses/b1/expenses`)).status, 503);
    await postJson(`${base}/swaggerizer/api/reset`, {});
  });

  test("the default delay applies, and an explicit 0 overrides it", async () => {
    let started = Date.now();
    await call(`${base}/v4/banking/businesses/b1/rewards`);
    assert.ok(Date.now() - started >= 55, "default delay");
    const state = sw.getState().operations.find(o => o.operationId === "getBusinessRewards")!;
    assert.equal(state.delay, 60);
    assert.equal(state.modified, false, "the default delay is not a switch");
    await postJson(`${base}/swaggerizer/api/select`, { method: "get", route: "/banking/businesses/{businessId}/rewards", delay: 0 });
    started = Date.now();
    await call(`${base}/v4/banking/businesses/b1/rewards`);
    assert.ok(Date.now() - started < 55, "explicit 0");
    await postJson(`${base}/swaggerizer/api/reset`, {});
  });

  test("requests no spec declares go to the fallback server", async () => {
    const res = await call(`${base}/v1/legacy/thing?x=1`);
    assert.deepEqual(res.json, { legacy: true, url: "/v1/legacy/thing?x=1" });
    const log = sw.getRequestLog();
    assert.equal(log[log.length - 1].example, "fallback");
  });
});

describe("generate with a config", () => {
  test("puts the client and mocks in separate folders and fixes the mock imports", async () => {
    const config = (await loadConfig(configFile))!.config;
    const out = path.join(fixtureDir, "out");
    await fs.rm(out, { recursive: true, force: true });
    const result = await generate({ config, silent: true, yes: true, runtimeImport: "swaggerizer/msw" });
    assert.deepEqual(result.generated, ["bff"]);

    const client = path.join(out, "client");
    const mocks = path.join(out, "mock-service");
    assert.ok(existsSync(path.join(client, "bff.ts")));
    assert.ok(existsSync(path.join(client, CONTRACT_FILE)));
    assert.ok(existsSync(path.join(client, "model", "index.ts")));
    assert.ok(!existsSync(path.join(client, "bff.msw.ts")), "mocks moved out of the client folder");
    const msw = await fs.readFile(path.join(mocks, "bff.msw.ts"), "utf8");
    assert.match(msw, /from '\.\.\/client\/model'/);
    const wrapper = await fs.readFile(path.join(mocks, "swaggerizer.ts"), "utf8");
    assert.match(wrapper, /"aliases": \{\s*"\/banking\/bff\/v4\/": "\/v4\/banking\/"/);
    assert.match(wrapper, /"name": "accountLimitExceeded"/);
    assert.ok(!existsSync(path.join(out, "index.ts")), "no aggregate index for custom layouts");
    await fs.rm(out, { recursive: true, force: true });
  });
});

describe("pull", () => {
  test("saves specs from their source, reports changes and never saves a broken spec", async () => {
    let served = JSON.stringify(JSON.parse(await fs.readFile(path.join(fixtureDir, "example-bff.json"), "utf8")));
    const server = http.createServer((_req, res) => res.end(served));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swaggerizer-pull-"));
    const file = path.join(tmp, "specs", "bff.json");
    const config: SwaggerizerConfig = { specs: { bff: { file, source: `http://127.0.0.1:${(server.address() as any).port}/spec` } } };
    try {
      const first = await pull({ config, silent: true });
      assert.equal(first.pulled[0].changed, true);
      assert.match(await fs.readFile(file, "utf8"), /^\{\n {2}"openapi"/, "JSON is re-indented");

      assert.equal((await pull({ config, silent: true })).pulled[0].changed, false);

      const doc = JSON.parse(served);
      delete doc.paths["/banking/businesses/{businessId}/expenses"].post;
      served = JSON.stringify(doc);
      const second = await pull({ config, silent: true });
      assert.deepEqual(second.pulled[0].report!.removed, ["POST /banking/businesses/{businessId}/expenses"]);

      served = "{ not json";
      const broken = await pull({ config, silent: true });
      assert.equal(broken.failed.length, 1);
      assert.doesNotMatch(await fs.readFile(file, "utf8"), /not json/);
      assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ["bff.json"], "no temp files left behind");
    } finally {
      server.close();
    }
  });
});
