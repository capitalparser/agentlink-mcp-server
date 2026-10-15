/**
 * Tax domain tools (세무 도메인 도구) bridged to agentlink-domain-tax-mcp.
 * All tools are read-only. Results are drafts: applicability is not
 * determined and no tax amount is computed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaxDomainClientLike } from "./bridge.js";
import { isBridgeError } from "./bridge.js";

const NOTICE =
  " Results are drafts for review; applicability is not determined and no tax amount is computed." +
  " (결과는 검토용 초안이며 적용 여부는 판단되지 않고 세액은 계산하지 않습니다.)";

const annotations = (openWorld: boolean) => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: openWorld,
});

export function registerTaxDomainTools(server: McpServer, client: TaxDomainClientLike): void {
  const reg = (
    name: string,
    domainTool: string,
    description: string,
    shape: z.ZodRawShape,
    openWorld = false,
  ) => {
    server.tool(name, description + NOTICE, shape, annotations(openWorld), async (args) => {
      const result = await client.callTool(domainTool, args as Record<string, unknown>);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        ...(isBridgeError(result) ? { isError: true } : {}),
      };
    });
  };

  reg("tax_list_workflows", "list_tax_workflows",
    "List the tax sub-workflows and their implementation status (세무 하위 업무와 구현 상태 목록).", {});

  reg("tax_get_workflow_contract", "get_workflow_contract",
    "Get required facts, roles and status contract of a workflow (업무의 필요 사실·역할·상태 계약).",
    { workflow_id: z.string().describe("Workflow id (업무 ID)") });

  reg("tax_plan_work", "plan_tax_work",
    "Plan tax work from a TaxMatter: questions, evidence, deadline candidates, unresolved items (TaxMatter로 업무 계획 초안 작성).",
    { matter: z.object({}).passthrough().describe("TaxMatter object (matter_id, workflow_id, as_of, taxpayer, facts)") });

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

  reg("tax_check_business_status", "check_business_status",
    "Check NTS business registration status (국세청 사업자등록 상태 조회: 계속/휴업/폐업).",
    { b_nos: z.array(z.string()).min(1).max(100).describe("Business numbers (사업자등록번호 목록)") }, true);
}
