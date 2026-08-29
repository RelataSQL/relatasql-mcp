import assert from "node:assert/strict";
import test from "node:test";
import {
  RELATASQL_MCP_SCOPE,
  extractBearerToken,
  isAllowedHost,
  protectedResourceMetadata,
  resourceMetadataUrl,
  wwwAuthenticateChallenge,
} from "../dist/http.js";

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
