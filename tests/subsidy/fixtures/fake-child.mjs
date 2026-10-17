// Real stdio fixture: optional argv[2] logs each spawn, never user arguments.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
if (process.argv[2]) appendFileSync(process.argv[2], `${process.pid}\n`);
const server = new McpServer({ name: 'fake-subsidy', version: '0' });
const ok = sc => ({ content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc });
for (const name of ['list_workflows', 'get_reference_bundle', 'search_references', 'get_reference',
  'answer_practitioner_question', 'list_practitioner_topics', 'get_official_text']) {
  server.registerTool(name, { inputSchema: z.object({}).passthrough() }, async args => ok({
    name, args, nested: { applicability: 'not_determined', values: [1, null, '원문'] },
  }));
}
server.tool('ping', async () => ok({ pid: process.pid }));
server.tool('crash', async () => { console.error('RAW_STDERR /secret/path'); process.exit(3); });
server.tool('sleep', async () => { await new Promise(r => setTimeout(r, 1000)); return ok({ slept: true }); });
server.tool('env_check', async () => ok({ env: process.env }));
server.tool('fail', async () => ({ isError: true, content: [{ type: 'text', text: 'RAW_DOMAIN_SECRET /private/path' }] }));
server.tool('structural_error', async () => ok({ error: 'invalid_input', field: 'conversation_state', nested: { preserved: [1, 2] } }));
server.tool('missing_structured', async () => ({ content: [{ type: 'text', text: 'RAW_DOMAIN_SECRET /private/path' }] }));
server.tool('array_structured', async () => ({ content: [], structuredContent: [] }));
await server.connect(new StdioServerTransport());
