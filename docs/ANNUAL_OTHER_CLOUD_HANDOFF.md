# Annual OTHER continuation — historical cloud checklist

**Latest user direction: continue on MacBook. Read ANNUAL_OTHER_MACBOOK_HANDOFF.md first. Do not launch another cloud task.**

Draft checkpoint, 2026-10-24. Finish the annual-other bridge changes on branch `test/tax-annual-other-20261022`; do not assume release readiness. Native runtime is an independently installed dependency.

- New runner `tests/tax/annual-other-live.mjs` saves `{calculations, answers, negative_cases, summary}` under `annual_other` in private acceptance receipt. Nine computed annual cases, one unresolved negative complete case, five input/evidence blockers, five practitioner answers.
- Retain all existing payment acceptance cases and validation; native tools20 and upper19 unchanged. Current package preflight expects30 calculation cards/eight annual IDs/new module.
- Worker-reported Oct22 checks: build pass; actual official parser5pass; bridge timeout check flaked under load and passed isolated retry. Repeat required current checks; no fresh installed/live acceptance exists.
- Run build, focused bridge/parser checks and required real installed integration. Coordinate with the native provider's cloud task; do not manufacture fake success when package or law credentials are absent. No deadline/retry expansion.
- Supported scenario:2026 current-law projection, one recipient, ordinary supported OTHER income only, self basic deduction, standard local rates. Keep annual outputs separate from monthly payer withholding/forms. Negative separate complete cases block annual tax conclusions pending legal interpretation. Output is calculated tax before credits/payment rounding, not final payable/refund.
- Full schema/contract, basis, counts, boundary, private install and independent review gates must pass before ready/merge. Fetch current main and preserve others' work; no force/admin/auto-merge/deployment.
- Keep private repository identifiers, local paths, credentials, and raw private acceptance data out of this public repository and PR.
