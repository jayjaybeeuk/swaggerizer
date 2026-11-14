import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { http as mswHttp, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { analyseSpecFile, createSwaggerizer, type Swaggerizer, type SwaggerizerManifest } from "../src/index";
import { createSwaggerizerMocks } from "../src/msw";

const specs = path.join(__dirname, "..", "example_specs");

async function manifestFor(file: string): Promise<SwaggerizerManifest> {
  const spec = await analyseSpecFile(path.join(specs, file));
  return { specId: spec.id, title: spec.contract.title, version: spec.contract.version, basePaths: spec.basePaths, operations: spec.operations };
}

async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : undefined };
}

describe("MSW runtime (local state)", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  const msw = setupServer();
  let mocks: ReturnType<typeof createSwaggerizerMocks>;
  let fallbackCalls: string[] = [];

  before(async () => {
    upstream = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ real: true, url: req.url }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
    upstreamPort = (upstream.address() as any).port;

    // Stand-ins for orval's generated faker handlers, registered in spec order (/users/{userId} first).
    const fallbackHandlers = [
      mswHttp.get("*/users/:userId", () => {
        fallbackCalls.push("getUser");
        return HttpResponse.json({ from: "orval getUser" });
      }),
      mswHttp.get("*/users/me", () => {
        fallbackCalls.push("getCurrentUser");
        return HttpResponse.json({ from: "orval getCurrentUser" });
      })
    ];
    mocks = createSwaggerizerMocks({
      manifests: [await manifestFor("petstore.yaml"), await manifestFor("users.swagger.json")],
      fallbackHandlers,
      storageKey: false
    });
    msw.use(...mocks.handlers);
    msw.listen({ onUnhandledRequest: "bypass" });
  });

  after(() => {
    msw.close();
    upstream.close();
  });

  test("serves the default example for any origin", async () => {
    const res = await call("https://anything.test/v1/pets");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-swaggerizer-scenario"), "200:threePets");
  });

  test("select() switches responses and notifies subscribers", async () => {
    let notified = 0;
    const off = mocks.subscribe(() => notified++);
    const [op] = await mocks.select({ method: "get", route: "/pets/{petId}", code: "404" });
    off();
    assert.equal(op.selectedCode, "404");
    assert.equal(notified, 1);
    assert.equal((await call("https://api.test/pets/3")).status, 404);
  });

  test("override header, custom responses and reset", async () => {
    assert.deepEqual((await call("https://api.test/pets/3", { headers: { "x-swaggerizer-scenario": "200:cat" } })).json.name, "Tom");
    await mocks.select({ method: "post", route: "/pets", custom: { status: 422, body: { nope: true } } });
    const custom = await call("https://api.test/pets", { method: "POST", body: "{}" });
    assert.equal(custom.status, 422);
    assert.deepEqual(custom.json, { nope: true });
    await mocks.reset();
    assert.equal((await call("https://api.test/pets/3")).status, 200);
    assert.equal(mocks.operations().filter(o => o.modified).length, 0);
  });

  test("'generated' responses come from the exact orval handler for the operation", async () => {
    fallbackCalls = [];
    assert.deepEqual((await call("https://users.test/api/users/me")).json, { from: "orval getCurrentUser" });
    assert.deepEqual((await call("https://users.test/api/users/42")).json, { from: "orval getUser" });
    assert.deepEqual(fallbackCalls, ["getCurrentUser", "getUser"]);
  });

  test("proxy mode passes the request through to the real API", async () => {
    await mocks.select({ method: "get", route: "/pets", mode: "proxy" });
    const res = await call(`http://127.0.0.1:${upstreamPort}/pets?limit=2`);
    assert.deepEqual(res.json, { real: true, url: "/pets?limit=2" });
    await mocks.reset();
  });

  test("delays are applied", async () => {
    await mocks.select({ method: "get", route: "/pets", delay: 150 });
    const started = Date.now();
    await call("https://api.test/pets");
    assert.ok(Date.now() - started >= 140);
    await mocks.reset();
  });

  test("scenarios embedded in the manifest are the defaults", async () => {
    const manifest = await manifestFor("petstore.yaml");
    manifest.scenarios = { "get:/pets": { code: "200", example: "emptyList" } };
    const local = createSwaggerizerMocks({ manifests: [manifest], storageKey: false });
    const op = local.operations().find(o => o.key === "get:/pets")!;
    assert.equal(op.selectedExample, "emptyList");
  });
});

describe("MSW runtime synced with a Swaggerizer server", () => {
  let sw: Swaggerizer;
  let admin: string;
  const msw = setupServer();

  before(async () => {
    sw = createSwaggerizer({ silent: true });
    await sw.load(path.join(specs, "petstore.yaml"));
    const server = await sw.listen(0, "127.0.0.1");
    admin = `http://127.0.0.1:${(server.address() as any).port}/swaggerizer`;
  });

  after(async () => {
    msw.close();
    await sw.close();
  });

  test("follows choices made in the admin API and reports requests back", async () => {
    const mocks = createSwaggerizerMocks({ manifests: [await manifestFor("petstore.yaml")], server: admin, syncInterval: 0 });
    msw.use(...mocks.handlers);
    msw.listen({ onUnhandledRequest: "bypass" });

    // Switch on the server (as the admin page would) …
    const switched = await fetch(`${admin}/api/select?method=get&route=/pets&code=500`);
    assert.equal(switched.status, 200);
    // … and the browser/test mocks follow.
    assert.equal((await call("https://petstore.example.com/v1/pets")).status, 500);

    // Switching from the MSW side updates the server too.
    await mocks.select({ method: "get", route: "/pets", example: "emptyList" });
    assert.equal(sw.getState().operations.find(o => o.key === "get:/pets")!.selectedExample, "emptyList");
    assert.deepEqual((await call("https://petstore.example.com/v1/pets")).json, []);

    await new Promise(resolve => setTimeout(resolve, 100));
    const log = sw.getRequestLog().filter(e => e.source === "msw");
    assert.ok(log.length >= 2, "MSW requests appear in the server's live log");
    assert.equal(log[log.length - 1].example, "emptyList");
  });
});

describe("MSW runtime with config features", () => {
  const msw = setupServer();
  after(() => msw.close());

  test("aliases, overlays, custom handlers and the default delay work in MSW too", async () => {
    const { loadConfig, applyOverlays } = await import("../src/index");
    const config = (await loadConfig(path.join(__dirname, "fixtures", "bff", "swaggerizer.config.ts")))!.config;
    const bff = config.specs.bff;
    const spec = await analyseSpecFile(bff.file!, "bff");
    const manifest: SwaggerizerManifest = {
      specId: "bff",
      basePaths: spec.basePaths,
      operations: applyOverlays(spec.operations, bff.scenarios),
      aliases: bff.aliases
    };
    const mocks = createSwaggerizerMocks({ manifests: [manifest], handlers: bff.handlers, storageKey: false, delay: 80 });
    msw.use(...mocks.handlers);
    msw.listen({ onUnhandledRequest: "error" });

    let started = Date.now();
    const aliased = await call("https://gateway.test/banking/bff/v4/businesses/b1/rewards");
    assert.ok(Date.now() - started >= 70, "default delay");
    assert.equal(aliased.headers.get("x-swaggerizer-scenario"), "200:populated");
    assert.equal(aliased.json.totals[0].cashback, 681.38);
    assert.equal((await call("https://gateway.test/v4/banking/businesses/b1/rewards")).json.totals[0].cashback, 681.38);

    await mocks.select({ method: "get", route: "/banking/businesses/{businessId}/rewards", example: "empty", delay: 0 });
    started = Date.now();
    assert.deepEqual((await call("https://gateway.test/banking/bff/v4/businesses/b1/rewards")).json.totals, []);
    assert.ok(Date.now() - started < 70, "explicit 0 delay");

    const created = await call("https://gateway.test/banking/bff/v4/businesses/b9/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "e1" })
    });
    assert.equal(created.status, 201);
    assert.deepEqual((await call("https://gateway.test/v4/banking/businesses/b9/expenses")).json, [{ id: "e1" }], "params come through aliased and canonical routes alike");
    await mocks.reset();
    assert.deepEqual((await call("https://gateway.test/v4/banking/businesses/b9/expenses")).json, [], "reset clears the store");
  });
});
