/** Funding-only contracts for the local Core adapter and MCP tools. */

import { z } from "zod";
import { isIP } from "node:net";

export const FUNDING_PROVIDER_IDS = [
  "data_go_kr_sme_support_15157820",
  "data_go_kr_subsidy_calls_15156853",
] as const;

export const FundingDomainSchema = z.enum(["subsidy", "national-rd"]);
export type FundingDomain = z.infer<typeof FundingDomainSchema>;

export const FundingErrorCodeSchema = z.enum([
  "CREDENTIAL_NOT_CONFIGURED",
  "CREDENTIAL_STORE_UNAVAILABLE",
  "ENDPOINT_UNVERIFIED",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_ACCESS_DENIED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RESPONSE_INVALID",
  "PROVIDER_RESPONSE_TOO_LARGE",
  "INVALID_REQUEST",
  "CORE_NOT_CONFIGURED",
  "CORE_UNAVAILABLE",
  "DOMAIN_NOT_SUPPORTED",
]);
export type FundingErrorCode = z.infer<typeof FundingErrorCodeSchema>;

export const FundingErrorSchema = z
  .object({
    schema_version: z.literal("funding-error.v1"),
    error_code: FundingErrorCodeSchema,
    message: z.string().min(1).max(240),
  })
  .strict();
export type FundingError = z.infer<typeof FundingErrorSchema>;

const FundingSourceStatusSchema = z
  .object({
    provider_id: z.enum(FUNDING_PROVIDER_IDS),
    domain_ids: z.array(FundingDomainSchema).max(2),
    configured: z.boolean(),
    endpoint_state: z.enum(["verified", "unverified"]),
    validation_state: z.enum([
      "not_validated",
      "validated",
      "authentication_failed",
      "unavailable",
    ]),
    last_checked_at: z.string().nullable(),
    valid_until: z.string().nullable(),
  })
  .strict();

export const FundingStatusSchema = z
  .object({
    schema_version: z.literal("funding-status.v1"),
    sources: z.array(FundingSourceStatusSchema).max(FUNDING_PROVIDER_IDS.length),
    workflow: z
      .object({
        state: z.enum(["not_checked", "unavailable", "available"]),
        domains: z.array(FundingDomainSchema).max(2),
      })
      .strict(),
  })
  .strict();
export type FundingStatus = z.infer<typeof FundingStatusSchema>;

export const FundingSearchInputSchema = z
  .object({
    domain: FundingDomainSchema,
    provider_id: z.enum(FUNDING_PROVIDER_IDS).optional(),
    keyword: z.string().max(200).optional(),
    page: z.number().int().min(1).max(100).optional(),
    page_size: z.number().int().min(1).max(100).optional(),
    business_year: z.number().int().min(1900).max(2100).optional(),
  })
  .strict();
export type FundingSearchInput = z.infer<typeof FundingSearchInputSchema>;

const FundingOpportunityItemSchema = z
  .object({
    provider_id: z.enum(FUNDING_PROVIDER_IDS),
    source_item_id: z.string().min(1).max(1000),
    title: z.string().min(1).max(1000),
    agency: z.string().max(1000).nullable(),
    source_url: z.string().max(4096).nullable(),
    application_period: z.string().max(2000).nullable(),
    source_classification: z.string().max(1000).nullable(),
    eligibility: z.literal("not_assessed"),
    award_status: z.literal("not_assessed"),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.source_url === null) return;
    try {
      const url = new URL(item.source_url);
      const host = url.hostname.toLowerCase();
      const hostnameWithoutBrackets = host.startsWith("[") && host.endsWith("]")
        ? host.slice(1, -1)
        : host;
      const normalizedHost = host.replace(/\.$/, "");
      const privateHostSuffixes = [
        "localhost",
        "local",
        "internal",
        "lan",
        "home",
        "home.arpa",
        "test",
        "invalid",
        "example",
        "onion",
      ];
      const privateLikeHost = privateHostSuffixes.some(
        (suffix) => normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`)
      );
      const hasIpLiteral = isIP(hostnameWithoutBrackets) !== 0;
      const isBizinfoNotice =
        item.provider_id === "data_go_kr_sme_support_15157820" &&
        (normalizedHost === "www.bizinfo.go.kr" || normalizedHost === "bizinfo.go.kr") &&
        (url.pathname === "/web/lay1/bbs/S1T122C128/AS/74/view.do" ||
          url.pathname === "/sii/siia/selectSIIA200Detail.do");
      const rawQueryStart = item.source_url.indexOf("?");
      const rawQuery = rawQueryStart >= 0 ? item.source_url.slice(rawQueryStart + 1) : "";
      const noticeId = url.searchParams.getAll("pblancId");
      const allowedBizinfoQuery =
        isBizinfoNotice &&
        noticeId.length === 1 &&
        /^PBLN_[A-Za-z0-9_-]{1,128}$/.test(noticeId[0]!) &&
        rawQuery === `pblancId=${noticeId[0]}`;
      if (
        new TextEncoder().encode(item.source_url).byteLength > 4096 ||
        item.source_url !== item.source_url.trim() ||
        /[\u0000-\u0020\u007f]/.test(item.source_url) ||
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        item.source_url.includes("#") ||
        hasIpLiteral ||
        privateLikeHost ||
        !host.includes(".") ||
        (rawQueryStart >= 0 && !allowedBizinfoQuery) ||
        (isBizinfoNotice && rawQueryStart >= 0 && !allowedBizinfoQuery)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source_url"],
          message: "source_url must be a sanitized HTTPS URL",
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_url"],
        message: "source_url must be a sanitized HTTPS URL",
      });
    }
  });

const FundingOpportunitySourceSchema = z
  .object({
    provider_id: z.enum(FUNDING_PROVIDER_IDS),
    status: z.enum(["ok", "blocked"]),
    code: FundingErrorCodeSchema.nullable(),
    retrieved_at: z.string().nullable(),
    cached: z.boolean(),
    cache_expires_at: z.string().nullable(),
  })
  .strict();

export const FundingOpportunitiesSchema = z
  .object({
    schema_version: z.literal("funding-opportunities.v1"),
    status: z.enum(["ok", "partial", "blocked"]),
    domain: FundingDomainSchema,
    business_year: z.number().int().min(1900).max(2100),
    items: z.array(FundingOpportunityItemSchema).max(200),
    sources: z.array(FundingOpportunitySourceSchema).max(FUNDING_PROVIDER_IDS.length),
    coverage: z.literal("bounded_provider_page"),
    filter_scope: z.enum(["provider", "fetched_page", "none"]),
    notice: z.literal(
      "Opportunities only; eligibility and awards are not assessed."
    ),
  })
  .strict();
export type FundingOpportunities = z.infer<typeof FundingOpportunitiesSchema>;

/**
 * The Core owns the complete WorkResult and WorkError schemas. The transport
 * validates the closed protocol discriminator here without copying those
 * schemas or altering the canonical payload.
 */
export const WorkResultSchema = z
  .object({ schema_version: z.literal("work-result.v1") })
  .passthrough();
export const WorkErrorSchema = z
  .object({ schema_version: z.literal("work-error.v1") })
  .passthrough();
export const WorkRequestEnvelopeSchema = z
  .object({
    request: z
      .object({ schema_version: z.literal("work-request.v1") })
      .passthrough(),
  })
  .strict();

export type WorkResult = z.infer<typeof WorkResultSchema>;
export type WorkError = z.infer<typeof WorkErrorSchema>;
export type WorkRequest = z.infer<typeof WorkRequestEnvelopeSchema>["request"];

export const WorkPlanInputSchema = WorkRequestEnvelopeSchema;

export const FundingStatusToolOutputSchema = z.union([
  FundingStatusSchema,
  FundingErrorSchema,
]);
export const FundingOpportunitiesToolOutputSchema = z.union([
  FundingOpportunitiesSchema,
  FundingErrorSchema,
]);
export const FundingWorkToolOutputSchema = z.union([
  WorkResultSchema,
  WorkErrorSchema,
  FundingErrorSchema,
]);

/**
 * The MCP SDK's output validator accepts object schemas, not Zod unions. The
 * adapter performs the full strict validation above before returning a tool
 * result; these object schemas expose the valid top-level discriminators to
 * MCP clients while allowing the canonical payload fields through unchanged.
 */
export const FundingStatusMcpOutputSchema = z
  .object({
    schema_version: z.enum(["funding-status.v1", "funding-error.v1"]),
  })
  .passthrough();
export const FundingOpportunitiesMcpOutputSchema = z
  .object({
    schema_version: z.enum(["funding-opportunities.v1", "funding-error.v1"]),
  })
  .passthrough();
export const FundingWorkMcpOutputSchema = z
  .object({
    schema_version: z.enum([
      "work-result.v1",
      "work-error.v1",
      "funding-error.v1",
    ]),
  })
  .passthrough();

export type FundingToolOutput =
  | FundingStatus
  | FundingOpportunities
  | FundingError
  | WorkResult
  | WorkError;

export function isToolError(value: FundingToolOutput): boolean {
  return (
    value.schema_version === "funding-error.v1" ||
    value.schema_version === "work-error.v1"
  );
}
