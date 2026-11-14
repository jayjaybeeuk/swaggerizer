# swaggerizer

It's a strategizer for OpenAPI and Swagger, the sibling of [ramlizer](https://github.com/jayjaybeeuk/ramlizer).

## What?

Swaggerizer takes your OpenAPI 3.x or Swagger 2.0 documents and gives you:

1. **A live mock API with an admin page.** Every response and named example in the spec becomes a scenario you can switch to while the mock is running. You can switch from the admin page, with a GET link, with an HTML form post or with JSON.
2. **Generated code from [orval](https://orval.dev).** You get a typed client, models and [MSW](https://mswjs.io) handlers. Swaggerizer wraps those handlers so they follow the same scenario choices: they serve a named example or a custom response, fall back to orval's faker data, or pass through to the real API.
3. **A debug menu for your app.** It's a small floating panel you mount in the browser to switch the MSW mocks while you click around. It works on its own, or synced with a running admin page.
4. **Contract-change warnings before you regenerate.** Swaggerizer saves a snapshot of the contract next to the generated code. It then tells you about new APIs, deleted APIs and breaking changes before `generate` overwrites anything.

## Why?

Your UI behaves differently depending on what the API returns: an empty list, a validation error, a 500 or a slow response. You need to see every one of those states without changing backend data or restarting a mock server.

You also regenerate client code whenever the backend team updates the spec. Swaggerizer warns you that an endpoint was removed, a field became required or an `operationId` was renamed (which renames your generated function) *before* the change lands in your code.

## Quick start

```bash
npm install --save-dev swaggerizer msw @faker-js/faker

# 1. Serve live mocks with an admin page
npx swaggerizer serve --folder ./specs --port 8080
#    → mock API on http://localhost:8080, admin page on http://localhost:8080/swaggerizer/

# 2. Generate a typed client, models and MSW mocks (warns about contract changes first)
npx swaggerizer generate --folder ./specs --output ./src/api

# 3. In CI: fail when the specs drift from the generated code in a breaking way
npx swaggerizer diff --folder ./specs --output ./src/api --fail-on breaking
```

You can try it on the bundled examples:

```bash
npm install && npm run build
npm run example            # serve ./example_specs, compared against ./example_generated
npm run example:diff       # what would change if ./example_specs_next were adopted
npm run example:browser    # orval client + MSW + debug menu demo on http://localhost:5173
```

## Scenarios

Each operation (method + route) answers in one of three **modes**:

| Mode | What is served |
| --- | --- |
| `mock` (default) | A response declared in the spec. Pick a status code and a named example. A response without examples gets a body generated from its schema. |
| `custom` | A status, body and content type you type in yourself. Bodies that aren't valid JSON are sent as `text/plain`. |
| `proxy` | The real API. The server forwards to `--proxy` or the spec's `servers` URL; MSW calls `passthrough()`. |

Any mode can add an artificial **delay** in milliseconds.

#### Named examples

OpenAPI 3 `examples` show up as switchable scenarios:

```yaml
responses:
  "400":
    description: Validation failed
    content:
      application/json:
        schema: { $ref: "#/components/schemas/ValidationError" }
        examples:
          missingName:
            value: { errorList: [{ fieldName: name, message: Name is required }] }
          badSpecies:
            value: { errorList: [{ fieldName: species, message: We do not stock dragons }] }
```

A single `example`, a schema-level `example`/`examples`, or a Swagger 2 `examples` entry appears as one scenario called `example`. A response with a body but no example is called `generated`, and one without a body is called `empty`.

#### Switching from anywhere

```bash
# A GET link: paste it in a browser or call it from a test
curl 'http://localhost:8080/swaggerizer/api/select?method=post&route=/pets&code=400&example=badSpecies'

# A plain HTML form post (add redirect=/somewhere to be sent back afterwards)
curl -X POST http://localhost:8080/swaggerizer/api/select -d 'method=get&route=/pets&example=emptyList'

# JSON: one selection or an array, applied all-or-nothing
curl -X POST http://localhost:8080/swaggerizer/api/select -H 'Content-Type: application/json' -d '[
  { "method": "get",  "route": "/pets", "code": "500", "delay": 1500 },
  { "method": "post", "route": "/login", "custom": { "status": 423, "body": { "locked": true } } },
  { "method": "get",  "route": "/pets/{petId}", "mode": "proxy" }
]'
```

`example` can be given without `code`: Swaggerizer finds the response that declares it. The ramlizer payload (`{ route, method, nextResponseCode, nextExampleName }` posted to `/swaggerizer`) works too.

#### One request at a time

Send `X-Swaggerizer-Scenario` with a request to override the choice for that request only. This is handy for parallel tests:

```
X-Swaggerizer-Scenario: 404            → the 404 response
X-Swaggerizer-Scenario: 400:badSpecies → that example
X-Swaggerizer-Scenario: emptyList      → whichever response declares it
X-Swaggerizer-Scenario: proxy          → the real API
```

## The admin page

Open **http://localhost:8080/swaggerizer/** while `serve` is running:

- **Switch responses.** Every response code and named example appears as a radio button. Use the **Spec response / Custom / Real API** buttons to change mode, and the delay box to add latency.
- **Custom responses.** Edit the status, content type and body. The editor starts from whatever is currently served.
- **Preview & try.** See the payload that will be served and fire a real request at the mock.
- **Copy link / Copy curl.** Copy the GET link or curl command that reproduces the current choice.
- **Contract changes.** A banner lists breaking changes, warnings, new and removed operations whenever the specs differ from the generated code (`--generated`) or changed since they were last loaded.
- **Specs.** Turn whole files on or off. When two enabled specs declare the same route, the first one wins and the other is marked *shadowed*.
- **Reload specs.** Re-read the files from disk, or start with `--watch` to reload automatically.
- **Live requests.** A log of calls to the mock, including requests answered by MSW in a browser or test (tagged `msw`).

The admin page and API have no authentication, so only run Swaggerizer on networks you trust.

## Generated code

```bash
npx swaggerizer generate --folder ./specs --output ./src/api --client fetch
```

For each spec (`petstore.yaml` → `src/api/petstore/`), orval writes:

| File | What it is |
| --- | --- |
| `petstore.ts` | The typed client (`listPets()`, `createPet()`…). `--client` accepts any orval client: `fetch`, `axios`, `react-query`, `swr`, `vue-query`, `angular`… |
| `model/` | TypeScript types for every schema |
| `petstore.msw.ts`, `petstore.faker.ts` | orval's MSW handlers and faker data |

Swaggerizer adds:

| File | What it is |
| --- | --- |
| `swaggerizer.ts` | The manifest (operations, responses, examples) and `createPetstoreMocks()` |
| `swaggerizer.contract.json` | The contract snapshot used for change detection. Commit it. |
| `../index.ts` | `createMocks()` for every spec, and each client as a namespace (`petstore.listPets()`) |

#### Using the mocks

```ts
// browser
import { setupWorker } from "msw/browser";
import { mountDebugMenu } from "swaggerizer/debug-menu";
import { createMocks } from "./api";

const mocks = createMocks();          // choices kept in localStorage
await setupWorker(...mocks.handlers).start();
mountDebugMenu(mocks);                // floating "API mocks" button, or Alt+Shift+S
```

```ts
// tests (vitest / jest / node:test)
import { setupServer } from "msw/node";
import { createMocks } from "./api";

const mocks = createMocks({ storageKey: false });
const server = setupServer(...mocks.handlers);

test("shows an error banner when the pet list fails", async () => {
  await mocks.select({ method: "get", route: "/pets", code: "500" });
  // …render and assert
});
```

Pass `server: "http://localhost:8080/swaggerizer"` to `createMocks()` to follow a running admin page instead of local state. Choices made in the admin page apply to your browser mocks, choices made in the debug menu are sent back, and every request MSW answers shows up in the admin page's live log.

When the selected response is `generated`, the request goes to orval's faker handler for that operation, so you get realistic random data. Named examples, error codes and custom responses come from Swaggerizer. Proxy mode lets the request through to the real API.

`swaggerizer serve --state-file .swaggerizer/state.json` saves the choices you make in the admin page. `swaggerizer generate --state-file .swaggerizer/state.json` builds them into the generated mocks as their defaults.

## Contract-change warnings

`generate` compares every spec with the `swaggerizer.contract.json` saved last time and prints a report first:

```
Petstore (1.0.0 → 1.1.0)
  9 breaking, 4 warning(s), 10 info · 2 new, 1 removed, 3 changed operation(s)
  ✖ BREAKING DELETE /pets/{petId} — Operation removed
  ✖ BREAKING GET /pets — Required parameter added [query parameter 'ownerId']
  ✖ BREAKING GET /pets/{petId} — operationId changed from 'showPetById' to 'getPet' — generated function names will change
  ✖ BREAKING POST /pets — Required property 'ownerId' added [request body.ownerId]
  ✖ BREAKING GET /pets — Type changed from integer to string [response 500 body.code]
  ▲ WARNING  GET /pets — Enum value(s) added: "rabbit" [response 200 body[].species]
  ● info     GET /owners — New operation
```

If any change reaches `--fail-on` (default `breaking`), `generate` asks before writing anything. Pass `--yes` to accept the changes. In a non-interactive shell it stops with exit code 1. `swaggerizer diff` prints the same report without writing anything, and `--json` gives machine-readable output.

What is checked, judged from the point of view of code using the generated client:

| Change | Severity |
| --- | --- |
| Operation removed, spec file removed | breaking |
| `operationId` renamed (generated function renamed) | breaking |
| Required parameter or request property added; optional one became required | breaking |
| Response property removed, became optional or became nullable | breaking |
| Type changed; enum value removed from a request; success response or content type removed | breaking |
| Response enum value added (exhaustive `switch` statements); success response added; format changed; operation deprecated; error response removed | warning |
| New operation; optional parameter or property added; error response added | info |

Renaming a path parameter (`/pets/{id}` → `/pets/{petId}`) isn't reported, because the generated call doesn't change.

## CLI

```
swaggerizer serve     --folder <files|dirs…> [--port 8080] [--host] [--endpoint swaggerizer] [--no-ui]
                      [--proxy <url>] [--state-file <file>] [--generated <dir>] [--watch] [--silent]
swaggerizer generate  --folder <files|dirs…> [--output src/api] [--client fetch] [--base-url <url>]
                      [--no-mock] [--state-file <file>] [--fail-on breaking|warning|any|none] [--yes]
                      [--runtime-import swaggerizer/msw] [--verbose]
swaggerizer diff      --folder <files|dirs…> [--output src/api] [--fail-on …] [--json] [--verbose]
```

`serve` is the default command, so `swaggerizer --folder ./specs` works like `ramlizer --folder`. A folder is scanned for `.yaml`, `.yml` and `.json` files that contain an `openapi` or `swagger` key.

## Admin API

All routes live under `/swaggerizer` (change the path with `--endpoint`).

| Method | Path | Body / query | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/state` | – | Specs, operations with every response and example, current choices and contract changes |
| `GET` `POST` | `/api/select` | `method`, `route`, `code?`, `example?`, `mode?`, `delay?`, `custom?` (or flat `status`/`body`/`contentType`). The body can be JSON, an array or a form | Switch one or more operations. Unknown codes or examples return `400` |
| `GET` `POST` | `/api/reset` | `{}` or `{ method, route }` | Restore defaults |
| `POST` | `/api/spec` | `{ id, enabled }` | Turn a spec on or off |
| `POST` | `/api/reload` | – | Re-read specs from disk |
| `GET` | `/api/changes` | – | Contract-change reports |
| `GET` | `/api/log?since=<id>` | – | Requests received after `id` |
| `POST` | `/api/log` | entry or array | Lets MSW report requests it answered |
| `GET` | `/api/openapi/<id>.json` | – | The spec as OpenAPI 3 JSON (Swagger 2 is converted), e.g. as an orval input |
| `POST` | `/swaggerizer` | ramlizer body | ramlizer-compatible switch |

## Programmatic use

```ts
import { createSwaggerizer, generate, checkChanges, formatReport } from "swaggerizer";

const sw = createSwaggerizer({ stateFile: ".swaggerizer/state.json" });
await sw.load("./specs");
await sw.listen(8080);
sw.select({ method: "get", route: "/pets", code: "500" });

// or mount sw.handler in Express / Connect alongside your dev server
app.use(sw.handler);

const { reports } = await checkChanges("./specs", "./src/api");
reports.forEach(r => console.log(formatReport(r)));
```

## Spec support

- OpenAPI 3.0 and 3.1, and Swagger 2.0 (converted with swagger2openapi).
- Internal and external `$ref`s, including recursive schemas.
- `allOf`, `oneOf` and `anyOf`, nullable types (3.0 `nullable` and 3.1 type arrays), enums, `const`, formats, and `default` / `2XX` responses.
- Requests are matched with or without the base path from `servers`, and static routes beat templated ones (`/users/me` before `/users/{id}`).
