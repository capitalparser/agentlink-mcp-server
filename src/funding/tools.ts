/** Funding tool registration. This is additive; legacy tools stay unchanged. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FundingProvider } from "./provider.js";
import {
  FundingOpportunitiesMcpOutputSchema,
  FundingOpportunitiesToolOutputSchema,
  FundingSearchInputSchema,
  FundingStatusMcpOutputSchema,
  FundingStatusToolOutputSchema,
  FundingWorkMcpOutputSchema,
  FundingWorkToolOutputSchema,
  WorkPlanInputSchema,
  isToolError,
  type FundingError,
  type FundingToolOutput,
} from "./types.js";
import { makeFundingError } from "./provider.js";

function resultForTool(
  value: unknown,
  outputSchema:
    | typeof FundingStatusToolOutputSchema
    | typeof FundingOpportunitiesToolOutputSchema
    | typeof FundingWorkToolOutputSchema
): {
  structuredContent: Record<string, unknown>;
  content: [{ type: "text"; text: string }];
  isError?: true;
} {
  const parsed = outputSchema.safeParse(value);
  const output: FundingToolOutput | FundingError = parsed.success
    ? (value as FundingToolOutput)
    : makeFundingError("CORE_UNAVAILABLE");
  let text: string;
  try {
    text = JSON.stringify(output, null, 2);
  } catch {
    const fallback = makeFundingError("CORE_UNAVAILABLE");
    return {
      structuredContent: fallback,
      content: [{ type: "text", text: JSON.stringify(fallback, null, 2) }],
      isError: true,
    };
  }
  return {
    structuredContent: output,
    content: [{ type: "text", text }],
    ...(isToolError(output) ? { isError: true as const } : {}),
  };
}

export function registerFundingTools(
  server: McpServer,
  provider: FundingProvider
): void {
  server.registerTool(
    "get_funding_status",
    {
      title: "Funding connector status",
      description:
        "Read local funding connector configuration and workflow availability. This does not call a funding provider or validate eligibility.",
      inputSchema: z.object({}).strict(),
      outputSchema: FundingStatusMcpOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => resultForTool(await provider.getFundingStatus(), FundingStatusToolOutputSchema)
  );

  server.registerTool(
    "search_funding_opportunities",
    {
      title: "Search funding opportunities",
      description:
        "Retrieve one bounded provider page of funding notices. Returned notices are candidates only; eligibility and awards are not assessed.",
      inputSchema: FundingSearchInputSchema,
      outputSchema: FundingOpportunitiesMcpOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      resultForTool(
        await provider.searchFundingOpportunities(input),
        FundingOpportunitiesToolOutputSchema
      )
  );

  server.registerTool(
    "get_funding_work_plan",
    {
      title: "Get funding work plan",
      description:
        "Run the existing host-configured subsidy or national R&D WorkRequest engine. The canonical WorkResult or WorkError is returned without summary or approval rewriting.",
      inputSchema: WorkPlanInputSchema,
      outputSchema: FundingWorkMcpOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ request }) =>
      resultForTool(
        await provider.getFundingWorkPlan(request),
        FundingWorkToolOutputSchema
      )
  );
}
