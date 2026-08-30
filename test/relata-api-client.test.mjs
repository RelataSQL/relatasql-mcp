import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_CAPABILITIES_VERSION,
  MCP_CAPABILITIES_VERSION_HEADER,
  RelataApiClient,
  RelataApiTimeoutError,
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
