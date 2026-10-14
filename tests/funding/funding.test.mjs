import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const buildDirectory = process.env.AGENTLINK_FUNDING_BUILD;
const nodeModules = process.env.AGENTLINK_FUNDING_NODE_MODULES;
if (!buildDirectory || !nodeModules) {
  throw new Error(
    "Set AGENTLINK_FUNDING_BUILD and AGENTLINK_FUNDING_NODE_MODULES to the external build/runtime paths."
  );
}

const [{ HttpFundingProvider }, { registerFundingTools }] = await Promise.all([
  import(pathToFileURL(resolve(buildDirectory, "funding/provider.js")).href),
  import(pathToFileURL(resolve(buildDirectory, "funding/tools.js")).href),
]);
const { Client } = await import(
  pathToFileURL(resolve(nodeModules, "@modelcontextprotocol/sdk/dist/esm/client/index.js")).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(
    resolve(nodeModules, "@modelcontextprotocol/sdk/dist/esm/client/stdio.js")
  ).href
);

const DUMMY_CORE_TOKEN = "funding-test-core-token-DO-NOT-USE";
const DUMMY_SECRET_MARKER = "never-echo-this-provider-secret";

function fundingStatus() {
  return {
    schema_version: "funding-status.v1",
    sources: [
      {
        provider_id: "data_go_kr_sme_support_15157820",
        domain_ids: ["subsidy", "national-rd"],
        configured: false,
        endpoint_state: "unverified",
        validation_state: "not_validated",
        last_checked_at: null,
        valid_until: null,
      },
      {
        provider_id: "data_go_kr_subsidy_calls_15156853",
        domain_ids: ["subsidy"],
        configured: false,
        endpoint_state: "unverified",
        validation_state: "not_validated",
        last_checked_at: null,
        valid_until: null,
      },
    ],
    workflow: { state: "not_checked", domains: ["subsidy", "national-rd"] },
  };
}

function opportunities(businessYear = 2026) {
  return {
    schema_version: "funding-opportunities.v1",
    status: "ok",
    domain: "subsidy",
    business_year: businessYear,
    items: [
      {
        provider_id: "data_go_kr_sme_support_15157820",
        source_item_id: "test-notice-001",
        title: "Synthetic funding notice",
        agency: null,
        source_url: "https://www.data.go.kr/notice/001",
        application_period: null,
        source_classification: null,
        eligibility: "not_assessed",
        award_status: "not_assessed",
      },
    ],
    sources: [
      {
        provider_id: "data_go_kr_sme_support_15157820",
        status: "ok",
        code: null,
        retrieved_at: "2026-10-14T00:00:00Z",
        cached: false,
        cache_expires_at: null,
      },
    ],
    coverage: "bounded_provider_page",
    filter_scope: "provider",
    notice: "Opportunities only; eligibility and awards are not assessed.",
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

class VirtualTimers {
  now = 0;
  created = [];

  setTimeout(callback, delayMs) {
    const handle = {
      callback,
      delayMs,
      dueAt: this.now + delayMs,
      active: true,
      cleared: false,
      unref() {
        return this;
      },
    };
    this.created.push(handle);
    return handle;
  }

  clearTimeout(handle) {
    handle.active = false;
    handle.cleared = true;
  }

  advance(ms) {
    const endAt = this.now + ms;
    while (true) {
      const next = this.created
        .filter((handle) => handle.active && handle.dueAt <= endAt)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!next) break;
      this.now = next.dueAt;
      next.active = false;
      next.callback();
    }
    this.now = endAt;
  }

  get pendingCount() {
    return this.created.filter((handle) => handle.active).length;
  }
}

test("funding provider fails closed before fetch when Core config is absent or non-loopback", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("unexpected fetch");
  };
  const missing = new HttpFundingProvider({ fetchImpl });
  const missingResult = await missing.getFundingStatus();
  assert.equal(missingResult.schema_version, "funding-error.v1");
  assert.equal(missingResult.error_code, "CORE_NOT_CONFIGURED");

  const remote = new HttpFundingProvider({
    coreUrl: "https://example.invalid",
    coreApiKey: DUMMY_CORE_TOKEN,
    fetchImpl,
  });
  const remoteResult = await remote.searchFundingOpportunities({ domain: "subsidy" });
  assert.equal(remoteResult.schema_version, "funding-error.v1");
  assert.equal(remoteResult.error_code, "CORE_NOT_CONFIGURED");
  assert.equal(calls, 0);

  for (const coreUrl of [
    "http://@127.0.0.1:8765",
    "http://127.0.0.1:8765?",
    "http://127.0.0.1:8765#",
  ]) {
    const invalid = new HttpFundingProvider({
      coreUrl,
      coreApiKey: DUMMY_CORE_TOKEN,
      fetchImpl,
    });
    const result = await invalid.getFundingStatus();
    assert.equal(result.error_code, "CORE_NOT_CONFIGURED");
  }
});

test("funding provider uses only fixed local paths, X-API-Key, and bounded request data", async () => {
  const calls = [];
  const provider = new HttpFundingProvider({
    coreUrl: "http://127.0.0.1:18765",
    coreApiKey: DUMMY_CORE_TOKEN,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/status")) return jsonResponse(fundingStatus());
      return jsonResponse(opportunities(JSON.parse(init.body).business_year));
    },
  });

  const status = await provider.getFundingStatus();
  const result = await provider.searchFundingOpportunities({
    domain: "subsidy",
    keyword: "startup",
    page: 2,
    page_size: 5,
    business_year: 2025,
  });

  assert.deepEqual(status, fundingStatus());
  assert.deepEqual(result, opportunities(2025));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:18765/api/v1/funding/status");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[1].url, "http://127.0.0.1:18765/api/v1/funding/opportunities");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers["X-API-Key"], DUMMY_CORE_TOKEN);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    domain: "subsidy",
    keyword: "startup",
    page: 2,
    page_size: 5,
    business_year: 2025,
  });
  assert.equal(calls[1].init.redirect, "manual");
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(calls[1].init.cache, "no-store");
});

test("opportunity request remains active through 14 seconds and clears its 25-second timer", async () => {
  const timers = new VirtualTimers();
  let signal;
  let resolveResponse;
  let settled = false;
  const provider = new HttpFundingProvider({
    coreUrl: "http://127.0.0.1:18765",
    coreApiKey: DUMMY_CORE_TOKEN,
    timerFactory: timers,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    },
  });

  const resultPromise = provider
    .searchFundingOpportunities({ domain: "subsidy", business_year: 2026 })
    .finally(() => {
      settled = true;
    });
  assert.equal(timers.created.length, 1);
  assert.equal(timers.created[0].delayMs, 25_000);

  timers.advance(12_000);
  assert.equal(signal.aborted, false);
  assert.equal(settled, false);
  timers.advance(2_000);
  assert.equal(signal.aborted, false);
  resolveResponse(jsonResponse(opportunities(2026)));

  const result = await resultPromise;
  assert.equal(result.schema_version, "funding-opportunities.v1");
  assert.equal(result.business_year, 2026);
  assert.equal(signal.aborted, false);
  assert.equal(timers.created[0].cleared, true);
  assert.equal(timers.pendingCount, 0);

  timers.advance(11_000);
  assert.equal(signal.aborted, false);
  assert.equal(timers.pendingCount, 0);
});

test("opportunity deadline covers a response body after headers arrive", async () => {
  const timers = new VirtualTimers();
  let signal;
  let streamController;
  let headersArrived = false;
  let settled = false;
  let bodyReadPending = false;
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode('{"schema_version":"'));
    },
    pull() {
      bodyReadPending = true;
    },
  });
  const provider = new HttpFundingProvider({
    coreUrl: "http://127.0.0.1:18765",
    coreApiKey: DUMMY_CORE_TOKEN,
    timerFactory: timers,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      signal.addEventListener(
        "abort",
        () => streamController.error(new Error(`sensitive ${DUMMY_SECRET_MARKER}`)),
        { once: true }
      );
      headersArrived = true;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  const resultPromise = provider
    .searchFundingOpportunities({ domain: "subsidy" })
    .finally(() => {
      settled = true;
    });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(headersArrived, true);
  assert.equal(bodyReadPending, true);
  assert.equal(timers.created[0].delayMs, 25_000);

  timers.advance(24_999);
  assert.equal(signal.aborted, false);
  assert.equal(settled, false);
  timers.advance(1);
  const result = await resultPromise;
  assert.equal(signal.aborted, true);
  assert.deepEqual(result, {
    schema_version: "funding-error.v1",
    error_code: "CORE_UNAVAILABLE",
    message: "The local Core funding service is unavailable.",
  });
  assert.equal(JSON.stringify(result).includes(DUMMY_SECRET_MARKER), false);
  assert.equal(JSON.stringify(result).includes("127.0.0.1"), false);
  assert.equal(timers.created[0].cleared, true);
  assert.equal(timers.pendingCount, 0);
});

test("status and work-plan keep their exact 12- and 25-second deadlines", async (t) => {
  const cases = [
    {
      name: "status",
      timeoutMs: 12_000,
      run: (provider) => provider.getFundingStatus(),
    },
    {
      name: "work plan",
      timeoutMs: 25_000,
      run: (provider) =>
        provider.getFundingWorkPlan({ schema_version: "work-request.v1", operation: "plan" }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const timers = new VirtualTimers();
      let signal;
      const provider = new HttpFundingProvider({
        coreUrl: "http://127.0.0.1:18765",
        coreApiKey: DUMMY_CORE_TOKEN,
        timerFactory: timers,
        fetchImpl: (_url, init) => {
          signal = init.signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error(`sensitive ${DUMMY_SECRET_MARKER}`)),
              { once: true }
            );
          });
        },
      });

      const resultPromise = scenario.run(provider);
      assert.equal(timers.created.length, 1);
      assert.equal(timers.created[0].delayMs, scenario.timeoutMs);
      timers.advance(scenario.timeoutMs - 1);
      assert.equal(signal.aborted, false);
      timers.advance(1);
      const result = await resultPromise;
      assert.equal(signal.aborted, true);
      assert.equal(result.schema_version, "funding-error.v1");
      assert.equal(result.error_code, "CORE_UNAVAILABLE");
      assert.equal(JSON.stringify(result).includes(DUMMY_SECRET_MARKER), false);
      assert.equal(timers.created[0].cleared, true);
      assert.equal(timers.pendingCount, 0);
    });
  }
});

test("Core funding errors are normalized to fixed safe messages", async () => {
  const provider = new HttpFundingProvider({
    coreUrl: "http://127.0.0.1:18765",
    coreApiKey: DUMMY_CORE_TOKEN,
    fetchImpl: async () =>
      jsonResponse(
        {
          schema_version: "funding-error.v1",
          error_code: "CREDENTIAL_NOT_CONFIGURED",
          message: `upstream leaked ${DUMMY_SECRET_MARKER}`,
        },
        503
      ),
  });
  const result = await provider.getFundingStatus();
  assert.deepEqual(result, {
    schema_version: "funding-error.v1",
    error_code: "CREDENTIAL_NOT_CONFIGURED",
    message: "The provider credential is not configured.",
  });
  assert.equal(JSON.stringify(result).includes(DUMMY_SECRET_MARKER), false);
});

test("opportunity requests enforce the bounded business year and public URL policy", async () => {
  const provider = new HttpFundingProvider({
    coreUrl: "http://127.0.0.1:18765",
    coreApiKey: DUMMY_CORE_TOKEN,
    fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).business_year, 2026);
      return jsonResponse(opportunities(2026));
    },
  });
  const currentYear = await provider.searchFundingOpportunities({
    domain: "subsidy",
    business_year: 2026,
  });
  assert.equal(currentYear.schema_version, "funding-opportunities.v1");

  const invalidYear = await provider.searchFundingOpportunities({
    domain: "subsidy",
    business_year: true,
  });
  assert.equal(invalidYear.schema_version, "funding-error.v1");
  assert.equal(invalidYear.error_code, "INVALID_REQUEST");

  const { FundingOpportunitiesSchema } = await import(
    pathToFileURL(resolve(buildDirectory, "funding/types.js")).href
  );
  const bizinfo = opportunities();
  bizinfo.items[0].source_url =
    "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000123835";
  assert.equal(FundingOpportunitiesSchema.safeParse(bizinfo).success, true);
  const unverifiedQueryUrl = structuredClone(opportunities());
  unverifiedQueryUrl.items[0].provider_id = "data_go_kr_subsidy_calls_15156853";
  unverifiedQueryUrl.items[0].source_url = "https://www.data.go.kr/notice?id=123";
  assert.equal(FundingOpportunitiesSchema.safeParse(unverifiedQueryUrl).success, false);
  const privateUrl = structuredClone(opportunities());
  privateUrl.items[0].source_url = "https://127.0.0.1/notice";
  assert.equal(FundingOpportunitiesSchema.safeParse(privateUrl).success, false);
  const localhostFqdn = structuredClone(opportunities());
  localhostFqdn.items[0].source_url = "https://localhost./notice";
  assert.equal(FundingOpportunitiesSchema.safeParse(localhostFqdn).success, false);
  const reservedRootHost = structuredClone(opportunities());
  reservedRootHost.items[0].source_url = "https://example./notice";
  assert.equal(FundingOpportunitiesSchema.safeParse(reservedRootHost).success, false);
  const whitespaceUrl = structuredClone(opportunities());
  whitespaceUrl.items[0].source_url = " https://example.com/notice ";
  assert.equal(FundingOpportunitiesSchema.safeParse(whitespaceUrl).success, false);
  const oversizedUtf8Url = structuredClone(opportunities());
  oversizedUtf8Url.items[0].source_url = `https://example.com/${"가".repeat(1400)}`;
  assert.equal(FundingOpportunitiesSchema.safeParse(oversizedUtf8Url).success, false);
});

test("duplicate-key, invalid, and oversized Core JSON become safe errors", async (t) => {
  const cases = [
    ["duplicate keys", '{"schema_version":"funding-status.v1","schema_version":"funding-status.v1"}'],
    ["non-finite value", '{"schema_version":"funding-status.v1","value":Infinity}'],
    ["oversized response", JSON.stringify(fundingStatus()) + " ".repeat(1_048_600)],
  ];
  for (const [name, body] of cases) {
    await t.test(name, async () => {
      const provider = new HttpFundingProvider({
        coreUrl: "http://127.0.0.1:18765",
        coreApiKey: DUMMY_CORE_TOKEN,
        fetchImpl: async () =>
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
      });
      const result = await provider.getFundingStatus();
      assert.equal(result.schema_version, "funding-error.v1");
      assert.equal(result.error_code, "CORE_UNAVAILABLE");
      assert.equal(JSON.stringify(result).includes(body.slice(0, 40)), false);
    });
  }
});

test("WorkResult and WorkError tags are passed through without summary rewriting", async () => {
  const canonicalLikeResult = {
    schema_version: "work-result.v1",
    request_sha256: "0".repeat(64),
    status: "blocked",
    decision_status: "not_assessed",
    details: { questions: ["keep this exact field"] },
  };
  const canonicalLikeError = {
    schema_version: "work-error.v1",
    error_code: "WORK_RELEASE_UNAVAILABLE",
    errors: [{ code: "WORK_RELEASE_UNAVAILABLE", message: "No configured release." }],
  };
  let current = canonicalLikeResult;
  const provider = new HttpFundingProvider({
    coreUrl: "http://127.0.0.1:18765",
    coreApiKey: DUMMY_CORE_TOKEN,
    fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), {
        request: { schema_version: "work-request.v1", operation: "plan" },
      });
      return jsonResponse(current);
    },
  });
  const request = { schema_version: "work-request.v1", operation: "plan" };
  assert.deepEqual(await provider.getFundingWorkPlan(request), canonicalLikeResult);
  current = canonicalLikeError;
  assert.deepEqual(await provider.getFundingWorkPlan(request), canonicalLikeError);
});

test("tool callbacks return matching structuredContent and JSON text with truthful error flags", async () => {
  const registrations = new Map();
  const fakeServer = {
    registerTool(name, config, callback) {
      registrations.set(name, { config, callback });
    },
  };
  const provider = {
    async getFundingStatus() {
      return fundingStatus();
    },
    async searchFundingOpportunities(input) {
      assert.equal(input.domain, "subsidy");
      return opportunities();
    },
    async getFundingWorkPlan() {
      return {
        schema_version: "work-error.v1",
        error_code: "WORK_RELEASE_UNAVAILABLE",
        errors: [{ code: "WORK_RELEASE_UNAVAILABLE" }],
      };
    },
  };
  registerFundingTools(fakeServer, provider);
  assert.deepEqual([...registrations.keys()], [
    "get_funding_status",
    "search_funding_opportunities",
    "get_funding_work_plan",
  ]);
  const statusTool = registrations.get("get_funding_status");
  assert.equal(statusTool.config.annotations.readOnlyHint, true);
  const statusResult = await statusTool.callback({});
  assert.deepEqual(statusResult.structuredContent, fundingStatus());
  assert.deepEqual(JSON.parse(statusResult.content[0].text), fundingStatus());
  assert.equal(statusResult.isError, undefined);

  const searchTool = registrations.get("search_funding_opportunities");
  const searchResult = await searchTool.callback({ domain: "subsidy" });
  assert.deepEqual(searchResult.structuredContent, opportunities());
  assert.equal(searchResult.isError, undefined);

  const workTool = registrations.get("get_funding_work_plan");
  const workResult = await workTool.callback({
    request: { schema_version: "work-request.v1", operation: "plan" },
  });
  assert.equal(workResult.isError, true);
  assert.deepEqual(JSON.parse(workResult.content[0].text), workResult.structuredContent);
  assert.equal(workResult.structuredContent.schema_version, "work-error.v1");
});

test("native MCP stdio exposes additive tools and carries Core data through structuredContent", async (t) => {
  const seen = [];
  const canonicalWorkResult = {
    schema_version: "work-result.v1",
    identity: {
      request_sha256: "a".repeat(64),
      release_sha256: "b".repeat(64),
    },
    operation: "plan",
    status: "partial",
    summary: "Synthetic canonical fixture; not a real funding determination.",
    context: { domain: "subsidy", program_id: "demo-program" },
    source_records: [{ source_id: "source.demo", text: null }],
    open_questions: ["Confirm the program's current requirements."],
  };
  const canonicalWorkResultJson = JSON.stringify(canonicalWorkResult);
  const core = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const requestBody = bodyText ? JSON.parse(bodyText) : null;
    seen.push({
      path: request.url,
      method: request.method,
      apiKey: request.headers["x-api-key"],
      requestBody,
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.headers["x-api-key"] !== DUMMY_CORE_TOKEN) {
      response.statusCode = 403;
      response.end(
        JSON.stringify({
          schema_version: "funding-error.v1",
          error_code: "CORE_UNAVAILABLE",
          message: "The local Core funding service is unavailable.",
        })
      );
      return;
    }
    if (request.url === "/api/v1/funding/status") {
      response.end(JSON.stringify(fundingStatus()));
      return;
    }
    if (request.url === "/api/v1/funding/opportunities") {
      response.end(JSON.stringify(opportunities()));
      return;
    }
    if (request.url === "/api/v1/funding/work-plan") {
      if (requestBody.request.operation === "plan") {
        response.end(canonicalWorkResultJson);
        return;
      }
      response.statusCode = 503;
      response.end(
        JSON.stringify({
          schema_version: "work-error.v1",
          error_code: "WORK_RELEASE_UNAVAILABLE",
          errors: [{ code: "WORK_RELEASE_UNAVAILABLE", message: "No configured release." }],
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const address = core.address();
  assert.ok(address && typeof address === "object");

  const client = new Client({ name: "funding-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(buildDirectory, "index.js")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      AGENTLINK_CORE_URL: `http://127.0.0.1:${address.port}`,
      AGENTLINK_CORE_API_KEY: DUMMY_CORE_TOKEN,
      NODE_ENV: "test",
    },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    for (const name of [
      "get_funding_status",
      "search_funding_opportunities",
      "get_funding_work_plan",
      "search_public_notices",
      "get_vat_data",
    ]) {
      assert.ok(toolNames.includes(name), `missing tool ${name}`);
    }

    const statusResult = await client.callTool({
      name: "get_funding_status",
      arguments: {},
    });
    assert.deepEqual(statusResult.structuredContent, fundingStatus());
    assert.deepEqual(JSON.parse(statusResult.content[0].text), fundingStatus());

    const searchResult = await client.callTool({
      name: "search_funding_opportunities",
      arguments: {
        domain: "subsidy",
        keyword: "startup",
        page: 1,
        page_size: 10,
        business_year: 2026,
      },
    });
    assert.deepEqual(searchResult.structuredContent, opportunities());
    assert.equal(searchResult.isError, undefined);

    const request = { schema_version: "work-request.v1", operation: "plan" };
    const workResultResponse = await client.callTool({
      name: "get_funding_work_plan",
      arguments: { request },
    });
    assert.equal(workResultResponse.isError, undefined);
    assert.equal(
      JSON.stringify(workResultResponse.structuredContent),
      canonicalWorkResultJson
    );
    assert.equal(
      workResultResponse.content[0].text,
      JSON.stringify(canonicalWorkResult, null, 2)
    );

    const workErrorResponse = await client.callTool({
      name: "get_funding_work_plan",
      arguments: {
        request: { schema_version: "work-request.v1", operation: "compare_versions" },
      },
    });
    assert.equal(workErrorResponse.isError, true);
    assert.deepEqual(workErrorResponse.structuredContent, {
      schema_version: "work-error.v1",
      error_code: "WORK_RELEASE_UNAVAILABLE",
      errors: [{ code: "WORK_RELEASE_UNAVAILABLE", message: "No configured release." }],
    });
    assert.deepEqual(seen.map(({ path, method }) => [path, method]), [
      ["/api/v1/funding/status", "GET"],
      ["/api/v1/funding/opportunities", "POST"],
      ["/api/v1/funding/work-plan", "POST"],
      ["/api/v1/funding/work-plan", "POST"],
    ]);
    assert.ok(seen.every((entry) => entry.apiKey === DUMMY_CORE_TOKEN));
    assert.deepEqual(seen[1].requestBody, {
      domain: "subsidy",
      keyword: "startup",
      page: 1,
      page_size: 10,
      business_year: 2026,
    });
    assert.deepEqual(seen[2].requestBody, { request });
    assert.deepEqual(seen[3].requestBody, {
      request: { schema_version: "work-request.v1", operation: "compare_versions" },
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await new Promise((resolvePromise, reject) =>
      core.close((error) => (error ? reject(error) : resolvePromise()))
    );
  }
});
