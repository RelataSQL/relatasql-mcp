# Changelog

All notable changes to `relatasql-mcp`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are npm publish dates.

## [Unreleased]

## [1.3.0] - 2026-09-24

### Added

- `get_schema` and `get_relations` accept optional discovery arguments for databases with many
  schemas: list schemas with their table counts, list or search tables page by page, read one
  table's columns, keys and incoming/outgoing foreign keys, and page through whole foreign keys
  (composite keys stay together). A missing table reports where a table with that name exists.
  Calls with only `connectionId` behave exactly as before.
- Sending only `connectionId` and a listing's `cursor` to `get_schema` continues that listing,
  schemas or tables, and the page says which in `listing`; a `cursor` sent with a `mode` still
  has to come from that mode's listing.
- Discovery arguments are sent only to servers whose capability catalog lists
  `schema_discovery_v1`; older servers get an explicit `SCHEMA_DISCOVERY_UNSUPPORTED` error
  instead of a silently unfiltered answer, and responses for another table, schema or connection
  are discarded.

### Changed

- The npm package is now published under the canonical RelataLabs name `@relatalabs/relatasql-mcp`; the existing CLI command names remain unchanged.
- The MCP Registry entry (`server.json`) now points at `@relatalabs/relatasql-mcp`, the package
  that is actually published, and every release file carries the same version.

### Fixed

- Tool errors now include the RelataSQL error code (for example `MCP_TABLE_NOT_FOUND`) next to
  the HTTP status, so agents can tell a missing table from a permission problem.

### Security

- Remote MCP requests now parse at most 1 MiB of JSON before tool dispatch, reject oversized
  `Content-Length` and chunked bodies, and use short HTTP receive deadlines.
- Closing a remote MCP request now cancels its RelataSQL API calls; every backend trip also has a
  75-second ceiling, above the governed 60-second SQL limit, so abandoned work cannot run forever.

## [1.2.0] - 2026-08-29

### Added

- A production Streamable HTTP entry point for remote MCP clients at `/mcp`, while retaining the
  existing stdio transport for local IDE/CLI integrations.
- OAuth Protected Resource Metadata and `WWW-Authenticate` discovery for user-scoped OAuth clients.
- A `/health` endpoint, Docker image, host-header allowlist and CI coverage for the remote service.

### Changed

- MCP tool registration now lives in a shared server factory so stdio and remote transports expose
  the same governed tool contract.
- Remote requests use the caller's OAuth bearer token for the RelataSQL backend. The public MCP
  container no longer needs or accepts a shared user's API key as its identity model.

## [1.1.0] - 2026-08-25

### Changed

- PostgreSQL, MySQL and SQL Server now receive engine-specific tool descriptions from the live
  capability catalog, including MySQL single-table, trigger-free InnoDB sandbox restrictions and
  per-connection operations.
- The capability parser accepts both known additive catalog contracts (v1 and v2), so a backend
  catalog upgrade no longer breaks `tools/list` before any database tool can run.
- Capability requests explicitly negotiate catalog v2; servers may safely keep returning the v1
  projection to already-published 1.0.1 clients that send no version header.
- Tool descriptions now state the database engines currently supported by that exact operation,
  using the live capability catalog returned by RelataSQL. Partial MySQL MCP support no longer
  implies that schema, query, sandbox, or approval tools work with MySQL.

### Fixed

- The `run_transaction_sandbox` tool description advertised a 10 s per-statement limit; the
  backend applies 60 s. Agents were working around a restriction that did not exist and
  discarding statements they could have run.

## [1.0.1] — 2026-07-03

### Changed

- The credential now defaults to the official cloud API (`https://api.relatasql.com`).
  Self-hosting became the case you override explicitly instead of the default, which
  previously pointed at a local URL that was useless to anyone installing from npm.

## [1.0.0] — 2026-06-22

### Added

- First public release, on npm and in the MCP Registry. Tools: `list_connections`,
  `get_schema`, `get_relations`, `sample_rows`, `execute_query` (read-only, run inside a
  read-only transaction server-side), `run_transaction_sandbox` (always rolled back), the
  human-approval write flow (`request_write_operation`, `check_write_approval`,
  `execute_approved_operation`) and `submit_agent_feedback`.
- Authentication through your RelataSQL API key. Database passwords never reach the client.

[Unreleased]: https://github.com/RelataSQL/relatasql-mcp/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/RelataSQL/relatasql-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/RelataSQL/relatasql-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://www.npmjs.com/package/relatasql-mcp/v/1.0.1
[1.0.0]: https://www.npmjs.com/package/relatasql-mcp/v/1.0.0
