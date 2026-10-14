/** Local-only adapter to the AgentLink Core funding routes. */

import {
  FundingErrorSchema,
  FundingOpportunitiesSchema,
  FundingSearchInputSchema,
  FundingStatusSchema,
  WorkErrorSchema,
  WorkRequestEnvelopeSchema,
  WorkResultSchema,
  type FundingError,
  type FundingErrorCode,
  type FundingOpportunities,
  type FundingSearchInput,
  type FundingStatus,
  type WorkError,
  type WorkRequest,
  type WorkResult,
} from "./types.js";

export interface FundingProvider {
  getFundingStatus(): Promise<FundingStatus | FundingError>;
  searchFundingOpportunities(
    input: FundingSearchInput
  ): Promise<FundingOpportunities | FundingError>;
  getFundingWorkPlan(
    request: WorkRequest
  ): Promise<WorkResult | WorkError | FundingError>;
}

export interface HttpFundingProviderOptions {
  coreUrl?: string;
  coreApiKey?: string;
  fetchImpl?: typeof fetch;
  timerFactory?: FundingTimerFactory;
}

export interface FundingTimerFactory {
  setTimeout(callback: () => void, delayMs: number): { unref?: () => unknown };
  clearTimeout(handle: { unref?: () => unknown }): void;
}

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_WORK_REQUEST_BYTES = 262_144;
const STATUS_TIMEOUT_MS = 12_000;
const OPPORTUNITY_TIMEOUT_MS = 25_000;
const WORK_TIMEOUT_MS = 25_000;

const SAFE_MESSAGES: Record<FundingErrorCode, string> = {
  CREDENTIAL_NOT_CONFIGURED: "The provider credential is not configured.",
  CREDENTIAL_STORE_UNAVAILABLE: "The provider credential store is unavailable.",
  ENDPOINT_UNVERIFIED: "The provider endpoint is not verified.",
  PROVIDER_AUTH_FAILED: "The provider rejected its configured credential.",
  PROVIDER_ACCESS_DENIED: "The provider denied this request.",
  PROVIDER_RATE_LIMITED: "The provider rate limit was reached.",
  PROVIDER_TIMEOUT: "The provider did not respond in time.",
  PROVIDER_UNAVAILABLE: "The provider is unavailable.",
  PROVIDER_RESPONSE_INVALID: "The provider response could not be validated.",
  PROVIDER_RESPONSE_TOO_LARGE: "The provider response exceeded the allowed size.",
  INVALID_REQUEST: "The funding request is invalid.",
  CORE_NOT_CONFIGURED: "The local Core funding service is not configured.",
  CORE_UNAVAILABLE: "The local Core funding service is unavailable.",
  DOMAIN_NOT_SUPPORTED: "The requested funding domain is not supported.",
};

export function makeFundingError(errorCode: FundingErrorCode): FundingError {
  return {
    schema_version: "funding-error.v1",
    error_code: errorCode,
    message: SAFE_MESSAGES[errorCode],
  };
}

class ResponseTooLargeError extends Error {}
class InvalidJsonError extends Error {}

/** Strict JSON parser that rejects duplicate object keys and non-finite numbers. */
function parseStrictJson(text: string): unknown {
  let index = 0;
  let parsedNodes = 0;

  const fail = (): never => {
    throw new InvalidJsonError("Invalid JSON");
  };
  const skipWhitespace = (): void => {
    while (index < text.length && /[\u0020\u0009\u000a\u000d]/.test(text[index]!)) {
      index += 1;
    }
  };
  const parseString = (): string => {
    if (text[index] !== '"') return fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      const char = text[index]!;
      if (char === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          return fail();
        }
      }
      if (code < 0x20) return fail();
      if (char === "\\") {
        index += 1;
        const escaped = text[index];
        if (escaped === undefined || !/["\\/bfnrtu]/.test(escaped)) return fail();
        if (escaped === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail();
          index += 4;
        }
      }
      index += 1;
    }
    return fail();
  };

  const parseValue = (depth: number): unknown => {
    parsedNodes += 1;
    if (depth > 64 || parsedNodes > 50_000) return fail();
    skipWhitespace();
    const char = text[index];
    if (char === '"') return parseString();
    if (char === "{") {
      index += 1;
      skipWhitespace();
      const output: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return output;
      }
      while (index < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) return fail();
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") return fail();
        index += 1;
        Object.defineProperty(output, key, {
          value: parseValue(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return output;
        }
        if (text[index] !== ",") return fail();
        index += 1;
      }
      return fail();
    }
    if (char === "[") {
      index += 1;
      skipWhitespace();
      const output: unknown[] = [];
      if (text[index] === "]") {
        index += 1;
        return output;
      }
      while (index < text.length) {
        output.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return output;
        }
        if (text[index] !== ",") return fail();
        index += 1;
      }
      return fail();
    }
    if (char === "t" && text.slice(index, index + 4) === "true") {
      index += 4;
      return true;
    }
    if (char === "f" && text.slice(index, index + 5) === "false") {
      index += 5;
      return false;
    }
    if (char === "n" && text.slice(index, index + 4) === "null") {
      index += 4;
      return null;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(index)
    );
    if (number) {
      index += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) return fail();
      return value;
    }
    return fail();
  };

  const result = parseValue(0);
  skipWhitespace();
  if (index !== text.length) return fail();
  return result;
}

function isWorkPayload(
  value: unknown
): value is WorkResult | WorkError {
  return WorkResultSchema.safeParse(value).success || WorkErrorSchema.safeParse(value).success;
}

function isLoopbackUrl(value: string): URL | null {
  if (value.length > 2048 || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (
      url.protocol !== "http:" ||
      !loopback ||
      url.username !== "" ||
      url.password !== "" ||
      value.includes("@") ||
      value.includes("?") ||
      value.includes("#") ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidJsonError("Invalid response encoding");
  }
}

function parseFundingError(value: unknown): FundingError | null {
  const parsed = FundingErrorSchema.safeParse(value);
  if (!parsed.success) return null;
  return makeFundingError(parsed.data.error_code);
}

function hasJsonContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType !== null && /^application\/json(?:\s*;|$)/i.test(contentType);
}

/**
 * Uses only the fixed local Core API. Provider credentials remain in Core and
 * are never read or sent by this adapter.
 */
export class HttpFundingProvider implements FundingProvider {
  private readonly coreUrl: string | undefined;
  private readonly coreApiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timerFactory: FundingTimerFactory;

  constructor(options: HttpFundingProviderOptions = {}) {
    this.coreUrl = options.coreUrl ?? process.env.AGENTLINK_CORE_URL;
    this.coreApiKey = options.coreApiKey ?? process.env.AGENTLINK_CORE_API_KEY;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timerFactory =
      options.timerFactory ?? {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      };
  }

  async getFundingStatus(): Promise<FundingStatus | FundingError> {
    const raw = await this.callCore(
      "/api/v1/funding/status",
      "GET",
      undefined,
      STATUS_TIMEOUT_MS
    );
    if (FundingErrorSchema.safeParse(raw).success) return parseFundingError(raw)!;
    const parsed = FundingStatusSchema.safeParse(raw);
    return parsed.success ? parsed.data : makeFundingError("CORE_UNAVAILABLE");
  }

  async searchFundingOpportunities(
    input: FundingSearchInput
  ): Promise<FundingOpportunities | FundingError> {
    const validated = FundingSearchInputSchema.safeParse(input);
    if (!validated.success) return makeFundingError("INVALID_REQUEST");
    const raw = await this.callCore(
      "/api/v1/funding/opportunities",
      "POST",
      validated.data,
      OPPORTUNITY_TIMEOUT_MS
    );
    if (FundingErrorSchema.safeParse(raw).success) return parseFundingError(raw)!;
    const parsed = FundingOpportunitiesSchema.safeParse(raw);
    return parsed.success ? parsed.data : makeFundingError("CORE_UNAVAILABLE");
  }

  async getFundingWorkPlan(
    request: WorkRequest
  ): Promise<WorkResult | WorkError | FundingError> {
    const validated = WorkRequestEnvelopeSchema.safeParse({ request });
    if (!validated.success) return makeFundingError("INVALID_REQUEST");
    const raw = await this.callCore(
      "/api/v1/funding/work-plan",
      "POST",
      { request: validated.data.request },
      WORK_TIMEOUT_MS
    );
    if (isWorkPayload(raw)) return raw;
    if (FundingErrorSchema.safeParse(raw).success) return parseFundingError(raw)!;
    return makeFundingError("CORE_UNAVAILABLE");
  }

  private async callCore(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    timeoutMs: number
  ): Promise<unknown | FundingError> {
    const baseUrl = this.coreUrl;
    const apiKey = this.coreApiKey;
    const parsedBase = baseUrl ? isLoopbackUrl(baseUrl) : null;
    if (
      !parsedBase ||
      typeof apiKey !== "string" ||
      apiKey.length === 0 ||
      apiKey.length > 4096 ||
      /[\r\n]/.test(apiKey)
    ) {
      return makeFundingError("CORE_NOT_CONFIGURED");
    }

    let serializedBody: string | undefined;
    try {
      serializedBody = body === undefined ? undefined : JSON.stringify(body);
    } catch {
      return makeFundingError("INVALID_REQUEST");
    }
    if (
      serializedBody !== undefined &&
      Buffer.byteLength(serializedBody, "utf8") > MAX_WORK_REQUEST_BYTES
    ) {
      return makeFundingError("INVALID_REQUEST");
    }

    const controller = new AbortController();
    const timeout = this.timerFactory.setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, parsedBase), {
        method,
        headers: {
          "X-API-Key": apiKey,
          Accept: "application/json",
          ...(serializedBody === undefined
            ? {}
            : { "Content-Type": "application/json; charset=utf-8" }),
        },
        body: serializedBody,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      this.timerFactory.clearTimeout(timeout);
      return makeFundingError("CORE_UNAVAILABLE");
    }

    try {
      if (response.status >= 300 && response.status < 400) {
        return makeFundingError("CORE_UNAVAILABLE");
      }
      if (!hasJsonContentType(response)) return makeFundingError("CORE_UNAVAILABLE");

      let payload: unknown;
      try {
        payload = parseStrictJson(await readBoundedBody(response));
      } catch (error) {
        if (error instanceof ResponseTooLargeError) {
          return makeFundingError("CORE_UNAVAILABLE");
        }
        return makeFundingError("CORE_UNAVAILABLE");
      }

      if (response.ok) return payload;
      const safeError = parseFundingError(payload);
      if (safeError) return safeError;
      if (isWorkPayload(payload) && payload.schema_version === "work-error.v1") {
        return payload;
      }
      return makeFundingError("CORE_UNAVAILABLE");
    } finally {
      this.timerFactory.clearTimeout(timeout);
      response.body?.cancel().catch(() => undefined);
    }
  }
}

export class UnavailableFundingProvider implements FundingProvider {
  async getFundingStatus(): Promise<FundingError> {
    return makeFundingError("CORE_NOT_CONFIGURED");
  }

  async searchFundingOpportunities(
    _input: FundingSearchInput
  ): Promise<FundingError> {
    return makeFundingError("CORE_NOT_CONFIGURED");
  }

  async getFundingWorkPlan(_request: WorkRequest): Promise<FundingError> {
    return makeFundingError("CORE_NOT_CONFIGURED");
  }
}

export function createFundingProviderFromEnvironment(): FundingProvider {
  return new HttpFundingProvider();
}

export function isFundingError(value: unknown): value is FundingError {
  return FundingErrorSchema.safeParse(value).success;
}
