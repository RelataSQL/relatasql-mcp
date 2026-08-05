# Changelog

All notable changes to `relatasql-mcp`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are npm publish dates.

## [Unreleased]

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

[Unreleased]: https://github.com/RelataSQL/relatasql-mcp/compare/v1.0.1...HEAD
[1.0.1]: https://www.npmjs.com/package/relatasql-mcp/v/1.0.1
[1.0.0]: https://www.npmjs.com/package/relatasql-mcp/v/1.0.0
