// Run after `npm run build`: node --test tests/tax/bridge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../dist/server.js";
import { TaxDomainClient } from "../../dist/domains/tax/bridge.js";

const TAX_TOOLS = [
  "tax_list_workflows", "tax_get_workflow_contract", "tax_plan_work",
  "tax_list_rule_cards", "tax_search_law", "tax_check_business_status",
];

async function connect(taxDomainClient) {
  const server = createServer({ taxDomainClient });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}

test("tool list has 6 read-only tax tools; structuredContent passes through unchanged", async () => {
  const payload = { status: "weird", nested: { applicability: "applies", due: "2026-01-01" }, n: [1, 2] };
  const calls = [];
  const fake = {
    async callTool(name, args) { calls.push([name, args]); return payload; },
    async close() {},
  };
  const { client } = await connect(fake);
  const { tools } = await client.listTools();
  for (const n of TAX_TOOLS) {
    const t = tools.find((x) => x.name === n);
    assert.ok(t, `missing ${n}`);
    assert.equal(t.annotations?.readOnlyHint, true);
  }
  assert.ok(tools.find((x) => x.name === "get_vat_data"), "legacy tool kept");
  const res = await client.callTool({ name: "tax_plan_work", arguments: { matter: { matter_id: "m", extra: 1 } } });
  assert.deepEqual(res.structuredContent, payload);
  assert.deepEqual(JSON.parse(res.content[0].text), payload);
  assert.deepEqual(calls[0], ["plan_tax_work", { matter: { matter_id: "m", extra: 1 } }]);
  await client.callTool({ name: "tax_search_law", arguments: { query: "원천징수" } });
  assert.deepEqual(calls[1], ["search_tax_law", { query: "원천징수", target: "law", limit: 10 }]);
});

test("error mapping never leaks stderr or paths", async () => {
  const secret = "/secret/leak/path SECRET_STDERR";
  const missing = new TaxDomainClient({ command: "/nonexistent/" + "bin-xyz", args: [] });
  const r1 = await missing.callTool("list_tax_workflows", {});
  assert.equal(r1.schema_version, "tax-bridge-error.v1");
  assert.equal(r1.error_code, "TAX_DOMAIN_UNAVAILABLE");
  assert.ok(!JSON.stringify(r1).includes("nonexistent"));

  const crash = new TaxDomainClient({
    command: process.execPath,
    args: ["-e", `console.error(${JSON.stringify(secret)}); process.exit(3)`],
  });
  const r2 = await crash.callTool("list_tax_workflows", {});
  assert.equal(r2.error_code, "TAX_DOMAIN_UNAVAILABLE");
  assert.ok(!JSON.stringify(r2).includes("SECRET_STDERR"));
  assert.ok(!JSON.stringify(r2).includes("/secret"));

  const hang = new TaxDomainClient({
    command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 300,
  });
  const r3 = await hang.callTool("list_tax_workflows", {});
  assert.ok(["TAX_DOMAIN_TIMEOUT", "TAX_DOMAIN_UNAVAILABLE"].includes(r3.error_code));
  assert.equal(r3.schema_version, "tax-bridge-error.v1");
  await Promise.all([missing.close(), crash.close(), hang.close()]);
});

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-child.mjs");
const fake = (log, extra = {}, env = { PATH: process.env.PATH }) =>
  new TaxDomainClient({ command: process.execPath, args: log ? [FAKE, log] : [FAKE], ...extra }, env);
const logPath = () => join(mkdtempSync(join(tmpdir(), "taxbridge-")), "pids.log");
const pids = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean);

test("reconnects after child crash", async () => {
  const log = logPath();
  const c = fake(log);
  const r1 = await c.callTool("ping", {});
  const crashed = await c.callTool("crash", {});
  assert.equal(crashed.error_code, "TAX_DOMAIN_UNAVAILABLE");
  const r2 = await c.callTool("ping", {});
  assert.ok(r1.pid && r2.pid && r1.pid !== r2.pid);
  assert.equal(pids(log).length, 2);
  await c.close();
});

test("concurrent first calls spawn one child", async () => {
  const log = logPath();
  const c = fake(log);
  const rs = await Promise.all([1, 2, 3, 4].map(() => c.callTool("ping", {})));
  assert.equal(new Set(rs.map((r) => r.pid)).size, 1);
  assert.equal(pids(log).length, 1);
  await c.close();
});

test("env allowlist: non-allowlisted vars are not passed, allowlisted are", async () => {
  const c = fake(null, {}, { PATH: process.env.PATH, FOO_SECRET: "x", HTTPS_PROXY: "http://p:1" });
  const r = await c.callTool("env_check", {});
  assert.equal(r.has_secret, false);
  assert.equal(r.has_proxy, true);
  await c.close();
});

test("child isError -> TAX_DOMAIN_TOOL_ERROR with fixed safe message", async () => {
  const c = fake(null);
  const r = await c.callTool("fail", {});
  assert.equal(r.error_code, "TAX_DOMAIN_TOOL_ERROR");
  assert.equal(r.schema_version, "tax-bridge-error.v1");
  assert.ok(!JSON.stringify(r).includes("RAW_DOMAIN_SECRET"));
  assert.ok(!JSON.stringify(r).includes("/private"));
  await c.close();
});

test("timeout returns TAX_DOMAIN_TIMEOUT and does not reset the shared child", async () => {
  const log = logPath();
  const c = fake(log, { timeoutMs: 300 });
  const r0 = await c.callTool("ping", {});
  const t = await c.callTool("sleep", {});
  assert.equal(t.error_code, "TAX_DOMAIN_TIMEOUT");
  const r1 = await c.callTool("ping", {});
  assert.equal(r1.pid, r0.pid);
  assert.equal(pids(log).length, 1);
  await c.close();
});

const PY = process.env.AGENTLINK_TAX_E2E_PYTHON;
const SRC = process.env.AGENTLINK_TAX_E2E_PYTHONPATH;

test("end-to-end against the real Python domain server", {
  skip: !PY || !existsSync(PY)
    ? "SKIPPED: set AGENTLINK_TAX_E2E_PYTHON (and AGENTLINK_TAX_E2E_PYTHONPATH if the domain package is not installed)"
    : false,
}, async () => {
  const tax = new TaxDomainClient({ command: PY, args: ["-m", "agentlink_tax.server"], pythonPath: SRC || undefined });
  const { client } = await connect(tax);
  try {
    const wf = await client.callTool({ name: "tax_list_workflows", arguments: {} });
    assert.equal(wf.structuredContent.domain, "tax");
    assert.equal(wf.structuredContent.workflows.length, 9);

    const matter = {
      matter_id: "m1", workflow_id: "withholding-payment", as_of: "2026-04-01",
      taxpayer: { type: "corporation", small_business_semiannual_approval: false },
      facts: { payments: [{ payment_id: "p1", income_type: "wage", payee_type: "resident",
        payment_date: "2026-03-25", gross_amount: 3000000, withheld_amount: "10000" }] },
    };
    const plan = await client.callTool({ name: "tax_plan_work", arguments: { matter } });
    assert.equal(plan.structuredContent.status, "draft_ready");
    const due = plan.structuredContent.next_actions.filter((a) => a.due_date);
    assert.equal(due[0].due_date, "2026-04-10");
    assert.equal(due[0].deadline_status, "candidate_unverified");
  } finally {
    await client.close();
    await tax.close();
  }
});
