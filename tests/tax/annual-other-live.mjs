// Finite installed-wheel acceptance for the optional annual OTHER projection.
// Expected money values are authored independently from the domain calculation.
import { createHash } from "node:crypto";

const RECIPIENT = "annual-live-recipient";
const ANNUAL_RULE_IDS = [
  "WH-CALC-ANNUAL-OTHER-SCOPE",
  "WH-CALC-ANNUAL-OTHER-EXPENSE",
  "WH-CALC-ANNUAL-OTHER-REGIME",
  "WH-CALC-ANNUAL-OTHER-DEDUCTION",
  "WH-CALC-ANNUAL-OTHER-NATIONAL",
  "WH-CALC-ANNUAL-OTHER-LOCAL",
  "WH-CALC-ANNUAL-OTHER-LOSS",
  "WH-CALC-ANNUAL-OTHER-BASE-ROUND",
];

const EXPECTED_BASIS = [
  { rule: ANNUAL_RULE_IDS[0], law: "001565", article: "제5조", locator: "제5조 제1항",
    instrument: "income-tax-act", groups: [["1월1일부터12월31일까지"]] },
  { rule: ANNUAL_RULE_IDS[0], law: "001565", article: "제21조",
    locator: "제21조 제1항 제15호 가목·제19호 가목·나목·다목·제3항",
    instrument: "income-tax-act", groups: [["총수입금액"], ["필요경비"]] },
  { rule: ANNUAL_RULE_IDS[0], law: "001565", article: "제37조", locator: "제37조 제2항·제4항",
    instrument: "income-tax-act", groups: [["필요경비"], ["해당과세기간"]] },
  { rule: ANNUAL_RULE_IDS[0], law: "001565", article: "제33조", locator: "제33조 제1항",
    instrument: "income-tax-act", groups: [["필요경비"], ["산입하지아니"]] },
  { rule: ANNUAL_RULE_IDS[0], law: "001565", article: "제84조", locator: "제84조 제4호",
    instrument: "income-tax-act", groups: [["5만원"], ["기타소득"]] },
  { rule: ANNUAL_RULE_IDS[1], law: "003956", article: "제87조", locator: "제87조 제1호의2",
    instrument: "income-tax-decree", groups: [["60퍼센트", "100분의60", "60%"], ["실제", "필요경비"]] },
  { rule: ANNUAL_RULE_IDS[2], law: "001565", article: "제14조", locator: "제14조 제2항·제3항 제8호 가목",
    instrument: "income-tax-act", groups: [["300만원"], ["기타소득"], ["원천징수"]] },
  { rule: ANNUAL_RULE_IDS[3], law: "001565", article: "제50조", locator: "제50조 제1항 제1호",
    instrument: "income-tax-act", groups: [["150만원"], ["해당거주자"]] },
  { rule: ANNUAL_RULE_IDS[3], law: "001565", article: "제51조", locator: "제51조 제4항",
    instrument: "income-tax-act", groups: [["인적공제의합계액"], ["종합소득금액"], ["초과하는공제액은없는것으로"]] },
  { rule: ANNUAL_RULE_IDS[3], law: "001565", article: "제54조", locator: "제54조 제1항",
    instrument: "income-tax-act", groups: [["종합소득과세표준", "분리과세"], ["공제"]] },
  { rule: ANNUAL_RULE_IDS[4], law: "001565", article: "제55조", locator: "제55조 제1항",
    instrument: "income-tax-act",
    groups: [["100분의6", "6퍼센트"], ["100분의45", "45퍼센트"]] },
  { rule: ANNUAL_RULE_IDS[5], law: "001649", article: "제91조", locator: "제91조 제1항",
    instrument: "local-tax-act", groups: [["소득세의과세표준"], ["동일한금액"]] },
  { rule: ANNUAL_RULE_IDS[5], law: "001649", article: "제92조", locator: "제92조 제1항·제2항·제3항",
    instrument: "local-tax-act", groups: [["1천분의6"], ["1천분의45"]] },
  { rule: ANNUAL_RULE_IDS[6], law: "001565", article: "제45조",
    locator: "제45조 제1항·제2항·제3항·제4항·제5항·제6항",
    instrument: "income-tax-act", groups: [["사업소득"], ["기타소득"], ["이월"]] },
  { rule: ANNUAL_RULE_IDS[7], law: "009409", article: "제47조", locator: "제47조 제2항",
    instrument: "national-funds-act", groups: [["1원미만"], ["과세표준"]] },
];

const AMOUNT_FIELDS = [
  "gross_amount", "expense_amount", "signed_reconciliation_amount", "excluded_case_income",
  "annual_other_income", "basic_deduction", "tax_base", "national_calculated_tax",
  "local_calculated_tax", "total_calculated_tax",
];
const TAX_CONCLUSION_FIELDS = [
  "annual_other_income", "basic_deduction", "tax_base", "national_calculated_tax",
  "local_calculated_tax", "total_calculated_tax",
];

function assert(condition, must, message) {
  must(condition, message);
}

function ordinaryFlags(overrides = {}) {
  return {
    resident_individual_confirmed: true,
    domestic_ordinary_only_confirmed: true,
    calendar_year_complete_confirmed: true,
    future_assumptions_complete_confirmed: true,
    current_law_projection_confirmed: true,
    no_other_income_confirmed: true,
    no_business_loss_deduction_confirmed: true,
    self_basic_deduction_only_confirmed: true,
    local_standard_rates_confirmed: true,
    withholding_fully_performed: true,
    ...overrides,
  };
}

function receipt(id, gross, options = {}) {
  const row = {
    receipt_id: id,
    payer_id: options.payer_id ?? "annual-live-payer-a",
    recipient_id: options.recipient_id ?? RECIPIENT,
    received_on: options.received_on ?? "2026-10-01",
    gross_amount: gross,
    record_kind: options.record_kind ?? "actual",
    expense_record_kind: options.expense_record_kind ?? null,
    actual_expense_amount: options.actual_expense_amount ?? null,
  };
  return row;
}

function caseRow(id, kind, receipts, options = {}) {
  const row = {
    case_id: id,
    kind,
    receipts,
    expense_method: options.expense_method ?? "standard_60",
    classification_scope_confirmed: options.classification_scope_confirmed ?? true,
    factual_case_complete_confirmed: options.factual_case_complete_confirmed ?? true,
  };
  if (row.expense_method === "actual") {
    row.actual_expense_scope_confirmed = options.actual_expense_scope_confirmed ?? true;
  }
  return row;
}

function matter(calculationDate, cases, annualOverrides = {}) {
  const annual = {
    recipient_id: RECIPIENT,
    tax_year: 2026,
    cases,
    tax_regime: "comprehensive",
    ...ordinaryFlags(),
    ...annualOverrides,
  };
  return {
    matter_id: "annual-other-live-acceptance",
    workflow_id: "withholding-payment",
    as_of: calculationDate,
    facts: { payments: [], annual_other: annual },
  };
}

function normalizeText(text) {
  return String(text ?? "").replace(/\s/gu, "").replace(/[，、]/gu, ",");
}

function kstDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return fields.year + "-" + fields.month + "-" + fields.day;
}

function assertBasis(result, calculation, calculationDate, must, same, equivalent, label) {
  const checks = calculation.basis_checks;
  assert(Array.isArray(checks) && checks.length === EXPECTED_BASIS.length, must,
    label + " must expose all 15 annual source checks");
  equivalent(checks.map((check) => ({ rule: check.rule_id, law: check.law_id,
    article: check.article, locator: check.locator })), EXPECTED_BASIS.map((spec) => ({
    rule: spec.rule, law: spec.law, article: spec.article, locator: spec.locator,
  })), label + " must preserve the exact annual card selectors and statute locations");
  const evidenceRows = (result.legal_evidence ?? []).filter((row) =>
    row.status === "fetched" && row.document?.article?.text);
  const uniqueDocuments = new Set(evidenceRows.map((row) =>
    String(row.document.law_id) + ":" + String(row.article)));
  same(uniqueDocuments.size, EXPECTED_BASIS.length,
    label + " must attach 15 unique complete current-law documents");

  for (let index = 0; index < EXPECTED_BASIS.length; index += 1) {
    const spec = EXPECTED_BASIS[index];
    const check = checks[index];
    same(check.status, "matched_pinned_current_text", label + " basis must match current pinned text: " + spec.article);
    same(check.instrument_id, spec.instrument, label + " basis instrument must be exact: " + spec.article);
    assert(/^[0-9a-f]{64}$/u.test(check.expected_text_sha256 ?? "") &&
      check.actual_text_sha256 === check.expected_text_sha256, must,
    label + " basis digest must match its pinned digest: " + spec.article);
    for (const field of ["effective_date", "article_effective_date", "retrieved_at", "source_link"]) {
      assert(typeof check[field] === "string" && check[field].length > 0, must,
        label + " basis is missing " + field + ": " + spec.article);
    }
    assert(check.effective_date <= calculationDate && check.article_effective_date <= calculationDate, must,
      label + " source must be effective by the projection date: " + spec.article);
    assert(typeof check.source_link === "string" && check.source_link.startsWith("https://") &&
      check.source_link.includes("law.go.kr"), must,
    label + " source must link to the official law service: " + spec.article);
    assert(/(?:Z|[+-]\d{2}:\d{2})$/u.test(check.retrieved_at) &&
      Number.isFinite(Date.parse(check.retrieved_at)), must,
    label + " source retrieval must include a timezone: " + spec.article);
    const age = Date.now() - Date.parse(check.retrieved_at);
    assert(age >= -5 * 60 * 1000 && age <= 24 * 60 * 60 * 1000, must,
      label + " source retrieval must be fresh: " + spec.article);
    same(kstDate(new Date(check.retrieved_at)), calculationDate,
      label + " source must be retrieved on the projection KST date: " + spec.article);

    const source = evidenceRows.find((row) => row.instrument_id === spec.instrument &&
      row.locator === spec.locator && row.article === spec.article && row.document?.law_id === spec.law);
    assert(source, must, label + " must include the exact fetched source row: " + spec.article);
    const document = source.document;
    same(source.scope, "current_law_not_historical", label + " source scope must be current law: " + spec.article);
    same(document.status, "ok", label + " source identity must be successful: " + spec.article);
    same(document.verification, "fetched_text_not_compared", label + " source must remain unpromoted: " + spec.article);
    same(document.text_sha256, check.actual_text_sha256, label + " source digest must match calculation basis: " + spec.article);
    same(document.effective_date, check.effective_date, label + " law version must match the basis: " + spec.article);
    same(document.article?.article_effective_date, check.article_effective_date,
      label + " article version must match the basis: " + spec.article);
    same(document.retrieved_at, check.retrieved_at, label + " retrieval timestamp must match the basis: " + spec.article);
    same(document.source_link, check.source_link, label + " source link must match the basis: " + spec.article);
    same(document.article?.label, spec.article, label + " article label must match the selector: " + spec.article);
    same(document.article?.truncated, false, label + " source must contain the complete article: " + spec.article);
    assert(typeof document.law_name === "string" && document.law_name.length > 0 &&
      typeof document.promulgation_no === "string" && document.promulgation_no.length > 0 &&
      typeof document.article?.text === "string" && document.article.text.trim().length > 0, must,
    label + " source identity and full text are required: " + spec.article);
    const bodyHash = createHashHex(document.article.text);
    same(bodyHash, check.actual_text_sha256, label + " complete source text must match its digest: " + spec.article);
    same(document.text_check_draft?.law_id, spec.law, label + " source draft law ID must match: " + spec.article);
    same(document.text_check_draft?.promulgation_no, document.promulgation_no,
      label + " source draft promulgation must match: " + spec.article);
    same(document.text_check_draft?.effective_date, check.effective_date,
      label + " source draft effective date must match: " + spec.article);

    const body = normalizeText(document.article.text);
    for (const group of spec.groups) {
      assert(group.some((needle) => body.includes(normalizeText(needle))), must,
        label + " official text must support the annual rule semantics: " + spec.article);
    }
  }
}

function createHashHex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertCalculation(result, expected, calculationDate, must, same, equivalent, label) {
  const calculation = result?.annual_other_calculation;
  assert(calculation && typeof calculation === "object", must, label + " must include annual_other_calculation");
  same(calculation.status, "computed", label + " annual projection must be computed");
  same(calculation.recipient_id, RECIPIENT, label + " must retain the distinct annual recipient");
  same(calculation.tax_year, 2026, label + " must retain the supported projection year");
  same(calculation.projection_as_of, calculationDate, label + " must retain the projection date");
  same(calculation.scope, "full_year_current_law_projection", label + " must label the projection scope");
  equivalent(calculation.rule_ids, ANNUAL_RULE_IDS, label + " must use all eight annual rules in order");
  for (const field of AMOUNT_FIELDS) {
    same(calculation[field], expected[field], label + "." + field + " must match an independent expected value");
  }
  for (const field of ["actual_receipt_count", "projected_receipt_count", "actual_expense_component_count",
    "projected_expense_component_count"]) {
    if (expected[field] !== undefined) same(calculation[field], expected[field], label + "." + field + " must match");
  }
  same(calculation.separate_taxation_eligible, expected.separate_taxation_eligible,
    label + " must report the conditional separate-tax eligibility result");
  same(calculation.regime_result, expected.regime_result, label + " must report the selected regime outcome");
  same(calculation.final_payable, null, label + " must not present a final payable amount");
  same(calculation.refund, null, label + " must not present a refund");
  same(calculation.business_loss_offset, null, label + " must not calculate business-loss offsets");
  same(calculation.loss_carryforward, null, label + " must not calculate a loss carryforward");
  same(calculation.fact_verification, "user_supplied_unverified", label + " facts must remain unverified");
  same(calculation.output_review, "pending", label + " output must remain pending review");
  assert(Array.isArray(calculation.case_reconciliations) && calculation.case_reconciliations.length === expected.case_count,
    must, label + " must preserve the expected number of factual cases");
  assert(Array.isArray(result.withholding_calculations) && result.withholding_calculations.length === 0,
    must, label + " is annual-only and must not create payer withholding rows");
  assertBasis(result, calculation, calculationDate, must, same, equivalent, label);
  return calculation;
}

function assertNoTaxConclusion(result, allowedStatuses, must, same, label, diagnosticNegative = false) {
  const calculation = result?.annual_other_calculation;
  assert(calculation && typeof calculation === "object", must, label + " must expose annual diagnostics");
  assert(allowedStatuses.includes(calculation.status), must, label + " must use a typed noncomputed status");
  for (const field of TAX_CONCLUSION_FIELDS) {
    same(calculation[field], null, label + "." + field + " must not contain a tax conclusion");
  }
  same(calculation.final_payable, null, label + " must not expose a final payable amount");
  same(calculation.refund, null, label + " must not expose a refund");
  same(calculation.regime_result, null, label + " must not contain a regime conclusion");
  same(calculation.separate_taxation_eligible, null, label + " must not contain a regime-eligibility conclusion");
  if (!diagnosticNegative) {
    for (const field of AMOUNT_FIELDS) {
      same(calculation[field], null, label + "." + field + " must remain empty");
    }
    for (const field of ["actual_receipt_count", "projected_receipt_count", "actual_expense_component_count",
      "projected_expense_component_count"]) {
      same(calculation[field], null, label + "." + field + " must remain empty");
    }
    assert(Array.isArray(calculation.case_reconciliations) && calculation.case_reconciliations.length === 0,
      must, label + " must not expose case reconciliation rows");
  }
  return calculation;
}

function assertNoAnnualComputedAssessments(answer, must, label) {
  const assessments = answer?.assessments ?? [];
  const annual = assessments.filter((item) => String(item.card_id ?? "").startsWith("tax.wh-calc-annual-other-"));
  must(annual.every((item) => item.outcome !== "computed_value"),
    label + " must not emit computed annual tax assessments");
}

function assertPractitionerAnnual(answer, expected, must, same, label) {
  const sections = answer?.perspective_view?.sections?.annual_other_calculation;
  must(Array.isArray(sections) && sections.length > 0,
    label + " must include the annual projection section");
  const text = sections.map((row) => String(row.text ?? "")).join("\n");
  for (const value of [RECIPIENT, "2026", "full_year_current_law_projection", expected.income, expected.national,
    expected.local, "review=pending", "user_supplied_unverified"]) {
    must(text.includes(value), label + " annual section must retain " + value);
  }
  const annualAssessments = (answer.assessments ?? []).filter((item) =>
    ["tax.wh-calc-annual-other-national", "tax.wh-calc-annual-other-local"].includes(item.card_id));
  same(annualAssessments.length, 2, label + " must contain national and local annual assessments only");
  const national = annualAssessments.find((item) => item.card_id === "tax.wh-calc-annual-other-national");
  const local = annualAssessments.find((item) => item.card_id === "tax.wh-calc-annual-other-local");
  for (const [assessment, value] of [[national, expected.national], [local, expected.local]]) {
    same(assessment.outcome, "computed_value", label + " tax assessment must be computed");
    same(assessment.computed?.value, value, label + " must retain the exact won amount");
    same(assessment.computed?.unit, "won", label + " assessment unit must be won");
    same(assessment.computed?.currency, "KRW", label + " assessment currency must be KRW");
    same(assessment.reliance, "do_not_rely_verify_source", label + " assessment must remain pending source review");
    must(assessment.notices.includes("review=pending") &&
      assessment.notices.includes("fact_verification=user_supplied_unverified"),
    label + " assessment must retain its review and fact-verification limits");
  }
  return sections;
}

export async function runAnnualOtherLive({ call, calculationDate, must, same, equivalent }) {
  const listed = await call("tax_list_rule_cards", { workflow_id: "withholding-payment" });
  const cardRows = listed.rules ?? listed.cards ?? listed.rule_cards;
  assert(Array.isArray(cardRows), must, "Annual live preflight must return the withholding rule cards");
  const calculationRows = cardRows.filter((row) => String(row.id ?? row.rule_id).startsWith("WH-CALC-"));
  same(calculationRows.length, 30, "Installed withholding registry must expose 30 calculation cards");
  const cardIds = calculationRows.map((row) => row.id ?? row.rule_id);
  equivalent(cardIds.filter((id) => String(id).startsWith("WH-CALC-ANNUAL-OTHER-")), ANNUAL_RULE_IDS,
    "Installed withholding registry must contain the eight annual rule cards");

  const calculations = {};
  calculations.lecture = await call("tax_plan_work", {
    matter: matter(calculationDate, [
      caseRow("annual-lecture-actual", "lecture", [receipt("lecture-actual", 10000000, {
        received_on: "2026-10-01", record_kind: "actual", payer_id: "annual-payer-lecture",
      })]),
      caseRow("annual-lecture-projected", "lecture", [receipt("lecture-projected", 5000000, {
        received_on: "2026-11-01", record_kind: "projected", payer_id: "annual-payer-second",
      })]),
    ]), include_evidence: true, include_filling_guide: false,
  });
  assertCalculation(calculations.lecture, {
    gross_amount: "15000000", expense_amount: "9000000", signed_reconciliation_amount: "6000000",
    excluded_case_income: "0", annual_other_income: "6000000", basic_deduction: "1500000",
    tax_base: "4500000", national_calculated_tax: "270000", local_calculated_tax: "27000",
    total_calculated_tax: "297000", separate_taxation_eligible: false,
    regime_result: "comprehensive_required", actual_receipt_count: 1, projected_receipt_count: 1,
    actual_expense_component_count: 0, projected_expense_component_count: 0, case_count: 2,
  }, calculationDate, must, same, equivalent, "Annual lecture projection");

  calculations.advisory = await call("tax_plan_work", {
    matter: matter(calculationDate, [
      caseRow("annual-advisory-actual-costs", "expert_advisory", [
        receipt("advisory-receipt-a", 1000000, { received_on: "2026-10-01", expense_record_kind: "actual",
          actual_expense_amount: 1200000, payer_id: "annual-payer-advisory" }),
        receipt("advisory-receipt-b", 1000000, { received_on: "2026-10-02", expense_record_kind: "actual",
          actual_expense_amount: 200000, payer_id: "annual-payer-advisory" }),
      ], { expense_method: "actual" }),
      caseRow("annual-advisory-standard", "expert_advisory", [receipt("advisory-standard", 5000000, {
        payer_id: "annual-payer-second",
      })]),
    ]), include_evidence: true, include_filling_guide: false,
  });
  const advisory = assertCalculation(calculations.advisory, {
    gross_amount: "7000000", expense_amount: "4400000", signed_reconciliation_amount: "2600000",
    excluded_case_income: "0", annual_other_income: "2600000", basic_deduction: "1500000",
    tax_base: "1100000", national_calculated_tax: "66000", local_calculated_tax: "6600",
    total_calculated_tax: "72600", separate_taxation_eligible: true,
    regime_result: "comprehensive_elected", actual_receipt_count: 3, projected_receipt_count: 0,
    actual_expense_component_count: 2, projected_expense_component_count: 0, case_count: 2,
  }, calculationDate, must, same, equivalent, "Annual advisory projection");
  same(advisory.case_reconciliations[0].signed_difference, "600000",
    "Within-case negative receipt component must reconcile before the annual minimum");
  same(advisory.case_reconciliations[0].receipt_components[0].signed_difference, "-200000",
    "Actual expense above a receipt must retain its signed receipt component");

  calculations.manuscript_split_case = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-manuscript-one-case", "manuscript_fee", [
      receipt("manuscript-split-a", 100000, { received_on: "2026-10-01" }),
      receipt("manuscript-split-b", 100000, { received_on: "2026-10-02" }),
    ])]), include_evidence: true, include_filling_guide: false,
  });
  const manuscript = assertCalculation(calculations.manuscript_split_case, {
    gross_amount: "200000", expense_amount: "120000", signed_reconciliation_amount: "80000",
    excluded_case_income: "0", annual_other_income: "80000", basic_deduction: "80000",
    tax_base: "0", national_calculated_tax: "0", local_calculated_tax: "0", total_calculated_tax: "0",
    separate_taxation_eligible: true, regime_result: "comprehensive_elected", actual_receipt_count: 2,
    projected_receipt_count: 0, actual_expense_component_count: 0, projected_expense_component_count: 0,
    case_count: 1,
  }, calculationDate, must, same, equivalent, "Annual manuscript split-case projection");
  same(manuscript.case_reconciliations[0].signed_difference, "80000",
    "Split receipts in one factual case must aggregate before the 50,000-won threshold");

  calculations.broadcast_actual = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-broadcast-actual", "broadcast_commentary", [
      receipt("broadcast-actual", 1000000, { received_on: "2026-10-03", expense_record_kind: "actual",
        actual_expense_amount: 700000 }),
    ], { expense_method: "actual" })]), include_evidence: true, include_filling_guide: false,
  });
  assertCalculation(calculations.broadcast_actual, {
    gross_amount: "1000000", expense_amount: "700000", signed_reconciliation_amount: "300000",
    excluded_case_income: "0", annual_other_income: "300000", basic_deduction: "300000",
    tax_base: "0", national_calculated_tax: "0", local_calculated_tax: "0", total_calculated_tax: "0",
    separate_taxation_eligible: true, regime_result: "comprehensive_elected", actual_receipt_count: 1,
    projected_receipt_count: 0, actual_expense_component_count: 1, projected_expense_component_count: 0,
    case_count: 1,
  }, calculationDate, must, same, equivalent, "Annual broadcast actual-cost projection");

  calculations.exact_threshold = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-exact-three-million", "lecture", [
      receipt("exact-three-million", 7500000),
    ])]), include_evidence: true, include_filling_guide: false,
  });
  assertCalculation(calculations.exact_threshold, {
    gross_amount: "7500000", expense_amount: "4500000", signed_reconciliation_amount: "3000000",
    excluded_case_income: "0", annual_other_income: "3000000", basic_deduction: "1500000",
    tax_base: "1500000", national_calculated_tax: "90000", local_calculated_tax: "9000",
    total_calculated_tax: "99000", separate_taxation_eligible: true, regime_result: "comprehensive_elected",
    actual_receipt_count: 1, projected_receipt_count: 0, actual_expense_component_count: 0,
    projected_expense_component_count: 0, case_count: 1,
  }, calculationDate, must, same, equivalent, "Annual exact regime threshold projection");

  calculations.above_threshold_fraction = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-above-three-million", "lecture", [
      receipt("above-three-million-fraction", 7500001),
    ])]), include_evidence: true, include_filling_guide: false,
  });
  assertCalculation(calculations.above_threshold_fraction, {
    gross_amount: "7500001", expense_amount: "4500000.6", signed_reconciliation_amount: "3000000.4",
    excluded_case_income: "0", annual_other_income: "3000000.4", basic_deduction: "1500000",
    tax_base: "1500000", national_calculated_tax: "90000", local_calculated_tax: "9000",
    total_calculated_tax: "99000", separate_taxation_eligible: false, regime_result: "comprehensive_required",
    actual_receipt_count: 1, projected_receipt_count: 0, actual_expense_component_count: 0,
    projected_expense_component_count: 0, case_count: 1,
  }, calculationDate, must, same, equivalent, "Annual above-threshold fractional projection");

  calculations.fractional_tax = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-fractional-tax", "lecture", [
      receipt("fractional-tax-base", 3750005),
    ])]), include_evidence: true, include_filling_guide: false,
  });
  assertCalculation(calculations.fractional_tax, {
    gross_amount: "3750005", expense_amount: "2250003", signed_reconciliation_amount: "1500002",
    excluded_case_income: "0", annual_other_income: "1500002", basic_deduction: "1500000",
    tax_base: "2", national_calculated_tax: "0.12", local_calculated_tax: "0.012",
    total_calculated_tax: "0.132", separate_taxation_eligible: true, regime_result: "comprehensive_elected",
    actual_receipt_count: 1, projected_receipt_count: 0, actual_expense_component_count: 0,
    projected_expense_component_count: 0, case_count: 1,
  }, calculationDate, must, same, equivalent, "Annual fractional pre-collection tax projection");

  calculations.small_cases = await call("tax_plan_work", {
    matter: matter(calculationDate, [
      caseRow("annual-small-case-a", "lecture", [receipt("small-case-a", 125000)]),
      caseRow("annual-small-case-b", "expert_advisory", [receipt("small-case-b", 125000)]),
    ]), include_evidence: true, include_filling_guide: false,
  });
  assertCalculation(calculations.small_cases, {
    gross_amount: "250000", expense_amount: "150000", signed_reconciliation_amount: "100000",
    excluded_case_income: "100000", annual_other_income: "0", basic_deduction: "0",
    tax_base: "0", national_calculated_tax: "0", local_calculated_tax: "0", total_calculated_tax: "0",
    separate_taxation_eligible: true, regime_result: "comprehensive_elected", actual_receipt_count: 2,
    projected_receipt_count: 0, actual_expense_component_count: 0, projected_expense_component_count: 0,
    case_count: 2,
  }, calculationDate, must, same, equivalent, "Annual small factual cases projection");

  calculations.top_tier = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-top-tier", "lecture", [
      receipt("top-tier-receipt", 2525000000),
    ])]), include_evidence: true, include_filling_guide: false,
  });
  assertCalculation(calculations.top_tier, {
    gross_amount: "2525000000", expense_amount: "1515000000", signed_reconciliation_amount: "1010000000",
    excluded_case_income: "0", annual_other_income: "1010000000", basic_deduction: "1500000",
    tax_base: "1008500000", national_calculated_tax: "387885000", local_calculated_tax: "38788500",
    total_calculated_tax: "426673500", separate_taxation_eligible: false, regime_result: "comprehensive_required",
    actual_receipt_count: 1, projected_receipt_count: 0, actual_expense_component_count: 0,
    projected_expense_component_count: 0, case_count: 1,
  }, calculationDate, must, same, equivalent, "Annual top-tier projection");

  calculations.negative_complete_case = await call("tax_plan_work", {
    matter: matter(calculationDate, [
      caseRow("annual-negative-case", "expert_advisory", [receipt("negative-receipt", 1000000, {
        expense_record_kind: "actual", actual_expense_amount: 1200000,
      })], { expense_method: "actual" }),
      caseRow("annual-positive-case", "lecture", [receipt("positive-receipt", 5000000)]),
    ]), include_evidence: true, include_filling_guide: false,
  });
  const negative = calculations.negative_complete_case.annual_other_calculation;
  assertNoTaxConclusion(calculations.negative_complete_case, ["blocked"], must, same,
    "Annual genuinely negative complete case", true);
  assertBasis(calculations.negative_complete_case, negative, calculationDate, must, same, equivalent,
    "Annual genuinely negative complete case");
  same(negative.gross_amount, "6000000", "Negative-case diagnostics must retain gross receipts");
  same(negative.expense_amount, "4200000", "Negative-case diagnostics must retain expenses");
  same(negative.signed_reconciliation_amount, "1800000",
    "Negative complete case must retain the signed financial reconciliation");
  same(negative.excluded_case_income, null, "Negative complete case must not conclude excluded taxable income");
  same(negative.actual_receipt_count, 2, "Negative-case diagnostics must retain actual receipt count");
  same(negative.projected_receipt_count, 0, "Negative-case diagnostics must retain projected receipt count");
  same(negative.actual_expense_component_count, 1, "Negative-case diagnostics must retain actual expense count");
  same(negative.projected_expense_component_count, 0, "Negative-case diagnostics must retain projected expense count");
  same(negative.case_reconciliations[0].minimum_treatment, "unresolved",
    "Negative factual case must retain unresolved minimum treatment");
  same(negative.case_reconciliations[0].signed_difference, "-200000",
    "Negative factual case must retain its signed case difference");
  same(negative.case_reconciliations[1].minimum_treatment, "taxable",
    "Nonnegative positive case must retain its factual-case treatment");
  same(negative.case_reconciliations[1].signed_difference, "2000000",
    "Positive factual case must retain its signed difference");
  same(negative.regime_result, null, "Negative complete case must block regime conclusions");
  same(negative.separate_taxation_eligible, null, "Negative complete case must block regime eligibility conclusions");
  must(negative.reason_codes.includes("annual_negative_case_interpretation_required"),
    "Negative complete case must identify the unresolved legal interpretation");

  const negative_cases = {};
  negative_cases.identity_mismatch = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-mismatch-case", "lecture", [receipt("mismatch-receipt", 1000000, {
      recipient_id: "different-live-recipient",
    })])]), include_evidence: true, include_filling_guide: false,
  });
  assertNoTaxConclusion(negative_cases.identity_mismatch, ["unsupported"], must, same,
    "Annual recipient identity mismatch");

  negative_cases.incomplete_case = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-incomplete-case", "lecture", [receipt("incomplete-receipt", 1000000)], {
      factual_case_complete_confirmed: false,
    })]), include_evidence: true, include_filling_guide: false,
  });
  assertNoTaxConclusion(negative_cases.incomplete_case, ["unsupported"], must, same,
    "Annual incomplete factual case");

  negative_cases.other_income_present = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-other-income-case", "lecture", [receipt("other-income-receipt", 1000000)])], {
      no_other_income_confirmed: false,
    }), include_evidence: true, include_filling_guide: false,
  });
  assertNoTaxConclusion(negative_cases.other_income_present, ["unsupported"], must, same,
    "Annual unsupported other-income scope");

  negative_cases.missing_expense_method = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-missing-method-case", "lecture", [receipt("missing-method-receipt", 1000000)], {
      expense_method: "unknown",
    })]), include_evidence: true, include_filling_guide: false,
  });
  const missingMethod = assertNoTaxConclusion(negative_cases.missing_expense_method, ["needs_facts"], must, same,
    "Annual missing expense method");
  assert(Array.isArray(missingMethod.missing_facts) && missingMethod.missing_facts.length > 0, must,
    "Annual missing expense method must return a typed fact question");
  const missingMethodQuestions = negative_cases.missing_expense_method.questions ?? [];
  assert(missingMethodQuestions.length > 0 && missingMethodQuestions.every((item) =>
    String(item.fact_key ?? "").startsWith("annual_other.") && !String(item.fact_key).includes("[")), must,
  "Annual fact questions must use flat registered keys without case identifiers");

  negative_cases.no_evidence = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-no-evidence-case", "lecture", [receipt("no-evidence-receipt", 1000000)])]),
    include_evidence: false, include_filling_guide: false,
  });
  const noEvidence = assertNoTaxConclusion(negative_cases.no_evidence, ["blocked"], must, same,
    "Annual evidence-disabled calculation");
  assert(Array.isArray(noEvidence.basis_checks) && noEvidence.basis_checks.length === EXPECTED_BASIS.length &&
    noEvidence.basis_checks.every((check) => check.status === "not_requested"), must,
  "Annual calculation without evidence must leave every source check unrequested");
  must(noEvidence.reason_codes.includes("annual_basis_not_matched"),
    "Annual calculation without matched evidence must identify its blocked basis");

  const answers = {};
  answers.lecture = await call("tax_answer_practitioner_question", {
    matter: matter(calculationDate, [caseRow("annual-answer-lecture", "lecture", [receipt("answer-lecture", 10000000)])]),
    include_evidence: true,
  });
  assertPractitionerAnnual(answers.lecture, { income: "4000000", national: "150000", local: "15000" },
    must, same, "Practitioner annual lecture projection");

  answers.advisory = await call("tax_answer_practitioner_question", {
    matter: matter(calculationDate, [caseRow("annual-answer-advisory", "expert_advisory", [
      receipt("answer-advisory-a", 1000000, { expense_record_kind: "actual", actual_expense_amount: 1200000 }),
      receipt("answer-advisory-b", 1000000, { expense_record_kind: "actual", actual_expense_amount: 200000 }),
      ], { expense_method: "actual" }), caseRow("annual-answer-advisory-standard", "expert_advisory", [
        receipt("answer-advisory-standard", 5000000),
      ])]), include_evidence: true,
  });
  assertPractitionerAnnual(answers.advisory, { income: "2600000", national: "66000", local: "6600" },
    must, same, "Practitioner annual advisory projection");

  answers.fractional_tax = await call("tax_answer_practitioner_question", {
    matter: matter(calculationDate, [caseRow("annual-answer-fractional-tax", "lecture", [
      receipt("answer-fractional-tax-base", 3750005),
    ])]), include_evidence: true,
  });
  assertPractitionerAnnual(answers.fractional_tax, { income: "1500002", national: "0.12", local: "0.012" },
    must, same, "Practitioner annual fractional tax projection");

  answers.negative_case = await call("tax_answer_practitioner_question", {
    matter: matter(calculationDate, [
      caseRow("annual-answer-negative", "expert_advisory", [receipt("answer-negative-receipt", 1000000, {
        expense_record_kind: "actual", actual_expense_amount: 1200000,
      })], { expense_method: "actual" }),
      caseRow("annual-answer-positive", "lecture", [receipt("answer-positive-receipt", 5000000)]),
    ]), include_evidence: true,
  });
  assertNoAnnualComputedAssessments(answers.negative_case, must, "Practitioner negative complete case");
  must(String(JSON.stringify(answers.negative_case)).includes("annual_negative_case_interpretation_required"),
    "Practitioner negative case must retain the unresolved interpretation boundary");

  answers.missing_facts = await call("tax_answer_practitioner_question", {
    matter: matter(calculationDate, [caseRow("annual-answer-missing", "lecture", [receipt("answer-missing", 1000000)])], {
      tax_regime: "unknown",
    }), include_evidence: true,
  });
  assertNoAnnualComputedAssessments(answers.missing_facts, must, "Practitioner annual missing facts");
  must(Array.isArray(answers.missing_facts.pending_facts) && answers.missing_facts.pending_facts.some((item) =>
    String(item.fact_key ?? "").startsWith("annual_other.")),
  "Practitioner annual missing facts must remain a precise pending fact");

  return {
    calculations,
    answers,
    negative_cases,
    summary: {
      annual_calculations: Object.keys(calculations).length,
      practitioner_answers: Object.keys(answers).length,
      negative_cases: Object.keys(negative_cases).length,
      annual_cards: ANNUAL_RULE_IDS.length,
      annual_documents: EXPECTED_BASIS.length,
      classifications: ["lecture", "manuscript_fee", "expert_advisory", "broadcast_commentary"],
      independent_expected_tables: true,
    },
  };
}

export async function runAnnualOtherNoCredentials({ call, calculationDate, must, same }) {
  const result = await call("tax_plan_work", {
    matter: matter(calculationDate, [caseRow("annual-no-credential-case", "lecture", [
      receipt("annual-no-credential-receipt", 1000000),
    ])]), include_evidence: true, include_filling_guide: false,
  });
  const calculation = assertNoTaxConclusion(result, ["blocked"], must, same,
    "Annual calculation with missing credentials");
  assert(AMOUNT_FIELDS.every((field) => calculation[field] === null), must,
    "Missing credentials must leave every annual amount empty");
  must(calculation.reason_codes.includes("annual_basis_not_matched"),
    "Annual missing-credential result must identify its blocked basis");
  assert(Array.isArray(calculation.basis_checks) && calculation.basis_checks.length === EXPECTED_BASIS.length, must,
    "Annual missing-credential result must retain all expected basis checks");
  assert(calculation.basis_checks.every((check) => check.status === "unavailable" &&
    check.reason === "credential_missing"), must,
  "Annual missing-credential basis checks must report credential_missing");
  return result;
}
