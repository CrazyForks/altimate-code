# dbt PR Review Self-Improvement Loop

Date: 2026-06-08

## Goal

Make `altimate review` the highest-signal dbt PR reviewer by adding only checks
that survive an end-to-end value test:

1. The finding is backed by deterministic evidence, warehouse execution, or a
   clearly bounded advisory rule.
2. It catches a real dbt PR risk in the public demo or sourced benchmark corpus.
3. It does not add false positives to corrected/safe cases.
4. It produces a review comment that a data engineer would act on.
5. It degrades loudly when required artifacts, schema, or warehouse access are
   missing.

## Recommended `/goal` Command

```text
/goal Objective: make the dbt PR reviewer demo-parity reliable and measurably
higher-signal by closing the current public-demo gaps while preserving the
existing benchmark floor.

Quantified acceptance target:
- Public demo matrix reaches expected verdicts for all 6 demo branches:
  safe-refactor=APPROVE, join-key-breakage=REQUEST_CHANGES,
  test-removal=COMMENT, new-pii-exposure=REQUEST_CHANGES,
  mart-select-star=COMMENT, incremental-without-guard=COMMENT.
- Real-world corpus remains at 15/15 caught bad cases and 0/5 false positives
  on corrected cases.
- At least one warehouse-backed DuckDB e2e proves a real dbt build/test pass
  that the reviewer catches pre-merge.
- Every blocking finding is produced by deterministic core evidence or
  warehouse-observed impact, not advisory AI or heuristic equivalence.

Operating rules:
- Always start by pulling latest main of
  /Users/anandgupta/codebase/altimate-core-internal with fast-forward only.
- Prefer implementing deterministic SQL/dbt analysis in altimate-core, not
  altimate-code. Avoid regex/custom parsing in altimate-code when core
  AST/parser support can own it.
- altimate-code should mostly orchestrate, map core findings to review
  categories/severity, format verdicts, and run GitHub/CI integration.
- For every candidate improvement:
  1. Write a short spec: risk, deterministic evidence, what must not be flagged.
  2. Add bad and safe/corrected fixtures.
  3. Implement in altimate-core when possible.
  4. Build local core Node package and link altimate-code to it only when e2e
     needs the local native package.
  5. Validate with the narrowest useful tests first, then corpus/demo/warehouse
     only at acceptance checkpoints.
  6. Keep only if it improves real review value with no new false positives;
     otherwise revert/reject or make advisory-only.
- Use /Users/anandgupta/codebase/altimate-code/demo/dbt-pr-review-demo for demo
  branch e2e.
- Compile base dbt artifacts into target-base and head artifacts into target
  before review when structural/equivalence lanes need base-vs-head compiled SQL.
- Use local DuckDB first; use BigQuery where warehouse behavior matters and
  credentials are available. Trino/Postgres/ClickHouse/DuckDB can be spawned
  locally. Snowflake later.
- Treat altimate-core equivalence as heuristic unless there is a sound proof
  path. Do not block or approve solely from heuristic equivalence. Block only on
  reproducible deterministic facts or warehouse-observed impact.
- Track results in
  docs/internal/2026-06-08-dbt-pr-review-self-improvement-loop.md.

Iteration speed:
- Optimize for fast learning loops. Do not run full test suites or expensive
  builds by default.
- Start with the narrowest relevant unit test or direct function smoke test.
- Only run broader tests after a candidate passes the focused check.
- Avoid rebuilding altimate-core unless the change affects native exports, NAPI
  bindings, or e2e verification requires the local Node package.
- Prefer `cargo test -p altimate-core <module_or_test_name>` over full cargo
  test.
- Prefer `bun test test/altimate/<specific-test-file>.ts` over full package
  tests.
- Use direct Node smoke tests against `crates/altimate-core-node` before
  relinking altimate-code.
- Run the real-world corpus and demo matrix only at acceptance checkpoints, not
  after every edit.
- Run warehouse e2e only when the value claim depends on observed data
  behavior.
- Keep a short validation ladder for each candidate: smoke -> focused unit ->
  focused integration -> corpus/demo -> warehouse e2e if needed.

Initial backlog:
1. Remove safe-refactor noise: base compiled artifact support and/or equivalence
   degradation handling.
2. Tighten PII precision: do not flag low-confidence Name such as
   customer_name, but still flag email/SSN/phone/payment identifiers.
3. Reduce low-value missing_table_alias comments for dbt CTE-heavy SQL.
4. Expand core structural diff rules for high-signal dbt semantic regressions.
5. Add warehouse data-diff e2e cases that prove real row/value impact.
```

## Skill vs Goal

Create a skill once this loop stabilizes across several iterations. A skill is
the right home for reusable operating instructions: how to pull core, choose
core-vs-code ownership, build local NAPI, run the demo matrix, and apply the
validation ladder. The active `/goal` should still include the quantified
objective above because it provides the stop condition and prevents open-ended
"make it better" work.

## Baseline From Dry Run

Commands run from `packages/opencode` unless noted:

```bash
bun run --conditions=browser script/review-realworld-eval.ts
```

Result:

- Sourced bad-case catch rate: 15/15.
- Corrected-case false positives: 0/5.

Demo matrix run against `demo/dbt-pr-review-demo` branches with the local dbt
virtualenv and `altimate review --mode gate --json`:

| Branch | Expected | Actual | Finding categories |
|---|---:|---:|---|
| `demo/safe-refactor` | `APPROVE` | `COMMENT` | `semantic_change`, `pii_exposure`, `sql_quality` |
| `demo/join-key-breakage` | `REQUEST_CHANGES` | `COMMENT` | `semantic_change`, `pii_exposure`, `sql_correctness`, `sql_quality` |
| `demo/test-removal` | `COMMENT` | `COMMENT` | `test_coverage` |
| `demo/new-pii-exposure` | `REQUEST_CHANGES` | `REQUEST_CHANGES` | `pii_exposure`, `semantic_change`, `sql_quality` |
| `demo/mart-select-star` | `COMMENT` | `COMMENT` | `semantic_change`, `pii_exposure`, `sql_quality`, `test_coverage` |
| `demo/incremental-without-guard` | `COMMENT` | `COMMENT` | `semantic_change`, `pii_exposure`, `join_risk`, `warehouse_cost`, `sql_quality`, `materialization`, `sql_correctness`, `test_coverage` |

Observed problems:

- `safe-refactor` is noisy. The semantic lane cannot decide equivalence because
  base compiled SQL is unavailable, `Name` classification flags `customer_name`
  as PII, and `missing_table_alias` flags harmless CTE aliasing.
- `join-key-breakage` is not blocked. The useful join-key mismatch appears from
  the advisory AI lane, not the deterministic lane, so it cannot gate.
- Several demo branches are degraded because base-vs-head compiled artifacts are
  incomplete. A safe review must not pretend heuristic equivalence is a proof.

## Loop Contract

For each candidate improvement:

1. **Spec**: one paragraph stating the risk, the deterministic evidence, and
   what must not be flagged.
2. **Fixtures**: at least one bad case and one corrected/safe countercase.
3. **Implementation**: smallest scoped change in the reviewer or demo workflow.
4. **Validation**:
   - Unit or harness test for the detector.
   - `bun run --conditions=browser script/review-realworld-eval.ts`.
   - Demo branch matrix for affected branches.
   - Warehouse-backed run when the value claim depends on actual data impact.
5. **Decision**:
   - Keep only if it improves catch rate or demo parity with zero new false
     positives.
   - Reject or keep advisory-only if evidence is heuristic, schema-dependent,
     or too broad.

## First Candidate Backlog

### 1. Deterministic Join-Key Regression Detector

Status: pushed down to `altimate-core-internal` as structural diff rule
`SC010 join_key_regression` in
`crates/altimate-core/src/review/structural_diff.rs`. `altimate-code` only maps
the core finding into the review verdict.

Risk: a PR changes a join predicate from matching the same business key to
joining unrelated identifiers, e.g. `orders.customer_id = customers.customer_id`
becomes `orders.order_id = customers.customer_id`.

Evidence:

- Base and head SQL are both available.
- A changed `JOIN ... ON` equality compares identifier columns ending in `_id`.
- The base predicate joined same-name/same-stem keys, while the head predicate
  joins different stems.

Do not flag:

- Intentional bridge joins such as `orders.order_id = order_items.order_id`.
- Joins where the changed key stems still match.
- Cases without a base predicate to compare.

Expected result:

- `demo/join-key-breakage` gets a deterministic `join_risk` or
  `sql_correctness` critical finding and blocks in gate mode.
- `demo/safe-refactor` remains quiet for this detector.

Validation:

- `git pull --ff-only origin main` completed in
  `/Users/anandgupta/codebase/altimate-core-internal`; latest core main was
  `a413804` before this local rule change.
- `cargo test -p altimate-core review::structural_diff --lib` passed with the
  new `SC010` bad case and safe countercases.
- `bun test --timeout 30000 test/altimate/review.test.ts` passed.
- `bun run --conditions=browser script/review-realworld-eval.ts` stayed at
  15/15 sourced catches and 0/5 corrected false positives.
- Demo matrix: `demo/join-key-breakage` improved from `COMMENT` to
  `REQUEST_CHANGES` with deterministic `join_risk`.
- The detector itself stayed quiet on `demo/safe-refactor` and on the
  same-key bridge-join countercase.

### 2. Base Compiled Artifact Support In Demo CI

Risk: safe refactors degrade to "could not prove equivalent" because the review
has incomplete proof inputs: missing base compiled SQL or incomplete schema
columns.

Evidence:

- `compiled.ts` already supports `target-base/compiled/<project>/<path>`.
- The demo workflow currently runs only head-side `dbt compile`.
- `demo/safe-refactor` became decidable after `dbt docs generate` produced
  `target/catalog.json`, but core equivalence then falsely compared CTE alias
  names inside the join filter.

Do not flag:

- A safe CTE rename where base and head compiled SQL are equivalent or where no
  deterministic structural difference exists.

Expected result:

- The demo workflow compiles base into `target-base` before compiling head.
- The demo workflow produces `target/catalog.json` when a warehouse-backed dbt
  project is available, so equivalence has complete columns.
- `demo/safe-refactor` emits no findings with local core and DuckDB catalog
  artifacts.

Implemented result:

- Core `L012 missing_table_alias` now ignores CTE references, removing the
  `order_records/customer_records` alias noise while preserving real table alias
  lint.
- Core equivalence now resolves join predicate columns through CTE aliases to
  base `table.column` provenance, so CTE alias renames are equivalent but a
  changed join key remains material.
- `altimate-code` now threads the detected dialect into
  `altimate_core.equivalence` and `--no-ai` correctly disables the advisory lane.
- Local DuckDB safe-refactor validation: `APPROVE`, zero findings.
- Real-world corpus floor preserved: 15/15 bad cases caught, 0/5 false
  positives.

### 3. PII Classification Precision Floor

Risk: high-noise PII comments on ordinary names such as `customer_name` reduce
trust and make safe PRs look risky.

Evidence:

- `classify_pii` labels `customer_name` as `Name` at 75% confidence in the demo.
- The stronger demo/security value is email/SSN/phone/payment identifiers and
  source-propagated sensitive columns.

Do not flag:

- `Name` classification below a high confidence threshold.
- Pre-existing PII columns not introduced by the PR.

Expected result:

- `demo/safe-refactor` no longer reports `customer_name`.
- `demo/new-pii-exposure` still reports `email`.

Implemented result:

- Diff-scoped core PII classification is the authoritative PR-review PII
  comment when lineage/classification are available.
- High-confidence non-low-risk PII introduced into `marts/` or `reporting/`
  is critical and blockable from `altimate_core.classify_pii` evidence.
- Low-risk `Name`/`Address` classifications require at least 90% confidence to
  surface, so `first_name`/`customer_name`-style weak signals do not create
  noisy comments.
- Fallback `dbt-patterns`/`rule-catalog` PII twins are suppressed for files
  where the diff-scoped core classifier ran; fallback remains available when
  core lineage/classification is unavailable.
- `demo/new-pii-exposure` now reports one critical core PII finding for
  `email` plus the core equivalence warning, and still returns
  `REQUEST_CHANGES`.
- Real-world corpus floor preserved: 15/15 bad cases caught, 0/5 false
  positives.

## Current Acceptance Checkpoint

Demo matrix with local core, base artifacts in `target-base`, head artifacts in
`target`, and AI disabled:

| Branch | Expected | Actual | Deterministic evidence |
|---|---:|---:|---|
| `demo/safe-refactor` | `APPROVE` | `APPROVE` | no findings |
| `demo/join-key-breakage` | `REQUEST_CHANGES` | `REQUEST_CHANGES` | `altimate_core.structural_diff:SC010`, core equivalence |
| `demo/test-removal` | `COMMENT` | `COMMENT` | `dbt-patterns:removed_tests` |
| `demo/new-pii-exposure` | `REQUEST_CHANGES` | `REQUEST_CHANGES` | `altimate_core.classify_pii`, core equivalence |
| `demo/mart-select-star` | `COMMENT` | `COMMENT` | core equivalence warning |
| `demo/incremental-without-guard` | `COMMENT` | `COMMENT` | core dbt config lint + deterministic catalog cost notes |

DuckDB e2e proof:

- Branch: `demo/join-key-breakage`.
- `dbt build --profiles-dir . --target dev`: passed `PASS=14 WARN=0 ERROR=0`.
- Reviewer: `REQUEST_CHANGES` with critical `join_risk` from
  `altimate_core.structural_diff` rule `join_key_regression` (`SC010`).

Warehouse data-diff e2e proof:

- Test: `packages/opencode/test/altimate/data-diff-duckdb-e2e.test.ts`.
- Connection: local DuckDB via `@altimateai/drivers/duckdb`.
- Base/head relations: `base_orders` and `head_orders`.
- Key columns: `order_id`; compared value column: `amount`.
- Observed warehouse delta: one row only in head and one updated value.
- Validation:
  `ALTIMATE_RUN_WAREHOUSE_E2E=1 bun test --timeout 30000 test/altimate/data-diff-duckdb-e2e.test.ts`.
- Default fast-loop behavior:
  `bun test --timeout 30000 test/altimate/data-diff-duckdb-e2e.test.ts`
  skips unless `ALTIMATE_RUN_WAREHOUSE_E2E=1` is set.
- Implementation note: fixed the DuckDB connector to use the two-argument
  constructor when no open options are required; Bun's native binding can miss
  the callback when `undefined` is passed as the second argument.

## Warehouse E2E Policy

Use local DuckDB first for fast end-to-end checks, then add BigQuery runs when a
candidate needs production-style warehouse behavior. Trino, Postgres,
ClickHouse, and DuckDB can be spawned locally. Snowflake is deferred until a
separate account is available.

Warehouse-backed findings must include:

- The connection used.
- Base/head SQL or model relation names.
- Key columns.
- Row/value delta summary.
- A skip/degraded state when credentials or drivers are unavailable.
