import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTRACT_FILE, checkChanges, findMockAggregate, generate } from "../src/index";

const root = path.join(__dirname, "..");
const specs = path.join(root, "example_specs");
const next = path.join(root, "example_specs_next");

describe("orval generation with contract gating", () => {
  let tmp: string;
  let specDir: string;
  let out: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swaggerizer-gen-"));
    specDir = path.join(tmp, "specs");
    out = path.join(tmp, "api");
    await fs.mkdir(specDir);
    await fs.copyFile(path.join(specs, "petstore.yaml"), path.join(specDir, "petstore.yaml"));
    await fs.copyFile(path.join(specs, "orders.yaml"), path.join(specDir, "orders.yaml"));
  });

  test("first run generates client, models, MSW mocks, wrapper, snapshot and index", async () => {
    const result = await generate({ specs: specDir, output: out, silent: true });
    assert.deepEqual(result.generated.sort(), ["orders", "petstore"]);
    assert.equal(result.blocked, false);
    for (const file of ["petstore.ts", "petstore.msw.ts", "petstore.faker.ts", "swaggerizer.ts", CONTRACT_FILE, "model/index.ts"]) {
      assert.ok(existsSync(path.join(out, "petstore", file)), `${file} exists`);
    }
    const wrapper = await fs.readFile(path.join(out, "petstore", "swaggerizer.ts"), "utf8");
    assert.match(wrapper, /import \{ getPetstoreMock \} from "\.\/petstore\.msw";/);
    assert.match(wrapper, /export function createPetstoreMocks/);
    assert.match(wrapper, /from "swaggerizer\/msw"/);
    const index = await fs.readFile(path.join(out, "index.ts"), "utf8");
    assert.match(index, /export \* as petstore from "\.\/petstore\/petstore";/);
    assert.match(index, /export function createMocks/);
    const client = await fs.readFile(path.join(out, "petstore", "petstore.ts"), "utf8");
    assert.match(client, /export const listPets = async/);
  });

  test("findMockAggregate finds orval's handler list", () => {
    assert.equal(findMockAggregate("export const getPetstoreMock = () => [\n  a(),\n]"), "getPetstoreMock");
    assert.equal(findMockAggregate("export const getListPetsMockHandler = (x) => http.get()"), undefined);
  });

  test("breaking changes block regeneration unless confirmed", async () => {
    await fs.copyFile(path.join(next, "petstore.yaml"), path.join(specDir, "petstore.yaml"));
    const snapshotFile = path.join(out, "petstore", CONTRACT_FILE);
    const before = await fs.readFile(snapshotFile, "utf8");

    const { reports } = await checkChanges(specDir, out);
    const petstore = reports.find(r => r.specId === "petstore")!;
    assert.ok(petstore.counts.breaking > 0);
    assert.deepEqual(petstore.removed, ["DELETE /pets/{petId}"]);

    const blocked = await generate({ specs: specDir, output: out, silent: true });
    assert.equal(blocked.skipped, true);
    assert.equal(blocked.blocked, true);
    assert.equal(await fs.readFile(snapshotFile, "utf8"), before, "nothing written");

    let asked = 0;
    const declined = await generate({ specs: specDir, output: out, silent: true, confirm: async () => (asked++, false) });
    assert.equal(asked, 1);
    assert.equal(declined.skipped, true);

    const checkOnly = await generate({ specs: specDir, output: out, silent: true, check: true, yes: true });
    assert.equal(checkOnly.skipped, true, "check mode never writes");

    const accepted = await generate({ specs: specDir, output: out, silent: true, confirm: async () => true });
    assert.equal(accepted.skipped, false);
    const snapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
    assert.equal(snapshot.version, "1.1.0");
    assert.ok(snapshot.operations["GET /owners"]);
    assert.equal((await checkChanges(specDir, out)).reports.every(r => r.changes.length === 0), true);
  });

  test("removing a spec file is reported as breaking, then acknowledged after generation", async () => {
    await fs.rm(path.join(specDir, "orders.yaml"));
    const { reports } = await checkChanges(specDir, out);
    const orders = reports.find(r => r.specId === "orders")!;
    assert.match(orders.title!, /spec file removed/);
    assert.deepEqual(orders.removed.sort(), ["GET /orders", "GET /orders/{orderId}"]);
    await generate({ specs: specDir, output: out, silent: true, yes: true });
    assert.equal((await checkChanges(specDir, out)).reports.some(r => r.specId === "orders"), false);
    assert.doesNotMatch(await fs.readFile(path.join(out, "index.ts"), "utf8"), /orders/);
  });

  test("scenarios saved by the server are embedded as mock defaults", async () => {
    const stateFile = path.join(tmp, "state.json");
    await fs.writeFile(stateFile, JSON.stringify({ scenarios: { "get:/pets": { code: "500" }, "get:/unrelated": { code: "200" } } }));
    await generate({ specs: specDir, output: out, silent: true, yes: true, stateFile, mock: false });
    const wrapper = await fs.readFile(path.join(out, "petstore", "swaggerizer.ts"), "utf8");
    assert.match(wrapper, /"scenarios": \{\s*"get:\/pets": \{\s*"code": "500"/);
    assert.doesNotMatch(wrapper, /get:\/unrelated/);
    assert.match(wrapper, /export const fallbackHandlers = \(\) => \[\];/, "no orval mocks with --no-mock");
  });
});
