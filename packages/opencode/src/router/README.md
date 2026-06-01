# Verifier-gated router

Run a cheap model first, verify the result deterministically, and escalate to a
stronger model only when verification fails. Most runs finish at the cheap tier;
the rest get a stronger attempt that receives the exact failing checks as context.
Flag-gated (`ALTIMATE_ROUTER`), default off — the normal single-model path is unchanged.

## Modules (pure, unit-tested)
- **`verifier.ts`** — `Verifier`: a deterministic `Verdict` from `dbt build`/`dbt test`
  output (`fromDbt`, `parseDbtSummary`, `failingNodes`). Every verdict carries a
  **`Strength`** (`UNVERIFIABLE < BUILD < DBT_TEST < EQUIVALENCE`) and a **`Decision`**
  (`OK | PROVEN_DIFFERENT | UNDECIDABLE | FAILED`) so consumers know *how strongly* a
  result was proven, not just pass/fail. `Impl` is the pluggable verifier interface; the
  default `dbtVerifier(run)` shells dbt (runner injected, fail-open). `fromEquivalence`
  folds per-model equivalence results soundly. `ALLOW_ALL` passes everything (ungated).
- **`equivalence-verifier.ts`** — `EquivalenceVerifier`: an optional, stronger `Impl` for
  the *reference-available* regime (editing an existing model) — compares base↔head
  compiled SQL via the altimate-core equivalence engine. **Not wired into the default run
  path in v1** (see "What v1 verifies"); it ships dormant behind the dbt build verifier.
- **`reference.ts`** — `ReferenceResolver`: produces the base↔head compiled-SQL pairs the
  equivalence verifier needs (all git/dbt-compile/schema IO injected → unit-tested). Returns
  `null` for greenfield (no base → build-fallback). Dormant alongside `equivalence-verifier`;
  the production git+dbt-backed `Deps` + a flag-gated `verifyWorkspace` switch are the final
  connect step, pending broader warehouse-dialect coverage in altimate-core
  (equivalence currently abstains on dialect functions like duckdb `STRFTIME`).
- **`router.ts`** — `Router`: the escalation mechanism. `route({tiers, runAgent, verify})`
  runs each tier, verifies, escalates on a failed verdict with the failing checks
  (`escalationContext`), stops at the first pass. `shouldEscalate` is **decision-aware**:
  it escalates on `FAILED`/`PROVEN_DIFFERENT` but **never on `UNDECIDABLE`** (a stronger
  model can't make an undecidable query decidable). `DEFAULT_LADDER` is ordered
  cheapest → strongest; override via `ALTIMATE_ROUTER_LADDER`.
- **`policy.ts`** — `Policy`: where the ladder comes from. `STATIC` is the built-in
  default; `altimate(key)` fetches a per-context ladder from the altimate API when
  `ALTIMATE_API_KEY` is set (degrades to static on any failure); `resolve()` picks
  between them; `reportOutcome()` posts verified outcomes back (key-gated, best-effort).
  `sanitizeTiers` validates + caps any ladder from the API.
- **`verdict.ts`** — `Verdict.Envelope` (schemaVersion 2): a machine-checkable record of the
  result (accepted tier, `strength` + `decision`, per-attempt history, checks, evidence
  hash, timestamp, optional signature).

## What v1 verifies (read before enabling)
v1 ships the **dbt build** verifier: a verdict is `OK` at **`BUILD`** strength when
`dbt build` exits 0 with no errors. That proves the output **compiles and the project's
own tests pass — it does NOT prove value-correctness.** The envelope is honest about this:
the `strength` field says `BUILD`, not `EQUIVALENCE`. Treat the receipt as
"build-verified", not "proven equivalent". The `EQUIVALENCE`-strength path
(`equivalence-verifier.ts`) is gated on broader warehouse-dialect coverage in altimate-core
(decidability) and lands in a later release.

## When to enable
Enable when the **tier-1 model is a strong cheap model** (the default `deepseek-v4-flash`
benchmarks at parity with frontier on dbt tasks). With a strong tier-1, escalation fires
rarely (only on a genuine build failure), so the router is economically favorable. With a
*weak* tier-1, escalation fires constantly and can cost as much as just using the strong
model — don't do that. The router is a **model-selection + verify** tool first, an
escalation ladder second.

## Default ladder rationale
`deepseek-v4-flash → glm-5.1 → claude-opus-4.8`. Tier-1 is a validated strong-cheap model.
Benchmarking (N=10 dbt tasks) found tier-2 (`glm-5.1`) quality-redundant with tier-1, but
it is retained as a **failover / data-governance substitute** slot pending a larger powered
tiering study; the final tier is a frontier model for genuine build failures. Override the
whole ladder with `ALTIMATE_ROUTER_LADDER`.

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
- **Unit** — `test/router/{verifier,router,verdict,policy,verdict-strength,equivalence-verifier}.test.ts`.
  Pure logic, incl. adversarial cases (dbt summary-line injection, ANSI/huge/multi-summary
  output, endpoint response validation/capping), the tri-state strength/decision contract,
  and the equivalence verifier's sound fallback (undecidable → build/test, never silent pass).
- **E2E** (`test/router/*.e2e.test.ts`, env-gated — require docker + a dbt image +
  network, excluded from default CI):
  - `verifier.e2e` — real `dbt build` (pass / compile-error / failing-test) and that a
    model emitting a fake summary does not change the verdict. `E2E_IMG=<image> bun test verifier.e2e`.
  - `router.e2e` — real model calls + real dbt: cheap tier solves; an unsatisfiable
    workspace escalates through tiers, caps, and threads failing-check context.
    `OPENROUTER_API_KEY=… E2E_IMG=… bun test router.e2e`.
  - `policy.e2e` — real network: live local server (incl. error/malformed/oversized
    responses) and an unreachable endpoint, all degrade gracefully. `bun test policy.e2e`.
