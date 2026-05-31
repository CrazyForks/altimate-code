# Verifier-gated router

Run a cheap model first, verify the result deterministically, and escalate to a
stronger model only when verification fails. Most runs finish at the cheap tier;
the rest get a stronger attempt that receives the exact failing checks as context.
Flag-gated (`ALTIMATE_ROUTER`), default off — the normal single-model path is unchanged.

## Modules (pure, unit-tested)
- **`verifier.ts`** — `Verifier`: a deterministic `Verdict` from `dbt build`/`dbt test`
  output (`fromDbt`, `parseDbtSummary`, `failingNodes`). `Impl` is the pluggable
  verifier interface; the default `dbtVerifier(run)` shells dbt (runner injected,
  fail-open). `ALLOW_ALL` passes everything when no verifier is configured.
- **`router.ts`** — `Router`: the escalation mechanism. `route({tiers, runAgent, verify})`
  runs each tier, verifies, escalates on a failed verdict with the failing checks
  (`escalationContext`), stops at the first pass. `DEFAULT_LADDER` is ordered
  cheapest → strongest; override via `ALTIMATE_ROUTER_LADDER`.
- **`policy.ts`** — `Policy`: where the ladder comes from. `STATIC` is the built-in
  default; `altimate(key)` fetches a per-context ladder from the altimate API when
  `ALTIMATE_API_KEY` is set (degrades to static on any failure); `resolve()` picks
  between them; `reportOutcome()` posts verified outcomes back (key-gated, best-effort).
  `sanitizeTiers` validates + caps any ladder from the API.
- **`verdict.ts`** — `Verdict.Envelope`: a machine-checkable record of the result
  (which tier, per-attempt history, checks, evidence hash, timestamp, optional signature).

## Configuration
- `ALTIMATE_ROUTER=1` — enable routing (default off).
- `ALTIMATE_ROUTER_LADDER` — comma-separated `provider/model` ids to override the default ladder.
- `ALTIMATE_API_KEY` / `ALTIMATE_API_URL` — use the altimate API for the routing policy
  and outcome reporting instead of the static ladder.

## Integration
`src/cli/cmd/run.ts` (`RunCommand`): when `Router.enabled()`, the run resolves a policy,
runs each tier by re-invoking the existing run path with that model (escalation note
prepended) in the same workspace, verifies with `dbt build` between tiers, and emits a
verdict envelope. The default (non-router) path is untouched.

## Tests
- **Unit** — `test/router/{verifier,router,verdict,policy}.test.ts`. Pure logic, incl.
  adversarial cases (dbt summary-line injection, ANSI/huge/multi-summary output,
  endpoint response validation/capping).
- **E2E** (`test/router/*.e2e.test.ts`, env-gated — require docker + a dbt image +
  network, excluded from default CI):
  - `verifier.e2e` — real `dbt build` (pass / compile-error / failing-test) and that a
    model emitting a fake summary does not change the verdict. `E2E_IMG=<image> bun test verifier.e2e`.
  - `router.e2e` — real model calls + real dbt: cheap tier solves; an unsatisfiable
    workspace escalates through tiers, caps, and threads failing-check context.
    `OPENROUTER_API_KEY=… E2E_IMG=… bun test router.e2e`.
  - `policy.e2e` — real network: live local server (incl. error/malformed/oversized
    responses) and an unreachable endpoint, all degrade gracefully. `bun test policy.e2e`.
