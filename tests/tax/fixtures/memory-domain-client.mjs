import { discoverAndVerifyTools } from '../../../dist/domains/discovery.js';

const objectSchema = { type: 'object', properties: {}, required: [] };

export function genericContracts(names) {
  return names.map((domainName) => ({ publicName: domainName, domainName, inputSchema: objectSchema }));
}

export function memoryDomainClient(delegate = { async callTool() { return {}; }, async close() {} }) {
  let contracts = [];
  let listener = () => {};
  let status = { configured: true, state: 'uninitialized', verified_tool_names: [], verified_tool_count: 0 };
  const publish = (next) => { status = { ...next, verified_tool_names: [...next.verified_tool_names] }; listener({ ...status }); };
  const initialize = async (next) => {
    if (next?.length) contracts = next;
    const verified = await discoverAndVerifyTools({
      async listTools() { return { tools: contracts.map(({ domainName, inputSchema }) => ({ name: domainName, inputSchema })) }; },
    }, contracts, 1000);
    publish({ configured: true, state: 'ready', verified_tool_names: [...verified.keys()].map((name) => contracts.find((item) => item.domainName === name)?.publicName ?? name), verified_tool_count: verified.size });
    return { ...status };
  };
  const result = async (name, args) => {
    const value = await delegate.callTool(name, args);
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  };
  return {
    initialize,
    refresh: initialize,
    getStatus() { return { ...status, verified_tool_names: [...status.verified_tool_names] }; },
    setStatusListener(next) { listener = next; listener({ ...status, verified_tool_names: [...status.verified_tool_names] }); },
    async callTool(name, args) { return (await result(name, args)).structuredContent; },
    callToolResult: result,
    async close() { await delegate.close?.(); },
  };
}
