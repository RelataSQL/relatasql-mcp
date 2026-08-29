#!/usr/bin/env node
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parseDatabaseCapabilities } from "./database-capabilities.js";
import { RelataApiClient, RelataApiError } from "./relata-api-client.js";
import {
  createRelataMcpServer,
  RELATASQL_MCP_VERSION,
} from "./server.js";

export const RELATASQL_MCP_SCOPE = "relatasql:mcp";

const apiBaseUrl = stripTrailingSlash(
  process.env.RELATASQL_API_URL?.trim() || "https://api.relatasql.com",
);
const publicBaseUrl = stripTrailingSlash(
  process.env.RELATASQL_MCP_PUBLIC_BASE_URL?.trim() ||
    "https://mcp.relatasql.com",
);
const listenHost = process.env.RELATASQL_MCP_HOST?.trim() || "0.0.0.0";
const listenPort = parsePort(process.env.RELATASQL_MCP_PORT, 3003);

export function extractBearerToken(
  authorization: string | string[] | undefined,
): string | null {
  if (Array.isArray(authorization)) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization?.trim() ?? "");
  return match?.[1] ?? null;
}

export function protectedResourceMetadata() {
  return {
    resource: publicBaseUrl,
    authorization_servers: [apiBaseUrl],
    scopes_supported: [RELATASQL_MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://relatasql.com",
  };
}

export function resourceMetadataUrl(): string {
  return `${publicBaseUrl}/.well-known/oauth-protected-resource`;
}

export function wwwAuthenticateChallenge(): string {
  return `Bearer resource_metadata="${resourceMetadataUrl()}", scope="${RELATASQL_MCP_SCOPE}"`;
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const configured = process.env.RELATASQL_MCP_ALLOWED_HOSTS?.trim();
  const allowed = new Set(
    (configured ? configured.split(",") : [new URL(publicBaseUrl).hostname])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  return allowed.has(host);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  if (!isAllowedHost(req.headers.host)) {
    return writeJson(res, 421, {
      error: "misdirected_request",
      message: "Host header is not allowed for this MCP endpoint.",
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return writeJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  }

  const token = extractBearerToken(req.headers.authorization);
  if (!token) return writeUnauthorized(res);

  const apiClient = new RelataApiClient(apiBaseUrl, token);
  let catalog;
  try {
    catalog = parseDatabaseCapabilities(
      await apiClient.getDatabaseCapabilities(),
    );
  } catch (error) {
    if (
      error instanceof RelataApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      return writeUnauthorized(res);
    }
    console.error(
      "[relatasql-mcp-http] backend authentication/capability probe failed:",
      safeError(error),
    );
    return writeJson(res, 502, {
      error: "bad_gateway",
      message: "RelataSQL API is unavailable.",
    });
  }

  const mcpServer = createRelataMcpServer(apiClient, catalog);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    void transport.close().catch(() => undefined);
    void mcpServer.close().catch(() => undefined);
  };
  res.once("finish", cleanup);
  res.once("close", cleanup);

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("[relatasql-mcp-http] MCP request failed:", safeError(error));
    cleanup();
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP server error" },
        id: null,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

export function createRelataHttpServer() {
  return createServer(async (req, res) => {
    const pathname = safePathname(req.url);

    if (req.method === "GET" && pathname === "/health") {
      return writeJson(res, 200, {
        ok: true,
        service: "relatasql-mcp",
        version: RELATASQL_MCP_VERSION,
        endpoint: `${publicBaseUrl}/mcp`,
        oauth: true,
      });
    }

    if (
      req.method === "GET" &&
      (pathname === "/.well-known/oauth-protected-resource" ||
        pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return writeJson(res, 200, protectedResourceMetadata());
    }

    if (pathname === "/mcp") return handleMcp(req, res);

    if (req.method === "GET" && pathname === "/") {
      return writeJson(res, 200, {
        service: "relatasql-mcp",
        version: RELATASQL_MCP_VERSION,
        mcp: `${publicBaseUrl}/mcp`,
        health: `${publicBaseUrl}/health`,
      });
    }

    return writeJson(res, 404, { error: "not_found" });
  });
}

async function main(): Promise<void> {
  const server = createRelataHttpServer();
  server.listen(listenPort, listenHost, () => {
    console.error(
      `[relatasql-mcp-http] ready on http://${listenHost}:${listenPort}; public endpoint ${publicBaseUrl}/mcp`,
    );
  });
}

function writeUnauthorized(res: ServerResponse) {
  res.setHeader("WWW-Authenticate", wwwAuthenticateChallenge());
  res.setHeader("Cache-Control", "no-store");
  return writeJson(res, 401, {
    error: "unauthorized",
    message: "A valid RelataSQL OAuth bearer token is required.",
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("[relatasql-mcp-http] FATAL:", safeError(error));
    process.exit(1);
  });
}
