import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  analyseSpecFile,
  applySelection,
  buildContract,
  buildOperationStates,
  diffContracts,
  exceedsThreshold,
  formatReport,
  matchOperation,
  parseScenarioHeader,
  resolveResponse,
  sampleFromSchema,
  statusForCode,
  variantsOf,
  type AnalysedSpec
} from "../src/index";

const specs = path.join(__dirname, "..", "example_specs");
const next = path.join(__dirname, "..", "example_specs_next");

async function load(file: string, folder = specs): Promise<AnalysedSpec> {
  return analyseSpecFile(path.join(folder, file));
}

describe("catalogue", () => {
  test("lists every operation with named examples and defaults (OpenAPI 3.0)", async () => {
    const spec = await load("petstore.yaml");
    assert.equal(spec.specVersion, "3.0.3");
    assert.deepEqual(spec.basePaths, ["/v1"]);
    assert.equal(spec.serverUrl, "https://petstore.example.com/v1");
    const list = spec.operations.find(o => o.key === "get:/pets")!;
    assert.equal(list.operationId, "listPets");
    assert.deepEqual(list.tags, ["pets"]);
    assert.equal(list.defaultCode, "200");
    assert.equal(list.defaultExample, "threePets");
    assert.deepEqual(variantsOf(list).map(v => `${v.code}:${v.example}`), ["200:threePets", "200:emptyList", "500:example"]);
    const del = spec.operations.find(o => o.key === "delete:/pets/{petId}")!;
    assert.equal(del.defaultCode, "204");
    assert.equal(del.defaultExample, "empty");
    // 404 without examples gets a synthesised body from its schema
    assert.deepEqual(del.responses.find(r => r.code === "404")!.generated, { code: 1, message: "string" });
  });

  test("converts Swagger 2.0 and names its single example 'example'", async () => {
    const spec = await load("users.swagger.json");
    assert.equal(spec.id, "users");
    assert.equal(spec.specVersion, "2.0");
    assert.deepEqual(spec.basePaths, ["/api"]);
    const login = spec.operations.find(o => o.key === "post:/login")!;
    assert.deepEqual(variantsOf(login).map(v => `${v.code}:${v.example}`), ["200:example", "401:example", "423:generated"]);
    const user = spec.operations.find(o => o.key === "get:/users/{userId}")!;
    const generated = user.responses[0].generated as any;
    assert.equal(generated.email, "user@example.com");
    assert.equal(generated.role, "customer");
    assert.equal(generated.manager?.manager, undefined, "recursive schemas stop expanding");
  });

  test("handles OpenAPI 3.1 type arrays, oneOf, schema examples and 'default' responses", async () => {
    const spec = await load("orders.yaml");
    const get = spec.operations.find(o => o.key === "get:/orders/{orderId}")!;
    const body = get.responses.find(r => r.code === "200")!.generated as any;
    assert.equal(body.id, "ord_123");
    assert.equal(body.status, "pending");
    assert.deepEqual(body.payment, { type: "card", last4: "string" });
    assert.equal(get.responses.find(r => r.code === "default")!.status, 500);
    const list = spec.operations.find(o => o.key === "get:/orders")!;
    assert.deepEqual(list.responses.find(r => r.code === "503")!.contentTypes, ["application/problem+json"]);
  });

  test("statusForCode maps ranges and default", () => {
    assert.equal(statusForCode("404"), 404);
    assert.equal(statusForCode("2XX"), 200);
    assert.equal(statusForCode("default"), 500);
  });

  test("sampleFromSchema respects formats, enums, bounds and allOf", () => {
    assert.deepEqual(
      sampleFromSchema({
        allOf: [
          { type: "object", properties: { id: { type: "integer", minimum: 10 } } },
          { type: "object", properties: { when: { type: "string", format: "date-time" }, kind: { enum: ["a", "b"] } } }
        ]
      }),
      { id: 10, when: "2024-01-01T12:00:00Z", kind: "a" }
    );
  });
});

describe("scenario planner", () => {
  test("applySelection validates codes and examples and can infer the code from an example", async () => {
    const spec = await load("petstore.yaml");
    const op = spec.operations.find(o => o.key === "get:/pets")!;
    assert.deepEqual(applySelection(op, { example: "emptyList" }), { code: "200", example: "emptyList" });
    assert.deepEqual(applySelection(op, { code: "500" }), { code: "500", example: "example" });
    assert.throws(() => applySelection(op, { code: "418" }), /does not declare a 418/);
    assert.throws(() => applySelection(op, { code: "200", example: "nope" }), /no example named 'nope'/);
    assert.throws(() => applySelection(op, { mode: "weird" as any }), /mode must be one of/);
    assert.throws(() => applySelection(op, { delay: -1 }), /delay must be/);
    assert.deepEqual(applySelection(op, { custom: { status: 418, body: '{"a":1}' } }), { mode: "custom", custom: { status: 418, body: { a: 1 } } });
    assert.deepEqual(applySelection(op, { custom: { status: 200, body: "plain words" } }).custom, { status: 200, body: "plain words", contentType: "text/plain" });
    assert.throws(() => applySelection(op, { custom: { status: 200, body: "{oops", contentType: "application/json" } }), /not valid JSON/);
    const custom = applySelection(op, { mode: "custom" });
    assert.equal(custom.custom!.status, 200, "custom mode starts from the served response");
    assert.ok(Array.isArray(custom.custom!.body));
  });

  test("resolveResponse serves examples, custom bodies and proxy, honouring overrides", async () => {
    const spec = await load("petstore.yaml");
    const [state] = buildOperationStates([{ id: "petstore", enabled: true, operations: spec.operations }], {
      "get:/pets": { code: "500", delay: 50 }
    }).filter(o => o.key === "get:/pets");
    assert.equal(state.modified, true);
    const served = resolveResponse(state);
    assert.equal(served.kind, "respond");
    if (served.kind === "respond") {
      assert.equal(served.status, 500);
      assert.equal(served.delay, 50);
    }
    const overridden = resolveResponse(state, parseScenarioHeader("200:emptyList"));
    assert.equal(overridden.kind === "respond" && overridden.variant, "emptyList");
    assert.equal(resolveResponse(state, parseScenarioHeader("proxy")).kind, "proxy");
    // An override that does not fit is ignored
    const ignored = resolveResponse(state, parseScenarioHeader("999"));
    assert.equal(ignored.kind === "respond" && ignored.status, 500);
  });

  test("parseScenarioHeader understands codes, examples and modes", () => {
    assert.deepEqual(parseScenarioHeader("404"), { code: "404", mode: "mock" });
    assert.deepEqual(parseScenarioHeader("404:notFound"), { code: "404", example: "notFound", mode: "mock" });
    assert.deepEqual(parseScenarioHeader("cat"), { example: "cat", mode: "mock" });
    assert.deepEqual(parseScenarioHeader("custom"), { mode: "custom" });
    assert.equal(parseScenarioHeader(""), undefined);
  });

  test("matchOperation prefers static segments and strips server base paths", async () => {
    const spec = await load("users.swagger.json");
    const states = buildOperationStates([{ id: "users", enabled: true, operations: spec.operations }], {});
    assert.equal(matchOperation(states, "GET", "/users/me")!.operationId, "getCurrentUser");
    assert.equal(matchOperation(states, "GET", "/api/users/42"), undefined, "base path is only stripped when known");
    assert.equal(matchOperation(states, "GET", "/api/users/42", ["/api"])!.operationId, "getUser");
    assert.equal(matchOperation(states, "DELETE", "/users/42"), undefined);
  });

  test("the first enabled spec serving a route shadows later ones", async () => {
    const spec = await load("petstore.yaml");
    const states = buildOperationStates(
      [
        { id: "a", enabled: true, operations: spec.operations.map(o => ({ ...o, specId: "a" })) },
        { id: "b", enabled: true, operations: spec.operations.map(o => ({ ...o, specId: "b" })) }
      ],
      {}
    );
    const copies = states.filter(s => s.key === "get:/pets");
    assert.deepEqual(copies.map(c => [c.specId, c.active, c.shadowedBy]), [["a", true, undefined], ["b", false, "a"]]);
  });
});

describe("contract change detection", () => {
  test("identical specs report no changes", async () => {
    const a = await load("petstore.yaml");
    const b = await load("petstore.yaml");
    const report = diffContracts(a.contract, b.contract);
    assert.equal(report.changes.length, 0);
    assert.match(formatReport(report), /No contract changes/);
  });

  test("reports removed, added, renamed and breaking schema changes", async () => {
    const before = await load("petstore.yaml");
    const after = await load("petstore.yaml", next);
    const report = diffContracts(before.contract, after.contract);
    assert.deepEqual(report.removed, ["DELETE /pets/{petId}"]);
    assert.deepEqual(report.added.sort(), ["GET /owners", "PATCH /pets/{petId}"]);
    const has = (severity: string, operation: string, pattern: RegExp) =>
      report.changes.some(c => c.severity === severity && c.operation === operation && pattern.test(`${c.message} ${c.location ?? ""}`));
    assert.ok(has("breaking", "GET /pets", /Required parameter added.*ownerId/), "required query param");
    assert.ok(has("breaking", "GET /pets/{petId}", /operationId changed/), "operationId rename");
    assert.ok(has("breaking", "POST /pets", /Required property 'ownerId' added/), "required request field");
    assert.ok(has("breaking", "GET /pets", /Property 'tag' removed.*response 200/), "response field removed");
    assert.ok(has("breaking", "GET /pets", /Type changed from integer to string/), "type change");
    assert.ok(has("warning", "GET /pets", /Enum value\(s\) added: "rabbit"/), "response enum widened");
    assert.ok(has("info", "POST /pets", /Enum value\(s\) added: "rabbit".*request body/), "request enum widened is safe");
    assert.ok(exceedsThreshold(report, "breaking"));
    assert.equal(exceedsThreshold(report, "none"), false);
  });

  test("renaming a path parameter is not a change, and severities follow direction", () => {
    const doc = (paramName: string, required: string[], extra: Record<string, unknown> = {}) => ({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        [`/things/{${paramName}}`]: {
          parameters: [{ name: paramName, in: "path", required: true, schema: { type: "string" } }],
          put: {
            requestBody: { content: { "application/json": { schema: { type: "object", required, properties: { a: { type: "string" }, b: { type: "string" }, ...extra } } } } },
            responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required, properties: { a: { type: "string" }, b: { type: "string" }, ...extra } } } } } }
          }
        }
      }
    });
    const report = diffContracts(buildContract(doc("id", ["a"]), "t"), buildContract(doc("thingId", ["a", "b"], { c: { type: "string", nullable: true } }), "t"));
    assert.equal(report.removed.length + report.added.length, 0);
    const msgs = report.changes.map(c => `${c.severity}:${c.location}:${c.message}`);
    assert.ok(msgs.includes("breaking:request body.b:Property 'b' is now required"));
    assert.ok(msgs.includes("info:response 200 body.b:Property 'b' is now required"));
    assert.ok(msgs.includes("info:request body.c:Optional property 'c' added"));
    assert.ok(msgs.includes("info:response 200 body.c:Optional property 'c' added"));
  });
});
