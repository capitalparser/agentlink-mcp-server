// Optional installed-package integration. Run after `npm run build` with the
// tax wheel (which carries its canonical registry) installed.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const python = process.env.AGENTLINK_TEST_TAX_PYTHON;
const registry = process.env.AGENTLINK_TEST_TAX_REGISTRY;
const missingPython = !python || !existsSync(python);
const invalidOverride = registry !== undefined && !existsSync(registry);
const required = process.env.AGENTLINK_REQUIRE_TAX_INTEGRATION === "1";
const STDERR_LIMIT = 8 * 1024;

function payment(overrides = {}) {
  return {
    payment_id: "p1",
    income_type: "wage",
    payee_type: "resident",
    payment_date: "2026-03-25",
    gross_amount: 3_000_000,
    withheld_amount: "10000",
    ...overrides,
  };
}

function matter({ approval = false, payments = [payment()], workflowId = "withholding-payment" } = {}) {
  return {
    matter_id: "p0-test",
    workflow_id: workflowId,
    as_of: "2026-04-01",
    taxpayer: { type: "corporation", small_business_semiannual_approval: approval },
    facts: { payments },
  };
}

test("installed tax child completes a withholding roundtrip through upper MCP stdio", {
  timeout: 90_000,
  skip: missingPython && !required && !invalidOverride
    ? "Set AGENTLINK_TEST_TAX_PYTHON to run the installed tax integration."
    : false,
}, async () => {
  assert.ok(python && existsSync(python), "AGENTLINK_TEST_TAX_PYTHON must name an installed tax-wheel interpreter");
  if (registry !== undefined) {
    assert.ok(existsSync(registry), "AGENTLINK_TEST_TAX_REGISTRY was explicitly set but does not exist");
  }
  if (required) {
    assert.equal(process.env.PYTHONPATH, undefined, "installed mode must not receive a source PYTHONPATH");
    assert.equal(process.env.PYTHONHOME, undefined, "installed mode must not receive a Python home override");
  }

  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const serverPath = join(root, "dist", "index.js");
  assert.ok(existsSync(serverPath), "build the upper MCP server before running this integration");

  const scratch = mkdtempSync(join(tmpdir(), "agentlink-tax-only-integration-"));
  const childEnv = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    TMPDIR: scratch,
    AGENTLINK_TAX_MCP_COMMAND: python,
    AGENTLINK_TAX_MCP_ARGS: JSON.stringify(["-I", "-B", "-m", "agentlink_tax.server"]),
    AGENTLINK_CREDENTIALS_PATH: join(scratch, "intentionally-missing-credentials.json"),
  };
  if (registry !== undefined) childEnv.AGENTLINK_TAX_REGISTRY = registry;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: scratch,
    stderr: "pipe",
    env: childEnv,
  });
  const client = new Client({ name: "agentlink-tax-real-integration", version: "0.1.0" });
  let upperStderr = "";
  transport.stderr?.on("data", (chunk) => {
    if (upperStderr.length < STDERR_LIMIT) {
      upperStderr += String(chunk).slice(0, STDERR_LIMIT - upperStderr.length);
    }
  });

  let passed = false;
  try {
    await client.connect(transport);

    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true, `${name} returned an MCP error: ${JSON.stringify(response)}`);
      assert.ok(response.structuredContent && typeof response.structuredContent === "object",
        `${name} must preserve structuredContent`);
      const text = response.content?.find((item) => item.type === "text")?.text;
      assert.equal(typeof text, "string", `${name} must preserve its text result`);
      assert.deepEqual(JSON.parse(text), response.structuredContent,
        `${name} text and structuredContent should carry the same domain result`);
      return response.structuredContent;
    };

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const taxNames = names.filter((name) => name.startsWith("tax_"));
    const bridgeStatus = await call("agentlink_bridge_status");
    assert.equal(taxNames.length, 19,
      `all mapped tax tools should be exposed after real child discovery; status=${JSON.stringify(bridgeStatus)}; tools=${names.join(",")}`);
    for (const name of ["tax_list_workflows", "tax_get_workflow_contract", "tax_plan_work"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    assert.ok(names.includes("agentlink_bridge_status"), "the bridge status tool should remain available");
    assert.ok(names.every((name) => name === "agentlink_bridge_status" || name.startsWith("tax_")),
      "default startup should expose only verified tax tools and bridge status");
    assert.ok(!names.some((name) => name.startsWith("subsidy_")), "the optional subsidy domain must stay absent");

    const plan = (taxMatter) => call("tax_plan_work", { matter: taxMatter, include_evidence: false });

    const workflowList = await call("tax_list_workflows");
    assert.equal(workflowList.domain, "tax");
    assert.equal(workflowList.workflows.length, 9);
    assert.deepEqual(workflowList.workflows.filter((item) => item.status === "implemented").map((item) => item.id),
      ["withholding-payment"]);
    const contractOnly = workflowList.workflows.filter((item) => item.status === "contract_only");
    assert.equal(contractOnly.length, 8);
    assert.ok(contractOnly.some((item) => item.id === "vat-return"), "VAT remains contract-only");

    const contract = await call("tax_get_workflow_contract", { workflow_id: "withholding-payment" });
    assert.equal(contract.id, "withholding-payment");
    assert.equal(contract.status, "implemented");
    const paymentRef = contract.facts_schema?.properties?.payments?.items?.$ref;
    assert.match(paymentRef ?? "", /^#\/\$defs\//,
      "the upper bridge should preserve the native payment schema reference");
    const paymentSchemaName = paymentRef.slice("#/$defs/".length);
    const paymentProperties = contract.facts_schema?.$defs?.[paymentSchemaName]?.properties;
    assert.ok(paymentProperties, "the upper bridge should preserve the native Payment definition");
    assert.deepEqual([...(paymentProperties.withholding_profile?.enum ?? [])].sort(), [
      "business_lecture", "business_personal_service", "other_lecture", "unknown",
    ], "the upper contract should preserve the bounded payment-profile enum");
    assert.deepEqual([...(paymentProperties.service_subtype?.enum ?? [])].sort(), [
      "artwork_design", "authorship", "composition", "entertainment_direction", "entertainment_filming",
      "illustration", "proofreading", "shorthand", "translation", "unknown", "unsupported", "voice_acting",
    ], "the upper contract should preserve the strict personal-service subtype enum");

    const practiceCards = await call("tax_list_practice_cards", { workflow_id: "withholding-payment" });
    assert.equal(practiceCards.workflow_id, "withholding-payment");
    assert.equal(practiceCards.authority, "practice");
    assert.equal(practiceCards.verification_status, "practice_signal_unverified");
    assert.ok(Array.isArray(practiceCards.cards));

    const formTips = await call("tax_get_form_field_tips", { form_id: "wh-payment-report", code: "A25" });
    assert.ok(JSON.stringify(formTips).includes("A25"));
    const formGuides = await call("tax_list_form_guides");
    assert.equal(formGuides.status, "ok");
    assert.ok(Array.isArray(formGuides.guides));

    const missingFacts = await plan({
      matter_id: "p0-test",
      workflow_id: "withholding-payment",
      as_of: "2026-04-01",
      facts: { payments: [] },
    });
    assert.equal(missingFacts.status, "needs_facts");
    assert.ok(missingFacts.questions.length > 0);
    assert.ok(missingFacts.questions.some((question) => question.fact_key === "payments"));

    const completed = await plan(matter());
    assert.equal(completed.status, "draft_ready");
    assert.equal(completed.applicability, "not_determined");
    assert.equal(completed.calculation_status, "not_determined");
    assert.equal(completed.withholding_calculations.length, 1);
    assert.equal(completed.withholding_calculations[0].status, "unsupported",
      "a wage payment with no lecture profile remains outside the calculation scope");
    for (const field of ["expense_rate", "expense_amount", "income_amount", "tax_base", "national_rate",
      "national_tax", "local_rate", "local_tax", "total_withholding", "net_payment"]) {
      assert.equal(completed.withholding_calculations[0][field], null,
        `unsupported wage payments must not contain a calculated ${field}`);
    }
    const dueActions = completed.next_actions.filter((action) => action.due_date);
    assert.equal(dueActions.length, 1);
    assert.equal(dueActions[0].due_date, "2026-04-10");
    assert.equal(dueActions[0].due_basis, "WH-PAY-MONTHLY");
    assert.equal(dueActions[0].deadline_status, "candidate_unverified");
    assert.match(dueActions[0].holiday_adjustment, /weekend_and_statutory_may1_fallback/);
    assert.match(dueActions[0].holiday_adjustment, /public\/substitute holidays not applied/);
    assert.ok(completed.unresolved.some((item) => item.code === "HOLIDAY_DATA_UNAVAILABLE"),
      "the unavailable holiday-provider warning should survive the bridge");
    assert.ok(Array.isArray(completed.filling_guide) && completed.filling_guide.length > 0,
      "the default filling guide should remain enabled");
    assert.ok(Array.isArray(completed.sources) && completed.sources.length > 0);
    assert.ok(completed.sources.every((source) => source.verification_status !== "verified"));
    assert.ok(Array.isArray(completed.why) && completed.why.length > 0);
    assert.ok(completed.why.some((item) => item.verification_status === "text_checked"));
    assert.ok(completed.why.every((item) => ["text_checked", "unverified_seed"].includes(item.verification_status)));
    assert.ok(completed.confirmed_facts.every((fact) => fact.verification === "user_supplied_unverified"));
    assert.deepEqual(completed.evidence_candidates, [], "include_evidence=false should avoid external evidence lookup");

    const practitionerAnswer = await call("tax_answer_practitioner_question", { matter: matter() });
    assert.equal(practitionerAnswer.schema_version, "practitioner-answer.v1");
    assert.equal(practitionerAnswer.final_decision, "not_issued");

    const missingWithheldAmount = await plan(matter({ payments: [payment({ withheld_amount: null })] }));
    assert.equal(missingWithheldAmount.status, "needs_facts");
    assert.ok(missingWithheldAmount.questions.some((question) => question.fact_key === "payments[p1].withheld_amount"));
    const paymentFacts = missingWithheldAmount.confirmed_facts.find((fact) => fact.key === "payments");
    assert.equal(paymentFacts.value[0].withheld_amount, null);
    assert.equal(missingWithheldAmount.withholding_calculations[0].status, "unsupported");
    assert.equal(missingWithheldAmount.withholding_calculations[0].national_tax, null,
      "legacy wage rows must not receive lecture calculation amounts");

    const unknownApproval = await plan(matter({ approval: null }));
    assert.equal(unknownApproval.status, "needs_facts");
    assert.ok(unknownApproval.questions.some((question) =>
      question.fact_key === "taxpayer.small_business_semiannual_approval"));
    assert.ok(!unknownApproval.next_actions.some((action) => action.due_date),
      "no due-date candidate should be offered until the approval fact is known");

    const nonresident = await plan(matter({ payments: [payment({ payee_type: "nonresident" })] }));
    assert.equal(nonresident.status, "blocked");
    assert.ok(nonresident.unresolved.some((item) => item.code === "NONRESIDENT_PAYMENT_REVIEW"));
    assert.ok(!nonresident.next_actions.some((action) => action.due_date));

    for (const workflow of contractOnly) {
      const result = await plan({
        matter_id: "p0-test",
        workflow_id: workflow.id,
        as_of: "2026-04-01",
      });
      assert.equal(result.status, "contract_only", `${workflow.id} should remain intake-only`);
      assert.ok(result.unresolved.some((item) => item.code === "WORKFLOW_NOT_IMPLEMENTED"));
      assert.deepEqual(result.why, []);
      assert.deepEqual(result.next_actions, []);
    }

    const unknownWorkflow = await plan({
      matter_id: "p0-test",
      workflow_id: "p0-unknown-workflow",
      as_of: "2026-04-01",
    });
    assert.equal(unknownWorkflow.status, "invalid_input");
    passed = true;
  } catch (error) {
    const stderrPath = join(scratch, "upper.stderr.log");
    writeFileSync(stderrPath, upperStderr || "<no upper-server stderr captured>\n", "utf8");
    if (error instanceof Error) {
      error.message = `${error.message}\nBounded upper-server stderr saved locally at ${stderrPath}`;
    }
    throw error;
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    if (passed) rmSync(scratch, { recursive: true, force: true });
  }
});
