import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { CONTRACT_FILE, analyseSpecFile, createSwaggerizer, type Swaggerizer } from "../src/index";

const specs = path.join(__dirname, "..", "example_specs");

async function startOn(sw: Swaggerizer): Promise<{ base: string; server: http.Server }> {
  const server = await sw.listen(0, "127.0.0.1");
  const address = server.address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}`, server };
}

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

const post = (url: string, body: unknown) =>
  call(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("mock server and admin API", () => {
  let sw: Swaggerizer;
  let base: string;
  let admin: string;
  let tmp: string;
  let upstream: http.Server;
  let upstreamUrl: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swaggerizer-test-"));
    upstream = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ real: true, url: req.url, method: req.method }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/real`;
    sw = createSwaggerizer({ silent: true, stateFile: path.join(tmp, "state.json"), proxy: upstreamUrl });
    await sw.load(specs);
    ({ base } = await startOn(sw));
    admin = `${base}/swaggerizer`;
  });

  after(async () => {
    await sw.close();
    upstream.close();
  });

  test("serves the default example, with and without the server base path", async () => {
    for (const p of ["/pets", "/v1/pets"]) {
      const res = await call(base + p);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-swaggerizer-scenario"), "200:threePets");
      assert.equal(res.json.length, 3);
    }
  });

  test("switches with a GET link", async () => {
    const res = await call(`${admin}/api/select?method=get&route=/pets&code=500`);
    assert.equal(res.status, 200);
    assert.equal(res.json.operations[0].selectedCode, "500");
    const mock = await call(`${base}/pets`);
    assert.equal(mock.status, 500);
    assert.equal(mock.json.message, "The pet database is on fire");
  });

  test("switches with a form post and redirects back", async () => {
    const res = await fetch(`${admin}/api/select`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "method=get&route=%2Fpets%2F%7BpetId%7D&example=cat&redirect=%2Fswaggerizer%2F",
      redirect: "manual"
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/swaggerizer/");
    assert.deepEqual((await call(`${base}/pets/7`)).json, { id: 2, name: "Tom", species: "cat" });
  });

  test("accepts JSON arrays, ramlizer-style bodies, custom responses and delays", async () => {
    const many = await post(`${admin}/api/select`, [
      { method: "post", route: "/pets", code: "400", example: "missingName" },
      { method: "post", route: "/login", custom: { status: 503, body: { down: true } }, delay: 120 }
    ]);
    assert.equal(many.status, 200);
    assert.equal((await call(`${base}/pets`, { method: "POST" })).json.errorList[0].fieldName, "name");

    const started = Date.now();
    const custom = await call(`${base}/api/login`, { method: "POST" });
    assert.equal(custom.status, 503);
    assert.deepEqual(custom.json, { down: true });
    assert.ok(Date.now() - started >= 110, "delay applied");

    await post(admin, { method: "post", route: "/pets", nextResponseCode: "400", nextExampleName: "badSpecies" });
    assert.equal((await call(`${base}/pets`, { method: "POST" })).json.errorList[0].fieldName, "species");
  });

  test("rejects unknown codes and examples atomically", async () => {
    const res = await post(`${admin}/api/select`, [
      { method: "get", route: "/pets/{petId}", code: "200", example: "dog" },
      { method: "get", route: "/pets", code: "418" }
    ]);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /does not declare a 418/);
    assert.deepEqual((await call(`${base}/pets/1`)).json, { id: 2, name: "Tom", species: "cat" }, "first item not applied");
  });

  test("per-request override header wins for that request only", async () => {
    const res = await call(`${base}/pets/1`, { headers: { "x-swaggerizer-scenario": "404" } });
    assert.equal(res.status, 404);
    assert.equal((await call(`${base}/pets/1`)).status, 200);
  });

  test("proxies to the real API in proxy mode", async () => {
    await call(`${admin}/api/select?method=get&route=/pets/{petId}&mode=proxy`);
    const res = await call(`${base}/v1/pets/5?x=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { real: true, url: "/real/pets/5?x=1", method: "GET" });
    assert.match(res.headers.get("x-swaggerizer-proxied")!, /\/real\/pets\/5/);
  });

  test("persists choices to the state file and resets them", async () => {
    const saved = JSON.parse(await fs.readFile(path.join(tmp, "state.json"), "utf8"));
    assert.equal(saved.scenarios["get:/pets"].code, "500");
    const one = await post(`${admin}/api/reset`, { method: "get", route: "/pets" });
    assert.equal(one.json.reset, 1);
    assert.equal((await call(`${base}/pets`)).status, 200);
    await post(`${admin}/api/reset`, {});
    const state = (await call(`${admin}/api/state`)).json;
    assert.equal(state.operations.filter((o: any) => o.modified).length, 0);
  });

  test("specs can be switched off and on", async () => {
    await post(`${admin}/api/spec`, { id: "petstore", enabled: false });
    assert.equal((await call(`${base}/pets`)).status, 404);
    await post(`${admin}/api/spec`, { id: "petstore", enabled: true });
    assert.equal((await call(`${base}/pets`)).status, 200);
  });

  test("records a live request log, including entries reported by MSW", async () => {
    await post(`${admin}/api/log`, { method: "get", path: "/from-browser", status: 201, example: "dog" });
    const log = (await call(`${admin}/api/log`)).json.entries;
    const last = log[log.length - 1];
    assert.equal(last.source, "msw");
    assert.equal(last.path, "/from-browser");
    assert.ok(log.some((e: any) => e.source === "server" && e.example === "threePets"));
  });

  test("serves the admin page, the converted OpenAPI document and CORS preflights", async () => {
    const page = await call(`${admin}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /swaggerizer/);
    assert.match(page.text, /href="\/swaggerizer\/app\.css"/);
    const doc = await call(`${admin}/api/openapi/users.json`);
    assert.match(doc.json.openapi, /^3\./);
    const pre = await fetch(`${base}/pets`, { method: "OPTIONS", headers: { Origin: "http://app.test", "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "http://app.test");
  });

  test("unmatched routes answer 404 JSON", async () => {
    const res = await call(`${base}/nothing/here`);
    assert.equal(res.status, 404);
    assert.match(res.json.error, /No operation matches GET \/nothing\/here/);
  });
});

describe("contract warnings in the server", () => {
  test("compares specs with generated snapshots and with the previous load", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swaggerizer-watch-"));
    const specDir = path.join(tmp, "specs");
    const genDir = path.join(tmp, "generated");
    await fs.mkdir(specDir);
    await fs.copyFile(path.join(specs, "petstore.yaml"), path.join(specDir, "petstore.yaml"));

    // Snapshot of an older contract that still had a DELETE /pets/{petId} and no POST /pets.
    const current = await analyseSpecFile(path.join(specDir, "petstore.yaml"));
    const old = structuredClone(current.contract);
    delete (old.operations as any)["POST /pets"];
    old.operations["GET /legacy"] = { method: "GET", route: "/legacy", parameters: {}, responses: { "200": { contentTypes: [] } } };
    await fs.mkdir(path.join(genDir, "petstore"), { recursive: true });
    await fs.writeFile(path.join(genDir, "petstore", CONTRACT_FILE), JSON.stringify(old));

    const sw = createSwaggerizer({ silent: true, generated: genDir });
    const state = await sw.load(specDir);
    const snap = state.changes.find(c => c.baseline === "snapshot")!;
    assert.deepEqual(snap.removed, ["GET /legacy"]);
    assert.deepEqual(snap.added, ["POST /pets"]);

    // Edit the spec on disk and reload: the change since the last load is reported too.
    const source = await fs.readFile(path.join(specDir, "petstore.yaml"), "utf8");
    await fs.writeFile(path.join(specDir, "petstore.yaml"), source.replace("operationId: listPets", "operationId: getAllPets"));
    const reloaded = await sw.reload();
    const live = reloaded.changes.find(c => c.baseline === "previous-load")!;
    assert.equal(live.counts.breaking, 1);
    assert.match(live.changes[0].message, /operationId changed from 'listPets' to 'getAllPets'/);
    await sw.close();
  });

  test("a spec that fails to parse is reported without stopping the others", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swaggerizer-bad-"));
    await fs.copyFile(path.join(specs, "orders.yaml"), path.join(tmp, "orders.yaml"));
    await fs.writeFile(path.join(tmp, "broken.yaml"), "openapi: 3.0.0\ninfo: [unclosed\n");
    const sw = createSwaggerizer({ silent: true });
    const state = await sw.load(tmp);
    assert.ok(state.specs.find(s => s.id === "broken")!.error);
    assert.equal(state.specs.find(s => s.id === "orders")!.operationCount, 2);
    await sw.close();
  });
});

describe("request validation", () => {
  const spec = {
    openapi: "3.0.3",
    info: { title: "Things", version: "1.0.0" },
    paths: {
      "/things": {
        get: {
          operationId: "listThings",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
            { name: "x-tenant", in: "header", required: true, schema: { type: "string" } }
          ],
          responses: { "200": { description: "ok", content: { "application/json": { example: [] } } } }
        },
        post: {
          operationId: "createThing",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/NewThing" } } }
          },
          responses: { "201": { description: "created", content: { "application/json": { example: { ok: true } } } } }
        }
      },
      "/legacy": {
        post: {
          operationId: "importLegacy",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } }
              }
            }
          },
          responses: { "201": { description: "ok", content: { "application/json": { example: { imported: true } } } } }
        }
      },
      "/things/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        get: {
          operationId: "showThing",
          responses: { "200": { description: "ok", content: { "application/json": { example: { id: 1 } } } } }
        }
      }
    },
    components: {
      schemas: { NewThing: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }
    }
  };

  let sw: Swaggerizer;
  let plain: Swaggerizer;
  let ignored: Swaggerizer;
  let base: string;
  let admin: string;
  let plainBase: string;
  let ignoredBase: string;
  let tmp: string;
  let specFile: string;
  let upstream: http.Server;
  let forwarded: string[];
  let handlerCalls = 0;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swaggerizer-validate-"));
    specFile = path.join(tmp, "things.json");
    await fs.writeFile(specFile, JSON.stringify(spec, null, 2));
    forwarded = [];
    upstream = http.createServer((req, res) => {
      forwarded.push(req.url!);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ real: true }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;

    sw = createSwaggerizer({
      silent: true,
      validate: "enforce",
      proxy: upstreamUrl,
      specConfigs: {
        things: {
          handlers: {
            createThing: () => {
              handlerCalls += 1;
              return undefined;
            }
          }
        }
      }
    });
    await sw.load(tmp);
    ({ base } = await startOn(sw));
    admin = `${base}/swaggerizer`;

    plain = createSwaggerizer({ silent: true });
    await plain.load(tmp);
    ({ base: plainBase } = await startOn(plain));

    ignored = createSwaggerizer({ silent: true, validate: "enforce", specConfigs: { things: { validateIgnore: ["POST /legacy"] } } });
    await ignored.load(tmp);
    ({ base: ignoredBase } = await startOn(ignored));
  });

  after(async () => {
    await sw.close();
    await plain.close();
    await ignored.close();
    upstream.close();
  });

  const tenant = { "x-tenant": "acme" };

  test("off is the default: nothing is validated and nothing is recorded", async () => {
    const res = await call(`${plainBase}/things?limit=abc`, { headers: tenant });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-swaggerizer-validation"), null);
    const log = (await call(`${plainBase}/swaggerizer/api/log`)).json.entries;
    assert.ok(log.every((entry: any) => entry.validation === undefined));
  });

  test("enforce rejects an invalid query parameter with the issues", async () => {
    const res = await call(`${base}/things?limit=abc`, { headers: tenant });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("x-swaggerizer-validation"), "failed");
    assert.equal(res.json.issues[0].location, "query.limit");
    assert.equal(res.json.operation, "GET /things");
  });

  test("enforce rejects a missing required header and a non-numeric path parameter", async () => {
    const header = await call(`${base}/things?limit=1`);
    assert.equal(header.status, 400);
    assert.equal(header.json.issues[0].location, "header.x-tenant");

    const path = await call(`${base}/things/abc`, { headers: tenant });
    assert.equal(path.status, 400);
    assert.equal(path.json.issues[0].location, "path.id");
  });

  test("a valid request is served unchanged", async () => {
    const res = await call(`${base}/things?limit=10`, { headers: tenant });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-swaggerizer-validation"), null);
  });

  test("the header overrides the mode per request, in both directions", async () => {
    const off = await call(`${base}/things?limit=abc`, { headers: { ...tenant, "x-swaggerizer-validation": "off" } });
    assert.equal(off.status, 200);

    const warn = await call(`${base}/things?limit=abc`, { headers: { ...tenant, "x-swaggerizer-validation": "warn" } });
    assert.equal(warn.status, 200);
    assert.equal(warn.headers.get("x-swaggerizer-validation"), "warning");

    const enforce = await call(`${plainBase}/things?limit=abc`, { headers: { ...tenant, "x-swaggerizer-validation": "enforce" } });
    assert.equal(enforce.status, 400);
  });

  test("the live log carries the issues for a warned request", async () => {
    await call(`${base}/things?limit=abc`, { headers: { ...tenant, "x-swaggerizer-validation": "warn" } });
    const entries = (await call(`${admin}/api/log`)).json.entries;
    const entry = entries.slice().reverse().find((item: any) => item.validation && item.status === 200);
    assert.equal(entry.validation.request[0].location, "query.limit");
    assert.equal(entry.validation.request[0].keyword, "type");
  });

  test("an invalid body is rejected before the custom handler runs", async () => {
    handlerCalls = 0;
    const missing = await call(`${base}/things`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenant },
      body: JSON.stringify({ count: 2 })
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.issues[0].location, "body.name");
    assert.equal(handlerCalls, 0);

    const valid = await call(`${base}/things`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenant },
      body: JSON.stringify({ name: "Nibbles" })
    });
    assert.equal(valid.status, 201);
    assert.equal(handlerCalls, 1);
  });

  test("a required body and an unparseable body are reported differently", async () => {
    const none = await call(`${base}/things`, { method: "POST", headers: tenant });
    assert.equal(none.status, 400);
    assert.equal(none.json.issues[0].keyword, "required");
    assert.equal(none.json.issues[0].location, "body");

    const broken = await call(`${base}/things`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenant },
      body: "{nope"
    });
    assert.equal(broken.status, 400);
    assert.equal(broken.json.issues[0].keyword, "parse");
  });

  test("an unsupported media type is skipped, not failed", async () => {
    const res = await call(`${base}/things`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...tenant },
      body: "hello"
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("x-swaggerizer-validation"), "warning");
    const entries = (await call(`${admin}/api/log`)).json.entries;
    const entry = entries.find((item: any) => item.validation && item.validation.skipped);
    assert.equal(entry.validation.skipped, "unsupported-media-type");
  });

  test("proxy mode does not forward a request the spec forbids", async () => {
    forwarded.length = 0;
    const blocked = await call(`${base}/things/abc`, { headers: { ...tenant, "x-swaggerizer-scenario": "proxy" } });
    assert.equal(blocked.status, 400);
    assert.deepEqual(forwarded, []);

    const allowed = await call(`${base}/things/7`, { headers: { ...tenant, "x-swaggerizer-scenario": "proxy" } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(forwarded, ["/things/7"]);
  });

  test("validateIgnore exempts an operation", async () => {
    const exempt = await call(`${ignoredBase}/legacy`, { method: "POST" });
    assert.equal(exempt.status, 201);
    const checked = await call(`${base}/legacy`, { method: "POST" });
    assert.equal(checked.status, 400);
  });

  test("unmatched routes keep their 404 and are not validated", async () => {
    const res = await call(`${base}/nothing/here`, { headers: tenant });
    assert.equal(res.status, 404);
    assert.match(res.json.error, /No operation matches/);
  });

  test("GET /api/validation reports the mode and which operations have schemas", async () => {
    const res = await call(`${admin}/api/validation`);
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, "enforce");
    const create = res.json.operations.find((op: any) => op.key === "post:/things");
    assert.equal(create.hasRequestSchema, true);
  });

  test("reloading rebuilds the compiled schemas", async () => {
    const before = await call(`${base}/things`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenant },
      body: "{}"
    });
    assert.equal(before.status, 400);

    const relaxed = structuredClone(spec);
    (relaxed.components.schemas.NewThing as any).required = [];
    await fs.writeFile(specFile, JSON.stringify(relaxed, null, 2));
    await post(`${admin}/api/reload`, {});
    const after = await call(`${base}/things`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tenant },
      body: "{}"
    });
    assert.equal(after.status, 201);
  });
});
