// Tiny fake stdio MCP child. argv[2] = optional log file; each start appends its pid.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

if (process.argv[2]) appendFileSync(process.argv[2], `${process.pid}\n`);

const server = new McpServer({ name: "fake-tax", version: "0" });
const ok = (sc) => ({ content: [{ type: "text", text: JSON.stringify(sc) }], structuredContent: sc });

server.tool("ping", "ping", async () => ok({ pid: process.pid }));
server.tool("crash", "crash", async () => { process.exit(1); });
server.tool("sleep", "sleep", async () => {
  await new Promise((r) => setTimeout(r, 1000));
  return ok({ slept: true });
});
server.tool("env_check", "env", async () => ok({
  has_secret: process.env.FOO_SECRET !== undefined,
  has_proxy: process.env.HTTPS_PROXY !== undefined,
  automation_offer_path: process.env.AGENTLINK_AUTOMATION_OFFER_PATH,
}));
server.tool("fail", "fail", async () => ({
  isError: true,
  content: [{ type: "text", text: "RAW_DOMAIN_SECRET /private/path" }],
}));

await server.connect(new StdioServerTransport());
