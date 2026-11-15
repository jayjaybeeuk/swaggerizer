# Request validation

**Status:** implemented (phase 1) · **Release:** minor (`feat:`)

Swaggerizer loads a spec, answers requests from it and warns when the spec drifts from the generated
code. It never checks the requests it receives against that spec. This document specifies adding
that check: validate the path, query, header and cookie parameters and the request body of every
matched operation, then either log the problems or reject the request.

The default is `off`, so existing users see no change until they opt in.

## Why

The mock server is where a frontend calls an API that does not exist yet. If the frontend sends a
request the spec does not allow — a missing required body field, `limit=abc` where the spec says
integer, the wrong content type — Swaggerizer happily answers `200` with a valid example. The bug
then surfaces against the real backend, or in production, long after the mock "proved" the
integration worked.

Two smaller wins come with the same machinery:

- **Spec drift in the tests.** `createSwaggerizer()` as Express/Connect middleware is used as a
  stand-in backend in test suites. In `enforce` mode those suites fail on a request the contract
  forbids, instead of silently passing.
- **Contract sanity.** Running the mock with `--validate warn` in CI while a frontend test suite
  exercises it reports the requests that would break after a real backend deployment.

## Goals

1. Validate path, query, header and cookie parameters, and JSON / form request bodies, for every
   matched operation, using the spec document already loaded.
2. A mode per server, per spec and per request: `off`, `warn`, `enforce`.
3. Report issues in the existing live-request log and in the admin API, with enough detail
   (`location`, `message`, `keyword`) to fix the caller.
4. Keep the mock's scenario behaviour unchanged: the same response is served in `warn` mode, and no
   validation work happens at all when the mode is `off`.

## Non-goals

- **Response validation.** The mock serves bodies taken from the spec's own examples and fixtures;
  judging them is a contract test, not a mock. See [Phase 2](#phase-2--response-validation-optional).
- **Browser-side validation in the MSW runtime.** It would pull `ajv` into the browser bundle and
  duplicate the server's report. The MSW runtime only gains the ability to *report* a summary it
  was given.
- **Security scheme checks.** `security`/`securitySchemes` describe real auth; a mock has none.
- **Full OpenAPI 3.1 / JSON Schema 2020-12 support.** See [Dialects](#dialects).
- **Multipart, `application/octet-stream`, content encodings, `callbacks` and `webhooks`.** Requests
  whose media type cannot be parsed are reported as skipped, not failed.
- **Spec authoring or linting.** `SwaggerParser.validate` at load already covers document-level
  problems; this feature is about traffic.

## Design

### Pipeline

`serveMock()` in `src/server.ts` currently does:

```
matchOperation → custom handler? → resolveResponse → proxy | mocked response → recordRequest
```

It becomes:

```
matchOperation → resolve mode → read/parse body (only when needed) → validate (0..n issues)
   → enforce && issues ? 400 problem response : (custom handler? → resolveResponse → serve)
   → recordRequest({ …, validation })
```

Validation happens *before* custom handlers run, so a handler in `enforce` mode never receives a
body its own spec rejects. In `warn` mode the handler still runs, unchanged.

### Configuration

Top level in `swaggerizer.config.ts`:

```ts
export default defineConfig({
  validate: "warn",                 // "off" (default) | "warn" | "enforce"
  specs: {
    "online-banking-bff": {
      validate: "enforce",          // wins over the top-level mode
      validateIgnore: ["POST /legacy/import", "uploadAttachment"] // operationIds or "METHOD /route"
    }
  }
});
```

CLI (`serve` only — `generate`, `diff` and `pull` never receive requests):

```
swaggerizer serve --folder ./specs --validate warn
```

Per request, mirroring `X-Swaggerizer-Scenario`:

```
X-Swaggerizer-Validation: off | warn | enforce
```

Resolution order, first match wins:

1. `X-Swaggerizer-Validation` header (unknown values are ignored with a warning in the log entry).
2. `specs[id].validateIgnore` → `off`.
3. `specs[id].validate`.
4. top-level `validate` / `--validate`.
5. `"off"`.

`SwaggerizerOptions` gains `validate?: ValidationMode` and `specValidation?: Record<string, ValidationMode>`
for programmatic use. `SwaggerizerState` gains
`validation: { mode: ValidationMode; perSpec: Record<string, ValidationMode> }` so the admin page can
show what is active.

### Modes

| Mode | On issues | Response | Log entry |
| --- | --- | --- | --- |
| `off` (default) | nothing is parsed or validated | unchanged | no `validation` field |
| `warn` | issues recorded | unchanged, plus `X-Swaggerizer-Validation: warning` | `validation.request[]` populated |
| `enforce` | request rejected with `400` | `400` problem body (below) | `status: 400`, `example: "validation"`, issues recorded |

`enforce` applies to every mode the operation can serve, including `proxy`. A request the spec
forbids is not forwarded to the real API; that is the point of running the mock in `enforce`.

`OPTIONS` preflights and requests with `X-Swaggerizer-Validation: off` are never validated.

### What is validated

Only for an operation `matchOperation()` already matched, so unmatched paths keep their current
`404` / `fallback` behaviour.

**Parameters.** Every `parameters` entry on the operation and on its path item, after `$ref`
resolution, that is `in: path | query | header | cookie` and has a `schema` (or a `content` map with
exactly one JSON media type — otherwise the parameter is skipped). `required` is honoured for query,
header and cookie; path parameters are required by definition. `style`/`explode` drive array and
object decoding, defaulting to `simple` for path/header and `form` + `explode: true` for query/cookie.
`header` parameters named `Accept`, `Content-Type` or `Authorization` are ignored, as OAS requires.

**Body.** Present only when the operation declares `requestBody`:

- missing body for a `required: true` request body → `body` / `required`;
- `Content-Type` matching `requestBody.content` (media types compared case-insensitively, `+json`
  suffixes recognised, `*/*` treated as `application/json` — the same rule `normaliseMediaType()` already
  applies to responses);
- `application/json` and `*/+json`: parsed with the existing `parseRequestBody()`. A parse failure is
  reported as a `body` issue with keyword `parse`, and is the one case in which `enforce` returns
  `400` even though no schema check ran;
- `application/x-www-form-urlencoded`: parsed to a `Record<string, string>` and coerced (below);
- anything else → `validation.skipped = "unsupported-media-type"` and no body check.

**Unknown query parameters and extra body properties** are accepted. `additionalProperties: false` in
the caller's own schema still applies, because that is the spec talking.

### Coercion

HTTP gives us strings; the spec gives us `integer`, `boolean`, arrays and objects. Validation runs
against a **coerced copy**; handlers keep receiving what they receive today (`URLSearchParams`, raw
path strings, parsed JSON).

| Spec type | Input | Rule |
| --- | --- | --- |
| `integer`, `number` | string | `Number(value)` when it matches `^[+-]?(\d+(\.\d+)?\|\.\d+)([eE][+-]?\d+)?$`, otherwise left as-is so the schema reports `type` |
| `boolean` | string | `"true"` → `true`, `"false"` → `false`, otherwise left as-is |
| `array` | `explode: true` | `URLSearchParams.getAll()` (repeated keys) |
| `array` | `explode: false` | split on `,` |
| `array` | header/path | split on `,` |
| `object` | `explode: false` | split on `,`, then on the first `:` |
| `object` | `explode: true` (query) | repeated keys are **not** rebuilt into an object — reported as `skipped: "object-style"` |

`coerceTypes` stays `false` in Ajv: coercion is ours, explicit, and never mutates the request or the
schema. `useDefaults` stays `false` — a mock must not invent values and then echo them as if the
caller sent them. `removeAdditional` is never used.

Form bodies get coercion at the top level only; a form body with a nested object schema is reported
as `skipped: "form-nesting"`. JSON bodies need no coercion.

### Error response (`enforce`)

Status `400`, `Content-Type: application/json` (matching `sendJson()` elsewhere), and:

```json
{
  "error": "Request validation failed",
  "operation": "POST /pets",
  "specId": "petstore",
  "issues": [
    { "location": "body.ownerId", "message": "must have required property 'ownerId'", "keyword": "required" },
    { "location": "query.limit", "message": "must be integer", "keyword": "type" }
  ]
}
```

`X-Swaggerizer-Validation: failed` is set (and added to `Access-Control-Expose-Headers`). Issues are
capped at 20 in the response and in the log; `allErrors: true` means the first 20 come from Ajv's own
ordering, which already reports `required` before per-property failures.

The response is *not* taken from the spec's declared `400`, because that response describes the real
API's error format and a validation failure here is a tooling error, not an API error. Specs whose
`400` schema is what the frontend parses keep working: they simply never see this body unless they
send a request the contract forbids.

### Admin page

- `RequestLogEntry` gains an optional `validation?: ValidationSummary`:

  ```ts
  export interface ValidationIssue {
    /** Dotted location: "query.limit", "body.ownerId", "header.x-tenant". */
    location: string;
    message: string;
    /** Ajv keyword: "required", "type", "enum", "format", "parse"… */
    keyword?: string;
  }

  export interface ValidationSummary {
    request: ValidationIssue[];
    /** Why a check did not run: "unsupported-media-type", "object-style", "form-nesting", "no-schema". */
    skipped?: string;
  }
  ```

- The **Live requests** list gets one extra chip per invalid entry — `⚠ 2` — whose `title` lists the
  issues (`query.limit: must be integer`). No new panel, no new page: the log already carries
  `status`, `example` and `ms`, and validation is a property of a request.
- The header row shows the active mode when it is not `off`, e.g. `validation: warn`, as a reminder
  that a `200` may still be an invalid request.
- `POST /api/log` accepts `validation` from the MSW runtime, sanitised the same way as every other
  field (strings only, max 20 issues, max 200 characters each). No MSW code in this change produces
  it; the endpoint simply stops dropping it.
- New route, for CI and for the tests that drive the server programmatically:
  `GET /api/validation` → `{ mode, perSpec, operations: [{ specId, key, hasRequestSchema }] }`.
  Useful for asserting that validation is on in a preview deployment.

### Phase 2 — response validation (optional)

Not part of this change. Sketched so the types and log shape above do not need to move later:

- `responseValidation: "off" | "warn"` (default `"off"`), never `enforce`;
- validates the variant actually served: `generated` (synthesised from the schema) and `custom`
  (typed into the admin page) — never a named `example`, which is authored and often deliberately
  partial;
- records `validation.response: ValidationIssue[]` and sets `X-Swaggerizer-Validation-Response: warning`;
- never alters the body or status.

The `ValidationSummary` type above already reserves `response`; adding it is additive.

## Implementation

### Module layout

New file `src/validate.ts` — Node only, never imported by `src/msw.ts`, `src/debug-menu.ts` or
`src/types.ts`:

```ts
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

export interface Validator {
  validateRequest(op: CatalogueOperation, input: ValidationInput): ValidationSummary;
  /** True when the operation declares any parameter or a request body. */
  hasRequestSchema(op: CatalogueOperation): boolean;
  /** Phase 2: validateResponse(op, body, contentType). */
}

export interface ValidationInput {
  /** Path parameters, already extracted for the matched route. */
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON or form fields; undefined when the request carried no body. */
  body?: unknown;
  /** Set when the body could not be parsed; reported as an issue rather than guessed at. */
  bodyError?: string;
  contentType?: string;
}

/** One validator per loaded spec, compiled lazily per operation and cached until the next reload. */
export function createValidator(doc: any, specId: string, specVersion?: string): Validator;

/** "query.limit: must be integer" — used for the log chip tooltip and CLI output. */
export function formatIssues(issues: ValidationIssue[]): string;
```

Per-operation schemas are compiled on first use and cached in the `Validator` by `op.key`, so a server
with 200 operations pays for the operations that are actually called.

### Schemas and `$ref`s

`loadSpecFile()` already leaves us with a **bundled** document: external `$ref`s are inlined and
internal ones stay as `#/components/...`, and Swagger 2 has been converted to OpenAPI 3. So one
code path handles both formats.

Register the whole document once under a `urn:swaggerizer:<id>` base, then compile each operation's
parameter and body schema standalone, with its internal `#/...` refs rewritten to point at that base.
Prefer that over dereferencing: dereferencing would break recursive schemas, which `src/schema.ts`
has to handle specially for sampling.

```ts
ajv.addSchema(docForAjv, base);                                 // base = `urn:swaggerizer:${specId}`
const validate = ajv.compile(withBaseRefs(schema, base));       // "#/components/…" → `${base}#/components/…`
```

A schema Ajv refuses to compile is reported as `skipped: "invalid-schema"` for that operation, never
as a failed request.

`docForAjv` is a deep clone of `spec.doc` with one rewrite: OpenAPI 3.0 `nullable: true` becomes
`type: [<type>, "null"]` (or `anyOf: [schema, { type: "null" }]` when the schema is a `$ref`/`allOf`,
as 3.0 allows). Ajv's `strict: false` covers the remaining OAS-only keywords (`example`, `xml`,
`discriminator`, `deprecated`, `externalDocs`). The clone matters: `spec.doc` is also what
`GET /api/openapi/<id>.json` serves and what the admin page reads, and must stay exactly as loaded.

Ajv options: `{ strict: false, allErrors: true, coerceTypes: false, useDefaults: false,
allowUnionTypes: true, validateFormats: true }`, plus `addFormats()`.

### Dialects

| Spec | Ajv instance | Reason |
| --- | --- | --- |
| `openapi: 3.0.x`, converted Swagger 2 | `ajv` (draft-07) | OAS 3.0's schema dialect is a draft-04/07 subset |
| `openapi: 3.1.x` | `ajv/dist/2020` | 3.1 is JSON Schema 2020-12; `exclusiveMinimum` is numeric, and draft-07 would misread it |

`createValidator()` picks the instance from `specVersion` (already on `AnalysedSpec`). A 3.1-only
keyword that the 2020-12 instance does not implement (`$dynamicRef`) is reported as
`skipped: "unsupported-keyword"` rather than a false failure.

### Body handling (the one real refactor)

`readBody(req)` consumes the `http.IncomingMessage` stream, and `serveMock()` currently calls it only
inside the custom-handler branch; `proxy()` calls it again. Validation needs the body *before* that
branch, so `serveMock()` reads it once into a `Buffer` when — and only when — it is needed:

```
needsBody = (method allows a body) && (validation enabled for this op || custom handler exists || mode === proxy)
```

The buffer is then reused for validation, for the handler context (`parseRequestBody()` on the same
buffer) and for forwarding. If no validation and no handler apply, nothing is read early and the
proxy path keeps streaming behaviour exactly as today. The existing 5 MiB `MAX_BODY_BYTES` guard
applies; exceeding it already rejects with `400`.

### Files

| File | Change |
| --- | --- |
| `src/types.ts` | `ValidationMode`, `ValidationIssue`, `ValidationSummary`; `RequestLogEntry.validation?`; `SwaggerizerState.validation` |
| `src/validate.ts` | **new** — Ajv setup, pointer escaping, nullable rewrite, coercion, `createValidator`, `formatIssues` |
| `src/server.ts` | mode resolution, single body read, call validator, `400` in `enforce`, `validation` on log entries, expose the new header |
| `src/config.ts` | `validate`, `validateIgnore` (top level and per spec); still browser-safe |
| `src/cli.ts` | `--validate <off\|warn\|enforce>` on `serve` |
| `src/admin.ts` | `GET /api/validation`, sanitise `validation` on `POST /api/log` |
| `src/ui/app.js`, `src/ui/app.css` | warning chip in the request log, active-mode label |
| `src/index.ts` | export `createValidator`, `formatIssues` and the new types |
| `package.json` | `ajv`, `ajv-formats` in `dependencies` (rollup picks dependencies up as externals automatically) |
| `README.md` | "Request validation" section; `serve` line in the CLI block |
| `test/validate.test.ts`, `test/server.test.ts` | see below |

### Backwards compatibility

- Default `off`: no behaviour change, no Ajv instance constructed, no extra body reads.
- `RequestLogEntry.validation` and `SwaggerizerState.validation` are additive; the MSW runtime and the
  admin page tolerate their absence (the UI checks the field before rendering).
- `X-Swaggerizer-Validation` joins `X-Swaggerizer-Scenario` and `X-Swaggerizer-Proxied` in the strip
  list in `proxy()` and in `Access-Control-Expose-Headers`.
- Release is `feat: validate requests against the loaded spec`, i.e. a minor.

### Performance

- Compilation is lazy, per operation, cached until reload (`validationCache.clear()` in `doReload()`).
- Steady-state cost per request is one Ajv validate call over the parameter set and the body schema,
  measured on the example specs before merging. If it shows up in `ms` on the log, the mode stays opt-in.
- With `off`, cost is one `Map` lookup.

## Test plan

New `test/validate.test.ts` (pure, no server) and additions to `test/server.test.ts` (HTTP-level,
using the existing `createSwaggerizer` + `startOn` helpers and a purpose-built fixture spec with
query, header, path and body parameters).

| # | Case | Expected |
| --- | --- | --- |
| 1 | mode `off`, invalid request | `200`, no `validation` on the log entry |
| 2 | mode `warn`, missing required body field | `200`, `X-Swaggerizer-Validation: warning`, issue `body.ownerId` / `required` |
| 3 | mode `enforce`, same request | `400`, `issues[0].location === "body.ownerId"`, `example: "validation"` |
| 4 | mode `enforce`, valid request | unchanged response, no validation header |
| 5 | `X-Swaggerizer-Validation: off` on an `enforce` server | request served, no issues |
| 6 | `X-Swaggerizer-Validation: enforce` on an `off` server | `400` |
| 7 | `validateIgnore` covers the operation | not validated even under `enforce` |
| 8 | `query.limit=abc` where spec says integer | issue `query.limit` / `type` |
| 9 | `query.ids=a&ids=b` with `explode: true` | valid array |
| 10 | `query.ids=a,b` with `explode: false` | valid array |
| 11 | missing required header | issue `header.x-tenant` / `required` |
| 12 | `Content-Type: text/plain` on a JSON body | skipped `unsupported-media-type`, request served |
| 13 | unparseable JSON body | issue `body` / `parse`; `400` under `enforce`, `200` under `warn` |
| 14 | `POST /pets` with a custom handler, invalid body, `enforce` | handler never called (assert on the handler's side effect) |
| 15 | proxy mode, invalid request, `enforce` | `400`; upstream receives nothing |
| 16 | unmatched route, `enforce` | existing `404`, no validation |
| 17 | OpenAPI 3.1 spec with numeric `exclusiveMinimum` | uses the 2020-12 instance; correct pass/fail |
| 18 | recursive schema (`Node.children: Node[]`) | compiles and validates; no stack overflow |
| 19 | spec reloaded | cache rebuilt; a spec change takes effect |
| 20 | Swagger 2.0 spec, converted | body validated the same as 3.0 |

## Alternatives considered

| Option | Why not |
| --- | --- |
| `express-openapi-validator` | Express-only middleware; Swaggerizer serves `handler` on plain `node:http` and as Connect middleware, so it would need an Express shim and would drag in a second routing/matching layer that disagrees with `matchOperation()`. |
| Stoplight Prism (`prism proxy`) | Does validate requests, but as a separate process: it cannot see scenario choices, custom handlers, aliases or the request log, and would need its own copy of every spec. |
| `openapi-backend` | Good validator, but brings its own router and operation registry — a parallel implementation of `matchOperation()`/`buildCatalogue()`. |
| `swagger-tools` | The historical answer to this exact problem, but Connect+Swagger 2.0 only and unmaintained; it also wants to own routing. |
| Hand-written checks per parameter type | No 3.0 param serialisation rules, no `$ref` handling, no `allOf`/`oneOf`; every gap becomes a false pass. |
| `SwaggerParser.validate` at request time | Document-level only, and already run at load (`src/spec.ts`). |

Ajv is the validator underneath most of the rejected options, is already in the dependency tree via
orval, and is the only addition this design needs.

## Open questions

1. **`warn` in CI.** Should a `--validate-fail-on` style flag make `serve` exit non-zero after N
   invalid requests, so a playwright run can fail the build? Useful, but it needs a shutdown hook and
   a report; skipping it keeps this change small. Leaning: follow-up.
2. **Rejecting unknown query parameters.** Strict mode would catch stale frontends early, but
   breaks any caller that adds cache-busting or tracking parameters. Leaning: opt-in
   (`validateStrict?: boolean`), not in this change.
3. **Cookie parameters.** `Cookie` header parsing is one line but cookie-based APIs are rare in the
   specs this tool serves (springdoc/JAX-RS). Implemented, untested against a real spec.
4. **Validation in the debug menu.** A "show invalid requests" filter in the in-app menu is cheap
   once the log carries the data, but belongs with the MSW reporting work in Phase 2.

## Rollout checklist

- [x] `src/validate.ts` with unit tests (coercion table, ref rewriting, nullable rewrite, dialects)
- [x] `src/server.ts` wiring: mode resolution, single body read, `enforce` short-circuit, log field
- [x] config + CLI + `SwaggerizerOptions` + state surface
- [x] admin `GET /api/validation`, log sanitising, UI chip
- [x] `ajv` + `ajv-formats` in `dependencies`; `npm run build` externalises them
- [x] README section and CLI block
- [x] validation tests green; `npm run typecheck`, `npm test`
- [ ] `npm run example` against `example_specs` with `--validate warn` to check the log stays readable
