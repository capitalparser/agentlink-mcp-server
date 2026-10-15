/**
 * AgentLink Korea - MCP Server Assembly
 *
 * Creates and configures the McpServer instance with all registered tools.
 * This is the central wiring point where tool modules are composed into
 * a complete MCP server ready for transport connection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StubDataProvider } from "./types/index.js";
import type { DataProvider } from "./types/index.js";
import { registerTaxTools } from "./tools/tax.js";
import { registerBusinessTools } from "./tools/business.js";
import { registerPublicDataTools } from "./tools/public-data.js";
import { registerLegalTools } from "./tools/legal.js";
import { registerDisasterTools } from "./tools/disaster.js";
import { TaxDomainClient } from "./domains/tax/bridge.js";
import type { TaxDomainClientLike } from "./domains/tax/bridge.js";
import { registerTaxDomainTools } from "./domains/tax/tools.js";

export interface CreateServerOptions {
  /** Custom data provider (defaults to StubDataProvider for development) */
  provider?: DataProvider;
  /** Tax domain MCP client (defaults to a lazy stdio client configured from env) */
  taxDomainClient?: TaxDomainClientLike;
}

/**
 * Create a fully configured AgentLink MCP server with all tools registered.
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const provider = options.provider ?? new StubDataProvider();

  const server = new McpServer({
    name: "agentlink-korea",
    version: "0.1.0",
  });

  // Register all tool categories
  registerTaxTools(server, provider);
  registerBusinessTools(server, provider);
  registerPublicDataTools(server, provider);
  registerLegalTools(server, provider);
  registerDisasterTools(server, provider);

  // Tax domain bridge (lazy: the child process starts on first call)
  const taxClient = options.taxDomainClient ?? new TaxDomainClient();
  registerTaxDomainTools(server, taxClient);
  const prevOnClose = server.server.onclose;
  server.server.onclose = () => {
    void taxClient.close();
    prevOnClose?.();
  };

  return server;
}
