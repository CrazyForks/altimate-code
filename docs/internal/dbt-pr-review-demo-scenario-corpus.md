# dbt PR Review Demo Scenario Corpus

Status: active corpus build, started 2026-06-08.

Goal: build 50 customer-demo-ready dbt PR scenarios in
`/Users/anandgupta/codebase/altimate-code/demo/dbt-pr-review-demo`. Each
scenario should be a small PR branch that either demonstrates a deterministic
reviewer catch or proves the reviewer correctly stays quiet for a safe change.

## Acceptance Contract

- 50 runnable demo PR branches.
- Every scenario has a unique id, title, risk category, expected verdict,
  deterministic evidence source, validation command, and customer demo script.
- No materially duplicate scenarios.
- DuckDB is the default warehouse.
- Final 50-branch matrix reaches the expected verdict for every implemented
  branch.
- Real-world corpus remains 15/15 caught bad cases and 0/5 false positives.
- Blocking findings come from `altimate-core` deterministic evidence or
  warehouse-observed impact, not advisory AI.
- Scenarios that need missing deterministic support are deferred rather than
  forced into noisy demos.

## Metadata Schema

The catalog below is intentionally table-shaped so it can be copied into YAML or
JSON once the pilot branch runner is added.

Required fields:

| Field | Meaning |
|---|---|
| `id` | Stable scenario id, `sNNN`. |
| `branch` | Demo branch name, `demo/<id>-<slug>` for new branches. Existing branches keep their current names. |
| `status` | `existing`, `pilot`, `planned`, or `deferred-core-needed`. |
| `title` | Customer-facing title. |
| `category` | Reviewer category or taxonomy bucket. |
| `expected` | Expected verdict: `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`. |
| `evidence` | Deterministic evidence source expected in the finding. |
| `artifact_needs` | `manifest`, `catalog`, `target-base`, `warehouse`, or combinations. |
| `validation` | Focused command or matrix selector. |
| `demo_script` | Short customer-facing explanation. |

Default focused validation command:

```bash
ALTIMATE_LOCAL_CORE=/Users/anandgupta/codebase/altimate-core-internal/crates/altimate-core-node \
  bun --conditions=browser /Users/anandgupta/codebase/altimate-code/packages/opencode/src/index.ts review \
  --cwd /Users/anandgupta/codebase/altimate-code/demo/dbt-pr-review-demo \
  --base=main \
  --head=HEAD \
  --mode=gate \
  --manifest=/Users/anandgupta/codebase/altimate-code/demo/dbt-pr-review-demo/target/manifest.json \
  --json \
  --no-ai
```

Base artifacts should be generated from `main` into `target-base`; head
artifacts should be generated on the scenario branch into `target`.

## Current Inventory

| id | branch | status | title | category | expected | evidence | artifact_needs | demo_script |
|---|---|---|---|---|---|---|---|---|
| s001 | `demo/safe-refactor` | existing | Safe CTE refactor is approved | safe_refactor | APPROVE | no findings after core equivalence proof | manifest, catalog, target-base | Shows the reviewer will not create noise for a harmless rewrite. |
| s002 | `demo/join-key-breakage` | existing | Wrong join key changes order attribution | join_risk | REQUEST_CHANGES | `altimate_core.structural_diff:join_key_regression` | manifest, catalog, target-base | Shows a PR that compiles and passes dbt tests but changes business attribution. |
| s003 | `demo/test-removal` | existing | Primary-key tests removed | test_coverage | COMMENT | `dbt-patterns:removed_tests` | manifest | Shows governance drift when a model loses its uniqueness guard. |
| s004 | `demo/new-pii-exposure` | existing | Customer email exposed in a mart | pii_exposure | REQUEST_CHANGES | `altimate_core.classify_pii` | manifest, catalog, target-base | Shows deterministic PII classification blocking a sensitive mart exposure. |
| s005 | `demo/mart-select-star` | existing | SELECT star in a published mart | semantic_change | COMMENT | `altimate_core.equivalence` warning | manifest, catalog, target-base | Shows a low-noise warning for an output-shape change in a mart. |
| s006 | `demo/incremental-without-guard` | existing | Unsafe incremental conversion | materialization | COMMENT | `altimate_core.dbt_config:incremental_no_guard` | manifest | Shows dbt config parsing catching an incremental model without a guard. |

## Planned 50-Scenario Corpus

### Pilot Tranche

The first 10 are the low-noise pilot. They cover existing validated branches plus
four new branches with deterministic support already present.

| id | branch | status | title | category | expected | evidence | artifact_needs | demo_script |
|---|---|---|---|---|---|---|---|---|
| s001 | `demo/safe-refactor` | existing | Safe CTE refactor is approved | safe_refactor | APPROVE | no findings | manifest, catalog, target-base | Proves the reviewer rewards safe cleanup rather than punishing it. |
| s002 | `demo/join-key-breakage` | existing | Wrong join key changes order attribution | join_risk | REQUEST_CHANGES | `altimate_core.structural_diff:join_key_regression` | manifest, catalog, target-base | Catches a silent semantic bug missed by compilation. |
| s003 | `demo/test-removal` | existing | Primary-key tests removed | test_coverage | COMMENT | `dbt-patterns:removed_tests` | manifest | Keeps model contracts visible during PR review. |
| s004 | `demo/new-pii-exposure` | existing | Customer email exposed in a mart | pii_exposure | REQUEST_CHANGES | `altimate_core.classify_pii` | manifest, catalog, target-base | Blocks sensitive data propagation before merge. |
| s005 | `demo/mart-select-star` | existing | SELECT star in a published mart | semantic_change | COMMENT | `altimate_core.equivalence` | manifest, catalog, target-base | Warns that an apparently small projection change alters the published contract. |
| s006 | `demo/incremental-without-guard` | existing | Unsafe incremental conversion | materialization | COMMENT | `altimate_core.dbt_config` | manifest | Flags a classic dbt incremental footgun. |
| s007 | `demo/s007-type-narrowing-amount` | pilot | Amount type narrowed | contract_violation | COMMENT | `altimate_core.structural_diff:type_narrowing` | manifest, target-base | Shows truncation/overflow risk before downstream dashboards break. |
| s008 | `demo/s008-join-on-cast` | pilot | Join key wrapped in CAST | join_risk | COMMENT | `altimate_core.check:cast_in_join_key` | manifest | Shows optimizer/key-pruning risk from casting join keys. |
| s009 | `demo/s009-join-or-condition` | pilot | OR added to join condition | join_risk | COMMENT | `altimate_core.check:or_in_join` | manifest | Shows explosive join risk from a broad OR condition. |
| s010 | `demo/s010-test-disabled` | pilot | Uniqueness test disabled | test_coverage | COMMENT | `dbt-patterns:removed_tests` | manifest | Shows a uniqueness guard being disabled in a way that removes the test guarantee. |

### Remaining Planned Scenarios

| id | branch | status | title | category | expected | evidence | artifact_needs | demo_script |
|---|---|---|---|---|---|---|---|---|
| s011 | `demo/s011-left-join-to-inner` | implemented | LEFT JOIN changed to INNER JOIN | semantic_change | COMMENT | `altimate_core.structural_diff:join_type_change` | manifest, target-base | Highlights row-loss risk from changing join optionality. |
| s012 | `demo/s012-join-using-ambiguity` | planned | JOIN USING hides merged key behavior | join_risk | COMMENT | `rule-catalog:using-join` | manifest | Shows ambiguity from merged join columns. |
| s013 | `demo/s013-right-join-readability` | planned | RIGHT JOIN introduced | sql_quality | COMMENT | `rule-catalog:right-join` | manifest | Shows a readability/maintainability warning with low blocking risk. |
| s014 | `demo/s014-cross-join-filtered` | implemented | Filtered CROSS JOIN introduced | join_risk | REQUEST_CHANGES | `dbt-patterns:cross_join` | manifest | Shows a high-confidence fanout/cost catch even when a WHERE filter preserves current rows. |
| s015 | `demo/s015-multiple-left-joins` | implemented-needs-strengthening | Multiple LEFT JOINs create fanout risk | semantic_change | COMMENT | `altimate_core.equivalence` | manifest, target-base | Shows a fanout-shaped change, but should be strengthened with a precise fanout rule before customer demo. |
| s016 | `demo/s016-distinct-added` | implemented | DISTINCT added to hide duplicates | semantic_change | COMMENT | `altimate_core.structural_diff:distinct_added` | manifest, target-base | Shows dedup masking rather than fixing upstream grain. |
| s017 | `demo/s017-limit-added` | implemented | LIMIT added to a mart | sql_correctness | REQUEST_CHANGES | `dbt-patterns:limit-in-model`, `altimate_core.structural_diff:limit_added` | manifest, target-base | Shows accidental sampling in production logic. |
| s018 | `demo/s018-clock-column` | implemented | Runtime clock added to mart output | sql_correctness | COMMENT | `rule-catalog:timezone-naive-now` | manifest | Shows non-reproducible output from run-time clock functions. |
| s019 | `demo/s019-scalar-subquery-select` | implemented-needs-strengthening | Scalar subquery added to SELECT | semantic_change | COMMENT | `altimate_core.equivalence` | manifest, target-base | Shows output-shape semantic drift, but should be strengthened with a precise scalar-subquery rule before customer demo. |
| s020 | `demo/s020-not-in-subquery` | implemented | NOT IN subquery added | sql_correctness | COMMENT | `altimate_core.check:not_in_nullable`, `rule-catalog:not-exists-suggested` | manifest | Shows the NULL-sensitive `NOT IN` failure mode. |
| s021 | `demo/s021-window-partition-dropped` | deferred-core-needed | Window partition removed | semantic_change | COMMENT | core structural diff needed | manifest, target-base | Would catch ranking/dedup leakage across customers. |
| s022 | `demo/s022-window-order-reversed` | deferred-core-needed | Latest-order window order reversed | semantic_change | COMMENT | core structural diff needed | manifest, target-base | Would catch choosing oldest record instead of latest. |
| s023 | `demo/s023-limit-added` | planned | LIMIT added to mart | semantic_change | COMMENT | `altimate_core.structural_diff` limit support if surfaced | manifest, target-base | Shows accidental sampling in production logic. |
| s024 | `demo/s024-date-filter-widened` | planned | Date filter widened | semantic_change | COMMENT | `altimate_core.equivalence` or core-needed predicate value change | manifest, target-base | Shows time-window drift in KPI definitions. |
| s025 | `demo/s025-status-filter-changed` | planned | Completed orders changed to non-refunded orders | semantic_change | COMMENT | `altimate_core.equivalence` or core-needed predicate value change | manifest, target-base | Shows subtle business-definition drift. |
| s026 | `demo/s026-incremental-unique-key-removed` | planned | Incremental unique key removed | materialization | COMMENT | `altimate_core.dbt_config` | manifest | Shows duplicate risk in incremental merges. |
| s027 | `demo/s027-incremental-var-no-default` | planned | Incremental logic depends on var without default | materialization | COMMENT | `altimate_core.dbt_config` | manifest | Shows brittle CI/prod behavior from missing var defaults. |
| s028 | `demo/s028-microbatch-lookback-zero` | planned | Microbatch lookback too small | materialization | COMMENT | `altimate_core.dbt_config` | manifest | Shows late-arriving data risk. |
| s029 | `demo/s029-materialized-table-to-view` | planned | Mart materialization changed to view | materialization | COMMENT | `altimate_core.dbt_config` | manifest | Shows cost/latency implications of materialization drift. |
| s030 | `demo/s030-contract-enforced-removed` | planned | Enforced contract removed | contract_violation | REQUEST_CHANGES | `rule-catalog:contract-enforced-removed` | manifest | Shows downstream schema guarantees being removed. |
| s031 | `demo/s031-contract-column-removed` | planned | Contract column removed from YAML | contract_violation | COMMENT | `rule-catalog:yml-column-removed` | manifest | Shows docs/contract metadata drift. |
| s032 | `demo/s032-contract-data-type-narrowed` | planned | Contract data type narrowed | contract_violation | COMMENT | `rule-catalog:yml-data-type-narrowed` | manifest | Shows schema-change risk even when SQL compiles. |
| s033 | `demo/s033-accepted-values-removed` | planned | Status enum test removed | test_coverage | COMMENT | `rule-catalog:accepted-values-removed` | manifest | Shows unexpected enum values can reach metrics. |
| s034 | `demo/s034-test-severity-warn` | planned | Failing test downgraded to warning | test_coverage | COMMENT | `rule-catalog:test-severity-warn` | manifest | Shows CI guardrails being weakened. |
| s035 | `demo/s035-relationships-test-removed` | planned | Relationship test removed | test_coverage | COMMENT | `dbt-patterns:removed_tests` | manifest | Shows foreign-key guard removal. |
| s036 | `demo/s036-new-phone-pii` | planned | Phone number exposed in mart | pii_exposure | REQUEST_CHANGES | `altimate_core.classify_pii` | manifest, catalog, target-base | Shows sensitive contact-data propagation. |
| s037 | `demo/s037-new-ssn-pii` | planned | SSN exposed in mart | pii_exposure | REQUEST_CHANGES | `altimate_core.classify_pii` | manifest, catalog, target-base | Shows high-risk identifier blocking. |
| s038 | `demo/s038-weak-pii-hash` | planned | Weak hash used for PII | pii_exposure | COMMENT | `rule-catalog:weak-pii-hash` | manifest | Shows masking that is not actually safe. |
| s039 | `demo/s039-plaintext-pii-key` | planned | Plaintext PII used as key | pii_exposure | COMMENT | `rule-catalog:plaintext-pii-key` | manifest | Shows sensitive identifiers entering joins/dedup keys. |
| s040 | `demo/s040-pii-concat` | planned | PII concatenated into label | pii_exposure | COMMENT | `rule-catalog:pii-concat` | manifest | Shows derived PII leakage. |
| s041 | `demo/s041-table-without-cluster` | planned | Large mart table lacks clustering | warehouse_cost | COMMENT | `rule-catalog:table-no-cluster-large` | manifest, catalog | Shows cost guardrails from catalog-aware table metadata. |
| s042 | `demo/s042-partition-function-filter` | planned | Function applied to partition filter | warehouse_cost | COMMENT | `dbt-patterns:partition-function` | manifest | Shows partition pruning defeat. |
| s043 | `demo/s043-scalar-subquery-select` | planned | Scalar subquery added to SELECT | warehouse_cost | COMMENT | `rule-catalog:scalar-subquery-select` | manifest | Shows per-row execution risk. |
| s044 | `demo/s044-in-subquery-large` | planned | Large IN subquery introduced | warehouse_cost | COMMENT | `rule-catalog:in-subquery-large` | manifest | Shows optimizer-unfriendly semi-join pattern. |
| s045 | `demo/s045-data-diff-row-added` | planned | Warehouse data diff catches extra row | semantic_change | COMMENT | warehouse data diff | warehouse, manifest, target-base | Shows observed row-level impact when static proof is insufficient. |
| s046 | `demo/s046-data-diff-value-changed` | planned | Warehouse data diff catches value change | semantic_change | COMMENT | warehouse data diff | warehouse, manifest, target-base | Shows observed metric drift on real DuckDB relations. |
| s047 | `demo/s047-doc-description-removed` | planned | Model description removed | sql_quality | COMMENT | `rule-catalog:yml-description-removed` | manifest | Shows governance/docs drift for data consumers. |
| s048 | `demo/s048-owner-meta-removed` | deferred-core-needed | Owner metadata removed | governance | COMMENT | deterministic YAML metadata rule needed | manifest | Would show ownership accountability drift. |
| s049 | `demo/s049-safe-column-reorder` | planned | Safe column reorder is approved | safe_refactor | APPROVE | no findings after equivalence proof | manifest, catalog, target-base | Shows precision on harmless formatting/output-order-insensitive changes if supported. |
| s050 | `demo/s050-safe-cte-extraction` | planned | Safe CTE extraction is approved | safe_refactor | APPROVE | no findings after equivalence proof | manifest, catalog, target-base | Shows the reviewer supports normal refactoring workflows. |

## Deferred Capability List

These should become demo branches only after deterministic support exists:

- Window partition/order diff (`s021`, `s022`) in `altimate-core` structural diff.
- Owner/meta YAML removal (`s048`) in core/dbt metadata parsing or a deterministic
  structured YAML lane.
- Predicate value-change classification (`s024`, `s025`) should be promoted from
  generic non-equivalence to a precise structural predicate-value rule before
  making it a primary customer demo.

## Validation Matrix Status

| tranche | implemented branches | matrix status | notes |
|---|---:|---|---|
| existing | 6 | passed in prior checkpoint | Documented in `2026-06-08-dbt-pr-review-self-improvement-loop.md`. |
| pilot | 10 | passed locally | `s001`-`s010` reached expected verdicts with fresh DuckDB state per branch. |
| tranche 2 | 10 | passed locally | `s011`-`s020` reached observed expected verdicts; `s015` and `s019` need stronger precise evidence before final customer demo. |
| full corpus | 50 | pending | Scale only after pilot remains low-noise. |

## Pilot Matrix Result

Run date: 2026-06-08.

Validation setup:

- Base artifacts regenerated from demo `main` into `target-base`.
- Each branch ran with a fresh `demo.duckdb` file.
- Each branch ran `dbt build`, `dbt compile`, and `dbt docs generate`.
- Reviewer ran through local `altimate-code` with local `altimate-core` linked.
- AI was disabled. During the first pilot run this required a temporary local
  config because `--no-ai` was misregistered; the CLI flag is now fixed in
  `altimate-code` and the explicit command above works.

| id | branch | expected | actual | findings | deterministic evidence |
|---|---|---:|---:|---:|---|
| s001 | `demo/safe-refactor` | APPROVE | APPROVE | 0 | no findings |
| s002 | `demo/join-key-breakage` | REQUEST_CHANGES | REQUEST_CHANGES | 3 | `altimate_core.structural_diff:join_key_regression`, core equivalence |
| s003 | `demo/test-removal` | COMMENT | COMMENT | 1 | `dbt-patterns:removed_tests` |
| s004 | `demo/new-pii-exposure` | REQUEST_CHANGES | REQUEST_CHANGES | 2 | `altimate_core.classify_pii`, core equivalence |
| s005 | `demo/mart-select-star` | COMMENT | COMMENT | 1 | core equivalence |
| s006 | `demo/incremental-without-guard` | COMMENT | COMMENT | 4 | `altimate_core.dbt_config`, deterministic cost rules |
| s007 | `demo/s007-type-narrowing-amount` | COMMENT | COMMENT | 3 | `altimate_core.structural_diff:type_narrowing`, core equivalence |
| s008 | `demo/s008-join-on-cast` | COMMENT | COMMENT | 4 | `altimate_core.check:cast_in_join_key`, core equivalence |
| s009 | `demo/s009-join-or-condition` | COMMENT | COMMENT | 3 | `altimate_core.check:or_in_join`, core equivalence |
| s010 | `demo/s010-test-disabled` | COMMENT | COMMENT | 1 | `dbt-patterns:removed_tests` |

Pilot follow-ups:

- `--no-ai` was wired incorrectly as an option literally named `no-ai`; yargs
  interprets `--no-ai` as `ai=false`. The review CLI now registers `ai` as the
  boolean option and a parser regression test covers the documented flag.
- `s008` and `s009` also emit `altimate_core.structural_diff:removed_predicate`
  because the join predicate structure changed. The customer-facing evidence
  should lead with the more precise core lint rule (`cast_in_join_key` /
  `or_in_join`).
- `s010` is surfaced as removed test coverage because changing `- unique` to a
  configured test removes the simple test line in the diff. This is still
  deterministic and accurate, but a future structured YAML rule could produce a
  more precise `test_disabled` label.

## Tranche 2 Matrix Result

Run date: 2026-06-08.

Validation setup matched the pilot matrix: fresh DuckDB file per branch, `dbt
build`, `dbt compile`, `dbt docs generate`, local `altimate-code`, local linked
`altimate-core`, and explicit `--no-ai`.

| id | branch | expected | actual | findings | deterministic evidence |
|---|---|---:|---:|---:|---|
| s011 | `demo/s011-left-join-to-inner` | COMMENT | COMMENT | 2 | core equivalence, `altimate_core.structural_diff:join_type_change` |
| s012 | `demo/s012-join-using-ambiguity` | COMMENT | COMMENT | 3 | `rule-catalog:using-join`, core equivalence |
| s013 | `demo/s013-right-join-readability` | COMMENT | COMMENT | 3 | `rule-catalog:right-join`, `altimate_core.structural_diff:join_type_change` |
| s014 | `demo/s014-cross-join-filtered` | REQUEST_CHANGES | REQUEST_CHANGES | 2 | `dbt-patterns:cross_join`, core equivalence |
| s015 | `demo/s015-multiple-left-joins` | COMMENT | COMMENT | 1 | core equivalence |
| s016 | `demo/s016-distinct-added` | COMMENT | COMMENT | 3 | `altimate_core.structural_diff:distinct_added`, `altimate_core.check:select_distinct_smell` |
| s017 | `demo/s017-limit-added` | REQUEST_CHANGES | REQUEST_CHANGES | 4 | `dbt-patterns:limit-in-model`, `altimate_core.structural_diff:limit_added`, `rule-catalog:limit-no-order` |
| s018 | `demo/s018-clock-column` | COMMENT | COMMENT | 2 | `rule-catalog:timezone-naive-now`, core equivalence |
| s019 | `demo/s019-scalar-subquery-select` | COMMENT | COMMENT | 1 | core equivalence |
| s020 | `demo/s020-not-in-subquery` | COMMENT | COMMENT | 3 | `altimate_core.check:not_in_nullable`, `rule-catalog:not-exists-suggested`, core equivalence |

Tranche 2 follow-ups:

- `s015` did not trigger the intended precise multiple-left-join/fanout rule and
  should be replaced or backed by a stronger deterministic fanout lane before
  final customer-demo acceptance.
- `s019` did not trigger the intended scalar-subquery rule because the current
  rule is too line-shape-sensitive for formatted SQL. Replace it with a better
  scenario or move the detector into core AST analysis before final acceptance.
