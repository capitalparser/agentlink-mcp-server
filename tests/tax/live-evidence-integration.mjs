// Required live acceptance for a fresh tax wheel installed beside the upper stdio MCP server.
// This file intentionally has no skip or mock path; the coordinator runs it once after build/install.
import test from "node:test";
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

function savePrivateLiveReceipt(answer) {
  const receipt = process.env.AGENTLINK_TEST_TAX_LIVE_RECEIPT;
  if (receipt === undefined) return;
  const scratchRoot = resolve(dirname(taskTemp));
  const destination = resolve(receipt);
  const rel = relative(scratchRoot, destination);
  must(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`),
    "Private live receipt must stay under task scratch");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(destination, JSON.stringify({ practitioner_answer: answer }, null, 2),
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
print(json.dumps({
    "package_installed": package.is_relative_to(site_packages),
    "registry_bundled": registry.is_relative_to(package) and required_assets <= assets,
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

      savePrivateLiveReceipt(answer);

      const allLive = JSON.stringify([search, article, withEvidence, answer]);
      must(!allLive.includes("OC="), "Serialized live outputs must not contain authenticated OC parameters");
      process.stdout.write(JSON.stringify({
        live: "passed", tax_tools: 19, article: "fetched", evidence: "completed",
        legal_documents: withEvidence.evidence_lookup.legal_documents_count,
        candidates: withEvidence.evidence_lookup.candidate_count,
        resolved_forms: withEvidence.evidence_lookup.resolved_forms_count,
        practitioner: "evidence_attached",
      }) + "\n");
    });

    const missingCredentialPath = join(scratch, "intentionally-missing-credentials.json");
    must(!existsSync(missingCredentialPath), "Negative credential fixture must begin absent");
    await withUpper(scratch, missingCredentialPath, async (_client, call) => {
      const fullMatter = matter();
      const without = await call("tax_plan_work", { matter: fullMatter, include_evidence: false });
      const result = await call("tax_plan_work", { matter: fullMatter, include_evidence: true });
      same(result.status, without.status, "Missing credentials must not change plan status");
      for (const field of ["questions", "next_actions", "why", "sources", "applicability", "calculation_status"]) {
        equivalent(result[field], without[field], `Missing credentials changed plan authority field: ${field}`);
      }
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
