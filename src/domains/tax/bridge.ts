/**
 * Tax domain bridge: lazily spawns the agentlink-domain-tax-mcp stdio server
 * and forwards read-only tool calls. The domain owns all semantics; the
 * bridge returns structuredContent unchanged.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export const TAX_BRIDGE_ERROR_SCHEMA = "tax-bridge-error.v1";
export type TaxBridgeErrorCode =
  | "TAX_DOMAIN_UNAVAILABLE"
  | "TAX_DOMAIN_TIMEOUT"
  | "TAX_DOMAIN_TOOL_ERROR"
  | "TAX_DOMAIN_ERROR";

export interface TaxBridgeError {
  schema_version: typeof TAX_BRIDGE_ERROR_SCHEMA;
  error_code: TaxBridgeErrorCode;
  message: string;
}

/** Minimal client surface used by the tool registrations (fakeable in tests). */
export interface TaxDomainClientLike {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface TaxDomainConfig {
  command: string;
  args: string[];
  pythonPath?: string;
  timeoutMs?: number;
}

const ENV_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "PYTHONPATH", "AGENTLINK_CREDENTIALS_PATH",
  "AGENTLINK_TAX_REGISTRY", "AGENTLINK_AUTOMATION_OFFER_PATH",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
];
const DEFAULT_TIMEOUT_MS = 30_000;

export function bridgeError(code: TaxBridgeErrorCode, message: string): TaxBridgeError {
  return { schema_version: TAX_BRIDGE_ERROR_SCHEMA, error_code: code, message };
}

export function isBridgeError(v: unknown): v is TaxBridgeError {
  return typeof v === "object" && v !== null &&
    (v as { schema_version?: unknown }).schema_version === TAX_BRIDGE_ERROR_SCHEMA;
}

export function taxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TaxDomainConfig {
  let args = ["-m", "agentlink_tax.server"];
  const raw = env.AGENTLINK_TAX_MCP_ARGS;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((a) => typeof a === "string")) {
        args = parsed as string[];
      }
    } catch {
      // keep default args
    }
  }
  return {
    command: env.AGENTLINK_TAX_MCP_COMMAND || "python3",
    args,
    pythonPath: env.AGENTLINK_TAX_MCP_PYTHONPATH || undefined,
  };
}

function childEnv(config: TaxDomainConfig, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  if (config.pythonPath) out.PYTHONPATH = config.pythonPath;
  return out;
}

export class TaxDomainClient implements TaxDomainClientLike {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: TaxDomainConfig = taxConfigFromEnv(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: childEnv(this.config, this.env),
          stderr: "ignore",
        });
        const client = new Client({ name: "agentlink-tax-bridge", version: "0.1.0" });
        client.onclose = () => {
          if (this.client === client) this.client = null;
        };
        const abort = new AbortController();
        client.onerror = () => {};
        try {
          await client.connect(transport, { timeout: this.timeoutMs, signal: abort.signal });
        } catch (e) {
          abort.abort();
          try { await client.close(); } catch { /* ignore */ }
          throw e;
        }
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let client: Client;
    try {
      client = await this.connect();
    } catch (e) {
      await this.reset();
      return { ...this.mapError(e, true) };
    }
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, {
        timeout: this.timeoutMs,
      });
      if (res.isError) {
        return { ...bridgeError("TAX_DOMAIN_TOOL_ERROR", "Tax domain tool reported an error.") };
      }
      const sc = (res as { structuredContent?: unknown }).structuredContent;
      if (typeof sc !== "object" || sc === null || Array.isArray(sc)) {
        return { ...bridgeError("TAX_DOMAIN_ERROR", "Tax domain tool did not return a valid result.") };
      }
      return sc as Record<string, unknown>;
    } catch (e) {
      const mapped = this.mapError(e, false);
      // A timeout affects only that call; the shared child is reset only when
      // the connection closed or the transport failed.
      if (mapped.error_code !== "TAX_DOMAIN_TIMEOUT") await this.reset();
      return { ...mapped };
    }
  }

  private mapError(e: unknown, connecting: boolean): TaxBridgeError {
    if (e instanceof McpError) {
      if (e.code === ErrorCode.RequestTimeout) {
        return bridgeError("TAX_DOMAIN_TIMEOUT", "Tax domain server did not respond in time.");
      }
      if (e.code === ErrorCode.ConnectionClosed) {
        return bridgeError("TAX_DOMAIN_UNAVAILABLE", "Tax domain server is unavailable.");
      }
      return bridgeError("TAX_DOMAIN_ERROR", "Tax domain server returned a protocol error.");
    }
    if (connecting) {
      return bridgeError("TAX_DOMAIN_UNAVAILABLE", "Tax domain server could not be started.");
    }
    return bridgeError("TAX_DOMAIN_ERROR", "Tax domain call failed.");
  }

  private async reset(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) {
      try { await c.close(); } catch { /* ignore */ }
    }
  }

  async close(): Promise<void> {
    if (this.connecting) {
      try { await this.connecting; } catch { /* ignore */ }
    }
    await this.reset();
  }
}
