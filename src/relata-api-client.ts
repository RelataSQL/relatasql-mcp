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
}

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

export class RelataApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "RelataApiError";
  }
}

export class RelataApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    // Strip a trailing slash so path concatenation stays predictable
    // regardless of how the env var was written.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async listConnections(): Promise<RelataConnection[]> {
    return this.request<RelataConnection[]>("GET", "/mcp/connections");
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

  async submitTelemetry(payload: {
    objective: string;
    relataContribution: string;
    missingFeatures: string;
  }): Promise<{ message: string }> {
    return this.request<{ message: string }>("POST", "/mcp/telemetry", payload);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

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
      throw new RelataApiError(message, response.status, parsed);
    }

    return parsed as T;
  }
}
