import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { TaxDomainClient } from '../dist/domains/tax/bridge.js';
import { SubsidyDomainClient } from '../dist/domains/subsidy/bridge.js';
import { memoryDomainClient } from './tax/fixtures/memory-domain-client.mjs';

const invalidTax = () => new TaxDomainClient({ command: '', args: [], configInvalid: true });
const invalidSubsidy = () => new SubsidyDomainClient({ command: '', args: [], configInvalid: true });

async function openServer(options) {
  const server = await createServer(options);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'server-assembly-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test('default assembly hides demo/subsidy tools and keeps a safe diagnostic tool', async () => {
  const { server, client } = await openServer({ taxDomainClient: invalidTax() });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['agentlink_bridge_status']);
    const status = (await client.callTool({ name: 'agentlink_bridge_status', arguments: {} })).structuredContent;
    assert.equal(status.tax.state, 'invalid');
    assert.equal(status.subsidy.state, 'not_configured');
    assert.equal(status.subsidy.configured, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('demo tools require explicit opt-in', async () => {
  const { server, client } = await openServer({ taxDomainClient: invalidTax(), demo: true });
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'get_vat_data'));
    assert.ok(tools.some((tool) => tool.name === 'get_business_info'));
    assert.equal(tools.some((tool) => tool.name.startsWith('subsidy_')), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('an unavailable optional subsidy domain does not hide verified tax tools', async () => {
  const tax = memoryDomainClient();
  const { server, client } = await openServer({ taxDomainClient: tax, subsidyDomainClient: invalidSubsidy() });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.filter((tool) => tool.name.startsWith('tax_')).length, 18);
    assert.equal(tools.some((tool) => tool.name.startsWith('subsidy_')), false);
    const status = (await client.callTool({ name: 'agentlink_bridge_status', arguments: {} })).structuredContent;
    assert.equal(status.tax.state, 'ready');
    assert.equal(status.tax.verified_tool_count, 18);
    assert.equal(status.subsidy.state, 'invalid');
  } finally {
    await client.close();
    await server.close();
  }
});
