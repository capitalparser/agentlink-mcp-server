#!/usr/bin/env node

/**
 * AgentLink Korea - MCP Server Entry Point
 *
 * Starts the MCP server with stdio transport for local integration
 * with Claude Desktop, Claude Code, and other MCP-compatible clients.
 *
 * Usage:
 *   npx agentlink-mcp-server
 *   node dist/index.js
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: close server (and tax child) with a bounded wait.
  // StdioServerTransport does not fire onclose on stdin EOF, so listen explicitly.
  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    await Promise.race([server.close().catch(() => {}), timer]);
    process.exit(code);
  };

  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("close", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}

main().catch(() => {
  console.error("Failed to start AgentLink MCP server.");
  process.exit(1);
});
