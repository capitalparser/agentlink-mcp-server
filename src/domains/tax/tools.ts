/**
 * Tax domain tools (세무 도메인 도구) bridged to agentlink-domain-tax-mcp.
 * All tools are read-only. Selected lecture and personal-service payments can
 * include scoped withholding calculations when supplied facts and current-law evidence pass.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { TaxDomainClientLike } from "./bridge.js";
import { isBridgeError } from "./bridge.js";
import type { ToolContract } from "../discovery.js";

const NOTICE =
  " Results are review drafts. Per-payment withholding calculations are limited to explicitly selected business_lecture, other_lecture, and business_personal_service profiles when complete user facts and matched current-law evidence are available; whole-matter applicability remains not_determined. The personal-service profile covers only these explicitly selected continuing independent services: authorship (저술 용역), artwork_design (도안 용역), illustration (삽화 용역), composition (작곡 용역), voice_acting (성우 용역), entertainment_direction (연예에 관한 연출 용역), entertainment_filming (연예에 관한 촬영 용역), proofreading (교정 용역), translation (번역 용역), and shorthand (속기 용역). This scope applies only to those selected service types. Facts and calculations remain pending review, and no filing decision or submission is issued." +
  " (결과는 검토용 초안입니다. 지급별 원천징수 계산은 명시적으로 선택한 business_lecture, other_lecture 또는 business_personal_service 유형 중 사실이 모두 제공되고 현행 법령 근거가 대조된 경우에만 제공합니다. 개인 인적용역 유형은 계속적·독립적으로 제공하는 저술 용역·도안 용역·삽화 용역·작곡 용역·성우 용역·연예에 관한 연출 용역·연예에 관한 촬영 용역·교정 용역·번역 용역·속기 용역만 다룹니다. 전체 사안의 적용 여부는 not_determined로 유지되며, 사실과 계산은 검토 대기 중이고 신고 판단이나 제출을 대행하지 않습니다.)";

const annotations = (openWorld: boolean) => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: openWorld,
});

export interface RegisteredDomainTools {
  contracts: ToolContract[];
  handles: RegisteredTool[];
}

export function registerTaxDomainTools(server: McpServer, client: TaxDomainClientLike): RegisteredDomainTools {
  const contracts: ToolContract[] = [];
  const handles: RegisteredTool[] = [];
  const reg = (
    name: string,
    domainTool: string,
    description: string,
    shape: z.ZodRawShape,
    openWorld = false,
  ) => {
    const handle = server.tool(name, description + NOTICE, shape, annotations(openWorld), async (args) => {
      const result = await client.callToolResult(domainTool, args as Record<string, unknown>);
      return { ...result, ...(isBridgeError(result.structuredContent) ? { isError: true } : {}) };
    });
    handle.disable();
    handles.push(handle);
    contracts.push({ publicName: name, domainName: domainTool, inputSchema: toJsonSchemaCompat(z.object(shape), { pipeStrategy: "input" }) });
  };

  reg("tax_list_workflows", "list_tax_workflows",
    "List the tax sub-workflows and their implementation status (세무 하위 업무와 구현 상태 목록).", {});

  reg("tax_get_workflow_contract", "get_workflow_contract",
    "Get required facts, roles and status contract of a workflow (업무의 필요 사실·역할·상태 계약).",
    { workflow_id: z.string().describe("Workflow id (업무 ID)") });

  reg("tax_get_automation_offer", "get_automation_offer",
    "Get automation offers separately from legal content (법률 내용과 분리된 자동화 안내 조회).",
    { workflow_id: z.string().max(80).optional() });

  reg("tax_plan_work", "plan_tax_work",
    "Plan tax work from a TaxMatter: questions, evidence, deadline candidates, unresolved items, and scoped draft withholding calculations for the supported lecture profiles or the ten explicitly listed continuing personal-service subtypes when required facts and current-law evidence are complete (TaxMatter 업무 계획·질문·근거·기한 후보·미해결 항목 및 요건 충족 시 두 강의 유형 또는 열 가지로 한정한 계속적 인적용역의 지급별 원천징수 계산 초안).",
    {
      matter: z.object({}).passthrough().describe("TaxMatter object (matter_id, workflow_id, as_of, taxpayer, facts)"),
      include_evidence: z.boolean().optional().describe("Attach current law text, official form links and evidence candidates from law.go.kr; selected lecture and personal-service calculations require matched current-law evidence (default true, 현행 법령 본문·서식 원본·근거 후보 첨부; 선택한 강의·인적용역 계산은 현행 법령 대조 필요)"),
      include_filling_guide: z.boolean().optional().describe("Attach a draft filling guide mapping payments to form fields; not a tax computation (default true, 작성 안내 초안 첨부)"),
    }, true);

  reg("tax_answer_practitioner_question", "answer_practitioner_question",
    "Answer a practitioner question using the common practitioner packet. It may project scoped draft withholding calculations for the supported lecture profiles and ten explicitly listed continuing personal-service subtypes only when complete facts and matched current-law evidence are available; the final decision is not issued.",
    {
      matter: z.object({}).passthrough().describe("TaxMatter object"),
      question: z.string().max(500).nullable().optional(),
      conversation_state: z.object({}).passthrough().nullable().optional(),
      include_evidence: z.boolean().optional().describe("Opt in to current law text and unreviewed interpretation evidence; selected lecture and personal-service calculations require matched current-law evidence (default false, 현행 법령 본문·미검토 해석 후보 조회; 선택한 강의·인적용역 계산은 현행 법령 대조 필요)"),
    }, true);

  reg("tax_export_rule_cards", "export_rule_cards",
    "Export common rule cards or the separate practice_signal registry.",
    {
      layer: z.enum(["rules", "practice"]).default("rules"),
      workflow_id: z.string().max(80).nullable().optional(),
    });

  reg("tax_list_rule_cards", "list_rule_cards",
    "List rule cards of a workflow with verification status (업무의 규칙 카드와 원문 대조 상태).",
    { workflow_id: z.string().describe("Workflow id (업무 ID)") });

  reg("tax_search_law", "search_tax_law",
    "Search law.go.kr for statutes, administrative rules or interpretations; candidates only (법령·행정규칙·해석례 검색, 후보일 뿐).",
    {
      query: z.string().min(1).max(200).describe("Search query (검색어)"),
      target: z.enum(["law", "admrul", "expc"]).default("law").describe("law | admrul | expc"),
      limit: z.number().int().min(1).max(20).default(10).describe("Max results (1-20)"),
    }, true);

  reg("tax_get_law_article", "get_law_article",
    "Fetch current official text for one statute article; this does not establish historical wording, applicability, or completed text verification (법령 조문 본문 조회, 과거 문구·적용 여부·원문 대조 완료를 확정하지 않음).",
    {
      law_name: z.string().min(1).max(100).describe("Law name (법령명)"),
      article: z.string().min(1).max(20).describe("Article locator (조문 위치)"),
      law_id: z.string().max(10).nullable().optional().describe("Optional law ID from tax_search_law (법령 ID)"),
    }, true);

  reg("tax_check_business_status", "check_business_status",
    "Check NTS business registration status (국세청 사업자등록 상태 조회: 계속/휴업/폐업).",
    { b_nos: z.array(z.string()).min(1).max(100).describe("Business numbers (사업자등록번호 목록)") }, true);

  reg("tax_list_practice_cards", "list_practice_cards",
    "List practice cards (unverified practitioner signals) of a workflow, optionally filtered by topic (업무의 실무 카드, 미검증 실무 신호).",
    {
      workflow_id: z.string().describe("Workflow id (업무 ID)"),
      topic_query: z.string().max(100).optional().describe("Substring filter (주제 부분 문자열 필터)"),
    });

  reg("tax_list_holidays", "list_holidays",
    "List public holidays of a year from KASI (해당 연도 공휴일·대체공휴일 목록).",
    { year: z.number().int().min(1900).max(2100).describe("Year (1900-2100)") }, true);

  reg("tax_get_schedule", "get_tax_schedule",
    "NTS tax calendar entries of a year; deadline candidates only (국세청 세무일정, 기한 후보일 뿐).",
    {
      year: z.number().int().min(2000).max(2100).describe("Year (2000-2100)"),
      query: z.string().max(100).optional().describe("Substring of title/note (세무내용·비고 필터)"),
      month: z.number().int().min(1).max(12).optional().describe("Month filter (1-12)"),
      limit: z.number().int().min(1).max(300).default(100).describe("Max entries (1-300)"),
    }, true);

  reg("tax_find_office", "find_tax_office",
    "Find candidate tax offices by office name or district (세무서명·관할구역으로 관할 세무서 후보 검색).",
    { query: z.string().min(1).max(100).describe("Office name or district (세무서명 또는 관할구역)") }, true);

  reg("tax_search_interpretations", "search_tax_interpretations",
    "Search tax interpretation sources: NTS/MOEF/MOIS interpretations, tribunal decisions, precedents, administrative rules; candidates only (세법 해석·재결·판례 검색, 후보일 뿐).",
    {
      query: z.string().min(1).max(200).describe("Search query (검색어)"),
      source: z.enum([
        "nts_interpretation", "moef_interpretation", "mois_interpretation",
        "tribunal_decision", "precedent", "admin_rule",
      ]).default("nts_interpretation").describe("Interpretation source (해석 출처)"),
      limit: z.number().int().min(1).max(20).default(10).describe("Max results (1-20)"),
    }, true);

  reg("tax_get_tribunal_decision", "get_tribunal_decision",
    "Get a tax tribunal decision detail by id from tax_search_interpretations source=tribunal_decision (조세심판원 재결례 상세).",
    { id: z.string().regex(/^\d{1,12}$/).describe("Decision id (재결례 일련번호)") }, true);

  reg("tax_search_forms", "search_tax_forms",
    "Search law.go.kr appendices/forms (licbyl) for official form source HWP/PDF links; not filling guidance (법령정보센터 별표·서식 검색, 서식 원본 링크).",
    {
      query: z.string().min(1).max(100).describe("Form name query (별표·서식명 검색어)"),
      law_name: z.string().optional().describe("Exact related law name filter, e.g. 소득세법 시행규칙 (관련법령명 정확 일치)"),
      limit: z.number().int().min(1).max(20).default(10).describe("Max results (1-20)"),
    }, true);

  reg("tax_list_form_guides", "list_form_guides",
    "List form filling guides and examples from the registry; links only, content unverified, not legal basis (서식 작성요령·예시 자료 목록).",
    { form_id: z.string().max(60).optional().describe("Form id; omit for all (서식 ID, 생략 시 전체)") });

  reg("tax_get_form_field_tips", "get_form_field_tips",
    "Get per-field tips of a form in three labeled layers: official instruction, practice signal, guide; do not mix layers (서식 칸별 작성 tips 3계층).",
    {
      form_id: z.string().min(1).max(60).describe("Form id (서식 ID)"),
      code: z.string().max(80).optional().describe("Field key, code (A25) or circled number (칸 key·코드·원문자)"),
      query: z.string().max(100).optional().describe("Substring of label/instruction (라벨·작성방법 필터)"),
      limit: z.number().int().min(1).max(50).default(20).describe("Max tips (1-50)"),
    });

  client.setStatusListener((status) => {
    for (const handle of handles) status.state === "ready" ? handle.enable() : handle.disable();
  });
  return { contracts, handles };
}
