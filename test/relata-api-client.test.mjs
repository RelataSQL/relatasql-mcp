import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_CAPABILITIES_VERSION,
  MCP_CAPABILITIES_VERSION_HEADER,
  RelataApiClient,
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
