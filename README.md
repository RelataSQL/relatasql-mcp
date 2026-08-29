# relatasql-mcp

Official **Model Context Protocol (MCP)** server for [RelataSQL](https://relatasql.com). It lets MCP-compatible clients work with databases in a RelataSQL workspace while RelataSQL keeps database credentials, JIT access, SQL classification, sandboxing, approvals and audit authority.

The package supports two transports:

- **stdio** for local IDE/CLI clients. The process receives a RelataSQL API key.
- **Streamable HTTP** for remote clients such as ChatGPT and other MCP hosts. Each request carries a user-scoped OAuth bearer token; the public server does **not** use a global RelataSQL API key.

Database passwords never reach the MCP client.

## Local stdio mode

### Requirements

- Node.js >= 18
- A RelataSQL API key from **Settings -> API Keys** (`relata_live_...`)

### Environment

| Variable | Required | Description |
| --- | --- | --- |
| `RELATASQL_API_KEY` | yes | RelataSQL API key used by this local process. |
| `RELATASQL_API_URL` | no | Backend base URL; defaults to `https://api.relatasql.com`. |

### Claude Desktop

```json
{
  "mcpServers": {
    "relatasql": {
      "command": "npx",
      "args": ["-y", "relatasql-mcp"],
      "env": {
        "RELATASQL_API_KEY": "relata_live_xxx"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio \
  --env RELATASQL_API_KEY=relata_live_xxx \
  --scope user \
  relatasql -- npx -y relatasql-mcp
```

## Remote Streamable HTTP mode

The production endpoint is intended to be:

```text
https://mcp.relatasql.com/mcp
```

Remote mode is OAuth-only. A missing or invalid bearer token returns `401` with a `WWW-Authenticate` challenge pointing at the OAuth Protected Resource Metadata document. The authorization server is `https://api.relatasql.com`.

### Environment

```env
RELATASQL_API_URL=https://api.relatasql.com
RELATASQL_MCP_HOST=0.0.0.0
RELATASQL_MCP_PORT=3003
RELATASQL_MCP_PUBLIC_BASE_URL=https://mcp.relatasql.com
RELATASQL_MCP_ALLOWED_HOSTS=mcp.relatasql.com
```

Do **not** set `RELATASQL_API_KEY` on the public service. OAuth bearer credentials are supplied by each MCP client and forwarded only to the RelataSQL backend for that request.

### Endpoints

- `POST /mcp` — OAuth-protected Streamable HTTP MCP endpoint
- `GET /health` — deployment health/version probe
- `GET /.well-known/oauth-protected-resource` — OAuth protected-resource metadata

### Docker

```bash
docker build -t relatasql-mcp .
docker run --rm -p 3003:3003 \
  -e RELATASQL_MCP_PUBLIC_BASE_URL=https://mcp.relatasql.com \
  -e RELATASQL_MCP_ALLOWED_HOSTS=mcp.relatasql.com \
  relatasql-mcp
```

## Tools

- **list_connections** — connections visible to the authenticated user and their MCP/JIT access state
- **get_schema** / **get_relations** — tables, columns and foreign keys
- **sample_rows** — a backend-capped sample from a table
- **execute_query** — SQL proven read-only by RelataSQL
- **run_transaction_sandbox** — rollback-only simulation where the selected engine can prove safety
- **request_write_operation** -> **check_write_approval** -> **execute_approved_operation** — governed write flow in which the exact statement is approved by a human before one-shot execution
- **submit_agent_feedback** — sanitized end-of-task product feedback

## Security model

- **Per-user identity.** Remote callers receive OAuth credentials scoped to the user who linked RelataSQL.
- **Per-connection access.** A valid OAuth token does not automatically unlock a database; MCP/JIT access still has to be active for that connection.
- **Read-only by default.** `execute_query` cannot become a write path just because the model asks it to.
- **Governed writes.** Mutations continue through the existing RelataSQL approval flow; the remote MCP server does not duplicate or bypass it.
- **Multi-engine fail-closed behavior.** PostgreSQL, MySQL and SQL Server support is derived from the live capability catalog. Unsupported operations are rejected before a database socket is opened.
- **No shared production credential.** The remote container must not contain one user's API key.

## Self-hosted backend

Both transports can point at another RelataSQL backend with `RELATASQL_API_URL`. A remote deployment must also configure its public MCP URL and allowed Host values to match the external endpoint.

## License

[MIT](LICENSE)
