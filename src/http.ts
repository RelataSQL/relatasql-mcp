#!/usr/bin/env node
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parseDatabaseCapabilities } from "./database-capabilities.js";
import {
  RelataApiClient,
  RelataApiError,
  RelataApiTimeoutError,
} from "./relata-api-client.js";
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
const maxRequestBytes = parseBoundedInteger(
  process.env.RELATASQL_MCP_MAX_REQUEST_BYTES,
  1024 * 1024,
  16 * 1024,
  4 * 1024 * 1024,
);
const apiTimeoutMs = parseBoundedInteger(
  process.env.RELATASQL_API_TIMEOUT_MS,
  75_000,
  5_000,
  120_000,
);

export class McpHttpBodyError extends Error {
  constructor(
    public readonly kind: "too_large" | "invalid_json" | "aborted",
    message: string,
  ) {
    super(message);
    this.name = "McpHttpBodyError";
  }
}

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

  const cancellation = new AbortController();
  const onAborted = () => cancellation.abort();
  const onClosed = () => {
    if (!res.writableEnded) cancellation.abort();
  };
  req.once("aborted", onAborted);
  res.once("close", onClosed);
  const cleanupRequestListeners = () => {
    req.off("aborted", onAborted);
    res.off("close", onClosed);
  };

  let parsedBody: unknown;
  try {
    parsedBody = await readBoundedJsonBody(
      req,
      maxRequestBytes,
      cancellation.signal,
    );
  } catch (error) {
    cleanupRequestListeners();
    if (error instanceof McpHttpBodyError && error.kind === "too_large") {
      res.setHeader("Connection", "close");
      writeJson(res, 413, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "MCP request body is too large" },
        id: null,
      });
      res.once("finish", () => req.destroy());
      return;
    }
    if (error instanceof McpHttpBodyError && error.kind === "aborted") return;
    return writeJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Invalid JSON" },
      id: null,
    });
  }

  const apiClient = new RelataApiClient(apiBaseUrl, token, {
    signal: cancellation.signal,
    timeoutMs: apiTimeoutMs,
  });
  let catalog;
  try {
    catalog = parseDatabaseCapabilities(
      await apiClient.getDatabaseCapabilities(),
    );
  } catch (error) {
    cleanupRequestListeners();
    if (
      error instanceof RelataApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      return writeUnauthorized(res);
    }
    if (cancellation.signal.aborted) return;
    if (error instanceof RelataApiTimeoutError) {
      return writeJson(res, 504, {
        error: "gateway_timeout",
        message: "RelataSQL API did not answer in time.",
      });
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
    await transport.handleRequest(req, res, parsedBody);
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
  } finally {
    cleanupRequestListeners();
  }
}

export function createRelataHttpServer() {
  const server = createServer(async (req, res) => {
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
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

/** Reads exactly one bounded JSON document before the SDK sees the request. */
export function readBoundedJsonBody(
  req: IncomingMessage,
  limitBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const declaredRaw = req.headers["content-length"];
  const declared =
    typeof declaredRaw === "string" && /^\d+$/u.test(declaredRaw)
      ? Number.parseInt(declaredRaw, 10)
      : null;
  if (declared !== null && declared > limitBytes) {
    return Promise.reject(
      new McpHttpBodyError("too_large", "Declared body exceeds the limit"),
    );
  }
  if (signal?.aborted || req.aborted) {
    return Promise.reject(new McpHttpBodyError("aborted", "Request aborted"));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAbort);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () =>
      finish(new McpHttpBodyError("aborted", "Request aborted"));
    const onError = () => onAbort();
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limitBytes) {
        req.pause();
        finish(new McpHttpBodyError("too_large", "Body exceeds the limit"));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      const raw = Buffer.concat(chunks, bytes).toString("utf8");
      if (raw.trim().length === 0) {
        finish(new McpHttpBodyError("invalid_json", "Empty JSON body"));
        return;
      }
      try {
        finish(undefined, JSON.parse(raw) as unknown);
      } catch {
        finish(new McpHttpBodyError("invalid_json", "Malformed JSON body"));
      }
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
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

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
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
