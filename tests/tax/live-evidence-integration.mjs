// Required live acceptance for a fresh tax wheel installed beside the upper stdio MCP server.
// This file intentionally has no skip or mock path; the coordinator runs it once after build/install.
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OVERRIDE_KEYS = [
  "PYTHONPATH", "PYTHONHOME", "AGENTLINK_TEST_TAX_REGISTRY", "AGENTLINK_TAX_REGISTRY",
  "AGENTLINK_TAX_MCP_PYTHONPATH",
];
const ENV_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
  "AGENTLINK_CREDENTIALS_PATH",
];
const python = process.env.AGENTLINK_TEST_TAX_PYTHON;
const taskTemp = process.env.TMPDIR;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = join(root, "dist", "index.js");

class AcceptanceFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "AcceptanceFailure";
    this.stack = `AcceptanceFailure: ${message}`;
  }
}

function must(condition, message) {
  if (!condition) throw new AcceptanceFailure(message);
}

function same(actual, expected, message) {
  must(actual === expected, message);
}

function equivalent(actual, expected, message) {
  let equal = false;
  try { equal = JSON.stringify(actual) === JSON.stringify(expected); } catch { /* handled below */ }
  must(equal, message);
}

function kstDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

const CALCULATION_VALUE_FIELDS = [
  "expense_rate", "expense_amount", "income_amount", "tax_base", "national_rate", "national_tax",
  "local_rate", "local_tax", "total_withholding", "net_payment",
];

function assertNoCalculatedAmounts(result, paymentIds, message) {
  must(Array.isArray(result.withholding_calculations), `${message}: calculation rows are missing`);
  for (const paymentId of paymentIds) {
    const row = result.withholding_calculations.find((item) => item.payment_id === paymentId);
    must(row && row.status !== "computed", `${message}: ${paymentId} must not be computed`);
    for (const field of CALCULATION_VALUE_FIELDS) {
      same(row[field], null, `${message}: ${paymentId}.${field} must be null`);
    }
  }
}

function assertNoComputedTaxAssessments(answer, message) {
  const calculations = (answer.assessments ?? []).filter((assessment) =>
    /^tax\.wh-calc-(?:business|other|local)$/u.test(assessment.card_id ?? ""));
  must(calculations.every((assessment) => assessment.outcome !== "computed_value"),
    `${message}: practitioner output must not contain computed tax assessments`);
}

function assertTypedPaymentAssessments(answer, expected) {
  const matching = (answer.assessments ?? []).filter((assessment) => assessment.case_label === expected.paymentId);
  same(matching.length, 3, `${expected.paymentId} must have national, local, and applicability assessments`);
  const mainCard = expected.profile === "business_lecture" ? "tax.wh-calc-business" : "tax.wh-calc-other";
  const national = matching.find((assessment) => assessment.card_id === mainCard &&
    assessment.outcome === "computed_value");
  const local = matching.find((assessment) => assessment.card_id === "tax.wh-calc-local" &&
    assessment.outcome === "computed_value");
  const comparison = matching.find((assessment) => assessment.card_id === mainCard &&
    assessment.outcome === expected.comparisonOutcome);
  must(national && local && comparison, `${expected.paymentId} must expose typed national/local/comparison results`);
  for (const [assessment, value, expression] of [
    [national, expected.national, expected.nationalExpression],
    [local, expected.local, expected.localExpression],
  ]) {
    same(assessment.computed?.value, value, `${expected.paymentId} computed assessment must expose the exact won amount`);
    same(assessment.computed?.unit, "won", `${expected.paymentId} computed assessment must use won units`);
    same(assessment.computed?.currency, "KRW", `${expected.paymentId} computed assessment must use KRW currency`);
    must(typeof assessment.computed?.expression === "string" && assessment.computed.expression.length > 0,
      `${expected.paymentId} computed assessment must explain its expression`);
    const expressionMatches = expression instanceof RegExp
      ? expression.test(assessment.computed.expression)
      : assessment.computed.expression === expression;
    must(expressionMatches,
      `${expected.paymentId} computed assessment must expose the expected calculation operands and rule`);
    same(assessment.reliance, "do_not_rely_verify_source", `${expected.paymentId} must remain pending source review`);
    must(assessment.notices.includes("review=pending") &&
      assessment.notices.includes("comparison_basis=national_tax_only") &&
      assessment.notices.includes("local_tax_excluded_from_actual_comparison") &&
      assessment.notices.includes(`actual_withheld_comparison=${expected.comparisonStatus}`),
    `${expected.paymentId} computed assessment must retain review and comparison limits`);
  }
  same(comparison.card_id, mainCard, `${expected.paymentId} applicability comparison must use its profile card`);
  same(comparison.outcome, expected.comparisonOutcome,
    `${expected.paymentId} applicability comparison must reflect its payment-level result`);
  same(Object.keys(comparison.computed ?? {}).length, 0,
    `${expected.paymentId} applicability comparison must not add a third numeric tax value`);
  same(comparison.reliance, "do_not_rely_verify_source", `${expected.paymentId} comparison must remain pending review`);
  must(comparison.notices.includes(`profile=${expected.profile}`) && comparison.notices.includes("review=pending"),
    `${expected.paymentId} comparison must identify its profile and pending review state`);
}

function decodedCalculationSection(answer, paymentId, profile) {
  const mainCard = profile === "business_lecture" ? "tax.wh-calc-business" : "tax.wh-calc-other";
  const rows = answer.perspective_view?.sections?.withholding_calculations ?? [];
  const matching = rows.filter((item) => item.card_id === mainCard && typeof item.text === "string" &&
    item.text.split(/\r?\n/u).includes(`지급 ID: ${paymentId}`));
  same(matching.length, 1, `${paymentId} must have one practitioner calculation section`);
  return matching[0];
}

function assertPractitionerCalculationSection(answer, expected) {
  const entry = decodedCalculationSection(answer, expected.paymentId, expected.profile);
  const lines = entry.text.split(/\r?\n/u);
  const includes = (line) => must(lines.includes(line),
    `${expected.paymentId} practitioner calculation section must include ${line.split(":")[0]}`);
  same(entry.card_id, expected.profile === "business_lecture" ? "tax.wh-calc-business" : "tax.wh-calc-other",
    `${expected.paymentId} practitioner calculation section must use the profile card`);
  includes(`프로필: ${expected.profile}`);
  includes(`행 상태: computed; 적용성: ${expected.applicability}`);
  includes(`총수입금액: ${expected.values.gross_amount}원`);
  if (expected.values.expense_rate !== null && expected.values.expense_rate !== undefined) {
    includes(`표준 필요경비: ${expected.values.gross_amount} × ${expected.values.expense_rate} = ${expected.values.expense_amount}원`);
    includes(`소득금액: ${expected.values.gross_amount} − ${expected.values.expense_amount} = ${expected.values.income_amount}원`);
    includes(`과세표준(1원 미만 절사): ${expected.values.tax_base}원`);
  } else {
    includes(`사업소득금액: ${expected.values.income_amount}원`);
    includes(`과세표준: ${expected.values.tax_base}원`);
  }
  includes(`국세율: ${expected.nationalRate}; 국세: ${expected.formula}`);
  includes(`국세 원천징수 후보: ${expected.national}원`);
  includes(`지방소득세율: ${expected.localRate}; 지방소득세: 10원 단위 절사(${expected.national} × ${expected.localRate}) = ${expected.local}원`);
  includes(`총 원천징수 후보: ${expected.national} + ${expected.local} = ${expected.total}원`);
  includes(`순지급액: ${expected.values.gross_amount} − ${expected.total} = ${expected.net}원`);
  includes(`실제 징수액 대조(국세만, 지방소득세 제외): ${expected.comparisonStatus}; 사용자 입력 실제 징수액: ${expected.actualWithheld}`);
  must(lines.some((line) => line.startsWith("반올림·절사 정책: ")),
    `${expected.paymentId} practitioner calculation section must retain rounding policy`);
}

function assertPractitionerBasisProjection(answer, planResult) {
  const projected = answer.perspective_view?.sections?.withholding_basis_checks ?? [];
  const expectedMarkers = [];
  for (const row of planResult.withholding_calculations.filter((item) => item.status === "computed")) {
    for (const check of row.basis_checks) {
      const cardId = `tax.${check.rule_id.toLowerCase()}`;
      const instrumentId = INSTRUMENT_BY_LAW_ID[check.law_id];
      must(instrumentId, `Practitioner basis projection received an unpinned legal instrument for ${check.rule_id}`);
      const prefix = `지급 ID: ${row.payment_id}; 규칙: ${check.rule_id}; 법령 instrument ID: ${instrumentId}; 법령 ID: ${check.law_id}; 조문: ${check.article}; 정확한 위치: ${check.locator}; 상태: ${check.status};`;
      must(projected.filter((item) => item.card_id === cardId && typeof item.text === "string" &&
        item.text.startsWith(prefix)).length === 1,
      `Practitioner basis section must preserve ${check.rule_id} ${check.article} ${check.locator}`);
      expectedMarkers.push(prefix);
    }
  }
  same(projected.length, expectedMarkers.length,
    "Practitioner basis cards must not omit or add source clauses beyond the computed payments");
}

function assertComputedRow(result, paymentId, expected) {
  const row = result.withholding_calculations?.find((item) => item.payment_id === paymentId);
  must(row, `Calculation row is missing for ${paymentId}`);
  same(row.profile, expected.profile, `${paymentId} must retain its selected profile`);
  same(row.status, "computed", `${paymentId} must have a calculation result`);
  same(row.applicability_status, expected.applicability, `${paymentId} applicability must match the expected scope`);
  for (const [field, value] of Object.entries(expected.values)) {
    same(row[field], value, `${paymentId}.${field} must match the independent expected result`);
  }
  must(typeof row.formula === "string" && row.formula.length > 0, `${paymentId} must explain its formula`);
  same(row.rounding, "truncate_national_tax_to_10_won_then_local_tax_to_10_won",
    `${paymentId} must report the two-stage won truncation convention`);
  same(row.fact_verification, "user_supplied_unverified", `${paymentId} facts must remain unverified`);
  same(row.review, "pending", `${paymentId} must remain pending review`);
  must(Array.isArray(row.basis_checks) && row.basis_checks.length > 0, `${paymentId} must include calculation basis checks`);
  return row;
}

const SHARED_REQUIRED_BASIS = [
  { rule_id: "WH-CALC-NATIONAL-ROUND", law_id: "009409", article: "제47조",
    locator: "제47조 제1항·제2항", semantics: [
      { locator: "제47조 제1항", pattern: /(?=.*국고금의\s*수입\s*또는\s*지출)(?=.*10\s*원\s*미만의\s*끝수가.*그\s*끝수는\s*계산하지\s*아니하고)(?=.*전액이\s*10\s*원\s*미만.*전액을\s*계산하지\s*아니한다)(?=.*대통령령으로\s*정하는\s*경우)/u },
      { locator: "제47조 제2항", pattern: /국세의\s*과세표준액을\s*산정할\s*때.*1\s*원\s*미만의\s*끝수가\s*있으면\s*이를\s*계산하지\s*아니한다/u },
    ] },
  { rule_id: "WH-CALC-NATIONAL-ROUND-EXCEPTION", law_id: "009450", article: "제109조의2",
    locator: "제109조의2 제1항", semantics: [{ locator: "제109조의2 제1항", pattern: /법\s*제47조제1항\s*단서에서.*국고금을\s*분할하여\s*징수\s*또는\s*수납하거나\s*지급할\s*때.*분할금액\s*또는\s*끝수를.*최초의\s*수입금\s*또는\s*지급금에\s*합산/u }] },
  { rule_id: "WH-CALC-LOCAL", law_id: "001649", article: "제103조의13",
    locator: "제103조의13 제1항·제4항", semantics: [
      { locator: "제103조의13 제1항", pattern: /원천징수의무자가\s*거주자로부터\s*소득세를\s*원천징수.*원천징수하는\s*소득세.*100\s*분의\s*10.*소득세\s*원천징수와\s*동시에\s*개인지방소득세로\s*특별징수하여야/u },
      { locator: "제103조의13 제4항", pattern: /개인지방소득세의\s*특별징수에\s*관하여.*이\s*법에\s*특별한\s*규정이\s*있는\s*경우를\s*제외하고는.*(?:「)?소득세법(?:」)?에\s*따른\s*원천징수에\s*관한\s*규정을\s*준용/u },
    ] },
  { rule_id: "WH-CALC-LOCAL-ROUND", law_id: "012559", article: "제55조",
    locator: "제55조", semantics: [{ locator: "제55조", pattern: /지방자치단체의\s*수입\s*또는\s*지출에서\s*10\s*원\s*미만은\s*계산하지\s*아니할\s*수.*전액이\s*10\s*원\s*미만이면\s*0으로\s*처리할\s*수.*세입금을\s*분할하여\s*징수/u }] },
  { rule_id: "WH-CALC-LOCAL-ROUND-EXCEPTION", law_id: "012678", article: "제67조",
    locator: "제67조", semantics: [{ locator: "제67조", pattern: /법\s*제55조\s*단서에서.*세입금을\s*분할하여\s*징수.*분할금액\s*또는\s*끝수를.*최초의\s*수입금\s*또는\s*지급금에\s*합산/u }] },
];

const BUSINESS_REQUIRED_BASIS = [
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제19조", locator: "제19조 제1항 제21호",
    semantics: [{ locator: "제19조 제1항 제21호", pattern: /(?=.*영리를\s*목적으로)(?=.*자기의\s*계산과\s*책임\s*하에)(?=.*계속적[ㆍ·]?\s*반복적으로\s*행하는\s*활동)/u }] },
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제127조", locator: "제127조 제1항 제3호·제6호",
    semantics: [
      { locator: "제127조 제1항 제3호", pattern: /대통령령으로\s*정하는\s*사업소득.*원천징수대상\s*사업소득/u },
      { locator: "제127조 제1항 제6호", pattern: /기타소득.*다음\s*각\s*목의\s*어느\s*하나에\s*해당하는\s*소득은\s*제외/u },
    ] },
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제129조", locator: "제129조 제1항 제3호·제6호 라목",
    semantics: [
      { locator: "제129조 제1항 제3호", pattern: /원천징수대상\s*사업소득에\s*대해서는\s*100\s*분의\s*3/u },
      { locator: "제129조 제1항 제6호 라목", pattern: /그\s*밖의\s*기타소득에\s*대해서는\s*100\s*분의\s*20/u },
    ] },
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제144조", locator: "제144조 제1항",
    semantics: [{ locator: "제144조 제1항", pattern: /원천징수의무자가\s*원천징수대상\s*사업소득을\s*지급할\s*때.*지급금액에\s*원천징수세율을\s*적용하여\s*계산한\s*소득세를\s*원천징수/u }] },
  { rule_id: "WH-CALC-BUSINESS", law_id: "001565", article: "제86조", locator: "제86조 제1호",
    semantics: [{ locator: "제86조 제1호", pattern: /(?=.*제127조제1항\s*각\s*호의\s*소득)(?=.*제3호의\s*원천징수대상\s*사업소득\s*중\s*대통령령으로\s*정하는\s*사업소득은\s*제외한다)(?=.*원천징수세액이\s*1천원\s*미만인\s*경우)/u }] },
  { rule_id: "WH-CALC-BUSINESS-SCOPE", law_id: "003956", article: "제184조", locator: "제184조 제1항·제3항",
    semantics: [
      { locator: "제184조 제1항", pattern: /법\s*제127조제1항제3호에서.*대통령령으로\s*정하는\s*사업소득["”]?\s*이란.*제26조제1항제5호\s*및\s*제15호에\s*따른\s*용역의\s*공급에서\s*발생하는\s*소득/u },
      { locator: "제184조 제3항", pattern: /(?=.*소득세를\s*원천징수하여야\s*할\s*자는)(?=.*사업자)(?=.*법인세의\s*납세의무자)/u },
    ] },
  { rule_id: "WH-CALC-BUSINESS-SCOPE", law_id: "003956", article: "제149조의3", locator: "제149조의3",
    semantics: [{ locator: "제149조의3", pattern: /(?=.*법\s*제86조제1호에서)(?=.*대통령령으로\s*정하는\s*사업소득["”]?\s*이란)(?=.*제26조제1항제15호에\s*따른\s*인적\s*용역을)(?=.*계속적[ㆍ·]?\s*반복적으로\s*공급하고)(?=.*그\s*대가로\s*받은\s*소득)/u }] },
  { rule_id: "WH-CALC-BUSINESS-VAT", law_id: "001571", article: "제26조", locator: "제26조 제1항 제15호",
    semantics: [{ locator: "제26조 제1항 제15호", pattern: /저술가.*작곡가나\s*그\s*밖의\s*자가\s*직업상\s*제공하는\s*인적\s*\(\s*人的\s*\)\s*용역으로서\s*대통령령으로\s*정하는\s*것/u }] },
  { rule_id: "WH-CALC-BUSINESS-SERVICE", law_id: "003666", article: "제42조",
    locator: "제42조 제1호 본문 및 제1호 차목", semantics: [
      { locator: "제42조 제1호 본문", pattern: /(?=.*개인이)(?=.*물적\s*시설\s*없이)(?=.*근로자를\s*고용.*하지\s*아니하고)(?=.*고용\s*외의\s*형태.*주된\s*업무.*타인으로부터\s*노무\s*등을\s*제공받는\s*경우를\s*포함)(?=.*독립된\s*자격으로\s*용역을\s*공급하고\s*대가를\s*받는)/u },
      { locator: "제42조 제1호 차목", pattern: /고용관계\s*없는\s*사람이\s*다수인에게\s*강연을\s*하고\s*강연료.*대가를\s*받는\s*용역/u },
    ] },
  { rule_id: "WH-CALC-BUSINESS-FACILITIES", law_id: "007289", article: "제29조", locator: "제29조",
    semantics: [{ locator: "제29조", pattern: /영\s*제42조제1호에서.*물적\s*시설.*이란.*계속적[ㆍ·]?\s*반복적으로\s*사업에만\s*이용되는.*건축물.*기계장치.*사업설비/u }] },
  ...SHARED_REQUIRED_BASIS,
];

const OTHER_REQUIRED_BASIS = [
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제21조", locator: "제21조 제1항 제19호 가목·제3항",
    semantics: [
      { locator: "제21조 제1항 제19호 가목", pattern: /고용관계\s*없이\s*다수인에게\s*강연을\s*하고\s*강연료.*대가를\s*받는\s*용역/u },
      { locator: "제21조 제3항", pattern: /기타소득금액은\s*해당\s*과세기간의\s*총수입금액에서\s*이에\s*사용된\s*필요경비를\s*공제한\s*금액/u },
    ] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제127조", locator: "제127조 제1항 제3호·제6호",
    semantics: [
      { locator: "제127조 제1항 제3호", pattern: /대통령령으로\s*정하는\s*사업소득.*원천징수대상\s*사업소득/u },
      { locator: "제127조 제1항 제6호", pattern: /기타소득.*다음\s*각\s*목의\s*어느\s*하나에\s*해당하는\s*소득은\s*제외/u },
    ] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제129조", locator: "제129조 제1항 제3호·제6호 라목",
    semantics: [
      { locator: "제129조 제1항 제3호", pattern: /원천징수대상\s*사업소득에\s*대해서는\s*100\s*분의\s*3/u },
      { locator: "제129조 제1항 제6호 라목", pattern: /그\s*밖의\s*기타소득에\s*대해서는\s*100\s*분의\s*20/u },
    ] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제145조", locator: "제145조 제1항",
    semantics: [{ locator: "제145조 제1항", pattern: /원천징수의무자가\s*기타소득을\s*지급할\s*때.*기타소득금액에\s*원천징수세율을\s*적용하여\s*계산한\s*소득세를\s*원천징수/u }] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제84조", locator: "제84조 제4호",
    semantics: [{ locator: "제84조 제4호", pattern: /그\s*밖의\s*기타소득금액.*제21조제1항제21호의\s*기타소득금액은\s*제외.*건별로\s*5만원\s*이하인\s*경우/u }] },
  { rule_id: "WH-CALC-OTHER", law_id: "001565", article: "제37조", locator: "제37조 제2항",
    semantics: [{ locator: "제37조 제2항", pattern: /총수입금액에\s*대응하는\s*비용으로서\s*일반적으로\s*용인되는\s*통상적인\s*것의\s*합계액을\s*필요경비에\s*산입/u }] },
  { rule_id: "WH-CALC-OTHER-EXPENSE", law_id: "003956", article: "제87조", locator: "제87조 제1호의2",
    semantics: [{ locator: "제87조 제1호의2", pattern: /(?=.*법\s*제21조제1항.*제19호의\s*기타소득)(?=.*거주자가\s*받은\s*금액의\s*100\s*분의\s*60.*필요경비)(?=.*실제\s*소요된\s*필요경비.*100\s*분의\s*60.*초과.*그\s*초과하는\s*금액도\s*필요경비에\s*산입)/u }] },
  ...SHARED_REQUIRED_BASIS,
];

const INSTRUMENT_BY_LAW_ID = {
  "001565": "income-tax-act",
  "003956": "income-tax-decree",
  "001571": "vat-act",
  "003666": "vat-decree",
  "007289": "vat-rule",
  "009409": "national-funds-act",
  "009450": "national-funds-decree",
  "001649": "local-tax-act",
  "012559": "local-accounting-act",
  "012678": "local-accounting-decree",
};

function specsForProfile(profile) {
  if (profile === "business_lecture") return BUSINESS_REQUIRED_BASIS;
  if (profile === "other_lecture") return OTHER_REQUIRED_BASIS;
  throw new AcceptanceFailure("A supported lecture profile is required for a basis assertion");
}

function basisKey(row) {
  return [row.rule_id, row.law_id, row.article, row.locator].join("|");
}

const CIRCLED_NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
  "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
const KOREAN_SUBITEMS = "가나다라마바사아자차카타파하";

function segmentFromMarker(text, markerIndex, markerLength, nextMarkerPattern) {
  let end = text.length;
  if (nextMarkerPattern) {
    nextMarkerPattern.lastIndex = markerIndex + markerLength;
    const next = nextMarkerPattern.exec(text);
    if (next) end = next.index;
  }
  return text.slice(markerIndex, end).trim();
}

function paragraphSegment(text, number) {
  const circled = CIRCLED_NUMBERS[number - 1];
  if (circled) {
    const index = text.indexOf(circled);
    if (index >= 0) return segmentFromMarker(text, index, circled.length, /[①-⑳]/gu);
  }
  const marker = new RegExp(`제\\s*${number}\\s*항`, "u");
  const match = marker.exec(text);
  if (!match) return "";
  return segmentFromMarker(text, match.index, match[0].length, /제\s*\d+\s*항/gu);
}

function itemSegment(text, number) {
  const match = String(number).match(/^(\d+)(?:의(\d+))?$/u);
  if (!match) return "";
  const [, major, minor] = match;
  const linePrefix = "(?:^|\\r?\\n)[\\t ]*";
  const digitPattern = minor
    ? new RegExp(`${linePrefix}(${major}\\s*의\\s*${minor}\\s*[.)])`, "gu")
    : new RegExp(`${linePrefix}(${major}\\s*[.)])`, "gu");
  const explicitPattern = minor
    ? new RegExp(`${linePrefix}(제\\s*${major}\\s*호\\s*의\\s*${minor})(?=\\s|$)`, "gu")
    : new RegExp(`${linePrefix}(제\\s*${major}\\s*호)(?=\\s|$)`, "gu");
  const candidates = [digitPattern, explicitPattern];
  let found;
  for (const pattern of candidates) {
    found = pattern.exec(text);
    if (found) break;
  }
  if (!found) return "";
  const markerText = found[1];
  const start = found.index + found[0].length - markerText.length;
  const nextPattern = /(?:^|\r?\n)[\t ]*(?:\d+(?:\s*의\s*\d+)?\s*[.)]|제\s*\d+\s*호(?:\s*의\s*\d+)?(?=\s|$))/gu;
  return segmentFromMarker(text, start, markerText.length, nextPattern);
}

function subitemSegment(text, letter) {
  const marker = new RegExp(`(?:^|\\r?\\n)[\\t ]*((?:${letter}\\s*[.)]|${letter}목(?=\\s|$)))`, "gu");
  const match = marker.exec(text);
  if (!match) return "";
  const markerText = match[1];
  const start = match.index + match[0].length - markerText.length;
  const letterIndex = KOREAN_SUBITEMS.indexOf(letter);
  const nextLetters = letterIndex >= 0 ? KOREAN_SUBITEMS.slice(letterIndex + 1) : "";
  const nextPattern = nextLetters.length
    ? new RegExp(`(?:^|\\r?\\n)[\\t ]*(?:[${nextLetters}]\\s*[.)]|[${nextLetters}]목(?=\\s|$))`, "gu")
    : null;
  return segmentFromMarker(text, start, markerText.length, nextPattern);
}

function locatorSegments(text, locator) {
  const body = locator.replace(/^제\d+조(?:의\d+)?\s*/u, "");
  if (!body.trim()) return text.trim() ? [text.trim()] : [];
  const parts = body.split(/\s*[·,]\s*|\s+및\s+/u).filter(Boolean);
  let inheritedParagraph;
  const segments = [];
  for (const part of parts) {
    const paragraphMatch = part.match(/제(\d+)항/u);
    if (paragraphMatch) inheritedParagraph = Number(paragraphMatch[1]);
    let segment = inheritedParagraph === undefined ? text : paragraphSegment(text, inheritedParagraph);
    if (!segment) return [];
    const itemNumbers = [...part.matchAll(/제(\d+)호(?:의(\d+))?/gu)]
      .map((match) => `${match[1]}${match[2] ? `의${match[2]}` : ""}`);
    if (/본문/u.test(part)) {
      if (itemNumbers.length > 0) {
        for (const number of itemNumbers) {
          segment = itemSegment(segment, number);
          if (!segment) return [];
        }
        const firstSubitem = new RegExp(`(?:^|\\r?\\n)[\\t ]*[${KOREAN_SUBITEMS}](?:[\\t ]*[.)]|목(?=\\s|$))`, "u").exec(segment);
        if (firstSubitem) segment = segment.slice(0, firstSubitem.index).trim();
      } else {
        const firstItem = /(?:^|\r?\n)[\t ]*(?:\d+(?:\s*의\s*\d+)?\s*[.)]|제\s*\d+\s*호)/u.exec(segment);
        if (firstItem) segment = segment.slice(0, firstItem.index).trim();
      }
    } else {
      for (const number of itemNumbers) {
        segment = itemSegment(segment, number);
        if (!segment) return [];
      }
      const subitems = [...part.matchAll(/([가-힣])목/gu)].map((match) => match[1]);
      for (const letter of subitems) {
        segment = subitemSegment(segment, letter);
        if (!segment) return [];
      }
    }
    if (segment.trim()) segments.push(segment.trim());
  }
  return segments;
}

function assertClauseSemantics(documentText, spec) {
  must(Array.isArray(spec.semantics) && spec.semantics.length > 0,
    `Expected basis clause ${spec.locator} is missing semantic assertions`);
  for (const semantic of spec.semantics) {
    const segments = locatorSegments(documentText, semantic.locator);
    must(segments.length > 0 && segments.every((segment) => segment.length > 0),
      `Fetched law text must expose the exact clause ${semantic.locator}`);
    const clauseText = segments.join(" ").replace(/\s+/gu, " ");
    must(semantic.pattern.test(clauseText),
      `Fetched law text for ${semantic.locator} must support its pinned withholding role`);
  }
}

test("clause locator parser isolates statutory paragraphs, items, and subitems", () => {
  const incomeRateArticle = "①\n3. 원천징수대상 사업소득에 대해서는 100분의 3. 다만, 외국인 직업운동가 소득은 100분의 20으로 한다.\n6. 기타소득에 대해서는 다음 각 목에 따른다.\n가. 외국인 직업운동가의 해당 사업소득에 대해서는 100분의 20으로 한다.\n라. 그 밖의 기타소득에 대해서는 100분의 20으로 한다.\n마. 다른 소득은 별도 세율로 한다.\n②\n3. 별도 조항이다.";
  const businessRate = locatorSegments(incomeRateArticle, "제129조 제1항 제3호").join(" ");
  const otherIncomeRate = locatorSegments(incomeRateArticle, "제129조 제1항 제6호 라목").join(" ");
  must(/100\s*분의\s*3/u.test(businessRate), "The business rate locator must select item 3");
  must(/그\s*밖의\s*기타소득.*100\s*분의\s*20/u.test(otherIncomeRate) &&
    !/외국인\s*직업운동가/u.test(otherIncomeRate),
    "The other-income rate locator must select item 6, subitem 라, and exclude the foreign-athlete clause");

  const vatServiceArticle = "1. 이 호의 본문은 인적용역의 범위를 정한다.\n가. 가목이다.\n차. 강연 및 교육용역의 차목이다.\n카. 다른 용역이다.";
  const vatMain = locatorSegments(vatServiceArticle, "제42조 제1호 본문").join(" ");
  const vatLecture = locatorSegments(vatServiceArticle, "제42조 제1호 차목").join(" ");
  must(/인적용역/u.test(vatMain) && !/강연/u.test(vatMain), "The VAT decree main text must exclude subitems");
  must(/강연|교육용역/u.test(vatLecture) && !/다른 용역/u.test(vatLecture),
    "The VAT decree locator must isolate the lecture subitem");

  const fundsArticle = "① 첫째 규정은 10원 미만 끝수를 처리한다.\n② 둘째 규정은 예외이다.";
  must(/10원/u.test(locatorSegments(fundsArticle, "제47조 제1항").join(" ")) &&
    !/예외/u.test(locatorSegments(fundsArticle, "제47조 제1항").join(" ")),
  "The funds first-paragraph locator must exclude the next paragraph");
  must(/예외/u.test(locatorSegments(fundsArticle, "제47조 제2항").join(" ")),
    "The funds second-paragraph locator must select the required exception");

  const expenseArticle = "1. 제1호 본문이다.\n1의2. 필요경비는 수입금액의 100분의 60으로 한다.\n2. 다른 항목이다.";
  const expense = locatorSegments(expenseArticle, "제87조 제1호의2").join(" ");
  must(/100\s*분의\s*60/u.test(expense) && !/다른 항목/u.test(expense),
    "The expense allowance locator must select subitem 1의2");

  const minimumArticle = "1. 첫째 기준이다.\n4. 기타소득금액이 5만원 이하이면 과세하지 아니한다.\n5. 다음 기준이다.";
  const minimum = locatorSegments(minimumArticle, "제84조 제4호").join(" ");
  must(/5만원/u.test(minimum) && !/다음 기준/u.test(minimum),
    "The other-income minimum locator must select item 4");

  must(locatorSegments("제29조(물적 시설) 사업설비를 계속 이용한다.", "제29조").length === 1,
    "An article-only locator must retain its complete article text");
});

function assertMatchedBasis(result, paymentDate, expectedProfile) {
  const evidence = result.legal_evidence ?? [];
  const calculated = (result.withholding_calculations ?? []).filter((row) => row.status === "computed");
  must(calculated.length > 0, "Matched-basis check needs at least one computed payment");
  const expectedSpecs = specsForProfile(expectedProfile);
  const expectedBasisKeys = new Set(expectedSpecs.map(basisKey));
  const expectedRuleIds = [...new Set(expectedSpecs.map((spec) => spec.rule_id))].sort();
  for (const row of calculated) {
    same(row.profile, expectedProfile, `${row.payment_id} must retain the selected basis profile`);
    const rowRuleIds = [...new Set(row.rule_ids ?? [])].sort();
    equivalent(rowRuleIds, expectedRuleIds, `${row.payment_id} must expose exactly the required calculation rules`);
    const checks = row.basis_checks ?? [];
    const actualBasisKeys = new Set(checks.map(basisKey));
    equivalent([...actualBasisKeys].sort(), [...expectedBasisKeys].sort(),
      `${row.payment_id} must expose exactly the required law/article/locator basis set`);
    same(checks.length, expectedSpecs.length, `${row.payment_id} must not duplicate or omit a required basis check`);
    for (const check of row.basis_checks ?? []) {
      const spec = expectedSpecs.find((item) => basisKey(item) === basisKey(check));
      must(spec, `${row.payment_id} returned an unexpected rule or source clause`);
      same(check.status, "matched_pinned_current_text", `Basis must match pinned current text for ${check.article}`);
      same(check.instrument_id, INSTRUMENT_BY_LAW_ID[spec.law_id],
        `Basis ${check.article} must identify the exact public legal instrument`);
      for (const field of ["rule_id", "instrument_id", "locator", "law_id", "article", "effective_date",
        "article_effective_date", "retrieved_at", "source_link"]) {
        must(typeof check[field] === "string" && check[field].length > 0,
          `Basis ${check.article} is missing ${field}`);
      }
      must(/^[0-9a-f]{64}$/.test(check.expected_text_sha256) &&
        check.actual_text_sha256 === check.expected_text_sha256,
      `Basis ${check.article} must match its pinned SHA-256`);
      must(check.effective_date <= paymentDate && check.article_effective_date <= paymentDate,
        `Basis ${check.article} must be effective on the payment date`);
      must(typeof check.source_link === "string" && check.source_link.startsWith("https://") &&
        check.source_link.includes("law.go.kr"), `Basis ${check.article} must link to the official law source`);
      must(/(?:Z|[+-]\d{2}:\d{2})$/.test(check.retrieved_at) && Number.isFinite(Date.parse(check.retrieved_at)),
        `Basis ${check.article} must include a timezone-aware retrieval timestamp`);
      const retrievalAgeMs = Date.now() - Date.parse(check.retrieved_at);
      must(retrievalAgeMs <= 24 * 60 * 60 * 1000 && retrievalAgeMs >= -5 * 60 * 1000,
        `Basis ${check.article} retrieval time must be fresh`);
      same(kstDate(new Date(check.retrieved_at)), paymentDate,
        `Basis ${check.article} must be retrieved on the matter's KST date`);
      const source = evidence.find((item) => item.status === "fetched" && item.instrument_id === check.instrument_id &&
        item.locator === check.locator && item.article === check.article && item.document?.law_id === check.law_id);
      must(source, `Basis ${check.article} must resolve to its fetched legal-evidence row`);
      const document = source.document;
      same(document.verification, "fetched_text_not_compared",
        `API response verification for ${check.article} must remain unpromoted`);
      same(document.status, "ok", `Fetched ${check.article} identity must be successful`);
      same(document.text_sha256, check.actual_text_sha256, `Attached hash for ${check.article} must match the calculation basis`);
      same(document.effective_date, check.effective_date, `Attached version for ${check.article} must match the basis`);
      same(document.article?.article_effective_date, check.article_effective_date,
        `Attached article version for ${check.article} must match the basis`);
      same(document.retrieved_at, check.retrieved_at, `Attached retrieval time for ${check.article} must match the basis`);
      same(document.source_link, check.source_link, `Attached source link for ${check.article} must match the basis`);
      must(typeof document.law_name === "string" && document.law_name.length > 0 &&
        typeof document.promulgation_no === "string" && document.promulgation_no.length > 0 &&
        typeof document.article?.text === "string" && document.article.text.trim().length > 0,
      `Fetched ${check.article} must include its identity and full article text`);
      same(document.article.label, check.article, `Fetched article locator for ${check.article} must match the basis`);
      same(document.text_check_draft?.law_id, check.law_id, `Fetched law ID for ${check.article} must match its source metadata`);
      same(document.text_check_draft?.promulgation_no, document.promulgation_no,
        `Fetched promulgation identity for ${check.article} must be internally consistent`);
      same(document.text_check_draft?.effective_date, check.effective_date,
        `Fetched version metadata for ${check.article} must match the pinned basis`);
      same(document.article.truncated, false, `Fetched ${check.article} must not be truncated`);
      const bodyHash = createHash("sha256").update(document.article.text, "utf8").digest("hex");
      same(bodyHash, check.actual_text_sha256, `Fetched ${check.article} body must match the reported hash`);
      assertClauseSemantics(document.article.text, spec);
    }
  }
}

function assertCurrentCalculationDate() {
  const today = kstDate();
  must(today >= "2026-10-20" && today <= "2026-12-31",
    "Live lecture calculation acceptance requires the current KST date to be within 2026-10-20 through 2026-12-31");
  return today;
}

function lecturePayment(profile, gross, paymentId, paymentDate) {
  const business = profile === "business_lecture";
  return {
    payment_id: paymentId,
    income_type: business ? "business" : "other",
    payee_type: "resident",
    payee_entity: "individual",
    payment_date: paymentDate,
    gross_amount: gross,
    withholding_profile: profile,
    domestic_payment: true,
    lecture_to_many: true,
    employment_relationship: false,
    independent_service: true,
    has_business_facilities: false,
    uses_hired_labor: false,
    special_tax_treatment: false,
    single_payment_complete: true,
    expenses_exceed_standard: false,
    activity_continuity: business ? "continuing" : "temporary",
  };
}

function calculationMatter(payments, asOf, matterId) {
  return {
    matter_id: matterId,
    workflow_id: "withholding-payment",
    as_of: asOf,
    taxpayer: { type: "corporation", small_business_semiannual_approval: false },
    facts: { payments },
  };
}

function retryableCalculationBudgetFailure(result, paymentIds, expectedProfiles) {
  const rows = result.withholding_calculations ?? [];
  const selectedRows = paymentIds.map((paymentId) => rows.find((row) => row.payment_id === paymentId));
  if (selectedRows.some((row) => !row)) return false;
  let timedOutRequiredBasis = false;
  for (const row of selectedRows) {
    if (!expectedProfiles.has(row.payment_id) || row.profile !== expectedProfiles.get(row.payment_id)) return false;
    const specs = specsForProfile(row.profile);
    const expectedKeys = new Set(specs.map(basisKey));
    const checks = row.basis_checks ?? [];
    const checkKeys = new Set(checks.map(basisKey));
    if (checks.length !== specs.length || checkKeys.size !== specs.length ||
      [...checkKeys].some((key) => !expectedKeys.has(key))) return false;

    if (row.status === "computed") {
      if (checks.some((check) => check.status !== "matched_pinned_current_text")) return false;
      continue;
    }
    if (row.status !== "blocked") return false;
    assertNoCalculatedAmounts({ withholding_calculations: [row] }, [row.payment_id],
      "A blocked required-basis row must not expose calculated amounts before retry");
    if (JSON.stringify(row.reason_codes ?? []) !== '["time_budget_exceeded"]') return false;
    let thisRowTimedOut = false;
    for (const check of checks) {
      if (check.status === "matched_pinned_current_text") continue;
      if (check.status === "unavailable" && check.reason === "time_budget_exceeded") {
        thisRowTimedOut = true;
        continue;
      }
      // Any other unavailable, stale, mismatched, or unclassified basis makes this non-retryable.
      return false;
    }
    if (!thisRowTimedOut) return false;
    timedOutRequiredBasis = true;
  }
  return timedOutRequiredBasis;
}

async function planWithBoundedBudgetRetries(call, matterValue, retryBudget, paymentIds) {
  const expectedProfiles = new Map((matterValue.facts?.payments ?? [])
    .filter((item) => paymentIds.includes(item.payment_id))
    .map((item) => [item.payment_id, item.withholding_profile]));
  if (expectedProfiles.size !== paymentIds.length) {
    throw new AcceptanceFailure("Retry gate requires a known selected profile for every payment");
  }
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await call("tax_plan_work", { matter: matterValue, include_evidence: true });
    if (!retryableCalculationBudgetFailure(result, paymentIds, expectedProfiles)) return { result, attempts };
    must(retryBudget.used < 2, "Live calculation evidence exceeded the two-call time-budget retry limit");
    retryBudget.used += 1;
  }
}

function payment() {
  return {
    payment_id: "live-evidence-wage",
    income_type: "wage",
    payee_type: "resident",
    payment_date: "2026-03-25",
    gross_amount: 3_000_000,
    withheld_amount: "10000",
  };
}

function matter(payments = [payment()]) {
  return {
    matter_id: "live-evidence-acceptance",
    workflow_id: "withholding-payment",
    as_of: "2026-04-01",
    taxpayer: { type: "corporation", small_business_semiannual_approval: false },
    facts: { payments },
  };
}

function credentialEnvironment() {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = process.env.HOME;
  env.TMPDIR = taskTemp;
  return env;
}

function savePrivateLiveReceipt(receiptContent) {
  const receipt = process.env.AGENTLINK_TEST_TAX_LIVE_RECEIPT;
  if (receipt === undefined) return;
  const scratchRoot = resolve(dirname(taskTemp));
  const destination = resolve(receipt);
  const rel = relative(scratchRoot, destination);
  must(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`),
    "Private live receipt must stay under task scratch");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(destination, JSON.stringify(receiptContent, null, 2),
      { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(destination, 0o600);
  } catch {
    throw new AcceptanceFailure("Private live receipt could not be written safely");
  }
}

function verifyInstalledWheel(scratch) {
  const probe = String.raw`
import importlib.metadata as metadata
import json
import pathlib
import sysconfig

import agentlink_tax
from agentlink_tax.credentials import CredentialStore, LAW_GO_KR
from agentlink_tax.registry import default_registry_dir

package = pathlib.Path(agentlink_tax.__file__).resolve().parent
site_packages = pathlib.Path(sysconfig.get_paths()["purelib"]).resolve()
registry = pathlib.Path(default_registry_dir()).resolve()
dist = metadata.distribution("agentlink-domain-tax")
direct_url = dist.read_text("direct_url.json")
editable = bool(json.loads(direct_url).get("dir_info", {}).get("editable")) if direct_url else False
required_assets = {"workflows.json", "instruments.json", "forms.json", "automation_offer.json"}
assets = {path.name for path in registry.rglob("*.json") if path.is_file()}
withholding_rules = registry / "rules" / "withholding.json"
workflows_file = registry / "workflows.json"
rule_rows = json.loads(withholding_rules.read_text(encoding="utf-8")).get("rules", []) if withholding_rules.is_file() else []
workflow_rows = json.loads(workflows_file.read_text(encoding="utf-8")).get("workflows", []) if workflows_file.is_file() else []
withholding_workflow = next((row for row in workflow_rows if row.get("id") == "withholding-payment"), {})
calculation_rule_count = sum(1 for row in rule_rows if str(row.get("id", "")).startswith("WH-CALC-"))
print(json.dumps({
    "package_installed": package.is_relative_to(site_packages),
    "registry_bundled": registry.is_relative_to(package) and required_assets <= assets,
    "calculation_rules_bundled": withholding_rules.is_file() and calculation_rule_count == 12 and
        "business_lecture" in withholding_workflow.get("description", "") and
        "other_lecture" in withholding_workflow.get("description", ""),
    "editable": editable,
    "credential_present": CredentialStore().has(LAW_GO_KR),
}, separators=(",", ":")))
`;
  const env = credentialEnvironment();
  const result = spawnSync(python, ["-I", "-B", "-c", probe], {
    cwd: scratch, env, encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024,
  });
  must(result.status === 0, "Installed tax environment probe failed");
  let facts;
  try { facts = JSON.parse(result.stdout); } catch { throw new AcceptanceFailure("Installed tax environment probe returned invalid metadata"); }
  same(facts.package_installed, true, "Tax package must import from installed site-packages");
  same(facts.registry_bundled, true, "Canonical JSON registry must be bundled with the installed package");
  same(facts.calculation_rules_bundled, true, "Both supported lecture rule sets must be bundled with the installed package");
  same(facts.editable, false, "Installed tax package must not be editable");
  same(facts.credential_present, true, "Existing law.go.kr credential must be available to the installed child");
}

async function withUpper(scratch, credentialPath, run) {
  const env = credentialEnvironment();
  env.TMPDIR = scratch;
  env.AGENTLINK_TAX_MCP_COMMAND = python;
  env.AGENTLINK_TAX_MCP_ARGS = JSON.stringify(["-I", "-B", "-m", "agentlink_tax.server"]);
  if (credentialPath !== undefined) env.AGENTLINK_CREDENTIALS_PATH = credentialPath;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: scratch,
    stderr: "pipe",
    env,
  });
  // Drain diagnostics without keeping or displaying text that may contain transport internals.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "tax-live-evidence-acceptance", version: "0.1.0" });
  client.onerror = () => {};
  try {
    try { await client.connect(transport); } catch { throw new AcceptanceFailure("Upper MCP stdio failed to start"); }
    const call = async (name, args = {}) => {
      let response;
      try { response = await client.callTool({ name, arguments: args }); }
      catch { throw new AcceptanceFailure(`MCP call failed: ${name}`); }
      must(response.isError !== true, `MCP tool returned an error: ${name}`);
      const packet = response.structuredContent;
      must(packet && typeof packet === "object", `MCP tool omitted structured content: ${name}`);
      const text = response.content?.find((item) => item.type === "text")?.text;
      must(typeof text === "string", `MCP tool omitted text content: ${name}`);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new AcceptanceFailure(`MCP text result was not JSON: ${name}`); }
      equivalent(parsed, packet, `MCP text and structured content differed: ${name}`);
      return packet;
    };
    return await run(client, call);
  } finally {
    try { await client.close(); } catch { /* close errors do not replace acceptance results */ }
  }
}

test("installed wheel returns current law and opted-in withholding evidence through real stdio", {
  timeout: 120_000,
}, async () => {
  const calculationDate = assertCurrentCalculationDate();
  must(typeof python === "string" && existsSync(python), "AGENTLINK_TEST_TAX_PYTHON must name the installed-wheel interpreter");
  must(typeof taskTemp === "string" && existsSync(taskTemp), "TMPDIR must point to the task scratch directory");
  for (const key of OVERRIDE_KEYS) same(process.env[key], undefined, "Source and registry overrides are not allowed");
  must(process.env.HOME && existsSync(process.env.HOME), "The real credential-store home must be available");
  must(existsSync(serverPath), "Build the upper MCP server before running required live acceptance");

  const scratch = mkdtempSync(join(taskTemp, "tax-live-acceptance-"));
  chmodSync(scratch, 0o700);
  try {
    verifyInstalledWheel(scratch);
    await withUpper(scratch, undefined, async (_client, call) => {
      const listed = await _client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      same(names.filter((name) => name.startsWith("tax_")).length, 19, "Upper MCP must expose 19 verified tax tools");
      must(names.includes("tax_get_law_article"), "Upper MCP must expose the native law-article tool");

      const search = await call("tax_search_law", { query: "소득세법", target: "law", limit: 10 });
      same(search.status, "ok", "Live law search must succeed");
      must(Array.isArray(search.results), "Live law search must return result rows");
      const exact = search.results.find((row) => row?.title === "소득세법" && typeof row.id === "string" && row.id.length > 0);
      must(exact, "Live law search must return an exact 소득세법 ID");

      const article = await call("tax_get_law_article", {
        law_name: "소득세법", article: "제128조", law_id: exact.id,
      });
      same(article.status, "ok", "Fetched current article must succeed");
      must(typeof article.article?.text === "string" && article.article.text.trim().length > 0,
        "Fetched article must include official text");
      must(typeof article.text_sha256 === "string" && /^[0-9a-f]{64}$/.test(article.text_sha256),
        "Fetched article must include a text hash");
      must(typeof article.effective_date === "string" && article.effective_date.length > 0,
        "Fetched article must include its effective date");
      must(typeof article.retrieved_at === "string" && article.retrieved_at.length > 0,
        "Fetched article must include its retrieval timestamp");
      must(typeof article.source_link === "string" && article.source_link.startsWith("https://"),
        "Fetched article must include an official source link");
      same(article.verification, "fetched_text_not_compared", "Fetched text must remain unverified against the registry");

      const empty = await call("tax_plan_work", { matter: matter([]), include_evidence: true });
      same(empty.status, "needs_facts", "An empty payments matter must remain needs_facts");
      const fullMatter = matter();
      const without = await call("tax_plan_work", { matter: fullMatter, include_evidence: false });
      const withEvidence = await call("tax_plan_work", { matter: fullMatter, include_evidence: true });
      same(withEvidence.status, "draft_ready", "Evidence retrieval must preserve draft_ready status");
      for (const field of ["status", "questions", "next_actions", "why", "sources", "applicability", "calculation_status"]) {
        equivalent(withEvidence[field], without[field], `Evidence retrieval changed plan authority field: ${field}`);
      }
      same(withEvidence.evidence_lookup?.status, "completed", "Required live evidence must complete without partial results");
      must(withEvidence.evidence_lookup.legal_documents_count >= 4, "Live evidence must attach at least four unique law documents");
      const fetchedRows = new Map((withEvidence.legal_evidence ?? [])
        .filter((row) => row.status === "fetched" && row.document?.article?.text?.trim())
        .map((row) => [row.article, row]));
      for (const label of ["제128조", "제164조", "제164조의3", "제5조"]) {
        const row = fetchedRows.get(label);
        must(row, `Live evidence is missing fetched ${label}`);
        const document = row.document;
        must(typeof row.instrument_id === "string" && row.instrument_id.length > 0 &&
          typeof row.locator === "string" && row.locator.length > 0 && row.scope === "current_law_not_historical",
        `Live evidence provenance is incomplete for ${label}`);
        must(typeof document.law_id === "string" && document.law_id.length > 0 &&
          typeof document.law_name === "string" && document.law_name.length > 0 &&
          typeof document.source === "string" && document.source.length > 0,
        `Live evidence identity is incomplete for ${label}`);
        must(typeof document.retrieved_at === "string" && document.retrieved_at.length > 0 &&
          typeof document.effective_date === "string" && document.effective_date.length > 0,
        `Live evidence dates are incomplete for ${label}`);
        must(typeof document.text_sha256 === "string" && /^[0-9a-f]{64}$/.test(document.text_sha256) &&
          typeof document.source_link === "string" && document.source_link.startsWith("https://") &&
          document.source_link.includes("law.go.kr"),
        `Live evidence source metadata is incomplete for ${label}`);
        same(document.verification, "fetched_text_not_compared", `Live evidence verification changed for ${label}`);
      }
      const candidate = (withEvidence.evidence_candidates ?? []).find((row) =>
        row.id && row.source && row.date && row.retrieved_at && (row.agency || row.case_no) &&
        (row.public_link || row.detail_link) && row.relevance === "query_match_unreviewed" &&
        row.verification_status === "candidate_unverified");
      must(candidate, "Live evidence must contain a sourced, dated interpretation candidate");
      must(withEvidence.evidence_lookup.candidate_count > 0, "Live evidence summary must count interpretation candidates");
      const resolvedForm = (withEvidence.forms_and_evidence?.forms ?? []).some((row) =>
        row.official_file_status === "resolved" && row.official_file);
      must(resolvedForm, "Live evidence must resolve at least one official form");
      must(!(withEvidence.unresolved ?? []).some((row) => row.code === "EVIDENCE_LOOKUP_UNAVAILABLE"),
        "Required live acceptance cannot contain an evidence-unavailable warning");

      const defaultAnswer = await call("tax_answer_practitioner_question", { matter: fullMatter, include_evidence: false });
      const answer = await call("tax_answer_practitioner_question", { matter: fullMatter, include_evidence: true });
      same(answer.final_decision, "not_issued", "Practitioner evidence must not issue a final decision");
      same(answer.applicability, "not_determined", "Practitioner evidence must not decide applicability");
      equivalent(answer.assessments, defaultAnswer.assessments, "Practitioner evidence must preserve assessments");
      must(Array.isArray(answer.assessments) && answer.assessments.length > 0 &&
        answer.assessments.every((item) => item.reliance === "do_not_rely_verify_source"),
      "Practitioner assessments must retain their existing reliance warning");
      const sections = answer.perspective_view?.sections ?? {};
      same(sections.evidence_lookup?.[0]?.text?.includes("조회 상태: completed"), true,
        "Practitioner evidence summary must report completed live retrieval");
      must(Array.isArray(sections.source_evidence) && sections.source_evidence.length > 0,
        "Practitioner evidence section must contain law and interpretation evidence");
      const law128 = fetchedRows.get("제128조").document;
      const law128Text = sections.source_evidence.find((row) => row.text?.includes("제128조") &&
        row.text.includes("fetched_text_not_compared"));
      must(law128Text && law128Text.text.includes(law128.article.text) &&
        law128Text.text.includes(law128.law_id) && law128Text.text.includes(law128.law_name) &&
        law128Text.text.includes(law128.retrieved_at) && law128Text.text.includes(law128.effective_date) &&
        law128Text.text.includes(law128.source_link),
      "Practitioner source evidence must contain the fetched article 128 body and provenance");
      const candidateLink = candidate.public_link || candidate.detail_link;
      must(sections.source_evidence.some((row) => row.text?.includes(`ID: ${candidate.id}`) &&
        row.text.includes(candidate.source) && row.text.includes(candidate.date) &&
        row.text.includes(candidate.retrieved_at) && row.text.includes(candidateLink) &&
        row.text.includes("query_match_unreviewed") && row.text.includes("candidate_unverified")),
      "Practitioner source evidence must include the actual unreviewed candidate and provenance");

      const businessMatter = calculationMatter([
        lecturePayment("business_lecture", 33333, "business-33333", calculationDate),
        lecturePayment("business_lecture", 10000, "business-10000", calculationDate),
      ], calculationDate, "live-business-lecture");
      businessMatter.facts.payments[0].withheld_amount = "1000";
      const otherMatter = calculationMatter([
        lecturePayment("other_lecture", 125000, "other-125000", calculationDate),
        lecturePayment("other_lecture", 125001, "other-125001", calculationDate),
        lecturePayment("other_lecture", 1000000, "other-1000000", calculationDate),
      ], calculationDate, "live-other-lecture");
      const retryBudget = { used: 0 };
      const businessPlan = await planWithBoundedBudgetRetries(call, businessMatter, retryBudget,
        ["business-33333", "business-10000"]);
      const otherPlan = await planWithBoundedBudgetRetries(call, otherMatter, retryBudget,
        ["other-125000", "other-125001", "other-1000000"]);
      equivalent(businessPlan.result.withholding_calculations.map((row) => row.payment_id),
        ["business-33333", "business-10000"], "Business calculation rows must preserve payment input order");
      equivalent(otherPlan.result.withholding_calculations.map((row) => row.payment_id),
        ["other-125000", "other-125001", "other-1000000"], "Other calculation rows must preserve payment input order");
      same(businessPlan.result.applicability, "not_determined", "Scoped business results must not decide whole-matter applicability");
      same(otherPlan.result.applicability, "not_determined", "Scoped other results must not decide whole-matter applicability");
      same(businessPlan.result.calculation_status, "computed", "Both business lecture payments must compute");
      same(otherPlan.result.calculation_status, "computed", "Both taxable and below-minimum other lecture payments must compute");
      const business33333 = assertComputedRow(businessPlan.result, "business-33333", {
        profile: "business_lecture", applicability: "applies",
        values: {
          gross_amount: "33333", expense_rate: null, expense_amount: null, income_amount: "33333", tax_base: "33333",
          national_rate: "0.03", national_tax: "990", local_rate: "0.1", local_tax: "90",
          total_withholding: "1080", net_payment: "32253",
        },
      });
      const business10000 = assertComputedRow(businessPlan.result, "business-10000", {
        profile: "business_lecture", applicability: "applies",
        values: {
          gross_amount: "10000", expense_rate: null, expense_amount: null, income_amount: "10000", tax_base: "10000",
          national_rate: "0.03", national_tax: "300", local_rate: "0.1", local_tax: "30",
          total_withholding: "330", net_payment: "9670",
        },
      });
      same(business33333.withholding_required, true, "Business applicability remains applies when national withholding is due");
      same(business10000.withholding_required, true, "Small business payments do not receive a de-minimis waiver");
      const confirmedPayments = businessPlan.result.confirmed_facts.find((fact) => fact.key === "payments")?.value ?? [];
      same(confirmedPayments.find((item) => item.payment_id === "business-33333")?.withheld_amount, "1000",
        "A supplied actual withholding amount must remain unchanged beside the calculation");
      must(/0\.03|3\s*%|3\s*퍼센트/u.test(business33333.formula) &&
        /0\.1|10\s*%|10\s*퍼센트/u.test(business33333.formula),
      "Business formula must state the national 3% and local 10% calculations");
      assertMatchedBasis(businessPlan.result, calculationDate, "business_lecture");

      const other125000 = assertComputedRow(otherPlan.result, "other-125000", {
        profile: "other_lecture", applicability: "below_taxable_minimum",
        values: {
          gross_amount: "125000", expense_rate: "0.6", expense_amount: "75000", income_amount: "50000",
          tax_base: "50000", national_rate: "0.2", national_tax: "0", local_rate: "0.1", local_tax: "0",
          total_withholding: "0", net_payment: "125000",
        },
      });
      const other125001 = assertComputedRow(otherPlan.result, "other-125001", {
        profile: "other_lecture", applicability: "applies",
        values: {
          gross_amount: "125001", expense_rate: "0.6", expense_amount: "75000.6", income_amount: "50000.4",
          tax_base: "50000", national_rate: "0.2", national_tax: "10000", local_rate: "0.1", local_tax: "1000",
          total_withholding: "11000", net_payment: "114001",
        },
      });
      const other1000000 = assertComputedRow(otherPlan.result, "other-1000000", {
        profile: "other_lecture", applicability: "applies",
        values: {
          gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
          tax_base: "400000", national_rate: "0.2", national_tax: "80000", local_rate: "0.1", local_tax: "8000",
          total_withholding: "88000", net_payment: "912000",
        },
      });
      same(other125000.withholding_required, false, "An other-income amount at the 50,000-won threshold is below the taxable minimum");
      same(other125001.withholding_required, true, "An amount above the threshold requires withholding");
      same(other1000000.withholding_required, true, "Larger other lecture payments require withholding");
      must(/0\.6|60\s*%|60\s*퍼센트/u.test(other125001.formula) &&
        /50000|50,000|5\s*만/u.test(other125001.formula) &&
        /0\.2|20\s*%|20\s*퍼센트/u.test(other125001.formula) &&
        /0\.1|10\s*%|10\s*퍼센트/u.test(other125001.formula),
      "Other formula must explain the 60% allowance, 50,000-won threshold, and national/local rates");
      assertMatchedBasis(otherPlan.result, calculationDate, "other_lecture");

      const noEvidence = await call("tax_plan_work", { matter: businessMatter, include_evidence: false });
      same(noEvidence.calculation_status, "blocked", "Evidence-disabled selected profiles must aggregate as blocked");
      assertNoCalculatedAmounts(noEvidence, ["business-33333", "business-10000"],
        "Selected lecture profiles require matched current-law evidence");
      for (const row of noEvidence.withholding_calculations) {
        same(row.status, "blocked", "A selected profile without evidence must be blocked");
        must(row.reason_codes.includes("evidence_not_requested"), "Evidence-disabled calculation must report evidence_not_requested");
        must(row.basis_checks.length > 0 && row.basis_checks.every((check) =>
          check.status === "not_requested" && check.reason === "evidence_not_requested" &&
          /^[0-9a-f]{64}$/.test(check.expected_text_sha256) && check.actual_text_sha256 === null &&
          check.retrieved_at === null && check.source_link === null),
        "Evidence-disabled basis rows must report only the pinned expectation");
      }
      const noEvidenceOther = await call("tax_plan_work", { matter: otherMatter, include_evidence: false });
      same(noEvidenceOther.calculation_status, "blocked",
        "Evidence-disabled other lecture profiles must aggregate as blocked");
      assertNoCalculatedAmounts(noEvidenceOther,
        ["other-125000", "other-125001", "other-1000000"],
        "Other lecture profiles require matched current-law evidence");

      const unknownProfileMatter = calculationMatter([
        { ...lecturePayment("business_lecture", 1000, "unknown-profile", calculationDate), withholding_profile: "unknown" },
      ], calculationDate, "live-unknown-profile");
      const unknownProfile = await call("tax_plan_work", { matter: unknownProfileMatter, include_evidence: false });
      assertNoCalculatedAmounts(unknownProfile, ["unknown-profile"], "An unknown profile must ask for classification");
      const unknownRow = unknownProfile.withholding_calculations[0];
      same(unknownRow.status, "needs_facts", "Unknown profile must request a fact");
      same(unknownRow.reason_codes[0], "profile_required", "Unknown profile must use the scoped reason");
      must(unknownRow.missing_facts.includes("withholding_profile"), "Unknown profile must list the missing profile fact");
      must(unknownProfile.questions.some((item) => item.fact_key === "payments[unknown-profile].withholding_profile"),
        "Unknown profile must ask the exact payment-level profile question");

      const missingFactPayment = lecturePayment("business_lecture", 1000, "missing-fact", calculationDate);
      delete missingFactPayment.lecture_to_many;
      const missingFact = await call("tax_plan_work", {
        matter: calculationMatter([missingFactPayment], calculationDate, "live-missing-lecture-fact"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(missingFact, ["missing-fact"], "A missing scope fact must block calculation");
      same(missingFact.withholding_calculations[0].status, "needs_facts", "Missing scope facts must be requested");
      same(missingFact.withholding_calculations[0].reason_codes[0], "missing_required_facts",
        "Missing scope facts must use the targeted reason");
      must(missingFact.withholding_calculations[0].missing_facts.includes("lecture_to_many"),
        "The missing fact list must identify lecture_to_many");

      const missingPayeePayment = lecturePayment("business_lecture", 1000, "missing-payee-entity", calculationDate);
      delete missingPayeePayment.payee_entity;
      const missingPayeeEntity = await call("tax_plan_work", {
        matter: calculationMatter([missingPayeePayment], calculationDate, "live-missing-payee-entity"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(missingPayeeEntity, ["missing-payee-entity"],
        "A missing individual payee classification must not compute");
      same(missingPayeeEntity.withholding_calculations[0].status, "needs_facts",
        "A missing individual payee classification must request facts");
      must(missingPayeeEntity.withholding_calculations[0].missing_facts.includes("payee_entity"),
        "The missing fact list must identify payee_entity");

      const historicalPayment = lecturePayment("business_lecture", 1000, "historical-date", "2026-10-19");
      const historical = await call("tax_plan_work", {
        matter: calculationMatter([historicalPayment], calculationDate, "live-historical-payment"),
        include_evidence: true,
      });
      assertNoCalculatedAmounts(historical, ["historical-date"], "A payment before the supported law window must not compute");
      same(historical.withholding_calculations[0].status, "blocked", "An out-of-scope payment date must block calculation");
      must(historical.withholding_calculations[0].reason_codes.includes("date_out_of_scope"),
        "An out-of-scope payment must identify the date boundary");
      must(historical.withholding_calculations[0].basis_checks.every((check) =>
        check.status === "date_out_of_scope" && check.reason === "date_out_of_scope" &&
        check.actual_text_sha256 === null && check.retrieved_at === null),
      "Out-of-scope basis checks must not claim fetched current law as applicable");

      const conflictingPayment = lecturePayment("business_lecture", 1000, "profile-conflict", calculationDate);
      conflictingPayment.income_type = "wage";
      const conflict = await call("tax_plan_work", {
        matter: calculationMatter([conflictingPayment], calculationDate, "live-profile-conflict"),
        include_evidence: false,
      });
      assertNoCalculatedAmounts(conflict, ["profile-conflict"], "A profile incompatible with the income type must not compute");
      same(conflict.withholding_calculations[0].status, "unsupported", "A profile conflict must be unsupported");
      must(conflict.withholding_calculations[0].reason_codes.includes("income_profile_conflict"),
        "A profile conflict must identify the income type mismatch");

      const lectureAnswerWithoutEvidence = await call("tax_answer_practitioner_question", {
        matter: businessMatter, include_evidence: false,
      });
      same(lectureAnswerWithoutEvidence.final_decision, "not_issued", "Evidence-disabled practitioner output must remain a draft");
      const otherLectureAnswerWithoutEvidence = await call("tax_answer_practitioner_question", {
        matter: otherMatter, include_evidence: false,
      });
      same(otherLectureAnswerWithoutEvidence.final_decision, "not_issued",
        "Evidence-disabled other lecture output must remain a draft");
      assertNoComputedTaxAssessments(lectureAnswerWithoutEvidence,
        "Evidence-disabled business lecture answer");
      assertNoComputedTaxAssessments(otherLectureAnswerWithoutEvidence,
        "Evidence-disabled other lecture answer");
      for (const [answerWithoutEvidence, payments, profile] of [
        [lectureAnswerWithoutEvidence, businessMatter.facts.payments, "business_lecture"],
        [otherLectureAnswerWithoutEvidence, otherMatter.facts.payments, "other_lecture"],
      ]) {
        for (const item of payments) {
          const row = decodedCalculationSection(answerWithoutEvidence, item.payment_id, profile);
          const lines = row.text.split(/\r?\n/u);
          must(lines.some((line) => line.startsWith("행 상태: blocked;")),
            `${item.payment_id} practitioner row must remain blocked without evidence`);
          for (const forbidden of ["국세율:", "국세 원천징수 후보:", "지방소득세율:",
            "총 원천징수 후보:", "순지급액:"]) {
            must(!lines.some((line) => line.startsWith(forbidden)),
              `${item.payment_id} practitioner row must not project ${forbidden} without evidence`);
          }
        }
      }

      const lectureAnswer = await call("tax_answer_practitioner_question", {
        matter: businessMatter, include_evidence: true,
      });
      same(lectureAnswer.final_decision, "not_issued", "Practitioner calculation must not issue a final decision");
      same(lectureAnswer.applicability, "not_determined", "Practitioner calculation must retain whole-matter applicability");
      must(Array.isArray(lectureAnswer.assessments) && lectureAnswer.assessments.length > 0 &&
        lectureAnswer.assessments.every((item) => item.reliance === "do_not_rely_verify_source"),
      "Practitioner calculation assessments must retain their review warning");
      const lectureSections = lectureAnswer.perspective_view?.sections ?? {};
      must(Array.isArray(lectureSections.withholding_basis_checks) && lectureSections.withholding_basis_checks.length > 0,
        "Practitioner output must project the matched calculation basis checks");
      assertPractitionerBasisProjection(lectureAnswer, businessPlan.result);

      const otherLectureAnswer = await call("tax_answer_practitioner_question", {
        matter: otherMatter, include_evidence: true,
      });
      same(otherLectureAnswer.final_decision, "not_issued", "Other lecture practitioner result must not issue a final decision");
      same(otherLectureAnswer.applicability, "not_determined",
        "Other lecture practitioner result must preserve whole-matter applicability");
      must(Array.isArray(otherLectureAnswer.assessments) &&
        otherLectureAnswer.assessments.every((item) => item.reliance === "do_not_rely_verify_source"),
      "Other lecture practitioner assessments must retain their review warning");
      must(Array.isArray(otherLectureAnswer.perspective_view?.sections?.withholding_basis_checks) &&
        otherLectureAnswer.perspective_view.sections.withholding_basis_checks.length > 0,
      "Other lecture practitioner output must project its matched basis checks");
      assertPractitionerBasisProjection(otherLectureAnswer, otherPlan.result);

      for (const expected of [
        { paymentId: "business-33333", profile: "business_lecture", applicability: "applies",
          national: "990", local: "90", formula: business33333.formula,
          nationalExpression: /10원 단위 절사\(33333\s*×\s*0\.03\)/u, localExpression: /10원 단위 절사\(990\s*×\s*0\.1\)/u,
          nationalRate: "0.03", localRate: "0.1", total: "1080", net: "32253", actualWithheld: "1000원",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "differs_from_national_tax",
          values: { gross_amount: "33333", expense_amount: null, income_amount: "33333", tax_base: "33333",
            national_tax: "990", local_tax: "90", total_withholding: "1080", net_payment: "32253" } },
        { paymentId: "business-10000", profile: "business_lecture", applicability: "applies",
          national: "300", local: "30", formula: business10000.formula,
          nationalExpression: /10원 단위 절사\(10000\s*×\s*0\.03\)/u, localExpression: /10원 단위 절사\(300\s*×\s*0\.1\)/u,
          nationalRate: "0.03", localRate: "0.1", total: "330", net: "9670", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "10000", expense_amount: null, income_amount: "10000", tax_base: "10000",
            national_tax: "300", local_tax: "30", total_withholding: "330", net_payment: "9670" } },
      ]) {
        assertTypedPaymentAssessments(lectureAnswer, expected);
        assertPractitionerCalculationSection(lectureAnswer, expected);
      }
      for (const expected of [
        { paymentId: "other-125000", profile: "other_lecture", applicability: "below_taxable_minimum",
          national: "0", local: "0", formula: other125000.formula,
          nationalExpression: /소득금액\s*50000원\s*≤\s*50,000원\s*과세최저한\s*→\s*0원/u,
          localExpression: /10원 단위 절사\(0\s*×\s*0\.1\)/u,
          nationalRate: "0.2", localRate: "0.1", total: "0", net: "125000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_false_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "125000", expense_rate: "0.6", expense_amount: "75000", income_amount: "50000",
            tax_base: "50000", national_tax: "0", local_tax: "0", total_withholding: "0", net_payment: "125000" } },
        { paymentId: "other-125001", profile: "other_lecture", applicability: "applies",
          national: "10000", local: "1000", formula: other125001.formula,
          nationalExpression: /10원 단위 절사\(50000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(10000\s*×\s*0\.1\)/u,
          nationalRate: "0.2", localRate: "0.1", total: "11000", net: "114001", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "125001", expense_rate: "0.6", expense_amount: "75000.6", income_amount: "50000.4",
            tax_base: "50000", national_tax: "10000", local_tax: "1000", total_withholding: "11000", net_payment: "114001" } },
        { paymentId: "other-1000000", profile: "other_lecture", applicability: "applies",
          national: "80000", local: "8000", formula: other1000000.formula,
          nationalExpression: /10원 단위 절사\(400000\s*×\s*0\.2\)/u,
          localExpression: /10원 단위 절사\(80000\s*×\s*0\.1\)/u,
          nationalRate: "0.2", localRate: "0.1", total: "88000", net: "912000", actualWithheld: "미제공",
          comparisonOutcome: "comparison_true_candidate", comparisonStatus: "actual_withheld_not_provided",
          values: { gross_amount: "1000000", expense_rate: "0.6", expense_amount: "600000", income_amount: "400000",
            tax_base: "400000", national_tax: "80000", local_tax: "8000", total_withholding: "88000", net_payment: "912000" } },
      ]) {
        assertTypedPaymentAssessments(otherLectureAnswer, expected);
        assertPractitionerCalculationSection(otherLectureAnswer, expected);
      }

      savePrivateLiveReceipt({ business_plan: businessPlan.result, other_plan: otherPlan.result,
        practitioner_business_answer: lectureAnswer, practitioner_other_answer: otherLectureAnswer });

      const allLive = JSON.stringify([search, article, withEvidence, answer, businessPlan.result, otherPlan.result,
        lectureAnswerWithoutEvidence, lectureAnswer, noEvidence, unknownProfile, missingFact, missingPayeeEntity,
        otherLectureAnswerWithoutEvidence, otherLectureAnswer, noEvidenceOther, historical, conflict]);
      must(!allLive.includes("OC="), "Serialized live outputs must not contain authenticated OC parameters");
      process.stdout.write(JSON.stringify({
        live: "passed", tax_tools: 19, article: "fetched", evidence: "completed",
        legal_documents: withEvidence.evidence_lookup.legal_documents_count,
        candidates: withEvidence.evidence_lookup.candidate_count,
        resolved_forms: withEvidence.evidence_lookup.resolved_forms_count,
        practitioner: "evidence_attached",
        business_calculations: businessPlan.result.withholding_calculations.length,
        other_calculations: otherPlan.result.withholding_calculations.length,
        budget_retry_calls: retryBudget.used,
      }) + "\n");
    });

    const missingCredentialPath = join(scratch, "intentionally-missing-credentials.json");
    must(!existsSync(missingCredentialPath), "Negative credential fixture must begin absent");
    await withUpper(scratch, missingCredentialPath, async (_client, call) => {
      const missingCredentialMatter = calculationMatter([
        lecturePayment("business_lecture", 33333, "missing-credential-lecture", calculationDate),
      ], calculationDate, "live-missing-credential-lecture");
      const without = await call("tax_plan_work", { matter: missingCredentialMatter, include_evidence: false });
      const result = await call("tax_plan_work", { matter: missingCredentialMatter, include_evidence: true });
      same(result.status, without.status, "Missing credentials must not change plan status");
      equivalent(result.questions, without.questions, "Missing credentials must not change the supplied-fact questions");
      same(result.applicability, "not_determined", "Missing credentials must not decide whole-matter applicability");
      assertNoCalculatedAmounts(without, ["missing-credential-lecture"],
        "An evidence-disabled lecture calculation must not contain amounts");
      assertNoCalculatedAmounts(result, ["missing-credential-lecture"],
        "Missing credentials must leave every lecture calculation amount empty");
      same(result.calculation_status, "blocked", "Missing current-law credentials must block calculation");
      const calcRow = result.withholding_calculations[0];
      same(calcRow.status, "blocked", "Missing current-law credentials must block the payment row");
      must(calcRow.reason_codes.includes("credential_missing"), "Calculation must report credential_missing safely");
      must(calcRow.basis_checks.length > 0 && calcRow.basis_checks.some((check) =>
        check.status === "unavailable" && check.reason === "credential_missing"),
      "Missing-credential basis check must report the safe credential_missing reason");
      same(result.evidence_lookup?.status, "unavailable", "Missing credentials must produce unavailable evidence state");
      must(result.evidence_lookup.error_codes.includes("credential_missing"),
        "Missing credential state must identify credential_missing");
      same(result.evidence_lookup.legal_documents_count, 0, "Missing credentials cannot attach a law document");
      same(result.evidence_lookup.candidate_count, 0, "Missing credentials cannot attach a candidate");
      same((result.evidence_candidates ?? []).length, 0, "Missing credentials must leave candidate rows empty");
      must((result.legal_evidence ?? []).every((row) => row.status !== "fetched"),
        "Missing credentials must not produce fetched legal evidence");
      must((result.unresolved ?? []).some((row) => row.code === "EVIDENCE_LOOKUP_UNAVAILABLE"),
        "Missing credentials must provide a non-blocking evidence warning");
      must(!JSON.stringify(result).includes(missingCredentialPath), "Missing credentials must not expose the local credential path");
      must(!JSON.stringify(result).includes("OC="), "Missing-credential output must not expose authenticated transport parameters");
      process.stdout.write(JSON.stringify({ negative_fixture: "passed", evidence: "unavailable", code: "credential_missing" }) + "\n");
    });
  } catch (error) {
    // Assertion text is authored locally and safe. Suppress runtime/transport text and paths.
    if (error instanceof AcceptanceFailure) throw error;
    throw new AcceptanceFailure("Required live tax evidence acceptance failed; private diagnostics suppressed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
