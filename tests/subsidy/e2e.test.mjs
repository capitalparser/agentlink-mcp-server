import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../dist/server.js';
import { SubsidyDomainClient } from '../../dist/domains/subsidy/bridge.js';
import { TaxDomainClient } from '../../dist/domains/tax/bridge.js';

const PY = process.env.AGENTLINK_SUBSIDY_E2E_PYTHON;
const SRC = process.env.AGENTLINK_SUBSIDY_E2E_PYTHONPATH;
const skip = !PY || !existsSync(PY) || !SRC || !existsSync(join(SRC, 'regulation_reference', 'server.py'))
  ? 'Set AGENTLINK_SUBSIDY_E2E_PYTHON to the domain Python and AGENTLINK_SUBSIDY_E2E_PYTHONPATH to its src directory.' : false;

test('T6: real Python topics wrapper, local official error, card answer and conversation follow-up', { skip }, async t => {
  const root = dirname(SRC);
  const registry = process.env.REGULATION_PRACTITIONER_REGISTRY_DIR || join(root, 'registry');
  const cards = JSON.parse(readFileSync(join(registry, 'practitioner-rule-cards.v1.json'), 'utf8')).cards;
  const needs = JSON.parse(readFileSync(join(registry, 'practitioner-needs.v1.json'), 'utf8')).clusters;
  // Select a real card-linked need from source data, with a fact action to follow.
  const card = cards.find(c => c.need_ids.length && c.versions.some(v => v.rule.conditions.length));
  assert.ok(card);
  const need = needs.find(n => n.id === card.need_ids[0]);
  assert.ok(need);
  const sourceCatalog = join(root, 'data', 'catalog.json');
  // Practitioner registries are real; an empty catalog only satisfies startup
  // when the read-only source checkout does not carry generated catalog data.
  const work = mkdtempSync(join(tmpdir(), 'subsidy-e2e-'));
  const catalog = process.env.REGULATION_CATALOG || (existsSync(sourceCatalog) ? sourceCatalog : join(work, 'catalog.json'));
  if (!existsSync(catalog)) {
    assert.equal(catalog, join(work, 'catalog.json'), 'configured catalog must exist');
    writeFileSync(catalog, JSON.stringify({ schema_version: 2, references: [], documents: [] }));
  }
  const domain = new SubsidyDomainClient({ command: PY, args: ['-B', '-m', 'regulation_reference.server'], pythonPath: SRC }, {
    ...process.env,
    REGULATION_CATALOG: catalog,
    REGULATION_PRACTITIONER_REGISTRY_DIR: registry,
    REGULATION_OFFICIAL_TEXT_DIR: join(work, 'no-official-copies'),
    REGULATION_USAGE_DIR: join(work, 'usage'), REGULATION_USAGE_SIGNALS: 'off',
  });
  const tax = new TaxDomainClient({ command: '', args: [], configInvalid: true });
  const server = await createServer({ subsidyDomainClient: domain, taxDomainClient: tax });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'subsidy-e2e', version: '0' });
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(a), client.connect(b)]);
  const listed = await client.listTools();
  const publishedInstructions = listed.tools.find(x => x.name === 'subsidy_answer_practitioner_question').description;
  for (const marker of ['action.action_id', 'followed_action_id', '$conversation_state', '$answer']) assert.ok(publishedInstructions.includes(marker));
  const supportedDomainTools = new Set(['list_workflows', 'get_reference_bundle', 'search_references', 'get_reference',
    'answer_practitioner_question', 'list_practitioner_topics', 'get_official_text']);
  const umbrellaName = domainName => {
    assert.ok(supportedDomainTools.has(domainName), 'returned domain tool must be supported by the bridge');
    return `subsidy_${domainName}`;
  };
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name: umbrellaName(name), arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    return response.structuredContent;
  };
  const workflows = await call('list_workflows');
  assert.equal(workflows.domain, 'subsidy');
  const topics = await call('list_practitioner_topics');
  assert.deepEqual(Object.keys(topics), ['result']);
  assert.ok(Array.isArray(topics.result) && topics.result.length > 0);
  const official = await call('get_official_text', { doc_ref_id: 'law.subsidy', article_key: '0001000' });
  assert.deepEqual(official, { error: 'official_text_unavailable', doc_ref_id: 'law.subsidy' });
  const first = await call('answer_practitioner_question', {
    question: need.question, need_id: need.id, perspective: 'recipient', regime: need.regime, as_of: '2026-10-18',
  });
  assert.equal(first.schema_version, 'practitioner-answer.v1');
  assert.ok(first.assessments.some(a => a.card_id === card.id));
  assert.equal(first.conversation_state.turn, 1);
  assert.equal(first.conversation_state.last_need_id, need.id);
  const action = first.next_actions.find(a => a.kind === 'ask_fact' && a.tool);
  assert.ok(action, 'real answer offers a fact follow-up');
  assert.match(action.action_id, /^na\.\d{2}$/);
  assert.equal(action.tool.name, 'answer_practitioner_question');
  assert.equal(umbrellaName(action.tool.name), 'subsidy_answer_practitioner_question');
  assert.equal(action.tool.arguments.conversation_state, '$conversation_state');
  const key = Object.keys(action.tool.arguments.facts)[0];
  const condition = card.versions.flatMap(v => v.rule.conditions).find(c => c.fact_key === key);
  const value = condition?.value_type === 'enum' ? condition.enum_values.find(v => v !== condition.excludes_when) || condition.enum_values[0]
    : condition?.value_type === 'date' ? '2026-01-01' : '200000000';
  assert.equal(action.tool.arguments.facts[key], '$answer');
  const substitute = input => {
    if (input === '$conversation_state') return first.conversation_state;
    if (input === '$answer') return value;
    if (Array.isArray(input)) return input.map(substitute);
    if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, substitute(v)]));
    return input;
  };
  const followup = { ...substitute(action.tool.arguments), followed_action_id: action.action_id };
  const originalAction = structuredClone(action);
  const originalState = structuredClone(first.conversation_state);
  assert.deepEqual(Object.keys(followup).sort(), [...Object.keys(action.tool.arguments), 'followed_action_id'].sort());
  assert.equal(followup.followed_action_id, action.action_id);
  for (const [name, original] of Object.entries(action.tool.arguments)) {
    assert.deepEqual(followup[name], substitute(original), `only documented placeholders are transformed for ${name}`);
  }
  assert.equal(followup.conversation_state, first.conversation_state);
  const second = await call(action.tool.name, followup);
  assert.equal(action.tool.arguments.conversation_state, '$conversation_state');
  assert.equal(action.tool.arguments.facts[key], '$answer');
  assert.deepEqual(action, originalAction);
  assert.deepEqual(first.conversation_state, originalState);
  assert.equal(second.schema_version, 'practitioner-answer.v1');
  assert.equal(second.conversation_state.turn, 2);
  assert.equal(second.conversation_state.last_need_id, need.id);
  assert.equal(second.conversation_state.facts[key], value);
  assert.ok(second.assessments.some(a => a.card_id === card.id));
  assert.ok(second.conversation_state.visited_need_ids.includes(need.id));
  const invalidState = await call('answer_practitioner_question', { question: 'x', conversation_state: { invalid: true } });
  assert.deepEqual(invalidState, { error: 'invalid_input', field: 'conversation_state' });
  t.diagnostic(JSON.stringify({ catalog_mode: catalog === sourceCatalog ? 'source' : process.env.REGULATION_CATALOG ? 'configured' : 'empty-startup-fixture', topics: { keys: Object.keys(topics), result_type: 'array', count: topics.result.length, item_keys: Object.keys(topics.result[0]) },
    official, answer: { schema_version: first.schema_version, keys: Object.keys(first), need_id: need.id, card_id: card.id,
      first_status: first.answer_status, second_status: second.answer_status, turns: [first.conversation_state.turn, second.conversation_state.turn],
      followed_action_id: action.action_id, domain_tool: action.tool.name, umbrella_tool: umbrellaName(action.tool.name),
      placeholders_substituted: true, fact_key: key, card_continuity: true }, structural_error: invalidState }));
});
