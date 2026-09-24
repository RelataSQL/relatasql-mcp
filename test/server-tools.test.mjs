import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RelataApiClient } from "../dist/relata-api-client.js";
import { createRelataMcpServer } from "../dist/server.js";

const ENGINES = ["postgres", "mysql", "mssql"];

/** A v2 catalog whose three mcp cells carry `operations` (or none). */
function catalog(mcpOperations) {
  return {
    version: 2,
    engines: ENGINES,
    capabilities: ["mcp"],
    cells: ENGINES.map((engine) => ({
      engine,
      capability: "mcp",
      status: "available",
      ...(mcpOperations && { operations: mcpOperations }),
    })),
  };
}

const DISCOVERY = catalog(["schema_discovery_v1"]);
const LEGACY = catalog(undefined);

function jsonResponse(status, body, headers = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      forEach: (visit) =>
        Object.entries(lower).forEach(([key, value]) => visit(value, key)),
    },
    text: async () => JSON.stringify(body),
  };
}

/**
 * An MCP client connected in memory to the real server factory, with fetch
 * replaced by `route(url)`. Every URL the server asked for is recorded.
 */
async function connect(t, route) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(`${parsed.pathname}${parsed.search}`);
    return route(parsed);
  };
  const server = createRelataMcpServer(
    new RelataApiClient("https://api.example.test", "api-key"),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await client.close();
  });
  return { client, calls };
}

const text = (result) => JSON.parse(result.content[0].text);

test("get_schema routes by arguments", async (t) => {
  const { client, calls } = await connect(t, (url) => {
    if (url.pathname === "/mcp/capabilities") {
      return jsonResponse(200, DISCOVERY);
    }
    if (url.pathname === "/mcp/connections/c1/schema") {
      return jsonResponse(200, { connectionId: "c1", tables: [] });
    }
    if (url.pathname === "/mcp/connections/c1/schema/tables") {
      return jsonResponse(
        200,
        {
          connectionId: "c1",
          engine: "postgres",
          serverVersion: "17.5",
          filter: { schema: "academic", query: "stu" },
          tables: [],
          page: { limit: 50, totalMatches: 0, hasMore: false, nextCursor: null },
        },
        { "X-RelataSQL-Schema-Discovery": "v1" },
      );
    }
    return jsonResponse(404, { message: "unexpected" });
  });

  const legacy = await client.callTool({
    name: "get_schema",
    arguments: { connectionId: "c1" },
  });
  assert.equal(legacy.isError, undefined);
  // connectionId alone: the legacy route, and not even the catalog is read.
  assert.deepEqual(calls, ["/mcp/connections/c1/schema"]);

  const discovery = await client.callTool({
    name: "get_schema",
    arguments: { connectionId: "c1", schema: "academic", query: "stu" },
  });
  assert.equal(discovery.isError, undefined);
  assert.equal(
    calls.at(-1),
    "/mcp/connections/c1/schema/tables?schema=academic&query=stu",
  );
  assert.equal(text(discovery).filter.schema, "academic");
});

test("discovery args without schema_discovery_v1 fail explicitly", async (t) => {
  const { client, calls } = await connect(t, (url) =>
    url.pathname === "/mcp/capabilities"
      ? jsonResponse(200, LEGACY)
      : jsonResponse(200, { connectionId: "c1", tables: [] }),
  );

  const result = await client.callTool({
    name: "get_schema",
    arguments: { connectionId: "c1", schema: "academic" },
  });

  assert.equal(result.isError, true);
  assert.match(text(result).error, /SCHEMA_DISCOVERY_UNSUPPORTED/);
  assert.equal(text(result).code, "SCHEMA_DISCOVERY_UNSUPPORTED");
  // The legacy route would have answered with the whole database instead.
  assert.ok(calls.every((call) => !call.startsWith("/mcp/connections/")));
});

test("a route-missing 404 maps to the explicit error and refetches capabilities", async (t) => {
  let capabilityReads = 0;
  const { client } = await connect(t, (url) => {
    if (url.pathname === "/mcp/capabilities") {
      capabilityReads += 1;
      return jsonResponse(200, DISCOVERY);
    }
    // A backend without the route: Nest's generic 404, no discovery header.
    return jsonResponse(404, {
      statusCode: 404,
      message: `Cannot GET ${url.pathname}`,
    });
  });

  const first = await client.callTool({
    name: "get_relations",
    arguments: { connectionId: "c1", table: "students" },
  });
  assert.equal(first.isError, true);
  assert.match(text(first).error, /SCHEMA_DISCOVERY_UNSUPPORTED/);

  await client.callTool({
    name: "get_relations",
    arguments: { connectionId: "c1", table: "students" },
  });
  // The cached catalog was dropped after the first 404.
  assert.equal(capabilityReads, 2);
});

test("a missing table keeps the backend code and where that name exists", async (t) => {
  const { client } = await connect(t, (url) =>
    url.pathname === "/mcp/capabilities"
      ? jsonResponse(200, DISCOVERY)
      : jsonResponse(
          404,
          {
            statusCode: 404,
            code: "MCP_TABLE_NOT_FOUND",
            message: 'Table "public"."students" does not exist in this database.',
            candidates: [{ schema: "academic", name: "students" }],
          },
          { "X-RelataSQL-Schema-Discovery": "v1" },
        ),
  );

  const result = await client.callTool({
    name: "get_schema",
    arguments: { connectionId: "c1", table: "students" },
  });

  assert.equal(result.isError, true);
  assert.match(text(result).error, /\(404, MCP_TABLE_NOT_FOUND\)/);
  assert.deepEqual(text(result).candidates, [
    { schema: "academic", name: "students" },
  ]);
});

test("contradictory get_schema arguments are rejected before any backend call", async (t) => {
  const { client, calls } = await connect(t, () =>
    jsonResponse(200, DISCOVERY),
  );

  const result = await client.callTool({
    name: "get_schema",
    arguments: { connectionId: "c1", mode: "schemas", table: "students" },
  });

  assert.equal(result.isError, true);
  assert.match(text(result).error, /Invalid arguments/);
  assert.deepEqual(calls, []);
});

test("tools/list advertises the discovery arguments with their bounds", async (t) => {
  const { client } = await connect(t, () => jsonResponse(200, DISCOVERY));

  const { tools } = await client.listTools();
  const getSchema = tools.find((tool) => tool.name === "get_schema");
  const getRelations = tools.find((tool) => tool.name === "get_relations");

  assert.deepEqual(Object.keys(getSchema.inputSchema.properties).sort(), [
    "connectionId",
    "cursor",
    "limit",
    "mode",
    "query",
    "schema",
    "table",
  ]);
  assert.deepEqual(getSchema.inputSchema.required, ["connectionId"]);
  assert.equal(getSchema.inputSchema.properties.schema.maxLength, 128);
  assert.equal(getSchema.inputSchema.properties.limit.maximum, 200);
  assert.deepEqual(Object.keys(getRelations.inputSchema.properties).sort(), [
    "connectionId",
    "cursor",
    "direction",
    "limit",
    "schema",
    "table",
  ]);
  assert.match(
    getSchema.description,
    /Discovery arguments available on: postgres, mysql, mssql\./,
  );
});
