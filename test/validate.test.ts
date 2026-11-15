import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalogue } from "../src/catalogue";
import { createValidator, formatIssues, matchesIgnore, parseValidationMode, unmatchedIgnore } from "../src/validate";
import type { ValidationInput } from "../src/validate";

const doc = {
  openapi: "3.0.3",
  info: { title: "Things", version: "1.0.0" },
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
          { name: "ids", in: "query", schema: { type: "array", items: { type: "integer" } } },
          { name: "flag", in: "query", schema: { type: "boolean" } },
          { name: "x-tenant", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "ok" } }
      },
      post: {
        operationId: "createThing",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/NewThing" } } }
        },
        responses: { "201": { description: "created" } }
      }
    },
    "/things/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      get: { operationId: "showThing", responses: { "200": { description: "ok" } } }
    },
    "/nodes": {
      post: {
        operationId: "createNode",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } }
        },
        responses: { "201": { description: "created" } }
      }
    },
    "/form": {
      post: {
        operationId: "submitForm",
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } }
            }
          }
        },
        responses: { "201": { description: "created" } }
      }
    }
  },
  components: {
    schemas: {
      NewThing: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", nullable: true }, count: { type: "integer" } }
      },
      Node: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/components/schemas/Node" } } }
      }
    }
  }
};

const operations = buildCatalogue(doc, "things");
const operation = (key: string) => operations.find(op => op.key === key)!;
const validator = createValidator(doc, "things", "3.0.3");

function input(overrides: Partial<ValidationInput> = {}): ValidationInput {
  return {
    params: {},
    query: new URLSearchParams(),
    headers: { "x-tenant": "acme" },
    ...overrides
  };
}

describe("request validation", () => {
  test("accepts a request that fits the spec", () => {
    const summary = validator.validateRequest(
      operation("get:/things"),
      input({ query: new URLSearchParams("limit=10&ids=1&ids=2&flag=true") })
    );
    assert.deepEqual(summary.request, []);
    assert.equal(summary.skipped, undefined);
  });

  test("reports a wrong query type and a maximum violation", () => {
    const type = validator.validateRequest(operation("get:/things"), input({ query: new URLSearchParams("limit=abc") }));
    assert.equal(type.request[0].location, "query.limit");
    assert.equal(type.request[0].keyword, "type");

    const max = validator.validateRequest(operation("get:/things"), input({ query: new URLSearchParams("limit=101") }));
    assert.equal(max.request[0].location, "query.limit");
    assert.equal(max.request[0].keyword, "maximum");
  });

  test("coerces arrays, booleans and numbers on a copy", () => {
    const bad = validator.validateRequest(operation("get:/things"), input({ query: new URLSearchParams("ids=a") }));
    assert.equal(bad.request[0].location, "query.ids.0");
    const badFlag = validator.validateRequest(operation("get:/things"), input({ query: new URLSearchParams("flag=maybe") }));
    assert.equal(badFlag.request[0].location, "query.flag");
  });

  test("reports a missing required header and a non-numeric path parameter", () => {
    const header = validator.validateRequest(operation("get:/things"), input({ headers: {} }));
    assert.equal(header.request[0].location, "header.x-tenant");
    assert.equal(header.request[0].keyword, "required");

    const path = validator.validateRequest(operation("get:/things/{id}"), input({ params: { id: "abc" } }));
    assert.equal(path.request[0].location, "path.id");
    assert.equal(path.request[0].keyword, "type");
  });

  test("validates the body through $refs, including nullable properties", () => {
    const missing = validator.validateRequest(operation("post:/things"), input({ body: { count: 2 } }));
    assert.equal(missing.request[0].location, "body.name");
    assert.equal(missing.request[0].keyword, "required");

    const nullName = validator.validateRequest(operation("post:/things"), input({ body: { name: null } }));
    assert.deepEqual(nullName.request, []);

    const noBody = validator.validateRequest(operation("post:/things"), input());
    assert.equal(noBody.request[0].location, "body");
    assert.equal(noBody.request[0].keyword, "required");
  });

  test("reports an unparseable body as a parse issue", () => {
    const summary = validator.validateRequest(operation("post:/things"), input({ bodyError: "Request body is not valid JSON." }));
    assert.equal(summary.request[0].keyword, "parse");
    assert.equal(summary.request[0].location, "body");
  });

  test("skips a media type it cannot read", () => {
    const summary = validator.validateRequest(
      operation("post:/things"),
      input({ body: "hello", contentType: "text/plain" })
    );
    assert.deepEqual(summary.request, []);
    assert.equal(summary.skipped, "unsupported-media-type");
  });

  test("validates recursive schemas", () => {
    const summary = validator.validateRequest(
      operation("post:/nodes"),
      input({ body: { name: "root", children: [{ name: "leaf", children: [{ children: [] }] }] } })
    );
    assert.equal(summary.request.length, 1);
    assert.equal(summary.request[0].location, "body.children.0.children.0.name");
  });

  test("coerces form fields", () => {
    const form = (body: Record<string, string>) =>
      validator.validateRequest(operation("post:/form"), input({ body, contentType: "application/x-www-form-urlencoded" }));
    assert.deepEqual(form({ count: "3" }).request, []);
    assert.equal(form({ count: "three" }).request[0].location, "body.count");
    assert.equal(form({}).request[0].keyword, "required");
  });

  test("uses the 2020-12 dialect for OpenAPI 3.1", () => {
    const doc31 = {
      openapi: "3.1.0",
      info: { title: "N", version: "1.0.0" },
      paths: {
        "/n": {
          get: {
            operationId: "n",
            parameters: [{ name: "n", in: "query", schema: { type: "number", exclusiveMinimum: 5 } }],
            responses: { "200": { description: "ok" } }
          }
        }
      }
    };
    const op = buildCatalogue(doc31, "n31").find(entry => entry.key === "get:/n")!;
    const v31 = createValidator(doc31, "n31", "3.1.0");
    assert.deepEqual(v31.validateRequest(op, input({ query: new URLSearchParams("n=6") })).request, []);
    assert.equal(v31.validateRequest(op, input({ query: new URLSearchParams("n=5") })).request[0].keyword, "exclusiveMinimum");
  });

  test("knows which operations declare something to check", () => {
    assert.equal(validator.hasRequestSchema(operation("get:/things")), true);
    assert.equal(validator.hasRequestSchema(operation("post:/things")), true);
    assert.equal(validator.hasRequestSchema(operation("get:/things/{id}")), true);
  });

  test("formats issues and understands the config surface", () => {
    assert.equal(
      formatIssues([{ location: "query.limit", message: "must be integer" }]),
      "query.limit: must be integer"
    );
    assert.equal(parseValidationMode(" ENFORCE "), "enforce");
    assert.equal(parseValidationMode("yes"), undefined);
    assert.equal(matchesIgnore(["GET /things"], operation("get:/things")), true);
    assert.equal(matchesIgnore(["listThings"], operation("get:/things")), true);
    assert.equal(matchesIgnore(undefined, operation("get:/things")), false);
    assert.deepEqual(unmatchedIgnore(["nope"], operations), ["nope"]);
  });
});
