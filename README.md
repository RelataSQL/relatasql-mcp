# relatasql-mcp

Official **Model Context Protocol (MCP)** server for [RelataSQL](https://relatasql.com). It lets MCP-compatible
LLM clients (Claude Desktop, Claude Code, …) work with the databases in your RelataSQL workspace: list
connections, inspect schemas, run read-only SQL, test statements in a rolled-back sandbox, and request
human-approved writes — all through your RelataSQL **API key** (database passwords never reach the client).

## Requirements

- Node.js ≥ 18
- A RelataSQL **API key** (web app → **Settings → API Keys**, starts with `relata_live_`)
- Your RelataSQL backend base URL

## Configuration

Configured entirely via environment variables:

| Variable | Required | Description |
|---|---|---|
| `RELATASQL_API_KEY` | yes | Your RelataSQL API key (`relata_live_…`) |
| `RELATASQL_API_URL` | no (default `http://localhost:3000`) | Base URL of your RelataSQL backend, e.g. `https://api.your-domain.com` |

## Use with Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "relatasql": {
      "command": "npx",
      "args": ["-y", "relatasql-mcp"],
      "env": {
        "RELATASQL_API_KEY": "relata_live_xxx",
        "RELATASQL_API_URL": "https://api.your-domain.com"
      }
    }
  }
}
```

Then fully quit and reopen Claude Desktop.

## Use with Claude Code

```bash
claude mcp add --transport stdio \
  --env RELATASQL_API_KEY=relata_live_xxx \
  --env RELATASQL_API_URL=https://api.your-domain.com \
  --scope user \
  relatasql -- npx -y relatasql-mcp
```

## Tools

- **list_connections** — database connections reachable with your API key
- **get_schema** / **get_relations** — tables, columns and foreign keys for a connection
- **sample_rows** — first N rows of a table
- **execute_query** — run a read-only SQL query (`BEGIN READ ONLY`)
- **run_transaction_sandbox** — execute SQL in a transaction that is always rolled back (safe test)
- **request_write_operation** → **check_write_approval** → **execute_approved_operation** — governed write
  flow: a human approves the exact statement in the RelataSQL web app before it runs

## Notes

- **Enable access per connection.** Querying a connection requires you to enable MCP access for it in the
  RelataSQL web app (**Settings → MCP**); otherwise calls return `JIT_ACCESS_REQUIRED`. Choose an indefinite
  grant for unattended use.
- **Read-only by default.** `execute_query` runs read-only; mutations go through the approval flow above.
- **PostgreSQL** is supported for execution/schema in this version.

## License

[MIT](LICENSE)
