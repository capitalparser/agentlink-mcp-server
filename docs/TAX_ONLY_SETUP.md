# Tax-only MCP setup

This guide connects the upper MCP server to an installed tax-domain MCP package. The upper server starts and verifies the configured tax child before it accepts MCP connections, then advertises tax tools only after the child has listed and passed the expected tool-contract checks. Subsidy and demo tools are disabled by default.

## Required installed artifact

Use the authorized tax-domain Python wheel in a dedicated Python 3.12 environment. The wheel includes the matching canonical registry, so no separate registry artifact is required. Do not use a source checkout or `PYTHONPATH` as the runtime installation.

Create the environment and install the wheel supplied to you:

```sh
python3.12 -m venv /path/to/tax-venv
/path/to/tax-venv/bin/python -m pip install /path/to/authorized/tax-domain.whl
```

The installed server uses the registry bundled at `agentlink_tax/_registry` by default. `AGENTLINK_TAX_REGISTRY` is an optional exact-path override for compatibility. When set, that path replaces the bundled registry; an empty, missing, malformed, or invalid override fails startup without falling back to the bundle.

Use the Python MCP SDK 1.x dependency range supported by that wheel. If the child cannot complete MCP initialization because one of its imports is missing or has moved, ask the artifact owner for a compatible wheel or dependency set; installing the package alone does not establish runtime compatibility. The upper bridge reports only a safe status/error code and does not expose child tracebacks.

Install or build the upper MCP server through your approved package process. Its entry point is `dist/index.js` in the installed package.

## MCP client configuration

Add a server entry to the MCP client's configuration. Replace the placeholders with paths available to that client account:

```json
{
  "mcpServers": {
    "agentlink-tax": {
      "command": "node",
      "args": ["/path/to/upper-mcp/dist/index.js"],
      "env": {
        "AGENTLINK_TAX_MCP_COMMAND": "/path/to/tax-venv/bin/python",
        "AGENTLINK_TAX_MCP_ARGS": "[\"-B\",\"-m\",\"agentlink_tax.server\"]"
      }
    }
  }
}
```

`AGENTLINK_TAX_MCP_ARGS` is a JSON array encoded as a string. The Python interpreter must be the environment where the wheel was installed. The wheel installation removes the need for a separate registry artifact or a source-tree `PYTHONPATH`.

The default startup exposes the verified tax tools and `agentlink_bridge_status`. Optional subsidy tools remain unavailable until their domain is explicitly configured. Stub/demo tools require the explicit `AGENTLINK_DEMO_TOOLS=1` opt-in.

## Check readiness and recover

Call `agentlink_bridge_status` to inspect whether the tax domain is configured, its current state or safe error code, and the count/names of verified tools. It does not return local command lines, paths, credentials, child output, or tax facts.

If startup shows an unavailable tax domain, check that the configured interpreter can import the installed package and that its bundled registry is complete. If you deliberately set `AGENTLINK_TAX_REGISTRY`, also check that exact path; an invalid override does not use the bundled copy. Correct the client environment and restart the MCP server. If the configured paths are already correct and a transient startup issue has cleared, call `agentlink_bridge_status` with `{ "refresh": true }` to retry connection and contract verification. Tax tools are advertised only after a successful refresh.

Do not copy private configuration values into logs or support messages. If the status contains a fixed error code, use it to route diagnosis while keeping machine paths and credentials local.

## Result limits

`tax_plan_work` returns a review draft. It can calculate withholding for two explicitly selected payment profiles when all required user facts are present and the current-law basis is fetched and matched: `business_lecture` for continuing, repeated independent lectures, and `other_lecture` for temporary lectures where actual expenses do not exceed the statutory allowance. Set `include_evidence=true`; without matched evidence or complete facts, the payment has no calculated amounts. These scoped payment results do not decide applicability for the whole matter, which remains `not_determined`, and they do not issue a final filing decision, file, or submit anything. The facts are user-supplied and pending review. An input `withheld_amount` remains the actual reported amount and is kept separate from the calculated amount. Other income types, lecture classifications outside these conditions, and the eight other listed workflows including VAT remain outside this calculation scope; those workflows remain `contract_only` until separately implemented and verified.

The withholding deadline remains a candidate and must be checked against current rules and calendars. When the external holiday provider is unavailable, the result retains a warning that public and substitute holidays were not applied; that fallback is not verified holiday data. Missing facts stay as questions.

## Run the installed-child integration check

The offline integration test launches the built upper MCP through the MCP SDK's stdio transport, then lets it launch the installed Python wheel with its bundled registry. It uses synthetic wage facts, disables external evidence lookup, and points credentials to a nonexistent temporary file. It never calls the tax planner directly.

```sh
npm run build
AGENTLINK_TEST_TAX_PYTHON=/path/to/tax-venv/bin/python \
npm run test:integration
```

The ordinary test suite may skip this integration when the interpreter is missing. `test:integration` sets `AGENTLINK_REQUIRE_TAX_INTEGRATION=1`, so a missing interpreter fails instead of being reported as a skip. `AGENTLINK_TEST_TAX_REGISTRY` is optional for deliberate override compatibility checks; if explicitly set to an invalid path, the test fails. The required `test:integration:live` acceptance uses the installed noneditable wheel, real law.go.kr credentials, and current-law retrieval to verify both lecture profiles and their projected practitioner amounts. It fails clearly when the current date is outside the supported evidence window or when law retrieval, identity, version, hash, or semantic checks do not pass. The test removes its temporary data on completion and keeps any requested calculation receipt under the caller-provided scratch directory with owner-only permissions.
