// Stdio fixture whose tools/list schemas come from the public tax registrations.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerTaxDomainTools } from '../../../dist/domains/tax/tools.js';

if (process.argv[2]) appendFileSync(process.argv[2], `${process.pid}\n`);

const schemaServer = new McpServer({ name: 'tax-schema-source', version: '0' });
const registered = registerTaxDomainTools(schemaServer, {
  setStatusListener(listener) { listener({ configured: true, state: 'ready', verified_tool_names: [], verified_tool_count: 0 }); },
  async initialize() { return this.getStatus(); }, async refresh() { return this.getStatus(); },
  getStatus() { return { configured: true, state: 'ready', verified_tool_names: [], verified_tool_count: 0 }; },
  async callTool() { return {}; }, async callToolResult() { return { content: [{ type: 'text', text: '{}' }], structuredContent: {} }; },
  async close() {},
});

const server = new McpServer({ name: 'fake-tax', version: '0' });
const ok = (structuredContent) => ({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });
for (let index = 0; index < registered.contracts.length; index++) {
  const { domainName } = registered.contracts[index];
  server.registerTool(domainName, { inputSchema: registered.handles[index].inputSchema }, async (args) => ok({ name: domainName, args }));
}
server.tool('ping', 'ping', {}, async () => ok({ pid: process.pid }));
server.tool('crash', 'crash', {}, async () => { process.exit(1); });
server.tool('sleep', 'sleep', {}, async () => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return ok({ slept: true });
});
server.tool('env_check', 'env', {}, async () => ok({
  has_secret: process.env.FOO_SECRET !== undefined,
  has_proxy: process.env.HTTPS_PROXY !== undefined,
  automation_offer_path: process.env.AGENTLINK_AUTOMATION_OFFER_PATH,
}));
server.tool('fail', 'fail', {}, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'RAW_DOMAIN_SECRET /private/path' }],
}));
await server.connect(new StdioServerTransport());
