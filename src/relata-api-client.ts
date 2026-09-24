/**
 * Thin HTTP wrapper around the RelataSQL backend. Uses Node 18+
 * global fetch on purpose — no axios — so the supply chain stays
 * minimal and every request is subject to the same origin, TLS,
 * and header handling the Node runtime already audits.
 *
 * Every call ships the user's API key as a Bearer token. The
 * backend is responsible for resolving that key to the owning
 * user and scoping connection/workspace access accordingly; this
 * client is deliberately dumb about auth beyond that.
 */
export interface RelataConnection {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  databaseName: string;
  workspaceId: string;
  workspaceName?: string;
  mcpAccessStatus: "ACTIVE" | "INACTIVE" | "EXPIRED" | "INDEFINITE";
  mcpGrantedUntil: string | null;
  mcpOperations?: string[];
}

export interface RelataDatabaseCapabilities {
  version: number;
  engines: string[];
  capabilities: string[];
  cells: Array<{
    engine: string;
    capability: string;
    status: string;
    operations?: string[];
    limitations?: string[];
    rejectionCode?: string;
    reason?: string;
    ownerPlan?: string;
    exitCriterion?: string;
  }>;
}

export const MCP_CAPABILITIES_VERSION_HEADER =
  "X-RelataSQL-Capabilities-Version";
export const MCP_CAPABILITIES_VERSION = "2";

export interface RelataColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey?: boolean;
}

export interface RelataTable {
  schema: string;
  name: string;
  columns: RelataColumn[];
}

export interface RelataSchema {
  connectionId: string;
  tables: RelataTable[];
}

export interface RelataQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated?: boolean;
}

export interface RelataSandboxResult {
  ok: boolean;
  sandbox: true;
  rolledBack: true;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  error?: {
    message: string;
    sqlState?: string;
    detail?: string;
    hint?: string;
    constraint?: string;
    table?: string;
    schema?: string;
    column?: string;
    routine?: string;
  };
}

export interface RelataRelation {
  constraintName: string;
  schema: string;
  table: string;
  column: string;
  foreignSchema: string;
  foreignTable: string;
  foreignColumn: string;
}

export interface RelataRelationsResult {
  connectionId: string;
  relations: RelataRelation[];
}

export interface RelataApproval {
  id: string;
  connectionId: string;
  connectionName: string;
  databaseName: string;
  databaseHost: string;
  databasePort: number;
  sql: string;
  justification: string;
  operationSummary: string | null;
  approvalStatus: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  usageStatus: "UNUSED" | "USED";
  requestedAt: string;
  decidedAt: string | null;
  usedAt: string | null;
  expiresAt: string;
  executionError: string | null;
}

/** Schema discovery (paged schemas, tables, table detail and foreign keys). */
export interface RelataDiscoveryPage {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface RelataSchemaSummary {
  name: string;
  tableCount: number;
  viewCount: number;
}

export interface RelataSchemasResult {
  connectionId: string;
  engine: string;
  serverVersion: string | null;
  defaultSchema: string;
  filter: { query: string };
  schemas: RelataSchemaSummary[];
  page: RelataDiscoveryPage;
}

export interface RelataTableSummary {
  schema: string;
  name: string;
  kind: "table" | "view";
  columnCount: number;
}

export interface RelataTablesResult {
  connectionId: string;
  engine: string;
  serverVersion: string | null;
  filter: { schema: string | null; query: string; schemaFound?: boolean };
  tables: RelataTableSummary[];
  page: RelataDiscoveryPage & { totalMatches: number };
}

/** One whole foreign key; composite keys keep their columns in order. */
export interface RelataForeignKey {
  key: [fromSchema: string, fromTable: string, constraintName: string];
  constraintName: string;
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
}

export interface RelataTableDetailResult {
  connectionId: string;
  engine: string;
  serverVersion: string | null;
  table: {
    schema: string;
    name: string;
    kind: "table" | "view";
    columns: Array<RelataColumn & { defaultValue: string | null }>;
    primaryKey: string[];
    uniqueConstraints: Array<{ name: string; columns: string[] }>;
  };
  relations: {
    outgoing: RelataForeignKey[];
    incoming: RelataForeignKey[];
    outgoingHasMore: boolean;
    incomingHasMore: boolean;
  };
}

export type RelataRelationDirection = "outgoing" | "incoming" | "both";

export interface RelataRelationsPageResult {
  connectionId: string;
  engine: string;
  filter: {
    schema: string | null;
    table: string | null;
    direction: RelataRelationDirection;
  };
  relations: RelataForeignKey[];
  page: RelataDiscoveryPage;
}

/**
 * Header the backend sets on every response of its schema discovery routes,
 * errors included. A 404 without it means the route itself is missing (an
 * older or rolled-back backend), not that a table does not exist.
 */
export const SCHEMA_DISCOVERY_HEADER = "x-relatasql-schema-discovery";

export class RelataApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    /** Response headers, lower-cased. */
    public readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "RelataApiError";
  }
}

/** The backend does not serve the schema discovery routes. */
export class SchemaDiscoveryUnsupportedError extends Error {
  constructor() {
    super(
      "SCHEMA_DISCOVERY_UNSUPPORTED: this RelataSQL server does not support get_schema discovery arguments yet. Call get_schema with only connectionId.",
    );
    this.name = "SchemaDiscoveryUnsupportedError";
  }
}

/** The backend answered for another table, schema or connection. */
export class RelataEchoMismatchError extends Error {
  constructor(what: string) {
    super(
      `RelataSQL answered for a different ${what} than the one requested; the answer was discarded.`,
    );
    this.name = "RelataEchoMismatchError";
  }
}

export class RelataApiTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`RelataSQL API request exceeded ${timeoutMs} ms`);
    this.name = "RelataApiTimeoutError";
  }
}

export interface RelataApiClientOptions {
  /** Cancels every backend trip that belongs to the current MCP request. */
  signal?: AbortSignal;
  /** Per-trip ceiling. It must remain above the backend's 60 s SQL limit. */
  timeoutMs?: number;
}

export class RelataApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    apiKey: string,
    options: RelataApiClientOptions = {},
  ) {
    // Strip a trailing slash so path concatenation stays predictable
    // regardless of how the env var was written.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs ?? 75_000;
  }

  async listConnections(): Promise<RelataConnection[]> {
    return this.request<RelataConnection[]>("GET", "/mcp/connections");
  }

  async getDatabaseCapabilities(): Promise<RelataDatabaseCapabilities> {
    return this.request<RelataDatabaseCapabilities>(
      "GET",
      "/mcp/capabilities",
      undefined,
      { [MCP_CAPABILITIES_VERSION_HEADER]: MCP_CAPABILITIES_VERSION },
    );
  }

  async getSchema(connectionId: string): Promise<RelataSchema> {
    const path = `/mcp/connections/${encodeURIComponent(connectionId)}/schema`;
    return this.request<RelataSchema>("GET", path);
  }

  async executeQuery(
    connectionId: string,
    sql: string,
  ): Promise<RelataQueryResult> {
    const path = `/mcp/connections/${encodeURIComponent(connectionId)}/query`;
    return this.request<RelataQueryResult>("POST", path, { sql });
  }

  async runTransactionSandbox(
    connectionId: string,
    payload: { sql: string; justification: string },
  ): Promise<RelataSandboxResult> {
    const path = `/mcp/connections/${encodeURIComponent(connectionId)}/sandbox`;
    return this.request<RelataSandboxResult>("POST", path, payload);
  }

  async getRelations(connectionId: string): Promise<RelataRelationsResult> {
    const path = `/mcp/connections/${encodeURIComponent(connectionId)}/relations`;
    return this.request<RelataRelationsResult>("GET", path);
  }

  async sampleRows(
    connectionId: string,
    payload: { schema?: string; table: string; limit?: number },
  ): Promise<RelataQueryResult> {
    const path = `/mcp/connections/${encodeURIComponent(connectionId)}/sample-rows`;
    return this.request<RelataQueryResult>("POST", path, payload);
  }

  async requestWriteApproval(
    connectionId: string,
    payload: {
      sql: string;
      justification: string;
      operationSummary?: string;
    },
  ): Promise<RelataApproval> {
    const path = `/mcp/connections/${encodeURIComponent(connectionId)}/write-approvals`;
    return this.request<RelataApproval>("POST", path, payload);
  }

  async checkWriteApproval(approvalId: string): Promise<RelataApproval> {
    const path = `/mcp/write-approvals/${encodeURIComponent(approvalId)}`;
    return this.request<RelataApproval>("GET", path);
  }

  async executeApprovedOperation(
    approvalId: string,
  ): Promise<RelataQueryResult> {
    const path = `/mcp/write-approvals/${encodeURIComponent(approvalId)}/execute`;
    return this.request<RelataQueryResult>("POST", path);
  }

  async listSchemas(
    connectionId: string,
    params: { query?: string; limit?: number; cursor?: string },
  ): Promise<RelataSchemasResult> {
    const result = await this.discovery<RelataSchemasResult>(
      connectionId,
      "schemas",
      params,
    );
    this.assertConnection(result, connectionId);
    return result;
  }

  async listTables(
    connectionId: string,
    params: { schema?: string; query?: string; limit?: number; cursor?: string },
  ): Promise<RelataTablesResult> {
    const result = await this.discovery<RelataTablesResult>(
      connectionId,
      "schema/tables",
      params,
    );
    this.assertConnection(result, connectionId);
    if (params.schema !== undefined && result.filter?.schema !== params.schema) {
      throw new RelataEchoMismatchError("schema");
    }
    return result;
  }

  async describeTable(
    connectionId: string,
    params: { schema?: string; table: string },
  ): Promise<RelataTableDetailResult> {
    const result = await this.discovery<RelataTableDetailResult>(
      connectionId,
      "schema/tables/detail",
      params,
    );
    this.assertConnection(result, connectionId);
    if (
      result.table?.name !== params.table ||
      (params.schema !== undefined && result.table?.schema !== params.schema)
    ) {
      throw new RelataEchoMismatchError("table");
    }
    return result;
  }

  async getRelationsPage(
    connectionId: string,
    params: {
      schema?: string;
      table?: string;
      direction?: RelataRelationDirection;
      limit?: number;
      cursor?: string;
    },
  ): Promise<RelataRelationsPageResult> {
    const result = await this.discovery<RelataRelationsPageResult>(
      connectionId,
      "relations/page",
      params,
    );
    this.assertConnection(result, connectionId);
    const filter = result.filter;
    if (
      (params.schema !== undefined && filter?.schema !== params.schema) ||
      (params.table !== undefined && filter?.table !== params.table) ||
      (params.direction !== undefined && filter?.direction !== params.direction)
    ) {
      throw new RelataEchoMismatchError("filter");
    }
    return result;
  }

  async submitTelemetry(payload: {
    objective: string;
    relataContribution: string;
    missingFeatures: string;
  }): Promise<{ message: string }> {
    return this.request<{ message: string }>("POST", "/mcp/telemetry", payload);
  }

  /**
   * GET on a schema discovery route. Only defined values travel in the query
   * string. A 404 without the discovery header is a missing route, reported
   * as SchemaDiscoveryUnsupportedError instead of "not found".
   */
  private async discovery<T>(
    connectionId: string,
    route: string,
    params: Readonly<Record<string, string | number | undefined>>,
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const search = query.toString();
    const path = `/mcp/connections/${encodeURIComponent(connectionId)}/${route}${search ? `?${search}` : ""}`;
    try {
      return await this.request<T>("GET", path);
    } catch (error) {
      if (
        error instanceof RelataApiError &&
        error.status === 404 &&
        error.headers[SCHEMA_DISCOVERY_HEADER] === undefined
      ) {
        throw new SchemaDiscoveryUnsupportedError();
      }
      throw error;
    }
  }

  private assertConnection(
    result: { connectionId?: unknown },
    connectionId: string,
  ): void {
    if (result?.connectionId !== connectionId) {
      throw new RelataEchoMismatchError("connection");
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    additionalHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...additionalHeaders,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const request = this.requestSignal();
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.didTimeout()) {
        throw new RelataApiTimeoutError(this.timeoutMs);
      }
      throw error;
    } finally {
      request.dispose();
    }

    // Read once and try to parse — the backend returns JSON for
    // both success and error paths, but we don't want to crash on
    // an empty 204 or a stray HTML error page either.
    const rawText = await response.text();
    let parsed: unknown = null;
    if (rawText.length > 0) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
      }
    }

    if (!response.ok) {
      let message = `RelataSQL API request failed with status ${response.status}`;
      if (parsed && typeof parsed === "object" && "message" in parsed) {
        const m = (parsed as { message: unknown }).message;
        if (typeof m === "string" && m.length > 0) {
          message = m;
        }
      }
      throw new RelataApiError(
        message,
        response.status,
        parsed,
        headersOf(response),
      );
    }

    return parsed as T;
  }

  private requestSignal(): {
    signal: AbortSignal;
    didTimeout: () => boolean;
    dispose: () => void;
  } {
    const controller = new AbortController();
    let timedOut = false;
    const relayAbort = () => controller.abort(this.signal?.reason);
    if (this.signal?.aborted) {
      relayAbort();
    } else {
      this.signal?.addEventListener("abort", relayAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("RelataSQL API timeout", "TimeoutError"));
    }, this.timeoutMs);
    return {
      signal: controller.signal,
      didTimeout: () => timedOut,
      dispose: () => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", relayAbort);
      },
    };
  }
}

/** Lower-cased response headers (test doubles may omit them). */
function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = (response as { headers?: Headers }).headers;
  if (source && typeof source.forEach === "function") {
    source.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
  }
  return headers;
}
