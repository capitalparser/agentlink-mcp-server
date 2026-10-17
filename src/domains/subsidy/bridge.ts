/**
 * Subsidy domain bridge: lazily spawns the regulation_reference.server stdio server
 * and forwards read-only tool calls. The domain owns all semantics; the
 * bridge returns structuredContent unchanged.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export const SUBSIDY_BRIDGE_ERROR_SCHEMA = "subsidy-bridge-error.v1";
export type SubsidyBridgeErrorCode =
  | "SUBSIDY_DOMAIN_UNAVAILABLE"
  | "SUBSIDY_DOMAIN_TIMEOUT"
  | "SUBSIDY_DOMAIN_TOOL_ERROR"
  | "SUBSIDY_DOMAIN_ERROR";

export interface SubsidyBridgeError {
  schema_version: typeof SUBSIDY_BRIDGE_ERROR_SCHEMA;
  error_code: SubsidyBridgeErrorCode;
  message: string;
}

/** Minimal client surface used by the tool registrations (fakeable in tests). */
export interface SubsidyDomainClientLike {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface SubsidyDomainConfig {
  command: string;
  args: string[];
  pythonPath?: string;
  timeoutMs?: number;
}

const ENV_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "PYTHONPATH",
  "REGULATION_CATALOG", "REGULATION_PRACTITIONER_REGISTRY_DIR", "REGULATION_OFFICIAL_TEXT_DIR",
  "REGULATION_USAGE_DIR", "REGULATION_USAGE_SIGNALS",
];
const DEFAULT_TIMEOUT_MS = 30_000;

export function bridgeError(code: SubsidyBridgeErrorCode, message: string): SubsidyBridgeError {
  return { schema_version: SUBSIDY_BRIDGE_ERROR_SCHEMA, error_code: code, message };
}

export function isBridgeError(v: unknown): v is SubsidyBridgeError {
  return typeof v === "object" && v !== null &&
    (v as { schema_version?: unknown }).schema_version === SUBSIDY_BRIDGE_ERROR_SCHEMA;
}

export function subsidyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SubsidyDomainConfig {
  let args = ["-m", "regulation_reference.server"];
  const raw = env.AGENTLINK_SUBSIDY_MCP_ARGS;
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
    command: env.AGENTLINK_SUBSIDY_MCP_COMMAND || "python3",
    args,
    pythonPath: env.AGENTLINK_SUBSIDY_MCP_PYTHONPATH || undefined,
  };
}

function childEnv(config: SubsidyDomainConfig, env: NodeJS.ProcessEnv): Record<string, string> {
  // The SDK merges defaults even with explicit env. Undefined tombstones remove
  // defaults outside our allowlist from the actual spawned child's environment.
  const out: Record<string, string | undefined> = {};
  for (const k of DEFAULT_INHERITED_ENV_VARS) out[k] = undefined;
  for (const k of ENV_ALLOWLIST) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  if (config.pythonPath) out.PYTHONPATH = config.pythonPath;
  return out as Record<string, string>;
}

export class SubsidyDomainClient implements SubsidyDomainClientLike {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: SubsidyDomainConfig = subsidyConfigFromEnv(),
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
        const client = new Client({ name: "agentlink-subsidy-bridge", version: "0.1.0" });
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
      return { ...this.mapError(e, true) };
    }
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, {
        timeout: this.timeoutMs,
      });
      if (res.isError) {
        return { ...bridgeError("SUBSIDY_DOMAIN_TOOL_ERROR", "Subsidy domain tool reported an error.") };
      }
      const sc = (res as { structuredContent?: unknown }).structuredContent;
      if (typeof sc !== "object" || sc === null || Array.isArray(sc)) {
        return { ...bridgeError("SUBSIDY_DOMAIN_ERROR", "Subsidy domain tool did not return a valid result.") };
      }
      return sc as Record<string, unknown>;
    } catch (e) {
      const mapped = this.mapError(e, false);
      // A timeout affects only that call; the shared child is reset only when
      // the connection closed or the transport failed.
      if (mapped.error_code !== "SUBSIDY_DOMAIN_TIMEOUT") await this.reset(client);
      return { ...mapped };
    }
  }

  private mapError(e: unknown, connecting: boolean): SubsidyBridgeError {
    if (e instanceof McpError) {
      if (e.code === ErrorCode.RequestTimeout) {
        return bridgeError("SUBSIDY_DOMAIN_TIMEOUT", "Subsidy domain server did not respond in time.");
      }
      if (e.code === ErrorCode.ConnectionClosed) {
        return bridgeError("SUBSIDY_DOMAIN_UNAVAILABLE", "Subsidy domain server is unavailable.");
      }
      return bridgeError("SUBSIDY_DOMAIN_ERROR", "Subsidy domain server returned a protocol error.");
    }
    if (connecting) {
      return bridgeError("SUBSIDY_DOMAIN_UNAVAILABLE", "Subsidy domain server could not be started.");
    }
    return bridgeError("SUBSIDY_DOMAIN_ERROR", "Subsidy domain call failed.");
  }

  private async reset(expected?: Client): Promise<void> {
    const c = this.client;
    if (expected && c !== expected) return;
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
