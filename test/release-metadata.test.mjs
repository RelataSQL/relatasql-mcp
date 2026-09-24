import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RELATASQL_MCP_VERSION } from "../dist/server.js";

const json = (file) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

test("(guard, passes before too) every published version string is the same release", () => {
  const pkg = json("package.json");
  const lock = json("package-lock.json");
  const server = json("server.json");

  const versions = {
    "package.json": pkg.version,
    "package-lock.json": lock.version,
    "package-lock.json packages['']": lock.packages[""].version,
    "server.json": server.version,
    "server.json packages[0]": server.packages[0].version,
    RELATASQL_MCP_VERSION,
  };
  for (const [where, version] of Object.entries(versions)) {
    assert.equal(version, pkg.version, `${where} is ${version}`);
  }
});

test("the MCP Registry entry points at the npm package that is published", () => {
  const pkg = json("package.json");
  const server = json("server.json");

  assert.equal(server.packages[0].registryType, "npm");
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.name, pkg.mcpName);
});
