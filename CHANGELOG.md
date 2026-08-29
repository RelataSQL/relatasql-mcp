# Changelog

All notable changes to `relatasql-mcp`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are npm publish dates.

## [Unreleased]

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
