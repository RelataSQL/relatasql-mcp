import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  SCHEMA_DISCOVERY_OPERATION,
  operationExplicitlyListed,
  parseDatabaseCapabilities,
  schemaDiscoveryEngines,
  supportedEnginesForTool,
  withCapabilityDescriptions,
} from "../dist/database-capabilities.js";

const ENGINES = ["postgres", "mysql", "mssql"];
const CAPABILITIES = [
  "console",
  "schema",
  "rows",
  "ddl",
  "dump",
  "backup",
  "restore",
  "transfer",
  "mcp",
  "copilot_tools",
  "audit",
  "sql_table_analysis",
];
const cells = CAPABILITIES.flatMap((capability) =>
  ENGINES.map((engine) => ({
    engine,
    capability,
    status: "blocked",
    rejectionCode: "TEST_BLOCKED",
    reason: "fixture",
    ownerPlan: "MEGA-2026-003-P1",
    exitCriterion: "fixture",
  })),
);
function replace(engine, capability, value) {
  const index = cells.findIndex(
    (cell) => cell.engine === engine && cell.capability === capability,
  );
  cells[index] = { engine, capability, ...value };
}
replace("postgres", "mcp", { status: "available" });
replace("mysql", "mcp", {
  status: "partial",
  operations: [
    "list_connections",
    "get_schema",
    "get_relations",
    "sample_rows",
    "execute_query",
    "run_transaction_sandbox",
    "request_write_operation",
    "execute_approved_operation",
    "create_dump",
    "backups",
  ],
  reason: "partial",
  ownerPlan: "MEGA-2026-003-P7",
  exitCriterion: "real tests",
});
replace("mssql", "mcp", {
  status: "partial",
  operations: [
    "list_connections",
    "get_schema",
    "get_relations",
    "sample_rows",
    "execute_query",
    "run_transaction_sandbox",
    "request_write_operation",
    "execute_approved_operation",
    "backups",
  ],
  reason: "partial",
  ownerPlan: "MEGA-2026-003-P7",
  exitCriterion: "real tests",
});

const CATALOG = {
  version: 2,
  engines: ENGINES,
  capabilities: CAPABILITIES,
  cells,
};

test("only advertises engines that support the specific public tool", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  assert.deepEqual(supportedEnginesForTool(catalog, "get_schema"), ENGINES);
  assert.deepEqual(supportedEnginesForTool(catalog, "execute_query"), [
    "postgres",
    "mysql",
    "mssql",
  ]);
  assert.deepEqual(supportedEnginesForTool(catalog, "list_connections"), [
    "postgres",
    "mysql",
    "mssql",
  ]);
});

test("partial MCP support unlocks only operations explicitly verified", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  for (const tool of [
    "get_relations",
    "sample_rows",
    "run_transaction_sandbox",
    "request_write_operation",
    "execute_approved_operation",
  ]) {
    assert.deepEqual(supportedEnginesForTool(catalog, tool), ENGINES);
  }
});

test("tool descriptions state the live engine support", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  const tools = withCapabilityDescriptions(
    [
      {
        name: "get_schema",
        description: "Schema",
        inputSchema: { type: "object" },
      },
      {
        name: "list_connections",
        description: "Connections",
        inputSchema: { type: "object" },
      },
    ],
    catalog,
  );
  assert.match(
    tools[0].description,
    /Supported engines: postgres, mysql, mssql\./,
  );
  assert.match(
    tools[1].description,
    /Supported engines: postgres, mysql, mssql\./,
  );
});

test("accepts known additive versions and rejects unknown contracts", () => {
  assert.equal(
    parseDatabaseCapabilities({ ...CATALOG, version: 1 }).version,
    1,
  );
  assert.equal(parseDatabaseCapabilities(CATALOG).version, 2);
  assert.throws(
    () => parseDatabaseCapabilities({ ...CATALOG, version: 3 }),
    /version/i,
  );
  assert.throws(
    () =>
      parseDatabaseCapabilities({
        ...CATALOG,
        cells: cells.filter(
          (cell) => !(cell.engine === "mssql" && cell.capability === "mcp"),
        ),
      }),
    /mssql.*mcp/i,
  );
});

test("schema discovery counts only where the mcp cell lists its marker", () => {
  const catalog = parseDatabaseCapabilities(CATALOG);
  // An available cell without operations supports every tool, but it does
  // not list the discovery marker: an older backend is never taken for a
  // newer one.
  assert.equal(
    operationExplicitlyListed(
      catalog,
      "mcp",
      "postgres",
      SCHEMA_DISCOVERY_OPERATION,
    ),
    false,
  );
  assert.deepEqual(schemaDiscoveryEngines(catalog), []);

  const listed = parseDatabaseCapabilities({
    ...CATALOG,
    cells: CATALOG.cells.map((cell) =>
      cell.capability === "mcp" && cell.engine !== "mysql"
        ? {
            ...cell,
            operations: [...(cell.operations ?? []), SCHEMA_DISCOVERY_OPERATION],
          }
        : cell,
    ),
  });
  assert.deepEqual(schemaDiscoveryEngines(listed), ["postgres", "mssql"]);
  const [schemaTool, queryTool] = withCapabilityDescriptions(
    [
      { name: "get_schema", description: "Schema", inputSchema: {} },
      { name: "execute_query", description: "Query", inputSchema: {} },
    ],
    listed,
  );
  assert.match(
    schemaTool.description,
    /Discovery arguments available on: postgres, mssql\./,
  );
  assert.doesNotMatch(queryTool.description, /Discovery/);
  assert.match(
    withCapabilityDescriptions(
      [{ name: "get_relations", description: "FKs", inputSchema: {} }],
      catalog,
    )[0].description,
    /not available on this RelataSQL server; call with only connectionId\./,
  );
});

// --- The REAL catalog (RelataSQL backend `npm run test:parity:consumers`) ---
//
// The backend writes the v1 and v2 catalogs exactly as it serves them to
// RELATA_REAL_CAPABILITIES_DIR and runs this file with that variable. Without
// it these tests are skipped: the normal suite has no backend next to it.

const REAL_DIR = process.env.RELATA_REAL_CAPABILITIES_DIR;
const realCatalogFile = (version) =>
  path.join(REAL_DIR, `capabilities-catalog.v${version}.json`);

test(
  "real catalog: the suite reports the digest of the files it read",
  { skip: REAL_DIR ? false : "RELATA_REAL_CAPABILITIES_DIR is not set" },
  () => {
    const digest = (version) =>
      createHash("sha256")
        .update(readFileSync(realCatalogFile(version)))
        .digest("hex");
    const v1 = digest(1);
    const v2 = digest(2);
    assert.match(v1, /^[0-9a-f]{64}$/);
    assert.match(v2, /^[0-9a-f]{64}$/);
    console.log(`REAL_CATALOG_SHA256 v1=${v1} v2=${v2}`);
  },
);

test(
  "real catalog: v1 never enables discovery, v2 enables it on every engine",
  { skip: REAL_DIR ? false : "RELATA_REAL_CAPABILITIES_DIR is not set" },
  () => {
    const read = (version) =>
      parseDatabaseCapabilities(
        JSON.parse(readFileSync(realCatalogFile(version), "utf8")),
      );
    const v1 = read(1);
    const v2 = read(2);
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.deepEqual(schemaDiscoveryEngines(v1), []);
    assert.deepEqual(schemaDiscoveryEngines(v2), ["postgres", "mysql", "mssql"]);
    // The published tools keep the same engines on both contracts.
    for (const tool of ["get_schema", "get_relations", "sample_rows"]) {
      assert.deepEqual(
        supportedEnginesForTool(v1, tool),
        supportedEnginesForTool(v2, tool),
      );
    }
  },
);
