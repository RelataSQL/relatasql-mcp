import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_CAPABILITIES_VERSION,
  MCP_CAPABILITIES_VERSION_HEADER,
  RelataApiClient,
  RelataApiError,
  RelataApiTimeoutError,
  RelataEchoMismatchError,
  SchemaDiscoveryUnsupportedError,
} from "../dist/relata-api-client.js";

test("capability requests explicitly negotiate catalog v2", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let observed;
  globalThis.fetch = async (url, options) => {
    observed = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          version: 2,
          engines: [],
          capabilities: [],
          cells: [],
        }),
    };
  };

  const client = new RelataApiClient("https://api.example.test/", "api-key");
  await client.getDatabaseCapabilities();

  assert.equal(observed.url, "https://api.example.test/mcp/capabilities");
  assert.equal(
    observed.options.headers[MCP_CAPABILITIES_VERSION_HEADER],
    MCP_CAPABILITIES_VERSION,
  );
  assert.equal(observed.options.headers.Authorization, "Bearer api-key");
});

test("backend requests stop when their remote MCP request closes", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });

  const controller = new AbortController();
  const client = new RelataApiClient("https://api.example.test", "token", {
    signal: controller.signal,
  });
  const pending = client.getDatabaseCapabilities();
  controller.abort(new DOMException("client closed", "AbortError"));

  await assert.rejects(pending, (error) => error?.name === "AbortError");
});

test("backend requests have a per-trip timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });

  const client = new RelataApiClient("https://api.example.test", "token", {
    timeoutMs: 5,
  });
  await assert.rejects(
    client.getDatabaseCapabilities(),
    (error) => error instanceof RelataApiTimeoutError && error.timeoutMs === 5,
  );
});

function discoveryResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  };
}

test("discovery calls send only the arguments given and check the echo", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return discoveryResponse(
      200,
      {
        connectionId: "c1",
        table: { schema: "academic", name: "students" },
        relations: { outgoing: [], incoming: [] },
      },
      { "X-RelataSQL-Schema-Discovery": "v1" },
    );
  };
  const client = new RelataApiClient("https://api.example.test", "api-key");

  await client.describeTable("c1", { table: "students" });
  assert.equal(
    urls.at(-1),
    "https://api.example.test/mcp/connections/c1/schema/tables/detail?table=students",
  );
  // The backend answered for academic.students; asking for attendance's is
  // a mismatch, never a silent substitute.
  await assert.rejects(
    client.describeTable("c1", { schema: "attendance", table: "students" }),
    (error) => error instanceof RelataEchoMismatchError,
  );
});

test("a 404 tells a missing table from a missing route", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const client = new RelataApiClient("https://api.example.test", "api-key");

  globalThis.fetch = async () =>
    discoveryResponse(
      404,
      { code: "MCP_TABLE_NOT_FOUND", message: "missing", candidates: [] },
      { "X-RelataSQL-Schema-Discovery": "v1" },
    );
  await assert.rejects(
    client.describeTable("c1", { table: "students" }),
    (error) =>
      error instanceof RelataApiError &&
      error.status === 404 &&
      error.body.code === "MCP_TABLE_NOT_FOUND",
  );

  globalThis.fetch = async () =>
    discoveryResponse(404, { message: "Cannot GET /mcp/connections/c1/schemas" });
  await assert.rejects(
    client.listSchemas("c1", {}),
    (error) => error instanceof SchemaDiscoveryUnsupportedError,
  );
});

test("a continued listing must say which listing it is and keep the schema sent", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let body;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return discoveryResponse(200, body, { "X-RelataSQL-Schema-Discovery": "v1" });
  };
  const client = new RelataApiClient("https://api.example.test", "api-key");
  const tables = {
    listing: "tables",
    connectionId: "c1",
    filter: { schema: "academic", query: "" },
    tables: [],
    page: { limit: 1, totalMatches: 0, hasMore: false, nextCursor: null },
  };

  body = tables;
  await client.continueSchemaListing("c1", { cursor: "k", schema: "academic" });
  assert.equal(
    urls.at(-1),
    "https://api.example.test/mcp/connections/c1/schema/page?cursor=k&schema=academic",
  );

  // An answer that does not say what it continued is not guessed at.
  body = { ...tables, listing: undefined };
  await assert.rejects(
    client.continueSchemaListing("c1", { cursor: "k" }),
    (error) => error instanceof RelataEchoMismatchError,
  );
  // Nor is one for another schema than the one sent.
  body = { ...tables, filter: { schema: "iam", query: "" } };
  await assert.rejects(
    client.continueSchemaListing("c1", { cursor: "k", schema: "academic" }),
    (error) => error instanceof RelataEchoMismatchError,
  );
});
