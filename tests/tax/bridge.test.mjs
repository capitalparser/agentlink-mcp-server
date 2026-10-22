// Run after `npm run build`: node --test tests/tax/bridge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../../dist/server.js";
import { TaxDomainClient } from "../../dist/domains/tax/bridge.js";
import { registerTaxDomainTools } from "../../dist/domains/tax/tools.js";
import { memoryDomainClient, genericContracts } from "./fixtures/memory-domain-client.mjs";

const TAX_TOOLS = [
  "tax_list_workflows", "tax_get_workflow_contract", "tax_plan_work", "tax_get_automation_offer",
  "tax_list_rule_cards", "tax_search_law", "tax_get_law_article", "tax_check_business_status",
  "tax_list_practice_cards", "tax_list_holidays", "tax_get_schedule",
  "tax_find_office", "tax_search_interpretations", "tax_get_tribunal_decision",
  "tax_search_forms", "tax_list_form_guides", "tax_get_form_field_tips",
  "tax_answer_practitioner_question", "tax_export_rule_cards",
];

async function connect(taxDomainClient) {
  const server = await createServer({ taxDomainClient: memoryDomainClient(taxDomainClient), demo: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}

test("tool list has 19 read-only tax tools; structuredContent passes through unchanged", async () => {
  const automation_offer = {
    schema_version: "automation-offer.v1",
    label: "automation_offer_not_legal_content",
    domain: "tax",
    workflow_id: "withholding-payment",
    availability: "available_on_request",
    automates: [{
      capability_id: "payroll-ledger-to-wh-payment-report",
      label_ko: "급여대장으로 원천징수이행상황신고서 작성 초안",
      input_document_types: ["ev-payroll-ledger", "ev-payment-proof"],
      output_kinds: ["fill_draft_json", "working_paper_csv"],
    }],
    never_automated: ["government_submission", "final_tax_computation"],
    human_review_required: true,
    data_handling: { processing: "agentlink_private_backend", third_party_transfer: false },
    contact: { channel: "not_configured", value: null },
    pricing_ref: null,
    config_source: "registry_default",
  };
  const payload = { automation_offer, status: "weird", nested: { applicability: "applies", due: "2026-01-01" }, n: [1, 2] };
  const calls = [];
  const fake = {
    async callTool(name, args) { calls.push([name, args]); return payload; },
    async close() {},
  };
  const { client } = await connect(fake);
  const { tools } = await client.listTools();
  assert.equal(tools.filter((t) => t.name.startsWith("tax_")).length, 19);
  for (const n of TAX_TOOLS) {
    const t = tools.find((x) => x.name === n);
    assert.ok(t, `missing ${n}`);
    assert.equal(t.annotations?.readOnlyHint, true);
  }
  assert.ok(tools.find((x) => x.name === "agentlink_bridge_status"), "diagnostic tool is available");
  assert.ok(tools.find((x) => x.name === "get_vat_data"), "explicit demo tools are available in this test");
  const res = await client.callTool({ name: "tax_plan_work", arguments: { matter: { matter_id: "m", extra: 1 } } });
  assert.deepEqual(res.structuredContent, payload);
  assert.deepEqual(res.structuredContent.automation_offer, automation_offer);
  assert.deepEqual(JSON.parse(res.content[0].text), payload);
  assert.deepEqual(calls[0], ["plan_tax_work", { matter: { matter_id: "m", extra: 1 } }]);
  await client.callTool({ name: "tax_search_law", arguments: { query: "원천징수" } });
  assert.deepEqual(calls[1], ["search_tax_law", { query: "원천징수", target: "law", limit: 10 }]);
  await client.callTool({ name: "tax_get_law_article", arguments: { law_name: "소득세법", article: "제128조", law_id: "001565" } });
  assert.deepEqual(calls[2], ["get_law_article", { law_name: "소득세법", article: "제128조", law_id: "001565" }]);
  for (const name of ["tax_answer_practitioner_question", "tax_export_rule_cards"]) {
    const args = name === "tax_answer_practitioner_question" ? { matter: {} } : {};
    const result = await client.callTool({ name, arguments: args });
    assert.deepEqual(result.structuredContent, payload);
    assert.deepEqual(JSON.parse(result.content[0].text), payload);
    assert.equal(tools.find((t) => t.name === name).annotations.openWorldHint,
      name === "tax_answer_practitioner_question");
  }
  assert.equal(tools.find((t) => t.name === "tax_plan_work").annotations.openWorldHint, true);
});

test("lecture and personal-service calculation facts pass through unchanged with a bounded evidence scope", async () => {
  const calls = [];
  const fake = { async callTool(name, args) { calls.push([name, args]); return { status: "ok" }; }, async close() {} };
  const { client } = await connect(fake);
  try {
    const { tools } = await client.listTools();
    const description = (name) => tools.find((tool) => tool.name === name)?.description ?? "";
    for (const name of ["tax_plan_work", "tax_answer_practitioner_question"]) {
      assert.match(description(name), /business_lecture/);
      assert.match(description(name), /other_lecture/);
      assert.match(description(name), /business_personal_service/);
      assert.match(description(name), /other_personal_service/);
      for (const subtype of ["manuscript_fee", "expert_advisory", "broadcast_commentary"]) {
        assert.match(description(name), new RegExp(subtype));
      }
      for (const locator of ["Article 21(1)(15)(a)", "Article 21(1)(19)(c)", "Article 21(1)(19)(b)"]) {
        assert.ok(description(name).includes(locator), `tool description must include ${locator}`);
      }
      for (const phrase of ["original author", "professional knowledge", "analogous broadcasting media",
        "a one-off payment does not establish that classification", "The user-provided classification remains unverified"]) {
        assert.ok(description(name).includes(phrase), `tool description must include ${phrase}`);
      }
      for (const subtype of ["authorship", "artwork_design", "illustration", "composition", "voice_acting",
        "entertainment_direction", "entertainment_filming", "proofreading", "translation", "shorthand"]) {
        assert.match(description(name), new RegExp(subtype));
      }
      for (const label of ["저술 용역", "도안 용역", "삽화 용역", "작곡 용역", "성우 용역",
        "연예에 관한 연출 용역", "연예에 관한 촬영 용역", "교정 용역", "번역 용역", "속기 용역"]) {
        assert.ok(description(name).includes(label), `tool description must include ${label}`);
      }
      assert.match(description(name), /matched current-law evidence/);
      assert.match(description(name), /whole-matter applicability remains not_determined/);
      assert.doesNotMatch(description(name), /no tax amount is computed/);
    }

    const lectureMatter = {
      matter_id: "lecture-forwarding",
      workflow_id: "withholding-payment",
      as_of: "2026-10-22",
      taxpayer: { type: "corporation" },
      facts: { payments: [{
        payment_id: "lecture-1",
        income_type: "business",
        payee_type: "resident",
        payee_entity: "individual",
        payment_date: "2026-10-22",
        gross_amount: 33333,
        withholding_profile: "business_lecture",
        domestic_payment: true,
        lecture_to_many: true,
        employment_relationship: false,
        independent_service: true,
        has_business_facilities: false,
        uses_hired_labor: false,
        special_tax_treatment: false,
        single_payment_complete: true,
        activity_continuity: "continuing",
      }] },
    };
    const personalServiceMatter = {
      ...lectureMatter,
      matter_id: "personal-service-forwarding",
      facts: { payments: [{
        ...lectureMatter.facts.payments[0],
        payment_id: "translation-1",
        withholding_profile: "business_personal_service",
        service_subtype: "translation",
        lecture_to_many: false,
        expenses_exceed_standard: true,
      }] },
    };
    const otherServiceMatter = {
      ...lectureMatter,
      matter_id: "other-service-forwarding",
      facts: { payments: [{
        payment_id: "broadcast-commentary-1",
        income_type: "other",
        payee_type: "resident",
        payee_entity: "individual",
        payment_date: "2026-10-22",
        gross_amount: 1000000,
        withholding_profile: "other_personal_service",
        other_service_subtype: "broadcast_commentary",
        other_service_scope_confirmed: true,
        domestic_payment: true,
        employment_relationship: false,
        independent_service: true,
        activity_continuity: "temporary",
        special_tax_treatment: false,
        single_payment_complete: true,
        expenses_exceed_standard: false,
        lecture_to_many: false,
      }] },
    };
    await client.callTool({ name: "tax_plan_work", arguments: { matter: lectureMatter, include_evidence: true } });
    await client.callTool({ name: "tax_answer_practitioner_question", arguments: {
      matter: lectureMatter, include_evidence: true,
    } });
    await client.callTool({ name: "tax_plan_work", arguments: { matter: personalServiceMatter, include_evidence: true } });
    await client.callTool({ name: "tax_answer_practitioner_question", arguments: {
      matter: personalServiceMatter, include_evidence: true,
    } });
    await client.callTool({ name: "tax_plan_work", arguments: { matter: otherServiceMatter, include_evidence: true } });
    await client.callTool({ name: "tax_answer_practitioner_question", arguments: {
      matter: otherServiceMatter, include_evidence: true,
    } });
    assert.deepEqual(calls, [
      ["plan_tax_work", { matter: lectureMatter, include_evidence: true }],
      ["answer_practitioner_question", { matter: lectureMatter, include_evidence: true }],
      ["plan_tax_work", { matter: personalServiceMatter, include_evidence: true }],
      ["answer_practitioner_question", { matter: personalServiceMatter, include_evidence: true }],
      ["plan_tax_work", { matter: otherServiceMatter, include_evidence: true }],
      ["answer_practitioner_question", { matter: otherServiceMatter, include_evidence: true }],
    ]);
  } finally {
    await client.close();
  }
});

test("practitioner tools forward arguments and reject invalid ranges before domain calls", async () => {
  const calls = [];
  const fake = { async callTool(name, args) { calls.push([name, args]); return {}; }, async close() {} };
  const { client } = await connect(fake);
  const call = (name, args) => client.callTool({ name, arguments: args });
  try {
    const matter = { workflow_id: "withholding-payment", facts: { payments: [] } };
    const state = { schema_version: "conversation-state.v1", turn: 1 };
    await call("tax_answer_practitioner_question", { matter });
    await call("tax_answer_practitioner_question", { matter, question: "q".repeat(500), conversation_state: state });
    await call("tax_answer_practitioner_question", { matter, question: null, conversation_state: null });
    await call("tax_answer_practitioner_question", { matter, include_evidence: false });
    await call("tax_answer_practitioner_question", { matter, include_evidence: true });
    await call("tax_export_rule_cards", {});
    await call("tax_export_rule_cards", { layer: "practice", workflow_id: "withholding-payment" });
    await call("tax_export_rule_cards", { layer: "rules", workflow_id: null });
    assert.deepEqual(calls, [
      ["answer_practitioner_question", { matter }],
      ["answer_practitioner_question", { matter, question: "q".repeat(500), conversation_state: state }],
      ["answer_practitioner_question", { matter, question: null, conversation_state: null }],
      ["answer_practitioner_question", { matter, include_evidence: false }],
      ["answer_practitioner_question", { matter, include_evidence: true }],
      ["export_rule_cards", { layer: "rules" }],
      ["export_rule_cards", { layer: "practice", workflow_id: "withholding-payment" }],
      ["export_rule_cards", { layer: "rules", workflow_id: null }],
    ]);
    const n = calls.length;
    for (const [name, args] of [
      ["tax_answer_practitioner_question", {}],
      ["tax_answer_practitioner_question", { matter: [] }],
      ["tax_answer_practitioner_question", { matter: {}, question: "q".repeat(501) }],
      ["tax_answer_practitioner_question", { matter: {}, question: 1 }],
      ["tax_answer_practitioner_question", { matter: {}, conversation_state: [] }],
      ["tax_answer_practitioner_question", { matter: {}, include_evidence: "yes" }],
      ["tax_export_rule_cards", { layer: "bogus" }],
      ["tax_export_rule_cards", { workflow_id: "x".repeat(81) }],
    ]) {
      let rejected = false;
      try { rejected = (await call(name, args)).isError === true; } catch { rejected = true; }
      assert.ok(rejected, `${name} should reject invalid input`);
    }
    assert.equal(calls.length, n);
  } finally {
    await client.close();
  }
});

test("new tax tools forward arguments, apply defaults and reject out-of-range input", async () => {
  const calls = [];
  const fake = { async callTool(name, args) { calls.push([name, args]); return { status: "ok" }; }, async close() {} };
  const { client } = await connect(fake);
  const call = (name, args) => client.callTool({ name, arguments: args });
  await call("tax_list_practice_cards", { workflow_id: "withholding-payment", topic_query: "지급명세서" });
  await call("tax_list_holidays", { year: 2026 });
  await call("tax_get_schedule", { year: 2026, query: "부가", month: 7 });
  await call("tax_find_office", { query: "역삼동" });
  await call("tax_search_interpretations", { query: "원천징수" });
  await call("tax_search_interpretations", { query: "x", source: "tribunal_decision", limit: 3 });
  await call("tax_get_tribunal_decision", { id: "123456" });
  await call("tax_get_law_article", { law_name: "소득세법", article: "제128조", law_id: "001565" });
  await call("tax_search_forms", { query: "원천징수이행상황신고서", law_name: "소득세법 시행규칙" });
  await call("tax_list_form_guides", {});
  await call("tax_get_form_field_tips", { form_id: "wh-payment-report", code: "A25" });
  await call("tax_plan_work", { matter: { matter_id: "m" }, include_evidence: false, include_filling_guide: false });
  await call("tax_get_automation_offer", {});
  await call("tax_get_automation_offer", { workflow_id: "withholding-payment" });
  assert.deepEqual(calls, [
    ["list_practice_cards", { workflow_id: "withholding-payment", topic_query: "지급명세서" }],
    ["list_holidays", { year: 2026 }],
    ["get_tax_schedule", { year: 2026, query: "부가", month: 7, limit: 100 }],
    ["find_tax_office", { query: "역삼동" }],
    ["search_tax_interpretations", { query: "원천징수", source: "nts_interpretation", limit: 10 }],
    ["search_tax_interpretations", { query: "x", source: "tribunal_decision", limit: 3 }],
    ["get_tribunal_decision", { id: "123456" }],
    ["get_law_article", { law_name: "소득세법", article: "제128조", law_id: "001565" }],
    ["search_tax_forms", { query: "원천징수이행상황신고서", law_name: "소득세법 시행규칙", limit: 10 }],
    ["list_form_guides", {}],
    ["get_form_field_tips", { form_id: "wh-payment-report", code: "A25", limit: 20 }],
    ["plan_tax_work", { matter: { matter_id: "m" }, include_evidence: false, include_filling_guide: false }],
    ["get_automation_offer", {}],
    ["get_automation_offer", { workflow_id: "withholding-payment" }],
  ]);
  const { tools } = await client.listTools();
  const open = (n) => tools.find((t) => t.name === n).annotations.openWorldHint;
  assert.equal(open("tax_get_automation_offer"), false);
  assert.equal(open("tax_list_practice_cards"), false);
  assert.equal(open("tax_list_holidays"), true);
  assert.equal(open("tax_search_forms"), true);
  assert.equal(open("tax_list_form_guides"), false);
  assert.equal(open("tax_get_form_field_tips"), false);
  assert.equal(open("tax_plan_work"), true);
  assert.equal(open("tax_answer_practitioner_question"), true);
  assert.equal(open("tax_get_law_article"), true);
  const n = calls.length;
  const bad = [
    ["tax_get_automation_offer", { workflow_id: "x".repeat(81) }],
    ["tax_list_holidays", { year: 1800 }],
    ["tax_get_schedule", { year: 2026, month: 13 }],
    ["tax_get_schedule", { year: 2026, limit: 301 }],
    ["tax_search_interpretations", { query: "x", source: "bogus" }],
    ["tax_search_interpretations", { query: "x", limit: 21 }],
    ["tax_get_tribunal_decision", { id: "1234567890123" }],
    ["tax_find_office", { query: "" }],
    ["tax_search_forms", { query: "x", limit: 21 }],
    ["tax_search_forms", { query: "x".repeat(101) }],
    ["tax_list_form_guides", { form_id: "x".repeat(61) }],
    ["tax_get_form_field_tips", { form_id: "" }],
    ["tax_get_form_field_tips", { form_id: "a", limit: 51 }],
    ["tax_get_form_field_tips", { form_id: "a", code: "x".repeat(81) }],
    ["tax_get_law_article", { law_name: "x".repeat(101), article: "제1조" }],
    ["tax_get_law_article", { law_name: "소득세법", article: "x".repeat(21) }],
    ["tax_get_law_article", { law_name: "소득세법", article: "제1조", law_id: "x".repeat(11) }],
    ["tax_plan_work", { matter: {}, include_evidence: "yes" }],
  ];
  for (const [name, args] of bad) {
    let rejected = false;
    try { const r = await call(name, args); rejected = r.isError === true; } catch { rejected = true; }
    assert.ok(rejected, `${name} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, n, "invalid input must not reach the domain");
});

test("error mapping never leaks stderr or paths", async () => {
  const secret = "/secret/leak/path SECRET_STDERR";
  const missing = new TaxDomainClient({ command: "/nonexistent/" + "bin-xyz", args: [] });
  const contracts = genericContracts(["list_tax_workflows"]);
  await missing.initialize(contracts);
  const r1 = await missing.callTool("list_tax_workflows", {});
  assert.equal(r1.schema_version, "tax-bridge-error.v1");
  assert.equal(r1.error_code, "TAX_DOMAIN_UNAVAILABLE");
  assert.ok(!JSON.stringify(r1).includes("nonexistent"));

  const crash = new TaxDomainClient({
    command: process.execPath,
    args: ["-e", `console.error(${JSON.stringify(secret)}); process.exit(3)`],
  });
  await crash.initialize(contracts);
  const r2 = await crash.callTool("list_tax_workflows", {});
  assert.equal(r2.error_code, "TAX_DOMAIN_UNAVAILABLE");
  assert.ok(!JSON.stringify(r2).includes("SECRET_STDERR"));
  assert.ok(!JSON.stringify(r2).includes("/secret"));

  const hang = new TaxDomainClient({
    command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 300,
  });
  await hang.initialize(contracts);
  const r3 = await hang.callTool("list_tax_workflows", {});
  assert.ok(["TAX_DOMAIN_TIMEOUT", "TAX_DOMAIN_UNAVAILABLE"].includes(r3.error_code));
  assert.equal(r3.schema_version, "tax-bridge-error.v1");
  await Promise.all([missing.close(), crash.close(), hang.close()]);
});

test("safe law error packet passes through and authenticated MCP error is redacted", async () => {
  const safePacket = { status: "error", code: "http_500" };
  const forwarded = [];
  const { server, client } = await connect({
    async callTool(name, args) { forwarded.push([name, args]); return safePacket; },
    async close() {},
  });
  try {
    const pass = await client.callTool({ name: "tax_get_law_article", arguments: {
      law_name: "소득세법", article: "제128조", law_id: "001565",
    } });
    assert.deepEqual(pass.structuredContent, safePacket);
    assert.deepEqual(JSON.parse(pass.content[0].text), safePacket);
    assert.deepEqual(forwarded, [["get_law_article", { law_name: "소득세법", article: "제128조", law_id: "001565" }]]);
  } finally {
    await client.close();
    await server.close();
  }

  const schemaSource = new McpServer({ name: "tax-contract-source", version: "0" });
  const contracts = registerTaxDomainTools(schemaSource, {
    setStatusListener() {},
    async callToolResult() { return { content: [{ type: "text", text: "{}" }], structuredContent: {} }; },
  }).contracts;
  const articleContract = contracts.find((item) => item.domainName === "get_law_article");
  assert.ok(articleContract);
  const sentinel = "https://www.law.go.kr/DRF/lawService.do?OC=SYNTHETIC-LEAK-SENTINEL";
  const childScript = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "sentinel-tax-error", version: "0" });
server.tool("get_law_article", "", {
  law_name: z.string().min(1).max(100), article: z.string().min(1).max(20),
  law_id: z.string().max(10).nullable().optional(),
}, async () => ({ isError: true, content: [{ type: "text", text: ${JSON.stringify(sentinel)} }] }));
await server.connect(new StdioServerTransport());
`;
  const bridge = new TaxDomainClient({ command: process.execPath, args: ["--input-type=module", "-e", childScript] });
  try {
    const status = await bridge.initialize([articleContract]);
    assert.equal(status.state, "ready");
    const result = await bridge.callTool("get_law_article", { law_name: "소득세법", article: "제128조" });
    assert.equal(result.error_code, "TAX_DOMAIN_TOOL_ERROR");
    assert.equal(result.message, "Tax domain tool reported an error.");
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC-LEAK-SENTINEL"));
    assert.ok(!JSON.stringify(result).includes("OC="));
  } finally {
    await bridge.close();
  }
});

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-child.mjs");
const FAKE_TOOL_NAMES = ["ping", "crash", "sleep", "env_check", "fail"];
const FAKE_CONTRACTS = genericContracts(FAKE_TOOL_NAMES);
const fake = async (log, extra = {}, env = { PATH: process.env.PATH }) => {
  const client = new TaxDomainClient({ command: process.execPath, args: log ? [FAKE, log] : [FAKE], ...extra }, env);
  await client.initialize(FAKE_CONTRACTS);
  return client;
};
const logPath = () => join(mkdtempSync(join(tmpdir(), "taxbridge-")), "pids.log");
const pids = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean);

test("reconnects after child crash", async () => {
  const log = logPath();
  const c = await fake(log);
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
  const c = new TaxDomainClient({ command: process.execPath, args: [FAKE, log] });
  await Promise.all([1, 2, 3, 4].map(() => c.initialize(FAKE_CONTRACTS)));
  const rs = await Promise.all([1, 2, 3, 4].map(() => c.callTool("ping", {})));
  assert.equal(new Set(rs.map((r) => r.pid)).size, 1);
  assert.equal(pids(log).length, 1);
  await c.close();
});

test("env allowlist: non-allowlisted vars are not passed, allowlisted are", async () => {
  const offerPath = "/tmp/automation-offer.json";
  const c = await fake(null, {}, {
    PATH: process.env.PATH, FOO_SECRET: "x", HTTPS_PROXY: "http://p:1",
    AGENTLINK_AUTOMATION_OFFER_PATH: offerPath,
  });
  const r = await c.callTool("env_check", {});
  assert.equal(r.has_secret, false);
  assert.equal(r.has_proxy, true);
  assert.equal(r.automation_offer_path, offerPath);
  await c.close();
});

test("child isError -> TAX_DOMAIN_TOOL_ERROR with fixed safe message", async () => {
  const c = await fake(null);
  const r = await c.callTool("fail", {});
  assert.equal(r.error_code, "TAX_DOMAIN_TOOL_ERROR");
  assert.equal(r.schema_version, "tax-bridge-error.v1");
  assert.ok(!JSON.stringify(r).includes("RAW_DOMAIN_SECRET"));
  assert.ok(!JSON.stringify(r).includes("/private"));
  await c.close();
});

test("timeout returns TAX_DOMAIN_TIMEOUT and does not reset the shared child", async () => {
  const log = logPath();
  const c = await fake(log, { timeoutMs: 300 });
  const r0 = await c.callTool("ping", {});
  const t = await c.callTool("sleep", {});
  assert.equal(t.error_code, "TAX_DOMAIN_TIMEOUT");
  const r1 = await c.callTool("ping", {});
  assert.equal(r1.pid, r0.pid);
  assert.equal(pids(log).length, 1);
  await c.close();
});
