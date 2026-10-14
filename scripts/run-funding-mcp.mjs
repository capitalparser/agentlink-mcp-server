#!/usr/bin/env node

/**
 * Starts a private Core funding runtime and the AgentLink MCP stdio process.
 * This is an explicit local launcher, not a daemon or login item.
 */

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const MCP_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_CORE_PATH = resolve(MCP_REPOSITORY_ROOT, "..", "agentlink-core-engine");
const DEFAULT_MCP_BUILD_PATH = resolve(MCP_REPOSITORY_ROOT, "dist", "index.js");
const CORE_STARTUP_DEADLINE_MS = 10_000;
const CORE_PROBE_DEADLINE_MS = 750;
const CORE_PROBE_INTERVAL_MS = 100;
const CHILD_SHUTDOWN_DEADLINE_MS = 2_000;

const SAFE_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
];

const WORKFLOW_CONFIGURATION_NAMES = [
  "REGULATION_WORKFLOW_RELEASE",
  "REGULATION_WORKFLOW_CONTENT_CONFIG",
];

function safeEnvironmentSubset(parentEnvironment) {
  const environment = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = parentEnvironment[name];
    if (typeof value === "string") environment[name] = value;
  }
  return environment;
}

export function buildCoreChildEnvironment(parentEnvironment, coreApiKey) {
  const environment = safeEnvironmentSubset(parentEnvironment);
  for (const name of WORKFLOW_CONFIGURATION_NAMES) delete environment[name];
  environment.REGULATION_GUIDELINE_MODE = "real";
  environment.PYTHONNOUSERSITE = "1";
  environment.PYTHONDONTWRITEBYTECODE = "1";
  environment.API_SECRET_KEY = coreApiKey;
  return environment;
}

export function buildMcpChildEnvironment(parentEnvironment, coreUrl, coreApiKey) {
  const environment = safeEnvironmentSubset(parentEnvironment);
  for (const name of WORKFLOW_CONFIGURATION_NAMES) delete environment[name];
  environment.REGULATION_GUIDELINE_MODE = "real";
  environment.AGENTLINK_CORE_URL = coreUrl;
  environment.AGENTLINK_CORE_API_KEY = coreApiKey;
  return environment;
}

async function requireReadableFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveLaunchPaths(environment = process.env) {
  const corePython = environment.AGENTLINK_CORE_PYTHON;
  if (typeof corePython !== "string" || !isAbsolute(corePython)) {
    throw new Error("AGENTLINK_CORE_PYTHON_REQUIRED");
  }
  try {
    await access(corePython, fsConstants.X_OK);
  } catch {
    throw new Error("CORE_PYTHON_UNAVAILABLE");
  }

  const configuredCorePath = environment.AGENTLINK_CORE_PATH;
  if (configuredCorePath !== undefined && !isAbsolute(configuredCorePath)) {
    throw new Error("CORE_PATH_INVALID");
  }
  const corePath = configuredCorePath ?? DEFAULT_CORE_PATH;
  if (!(await requireReadableFile(resolve(corePath, "app/funding/runtime.py")))) {
    throw new Error("CORE_RUNTIME_UNAVAILABLE");
  }

  const configuredBuildPath = environment.AGENTLINK_MCP_BUILD_PATH;
  if (configuredBuildPath !== undefined && !isAbsolute(configuredBuildPath)) {
    throw new Error("MCP_BUILD_PATH_INVALID");
  }
  const mcpBuildPath = configuredBuildPath ?? DEFAULT_MCP_BUILD_PATH;
  if (!(await requireReadableFile(mcpBuildPath))) {
    throw new Error("MCP_BUILD_UNAVAILABLE");
  }

  return { corePython, corePath, mcpBuildPath };
}

export async function allocateLoopbackPort() {
  const server = createNetServer();
  server.unref();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    throw new Error("LOOPBACK_PORT_UNAVAILABLE");
  }
  const port = address.port;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

function isFundingStatus(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.schema_version === "funding-status.v1" &&
    Array.isArray(value.sources) &&
    value.workflow !== null &&
    typeof value.workflow === "object"
  );
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function probeCoreStatus(coreUrl, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CORE_PROBE_DEADLINE_MS);
  try {
    const response = await fetch(`${coreUrl}/api/v1/funding/status`, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (
      response.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    ) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > 32_768) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    if (!response.body) return false;
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > 32_768) {
          await reader.cancel().catch(() => undefined);
          return false;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    );
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return false;
    }
    return isFundingStatus(payload);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCoreReady(coreProcess, coreUrl, apiKey, shouldStop) {
  const deadline = Date.now() + CORE_STARTUP_DEADLINE_MS;
  let spawnFailed = false;
  coreProcess.once("error", () => {
    spawnFailed = true;
  });

  while (Date.now() < deadline) {
    if (shouldStop() || spawnFailed || coreProcess.exitCode !== null || coreProcess.signalCode !== null) {
      return false;
    }
    if (await probeCoreStatus(coreUrl, apiKey)) return true;
    await delay(CORE_PROBE_INTERVAL_MS);
  }
  return false;
}

function childAlreadyClosed(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildClose(child, timeoutMs) {
  if (childAlreadyClosed(child)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolvePromise(closed);
    };
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(childAlreadyClosed(child)), timeoutMs);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function stopChild(child) {
  if (!child || childAlreadyClosed(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  if (await waitForChildClose(child, CHILD_SHUTDOWN_DEADLINE_MS)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await waitForChildClose(child, CHILD_SHUTDOWN_DEADLINE_MS);
}

function signalExitCode(signal) {
  const codes = { SIGINT: 130, SIGTERM: 143 };
  return codes[signal] ?? 1;
}

function waitForMainChild(child) {
  return new Promise((resolvePromise) => {
    child.once("error", () => resolvePromise({ code: 1, signal: null }));
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

export async function runFundingMcp({ environment = process.env } = {}) {
  let paths;
  try {
    paths = await resolveLaunchPaths(environment);
  } catch (error) {
    const code = error instanceof Error ? error.message : "LAUNCH_CONFIGURATION_INVALID";
    const safeMessage = {
      AGENTLINK_CORE_PYTHON_REQUIRED: "Set AGENTLINK_CORE_PYTHON to the existing Core Python runtime.",
      CORE_PYTHON_UNAVAILABLE: "The configured Core Python runtime is unavailable.",
      CORE_PATH_INVALID: "AGENTLINK_CORE_PATH must be an absolute path.",
      CORE_RUNTIME_UNAVAILABLE: "The local Core funding runtime is unavailable.",
      MCP_BUILD_PATH_INVALID: "AGENTLINK_MCP_BUILD_PATH must be an absolute path.",
      MCP_BUILD_UNAVAILABLE: "The AgentLink MCP build entrypoint is unavailable.",
    }[code] ?? "The local funding MCP launcher could not validate its runtime paths.";
    process.stderr.write(`${safeMessage}\n`);
    return 2;
  }

  let coreProcess;
  let mcpProcess;
  let receivedSignal = null;
  const handleSignal = (signal) => {
    if (receivedSignal !== null) return;
    receivedSignal = signal;
    if (mcpProcess && !childAlreadyClosed(mcpProcess)) mcpProcess.kill(signal);
    if (coreProcess && !childAlreadyClosed(coreProcess)) coreProcess.kill("SIGTERM");
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const coreApiKey = randomBytes(32).toString("base64url");
  let exitCode = 1;
  try {
    const port = await allocateLoopbackPort();
    const coreUrl = `http://127.0.0.1:${port}`;
    coreProcess = spawn(
      paths.corePython,
      ["-m", "app.funding.runtime", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: paths.corePath,
        env: buildCoreChildEnvironment(environment, coreApiKey),
        stdio: "ignore",
      }
    );

    if (!(await waitForCoreReady(coreProcess, coreUrl, coreApiKey, () => receivedSignal !== null))) {
      if (receivedSignal !== null) exitCode = signalExitCode(receivedSignal);
      else process.stderr.write("The private Core funding runtime did not become ready.\n");
      return exitCode;
    }
    if (receivedSignal !== null) {
      exitCode = signalExitCode(receivedSignal);
      return exitCode;
    }

    mcpProcess = spawn(process.execPath, [paths.mcpBuildPath], {
      cwd: MCP_REPOSITORY_ROOT,
      env: buildMcpChildEnvironment(environment, coreUrl, coreApiKey),
      stdio: "inherit",
    });
    mcpProcess.once("error", () => {
      process.stderr.write("The AgentLink MCP process could not be started.\n");
    });
    const result = await waitForMainChild(mcpProcess);
    exitCode = result.signal ? signalExitCode(result.signal) : (result.code ?? 1);
    if (receivedSignal !== null) exitCode = signalExitCode(receivedSignal);
    return exitCode;
  } catch {
    if (receivedSignal !== null) exitCode = signalExitCode(receivedSignal);
    else process.stderr.write("The local funding MCP launcher failed safely.\n");
    return exitCode;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await stopChild(mcpProcess);
    await stopChild(coreProcess);
  }
}

function invokedAsProgram() {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  return resolve(invokedPath) === resolve(fileURLToPath(import.meta.url));
}

if (invokedAsProgram()) {
  runFundingMcp().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
