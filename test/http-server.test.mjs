import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  McpHttpBodyError,
  RELATASQL_MCP_SCOPE,
  extractBearerToken,
  isAllowedHost,
  protectedResourceMetadata,
  readBoundedJsonBody,
  resourceMetadataUrl,
  wwwAuthenticateChallenge,
} from "../dist/http.js";

function requestStream(chunks, headers = {}) {
  const stream = new PassThrough();
  stream.headers = headers;
  stream.aborted = false;
  queueMicrotask(() => {
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  return stream;
}

test("remote MCP accepts only a canonical Bearer header", () => {
  assert.equal(extractBearerToken("Bearer relata_live_deadbeef"), "relata_live_deadbeef");
  assert.equal(extractBearerToken("bearer token"), "token");
  assert.equal(extractBearerToken("Basic abc"), null);
  assert.equal(extractBearerToken("Bearer one two"), null);
  assert.equal(extractBearerToken(undefined), null);
});

test("protected resource metadata points clients at RelataSQL OAuth", () => {
  const metadata = protectedResourceMetadata();
  assert.equal(metadata.resource, "https://mcp.relatasql.com");
  assert.deepEqual(metadata.authorization_servers, ["https://api.relatasql.com"]);
  assert.deepEqual(metadata.scopes_supported, [RELATASQL_MCP_SCOPE]);
  assert.equal(
    resourceMetadataUrl(),
    "https://mcp.relatasql.com/.well-known/oauth-protected-resource",
  );
  assert.match(wwwAuthenticateChallenge(), /^Bearer resource_metadata=/);
  assert.match(wwwAuthenticateChallenge(), /scope="relatasql:mcp"/);
});

test("remote MCP rejects unexpected Host values by default", () => {
  assert.equal(isAllowedHost("mcp.relatasql.com"), true);
  assert.equal(isAllowedHost("mcp.relatasql.com:443"), true);
  assert.equal(isAllowedHost("evil.example"), false);
  assert.equal(isAllowedHost(undefined), false);
});

test("remote MCP parses one bounded JSON document", async () => {
  const request = requestStream([
    '{"jsonrpc":"2.0",',
    '"method":"initialize","id":1}',
  ]);

  assert.deepEqual(await readBoundedJsonBody(request, 1024), {
    jsonrpc: "2.0",
    method: "initialize",
    id: 1,
  });
});

test("remote MCP rejects both declared and streamed oversized bodies", async () => {
  await assert.rejects(
    readBoundedJsonBody(
      requestStream([], { "content-length": "2048" }),
      1024,
    ),
    (error) => error instanceof McpHttpBodyError && error.kind === "too_large",
  );
  await assert.rejects(
    readBoundedJsonBody(requestStream([Buffer.alloc(1025)]), 1024),
    (error) => error instanceof McpHttpBodyError && error.kind === "too_large",
  );
});

test("remote MCP rejects malformed or cancelled bodies without dispatch", async () => {
  await assert.rejects(
    readBoundedJsonBody(requestStream(["not-json"]), 1024),
    (error) => error instanceof McpHttpBodyError && error.kind === "invalid_json",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readBoundedJsonBody(requestStream(["{}"]), 1024, controller.signal),
    (error) => error instanceof McpHttpBodyError && error.kind === "aborted",
  );
});
