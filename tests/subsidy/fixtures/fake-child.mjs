// Stdio fixture whose tools/list schemas come from the public subsidy registrations.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSubsidyDomainTools } from '../../../dist/domains/subsidy/tools.js';

if (process.argv[2]) appendFileSync(process.argv[2], `${process.pid}\n`);
const schemaServer = new McpServer({ name: 'subsidy-schema-source', version: '0' });
const registered = registerSubsidyDomainTools(schemaServer, {
  setStatusListener(listener) { listener({ configured: true, state: 'ready', verified_tool_names: [], verified_tool_count: 0 }); },
  async initialize() { return this.getStatus(); }, async refresh() { return this.getStatus(); },
  getStatus() { return { configured: true, state: 'ready', verified_tool_names: [], verified_tool_count: 0 }; },
  async callTool() { return {}; }, async callToolResult() { return { content: [{ type: 'text', text: '{}' }], structuredContent: {} }; },
  async close() {},
});

const server = new McpServer({ name: 'fake-subsidy', version: '0' });
const ok = (structuredContent) => ({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });
for (let index = 0; index < registered.contracts.length; index++) {
  const { domainName } = registered.contracts[index];
  server.registerTool(domainName, { inputSchema: registered.handles[index].inputSchema }, async (args) => ok({
    name: domainName, args, nested: { applicability: 'not_determined', values: [1, null, '원문'] },
  }));
}
server.tool('ping', async () => ok({ pid: process.pid }));
server.tool('crash', async () => { console.error('RAW_STDERR /secret/path'); process.exit(3); });
server.tool('sleep', async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); return ok({ slept: true }); });
server.tool('env_check', async () => ok({ env: process.env }));
server.tool('fail', async () => ({ isError: true, content: [{ type: 'text', text: 'RAW_DOMAIN_SECRET /private/path' }] }));
server.tool('structural_error', async () => ok({ error: 'invalid_input', field: 'conversation_state', nested: { preserved: [1, 2] } }));
server.tool('missing_structured', async () => ({ content: [{ type: 'text', text: 'RAW_DOMAIN_SECRET /private/path' }] }));
server.tool('array_structured', async () => ({ content: [], structuredContent: [] }));
await server.connect(new StdioServerTransport());
