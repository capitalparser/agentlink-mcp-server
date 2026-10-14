import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildCoreChildEnvironment,
  buildMcpChildEnvironment,
  resolveLaunchPaths,
} from "../../scripts/run-funding-mcp.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER_PATH = path.join(REPOSITORY_ROOT, "scripts/run-funding-mcp.mjs");

test("launcher child environments remove workflow configuration and unrelated secrets", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/tmp/example-home",
    REGULATION_WORKFLOW_RELEASE: "/private/release.json",
    REGULATION_WORKFLOW_CONTENT_CONFIG: "/private/content.json",
    REGULATION_GUIDELINE_MODE: "demo",
    API_SECRET_KEY: "parent-core-secret",
    AGENTLINK_CORE_API_KEY: "parent-transport-secret",
    DATA_GO_KR_API_KEY: "provider-secret",
  };
  const core = buildCoreChildEnvironment(parent, "ephemeral-core-token");
  const mcp = buildMcpChildEnvironment(parent, "http://127.0.0.1:45678", "ephemeral-core-token");

  for (const environment of [core, mcp]) {
    assert.equal(environment.REGULATION_WORKFLOW_RELEASE, undefined);
    assert.equal(environment.REGULATION_WORKFLOW_CONTENT_CONFIG, undefined);
    assert.equal(environment.REGULATION_GUIDELINE_MODE, "real");
    assert.equal(environment.DATA_GO_KR_API_KEY, undefined);
  }
  assert.equal(core.API_SECRET_KEY, "ephemeral-core-token");
  assert.equal(core.AGENTLINK_CORE_API_KEY, undefined);
  assert.equal(mcp.AGENTLINK_CORE_API_KEY, "ephemeral-core-token");
  assert.equal(mcp.API_SECRET_KEY, undefined);
  assert.equal(parent.REGULATION_WORKFLOW_RELEASE, "/private/release.json");
  assert.equal(parent.REGULATION_GUIDELINE_MODE, "demo");
  assert.equal(parent.API_SECRET_KEY, "parent-core-secret");
});

test("launcher requires an absolute existing Core Python runtime", async () => {
  await assert.rejects(
    resolveLaunchPaths({ AGENTLINK_CORE_PYTHON: "python3" }),
    (error) => error.message === "AGENTLINK_CORE_PYTHON_REQUIRED"
  );
});

test("maintained stdio launcher starts loopback Core, keeps protocol streams clean, and reaps Core", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agentlink-funding-launcher-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const corePath = path.join(temporaryRoot, "agentlink-core-engine");
  const fakePythonPath = path.join(temporaryRoot, "fake-python");
  const mcpBuildPath = path.join(temporaryRoot, "fake-mcp.js");
  const coreAuditPath = path.join(temporaryRoot, "core-audit.json");
  const mcpAuditPath = path.join(temporaryRoot, "mcp-audit.json");
  await mkdir(path.join(corePath, "app/funding"), { recursive: true });
  await writeFile(path.join(corePath, "app/funding/runtime.py"), "# fixture runtime marker\n");

  const fakePython = `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const hostIndex = args.indexOf("--host");
const port = Number(args[portIndex + 1]);
const auditPath = ${JSON.stringify(coreAuditPath)};
const audit = {
  pid: process.pid,
  moduleArgsValid: args[0] === "-m" && args[1] === "app.funding.runtime",
  host: args[hostIndex + 1],
  portValid: Number.isInteger(port) && port > 0,
  modeReal: process.env.REGULATION_GUIDELINE_MODE === "real",
  workflowVarsAbsent: process.env.REGULATION_WORKFLOW_RELEASE === undefined && process.env.REGULATION_WORKFLOW_CONTENT_CONFIG === undefined,
  providerKeyAbsent: process.env.DATA_GO_KR_API_KEY === undefined,
  tokenInArgv: args.some((arg) => arg === process.env.API_SECRET_KEY),
  paths: [],
  probeAuthorized: false,
  closed: false,
};
fs.writeFileSync(auditPath, JSON.stringify(audit));
const server = http.createServer((request, response) => {
  audit.paths.push(request.url);
  audit.probeAuthorized = request.headers["x-api-key"] === process.env.API_SECRET_KEY;
  if (request.url !== "/api/v1/funding/status" || request.method !== "GET" || !audit.probeAuthorized) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ schema_version: "funding-error.v1", error_code: "NOT_FOUND", message: "Not found." }));
  } else {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ schema_version: "funding-status.v1", sources: [], workflow: { state: "not_checked" } }));
  }
  fs.writeFileSync(auditPath, JSON.stringify(audit));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => {
  audit.closed = true;
  fs.writeFileSync(auditPath, JSON.stringify(audit));
  process.exit(0);
}));
`;
  await writeFile(fakePythonPath, fakePython, { mode: 0o700 });
  await chmod(fakePythonPath, 0o700);

  const fakeMcp = `import fs from "node:fs";

const auditPath = ${JSON.stringify(mcpAuditPath)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", async () => {
  let statusOk = false;
  try {
    const response = await fetch(process.env.AGENTLINK_CORE_URL + "/api/v1/funding/status", {
      headers: { "X-API-Key": process.env.AGENTLINK_CORE_API_KEY, Accept: "application/json" },
    });
    const payload = await response.json();
    statusOk = response.status === 200 && payload.schema_version === "funding-status.v1";
  } catch {}
  const audit = {
    statusOk,
    modeReal: process.env.REGULATION_GUIDELINE_MODE === "real",
    workflowVarsAbsent: process.env.REGULATION_WORKFLOW_RELEASE === undefined && process.env.REGULATION_WORKFLOW_CONTENT_CONFIG === undefined,
    providerKeyAbsent: process.env.DATA_GO_KR_API_KEY === undefined,
    coreSecretAbsent: process.env.API_SECRET_KEY === undefined,
    tokenLooksEphemeral: /^[A-Za-z0-9_-]{43}$/.test(process.env.AGENTLINK_CORE_API_KEY ?? ""),
    tokenInArgv: process.argv.some((arg) => arg === process.env.AGENTLINK_CORE_API_KEY),
    stdin,
  };
  fs.writeFileSync(auditPath, JSON.stringify(audit));
  process.stdout.write(JSON.stringify({ protocol: "stdio-preserved", stdin, statusOk }) + "\\n");
  if (!statusOk) process.exitCode = 3;
});
`;
  await writeFile(mcpBuildPath, fakeMcp);

  const parentEnvironment = {
    ...process.env,
    AGENTLINK_CORE_PYTHON: fakePythonPath,
    AGENTLINK_CORE_PATH: corePath,
    AGENTLINK_MCP_BUILD_PATH: mcpBuildPath,
    REGULATION_WORKFLOW_RELEASE: "/parent/private/release.json",
    REGULATION_WORKFLOW_CONTENT_CONFIG: "/parent/private/content.json",
    REGULATION_GUIDELINE_MODE: "demo",
    API_SECRET_KEY: "parent-core-secret-canary",
    AGENTLINK_CORE_API_KEY: "parent-transport-secret-canary",
    DATA_GO_KR_API_KEY: "provider-secret-canary",
  };
  const launcher = spawn(process.execPath, [LAUNCHER_PATH], {
    cwd: REPOSITORY_ROOT,
    env: parentEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  launcher.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  launcher.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  launcher.stdin.end('{"jsonrpc":"2.0","method":"initialize"}\n');
  const exit = await new Promise((resolvePromise, reject) => {
    launcher.once("error", reject);
    launcher.once("close", (code, signal) => resolvePromise({ code, signal }));
  });

  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(Buffer.concat(stderrChunks).toString("utf8"), "");
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  assert.equal(
    stdout,
    '{"protocol":"stdio-preserved","stdin":"{\\"jsonrpc\\":\\"2.0\\",\\"method\\":\\"initialize\\"}\\n","statusOk":true}\n'
  );
  for (const canary of [
    "parent-core-secret-canary",
    "parent-transport-secret-canary",
    "provider-secret-canary",
  ]) {
    assert.equal(stdout.includes(canary), false);
    assert.equal(Buffer.concat(stderrChunks).toString("utf8").includes(canary), false);
  }

  const coreAudit = JSON.parse(await readFile(coreAuditPath, "utf8"));
  const mcpAudit = JSON.parse(await readFile(mcpAuditPath, "utf8"));
  assert.equal(coreAudit.moduleArgsValid, true);
  assert.equal(coreAudit.host, "127.0.0.1");
  assert.equal(coreAudit.portValid, true);
  assert.equal(coreAudit.modeReal, true);
  assert.equal(coreAudit.workflowVarsAbsent, true);
  assert.equal(coreAudit.providerKeyAbsent, true);
  assert.equal(coreAudit.tokenInArgv, false);
  assert.equal(coreAudit.probeAuthorized, true);
  assert.equal(coreAudit.closed, true);
  assert.deepEqual(coreAudit.paths, ["/api/v1/funding/status", "/api/v1/funding/status"]);
  assert.equal(mcpAudit.statusOk, true);
  assert.equal(mcpAudit.modeReal, true);
  assert.equal(mcpAudit.workflowVarsAbsent, true);
  assert.equal(mcpAudit.providerKeyAbsent, true);
  assert.equal(mcpAudit.coreSecretAbsent, true);
  assert.equal(mcpAudit.tokenLooksEphemeral, true);
  assert.equal(mcpAudit.tokenInArgv, false);
  assert.equal(mcpAudit.stdin, '{"jsonrpc":"2.0","method":"initialize"}\n');
  assert.equal(parentEnvironment.REGULATION_WORKFLOW_RELEASE, "/parent/private/release.json");
  assert.equal(parentEnvironment.REGULATION_GUIDELINE_MODE, "demo");

  await assert.rejects(
    new Promise((resolvePromise, reject) => {
      process.kill(coreAudit.pid, 0);
      resolvePromise();
    }),
    (error) => error?.code === "ESRCH"
  );
});

test("launcher signal shutdown terminates both foreground children", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agentlink-funding-signal-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const corePath = path.join(temporaryRoot, "agentlink-core-engine");
  const fakePythonPath = path.join(temporaryRoot, "fake-python");
  const mcpBuildPath = path.join(temporaryRoot, "waiting-mcp.js");
  const coreAuditPath = path.join(temporaryRoot, "core-audit.json");
  const mcpStartedPath = path.join(temporaryRoot, "mcp-started");
  await mkdir(path.join(corePath, "app/funding"), { recursive: true });
  await writeFile(path.join(corePath, "app/funding/runtime.py"), "# fixture runtime marker\n");
  await writeFile(
    fakePythonPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const auditPath = ${JSON.stringify(coreAuditPath)};
const audit = { pid: process.pid, closed: false };
fs.writeFileSync(auditPath, JSON.stringify(audit));
const server = http.createServer((request, response) => {
  if (request.url === "/api/v1/funding/status" && request.headers["x-api-key"] === process.env.API_SECRET_KEY) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ schema_version: "funding-status.v1", sources: [], workflow: { state: "not_checked" } }));
  } else {
    response.writeHead(404);
    response.end();
  }
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => {
  audit.closed = true;
  fs.writeFileSync(auditPath, JSON.stringify(audit));
  process.exit(0);
}));
`,
    { mode: 0o700 }
  );
  await chmod(fakePythonPath, 0o700);
  await writeFile(
    mcpBuildPath,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(mcpStartedPath)}, "started");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`
  );

  const launcher = spawn(process.execPath, [LAUNCHER_PATH], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      AGENTLINK_CORE_PYTHON: fakePythonPath,
      AGENTLINK_CORE_PATH: corePath,
      AGENTLINK_MCP_BUILD_PATH: mcpBuildPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
  });
  const stderrChunks = [];
  launcher.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const startedDeadline = Date.now() + 5_000;
  while (Date.now() < startedDeadline) {
    try {
      await readFile(mcpStartedPath);
      break;
    } catch {
      if (launcher.exitCode !== null || launcher.signalCode !== null) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  await readFile(mcpStartedPath);
  const coreAuditBeforeSignal = JSON.parse(await readFile(coreAuditPath, "utf8"));
  launcher.kill("SIGTERM");
  const exit = await new Promise((resolvePromise, reject) => {
    launcher.once("error", reject);
    launcher.once("close", (code, signal) => resolvePromise({ code, signal }));
  });

  assert.deepEqual(exit, { code: 143, signal: null });
  assert.equal(Buffer.concat(stderrChunks).toString("utf8"), "");
  const coreAudit = JSON.parse(await readFile(coreAuditPath, "utf8"));
  assert.equal(coreAudit.closed, true);
  await assert.rejects(
    new Promise((resolvePromise, reject) => {
      process.kill(coreAuditBeforeSignal.pid, 0);
      resolvePromise();
    }),
    (error) => error?.code === "ESRCH"
  );
});
