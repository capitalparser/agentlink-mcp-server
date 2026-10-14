# Funding MCP tools

The funding tools are an additive local-Core adapter. Existing tax, business,
public-data, legal, and disaster tools continue to use the existing
`DataProvider`; its development stub behavior is unchanged. Funding tools use a
separate `FundingProvider` and never treat the legacy stub as a funding result.

The server registers three read-only tools:

| Tool | Input | Behavior |
| --- | --- | --- |
| `get_funding_status` | `{}` | Reads connector/workflow status from the local Core service. It does not call a provider. `configured` does not mean the key was validated. |
| `search_funding_opportunities` | `domain`, optional provider/keyword/page/page_size/business_year | Requests one bounded provider page. A missing business year is resolved by Core using the current Korea-local year. A result is candidate discovery only; eligibility and award status remain `not_assessed`. |
| `get_funding_work_plan` | `{ "request": <work-request.v1> }` | Forwards the request to the existing host-configured Core workflow. The canonical `work-result.v1` or `work-error.v1` is returned without summary rewriting. |

The opportunity output is validated as `funding-opportunities.v1`, including
the year, safe provider IDs, bounded fields, and the pinned public-link rules.
The transport does not reconstruct provider endpoints or make provider API
calls. Provider parsing, credentials, caching, and endpoint mappings belong to
Core. In particular, the SME provider is a broad discovery source for
`national-rd`, not proof of complete R&D coverage. The current provider appendix
documents bounded filters and URL handling; live connectivity remains a
separate observation.

## Local Core configuration

Set `AGENTLINK_CORE_URL` to the Core service origin, for example
`http://127.0.0.1:8765`, and set `AGENTLINK_CORE_API_KEY` to the ephemeral
transport token configured for that Core process. The URL must be plain HTTP on
`127.0.0.1`, `localhost`, or `::1`, with no path, credentials, query, or
fragment. The token is sent only in the `X-API-Key` header to fixed
`/api/v1/funding/...` routes. It is not a Data.go.kr provider key.

The TypeScript server never reads the Core credential store. Provider keys
remain in the private Core credential helper and are not accepted as MCP tool
inputs, environment fallbacks, or query parameters. The adapter does not log
request URLs, response bodies, tokens, or exception text. Missing or invalid
Core configuration produces a fixed `funding-error.v1`; unexpected HTTP,
redirect, JSON, schema, size, and timeout failures produce a safe
`CORE_UNAVAILABLE` error. Work errors from Core remain unchanged and MCP marks
them as tool errors. Every tool response carries matching JSON text and
`structuredContent`.

The HTTP adapter uses fixed paths, a 12-second status deadline, and 25-second
opportunity and work-plan deadlines. Each deadline remains active through
response-body consumption. The adapter also uses manual redirect handling, no
cookies, and a 1 MiB response limit. Strict JSON parsing rejects duplicate
object keys and non-finite numbers. The returned source URLs are not fetched by
this server.

## Maintained local stdio launcher

For a local MCP client, build this repository and start the maintained launcher
with an existing Core Python environment:

```sh
AGENTLINK_CORE_PYTHON=/absolute/path/to/core-venv/bin/python \
  node scripts/run-funding-mcp.mjs
```

The launcher defaults to the sibling `agentlink-core-engine` checkout and this
repository's `dist/index.js`. Set `AGENTLINK_CORE_PATH` or
`AGENTLINK_MCP_BUILD_PATH` to absolute paths only when those checkouts/builds
live elsewhere. The Core Python executable must also be an absolute path. The
launcher validates those paths before starting either child and prints only a
fixed safe error if a path is unavailable.

Each launch starts Core on a newly allocated `127.0.0.1` port, creates a random
transport token in memory, and checks readiness with the authenticated status
route. That status check does not contact a funding provider. Core logs are
not connected to the MCP protocol stream; the MCP child inherits stdin,
stdout, and stderr unchanged. When MCP exits or receives a termination signal,
the launcher stops the Core child as well. This is an explicit foreground
command, not a daemon, login item, or client-configuration editor.

The launcher passes a small allowlist of ordinary runtime environment values
to its children. It removes `REGULATION_WORKFLOW_RELEASE` and
`REGULATION_WORKFLOW_CONTENT_CONFIG` from both child environments and forces
`REGULATION_GUIDELINE_MODE=real`, without changing the parent shell. The
source-bearing work-plan path therefore remains unavailable in this maintained
launcher configuration; no synthetic release is installed or activated.
Provider credentials remain in Core's private JSON store. The launcher never
reads that file or accepts provider keys. Its generated `API_SECRET_KEY` and
`AGENTLINK_CORE_API_KEY` are separate, process-local transport credentials and
are not written to files or command arguments.

The existing workflow scope limitation is:

> Funding discovery and canonical forwarding are implemented. Source-bearing
> subsidy/national-R&D workflow activation is blocked by the upstream
> ContentConfig role-scope mismatch; native expiry/revocation enforcement
> through this bridge is not verified.

## Build and test outside the checkout

The repository intentionally contains no `node_modules` or generated build
output. Use the exact-lock runtime installed by the coordinator under the
external task scratch directory. Its external TypeScript config maps package
types to that runtime without adding a dependency directory to this checkout:

```sh
S=/Volumes/Dev_KJ/task-scratch/agentlink-funding-20261014/surface
RUNTIME="$S/node-runtime"
T=/path/to/agentlink-mcp-server
mkdir -p "$S/tmp"
"$RUNTIME/node_modules/.bin/tsc" --project "$S/tsconfig.json" \
  --noEmit false --outDir "$RUNTIME/dist"
AGENTLINK_FUNDING_BUILD="$RUNTIME/dist" \
AGENTLINK_FUNDING_NODE_MODULES="$RUNTIME/node_modules" \
TMPDIR="$S/tmp" \
  node --test "$T/tests/funding/funding.test.mjs" "$T/tests/funding/launcher.test.mjs"
```

The tests use dummy Core tokens and loopback test servers. The launcher test
uses temporary fake child processes and does not start the real Core, read
provider credentials, or contact Data.go.kr. A native MCP stdio case checks
that the three new tools appear alongside existing tool names and that the
local Core response reaches the client with the expected structured JSON.

## Current boundary

No authenticated provider call or real credential validation is performed by
the TypeScript adapter. A successful opportunity response means only that the
bounded provider page was parsed by Core. It does not establish eligibility,
selection, award, payment, a complete provider feed, or ready workflow content.
Source-bearing subsidy/national-R&D workflow activation remains blocked by the
upstream ContentConfig role-scope mismatch, and native expiry/revocation
enforcement through this bridge has not been verified.
