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

## Implemented 50-Scenario Corpus

Run every branch from `/Users/anandgupta/codebase/altimate-code/demo/dbt-pr-review-demo`
with DuckDB, `dbt build`, `dbt compile`, `dbt docs generate`, and the default
focused review command above. AI must remain disabled for demo acceptance.

| id | branch | status | title | category | expected | deterministic evidence | artifact_needs | demo_script |
|---|---|---|---|---|---|---|---|---|
| s001 | `demo/safe-refactor` | implemented | Safe CTE refactor is approved | safe_refactor | APPROVE | no findings | manifest, catalog, target-base | Proves the reviewer stays quiet for harmless SQL cleanup. |
| s002 | `demo/join-key-breakage` | implemented | Wrong join key changes attribution | join_risk | REQUEST_CHANGES | `altimate_core.structural_diff:join_key_regression` | manifest, catalog, target-base | Catches a silent business-logic bug that still compiles. |
| s003 | `demo/test-removal` | implemented | Primary-key tests removed | test_coverage | COMMENT | `dbt-patterns:removed_tests` | manifest | Shows guardrail removal before duplicate rows ship. |
| s004 | `demo/new-pii-exposure` | implemented | Customer email exposed in a mart | pii_exposure | REQUEST_CHANGES | `altimate_core.classify_pii` | manifest, catalog, target-base | Blocks sensitive data propagation before merge. |
| s005 | `demo/mart-select-star` | implemented | SELECT star in a published mart | semantic_change | COMMENT | `altimate_core.equivalence` | manifest, catalog, target-base | Warns that a projection change alters the mart contract. |
| s006 | `demo/incremental-without-guard` | implemented | Unsafe incremental conversion | materialization | COMMENT | `altimate_core.dbt_config`, deterministic cost rules | manifest | Flags a common incremental-model footgun. |
| s007 | `demo/s007-type-narrowing-amount` | implemented | Amount type narrowed | contract_violation | COMMENT | `altimate_core.structural_diff:type_narrowing` | manifest, target-base | Shows truncation/overflow risk before downstream breakage. |
| s008 | `demo/s008-join-on-cast` | implemented | Join key wrapped in CAST | join_risk | COMMENT | `altimate_core.check:cast_in_join_key` | manifest | Shows optimizer and key-matching risk from casting join keys. |
| s009 | `demo/s009-join-or-condition` | implemented | OR added to join condition | join_risk | COMMENT | `altimate_core.check:or_in_join` | manifest | Shows explosive join risk from a broad OR predicate. |
| s010 | `demo/s010-test-disabled` | implemented | Uniqueness test disabled | test_coverage | COMMENT | `dbt-patterns:removed_tests`, `rule-catalog:test-disabled` | manifest | Shows a uniqueness guard being weakened in YAML. |
| s011 | `demo/s011-left-join-to-inner` | implemented | LEFT JOIN changed to INNER JOIN | semantic_change | COMMENT | `altimate_core.structural_diff:join_type_change` | manifest, target-base | Highlights row-loss risk from changing join optionality. |
| s012 | `demo/s012-join-using-ambiguity` | implemented | JOIN USING hides merged key behavior | join_risk | COMMENT | `rule-catalog:using-join` | manifest | Shows ambiguity from merged join columns. |
| s013 | `demo/s013-right-join-readability` | implemented | RIGHT JOIN introduced | sql_quality | COMMENT | `rule-catalog:right-join` | manifest | Shows a low-severity maintainability risk. |
| s014 | `demo/s014-cross-join-filtered` | implemented | Filtered CROSS JOIN introduced | join_risk | REQUEST_CHANGES | `dbt-patterns:cross_join` | manifest | Blocks a high-confidence cartesian-product risk. |
| s015 | `demo/s015-left-join-filter` | implemented | LEFT JOIN filtered in WHERE | join_risk | COMMENT | `dbt-patterns:outer_join_filter_in_where` | manifest, target-base | Shows a WHERE clause that silently turns optional rows into required rows. |
| s016 | `demo/s016-distinct-added` | implemented | DISTINCT added to hide duplicates | semantic_change | COMMENT | `altimate_core.structural_diff:distinct_added`, `altimate_core.check:select_distinct_smell` | manifest, target-base | Shows dedup masking rather than fixing upstream grain. |
| s017 | `demo/s017-limit-added` | implemented | LIMIT added to a mart | sql_correctness | REQUEST_CHANGES | `dbt-patterns:limit-in-model`, `altimate_core.structural_diff:limit_added` | manifest, target-base | Blocks accidental sampling in production logic. |
| s018 | `demo/s018-clock-column` | implemented | Runtime clock added to mart output | idempotency | COMMENT | `rule-catalog:timezone-naive-now` | manifest | Shows non-reproducible output from run-time clock functions. |
| s019 | `demo/s019-lateral-on-true` | implemented | LATERAL join with ON true | join_risk | COMMENT | `rule-catalog:lateral-join`, `altimate_core.check:join_without_condition` | manifest, target-base | Shows per-row lateral execution and an unbounded join condition. |
| s020 | `demo/s020-not-in-subquery` | implemented | NOT IN subquery added | sql_correctness | COMMENT | `altimate_core.check:not_in_nullable`, `rule-catalog:not-exists-suggested` | manifest | Shows the NULL-sensitive `NOT IN` failure mode. |
| s021 | `demo/s021-union-dedup-cost` | implemented | UNION dedup introduced | warehouse_cost | COMMENT | `rule-catalog:union-not-all`, `altimate_core.check:union_without_all` | manifest, target-base | Shows hidden sort/dedup cost in mart logic. |
| s022 | `demo/s022-in-subquery-large` | implemented | IN subquery introduced | warehouse_cost | COMMENT | `rule-catalog:in-subquery-large` | manifest | Shows an optimizer-unfriendly semi-join pattern. |
| s023 | `demo/s023-full-outer-join-filtered` | implemented | Filtered FULL OUTER JOIN introduced | join_risk | COMMENT | `altimate_core.check:full_outer_join`, `altimate_core.structural_diff:join_type_change` | manifest, target-base | Shows null-side handling risk from full outer joins. |
| s024 | `demo/s024-weak-pii-hash` | implemented | Weak MD5 hash of email exposed | pii_exposure | COMMENT | `rule-catalog:weak-pii-hash` | manifest, target-base | Shows why simple hashes are not anonymization. |
| s025 | `demo/s025-hardcoded-secret` | implemented | Hardcoded API key-like secret in SQL | pii_exposure | REQUEST_CHANGES | `rule-catalog:hardcoded-credential` | manifest, target-base | Blocks secret leakage into SQL and compiled artifacts. |
| s026 | `demo/s026-new-phone-pii` | implemented | Phone number exposed in mart | pii_exposure | REQUEST_CHANGES | `altimate_core.classify_pii`, lineage impact | manifest, catalog, target-base | Shows sensitive contact-data propagation from source to mart. |
| s027 | `demo/s027-new-ssn-pii` | implemented | SSN exposed in mart | pii_exposure | REQUEST_CHANGES | `altimate_core.classify_pii`, lineage impact | manifest, catalog, target-base | Blocks high-risk identifier exposure. |
| s028 | `demo/s028-test-severity-warn` | implemented | Test downgraded to severity warn | test_coverage | COMMENT | `rule-catalog:test-severity-warn`, `dbt-patterns:removed_tests` | manifest | Shows CI guardrails being weakened. |
| s029 | `demo/s029-description-removed` | implemented | Model description removed | governance | COMMENT | `rule-catalog:yml-description-removed` | manifest | Shows documentation drift for data consumers. |
| s030 | `demo/s030-yml-column-removed` | implemented | Column removed from schema.yml metadata | contract_violation | COMMENT | `rule-catalog:yml-column-removed` | manifest | Shows schema metadata drift while SQL still builds. |
| s031 | `demo/s031-count-distinct-cost` | implemented | Exact COUNT DISTINCT added | warehouse_cost | COMMENT | `rule-catalog:count-distinct-large`, `rule-catalog:bq-approx-good` | manifest | Shows expensive exact distinct counting. |
| s032 | `demo/s032-order-by-in-cte` | implemented | ORDER BY added without limiting rows | warehouse_cost | COMMENT | `dbt-patterns:order-by-no-limit` | manifest | Shows a sort that adds cost without a stable consumer contract. |
| s033 | `demo/s033-function-filter-column` | implemented | Function applied to filter column | warehouse_cost | COMMENT | `rule-catalog:function-filter-column`, `altimate_core.check:non_sargable_predicate` | manifest | Shows partition/index pruning defeated by a wrapper function. |
| s034 | `demo/s034-implicit-comma-join` | implemented | Comma join introduced | join_risk | COMMENT | `rule-catalog:implicit-cross-join-comma`, `altimate_core.check:implicit_cross_join` | manifest | Shows an accidental cross join from old-style SQL. |
| s035 | `demo/s035-natural-join` | implemented | NATURAL JOIN introduced | join_risk | REQUEST_CHANGES | `dbt-patterns:natural-join` | manifest, target-base | Blocks fragile joins that change when either side adds a same-named column. |
| s036 | `demo/s036-case-without-else` | implemented | CASE expression lacks ELSE | sql_correctness | COMMENT | `dbt-patterns:case-no-else` | manifest | Shows silent NULLs from unmatched branches. |
| s037 | `demo/s037-division-no-guard` | implemented | Division by column has no guard | sql_correctness | COMMENT | `altimate_core.check:division_by_column_no_guard` | manifest | Shows divide-by-zero/null risk before runtime failures. |
| s038 | `demo/s038-equals-null-filter` | implemented | Filter compares value to NULL with equals | sql_correctness | COMMENT | `altimate_core.check:not_null_comparison` | manifest | Shows SQL that looks valid but never matches NULLs. |
| s039 | `demo/s039-leading-wildcard-like` | implemented | Leading wildcard LIKE added | warehouse_cost | COMMENT | `altimate_core.check:like_leading_wildcard`, `altimate_core.check:case_sensitive_like` | manifest | Shows non-sargable pattern matching on a joined column. |
| s040 | `demo/s040-between-date-boundary` | implemented | BETWEEN timestamp boundary added | sql_correctness | COMMENT | `dbt-patterns:between-timestamp`, `dbt-patterns:hardcoded-date` | manifest | Shows inclusive timestamp boundary and stale hardcoded-date risk. |
| s041 | `demo/s041-order-by-no-limit` | implemented | Top-level ORDER BY without LIMIT | warehouse_cost | COMMENT | `dbt-patterns:order-by-no-limit` | manifest | Shows a production sort that does not guarantee useful output order. |
| s042 | `demo/s042-offset-no-order` | implemented | OFFSET without ORDER BY | sql_correctness | COMMENT | `dbt-patterns:offset-no-order` | manifest, target-base | Shows nondeterministic pagination in a model. |
| s043 | `demo/s043-random-column` | implemented | Random column added to mart | idempotency | COMMENT | `dbt-patterns:random-nondeterminism` | manifest, target-base | Shows non-reproducible data across reruns and backfills. |
| s044 | `demo/s044-full-refresh-config` | implemented | full_refresh=true added | materialization | COMMENT | `dbt-patterns:full-refresh-true` | manifest | Shows a config that forces repeated full rebuilds. |
| s045 | `demo/s045-hardcoded-date-filter` | implemented | Hardcoded date filter drops history | freshness | COMMENT | `dbt-patterns:hardcoded-date` | manifest, target-base | Shows a time filter that will not roll forward. |
| s046 | `demo/s046-regexp-filter` | implemented | Regex filter added | warehouse_cost | COMMENT | `rule-catalog:regexp-heavy` | manifest, target-base | Shows expensive/portable-risk regex filtering. |
| s047 | `demo/s047-cast-as-text` | implemented | Cast to non-portable TEXT type | sql_quality | COMMENT | `rule-catalog:cast-as-text` | manifest, target-base | Shows a cross-warehouse portability issue that still runs on DuckDB. |
| s048 | `demo/s048-interval-literal` | implemented | String interval literal added | sql_quality | COMMENT | `rule-catalog:interval-string-literal` | manifest, target-base | Shows date arithmetic syntax that differs by warehouse. |
| s049 | `demo/s049-date-plus-integer` | implemented | Date plus bare integer added | sql_correctness | COMMENT | `rule-catalog:date-plus-integer` | manifest, target-base | Shows ambiguous, non-portable date arithmetic. |
| s050 | `demo/s050-order-by-random` | implemented | ORDER BY RANDOM added | idempotency | COMMENT | `rule-catalog:order-by-random`, `dbt-patterns:random-nondeterminism` | manifest | Shows nondeterministic and costly random ordering. |

## Deferred Capability List

These are still useful demo candidates, but should wait for deterministic support:

- Window partition/order structural diffs in `altimate-core`.
- Owner/meta YAML removal via structured dbt metadata parsing.
- Warehouse-observed row/value data-diff demos that compare base/head relations
  after the review command has a stable scripted harness.
- Scalar-subquery SELECT detection in core AST analysis. The line-oriented
  catalog rule is too formatting-sensitive for a flagship scenario.
- Fanout-after-aggregate structural analysis in core. The current text detector
  does not cover enough real dbt formatting shapes.

## Validation Matrix Status

| checkpoint | branches | matrix status | notes |
|---|---:|---|---|
| pilot | 10 | passed | `s001`-`s010` reached expected verdicts with fresh DuckDB state per branch. |
| tranche 2 | 10 | passed after replacements | `s015` replaced with `left-join-filter`; `s019` replaced with `lateral-on-true`. |
| tranche 3 | 10 | passed | `s021`-`s030` reached expected verdicts after schema YAML catalog wiring. |
| tranche 4 | 10 | passed | `s031`-`s040` reached expected verdicts; `s035` strengthened to `REQUEST_CHANGES`. |
| tranche 5 | 10 | passed | `s041`-`s050` reached expected verdicts. |
| full corpus | 50 | passed after classifier fix | Full run built all branches. `s001` was revalidated to APPROVE after non-dbt YAML stopped being classified as schema.yml. |

## Final Matrix Result

Run date: 2026-06-08.

Validation setup:

- Each branch ran with a fresh `demo.duckdb` file.
- Each branch ran `dbt build`, `dbt compile`, and `dbt docs generate`.
- Reviewer ran through local `altimate-code`; AI was disabled with `--no-ai`.
- A false positive found during the first full run caused `.github/workflows/dbt-pr-review.yml`
  to be reviewed as dbt schema YAML. `classifyDbtFile` now limits schema YAML
  classification to dbt resource paths and conventional property filenames.

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
| s010 | `demo/s010-test-disabled` | COMMENT | COMMENT | 2 | `dbt-patterns:removed_tests`, `rule-catalog:test-disabled` |
| s011 | `demo/s011-left-join-to-inner` | COMMENT | COMMENT | 2 | core equivalence, `altimate_core.structural_diff:join_type_change` |
| s012 | `demo/s012-join-using-ambiguity` | COMMENT | COMMENT | 3 | `rule-catalog:using-join`, core equivalence |
| s013 | `demo/s013-right-join-readability` | COMMENT | COMMENT | 3 | `rule-catalog:right-join`, `altimate_core.structural_diff:join_type_change` |
| s014 | `demo/s014-cross-join-filtered` | REQUEST_CHANGES | REQUEST_CHANGES | 2 | `dbt-patterns:cross_join`, core equivalence |
| s015 | `demo/s015-left-join-filter` | COMMENT | COMMENT | 2 | `dbt-patterns:outer_join_filter_in_where`, core equivalence |
| s016 | `demo/s016-distinct-added` | COMMENT | COMMENT | 3 | `altimate_core.structural_diff:distinct_added`, `altimate_core.check:select_distinct_smell` |
| s017 | `demo/s017-limit-added` | REQUEST_CHANGES | REQUEST_CHANGES | 4 | `dbt-patterns:limit-in-model`, `altimate_core.structural_diff:limit_added`, `rule-catalog:limit-no-order` |
| s018 | `demo/s018-clock-column` | COMMENT | COMMENT | 2 | `rule-catalog:timezone-naive-now`, core equivalence |
| s019 | `demo/s019-lateral-on-true` | COMMENT | COMMENT | 4 | `rule-catalog:lateral-join`, `altimate_core.check:join_without_condition`, core equivalence |
| s020 | `demo/s020-not-in-subquery` | COMMENT | COMMENT | 3 | `altimate_core.check:not_in_nullable`, `rule-catalog:not-exists-suggested`, core equivalence |
| s021 | `demo/s021-union-dedup-cost` | COMMENT | COMMENT | 4 | `rule-catalog:union-not-all`, `altimate_core.check:union_without_all`, core equivalence |
| s022 | `demo/s022-in-subquery-large` | COMMENT | COMMENT | 2 | `rule-catalog:in-subquery-large`, core equivalence |
| s023 | `demo/s023-full-outer-join-filtered` | COMMENT | COMMENT | 3 | `altimate_core.check:full_outer_join`, `altimate_core.structural_diff:join_type_change` |
| s024 | `demo/s024-weak-pii-hash` | COMMENT | COMMENT | 3 | `rule-catalog:weak-pii-hash`, core structural/equivalence |
| s025 | `demo/s025-hardcoded-secret` | REQUEST_CHANGES | REQUEST_CHANGES | 2 | `rule-catalog:hardcoded-credential`, core equivalence |
| s026 | `demo/s026-new-phone-pii` | REQUEST_CHANGES | REQUEST_CHANGES | 6 | `altimate_core.classify_pii`, core equivalence, lineage impact |
| s027 | `demo/s027-new-ssn-pii` | REQUEST_CHANGES | REQUEST_CHANGES | 6 | `altimate_core.classify_pii`, core equivalence, lineage impact |
| s028 | `demo/s028-test-severity-warn` | COMMENT | COMMENT | 2 | `rule-catalog:test-severity-warn`, `dbt-patterns:removed_tests` |
| s029 | `demo/s029-description-removed` | COMMENT | COMMENT | 1 | `rule-catalog:yml-description-removed` |
| s030 | `demo/s030-yml-column-removed` | COMMENT | COMMENT | 2 | `rule-catalog:yml-column-removed`, `rule-catalog:yml-description-removed` |
| s031 | `demo/s031-count-distinct-cost` | COMMENT | COMMENT | 3 | `rule-catalog:count-distinct-large`, `rule-catalog:bq-approx-good`, core equivalence |
| s032 | `demo/s032-order-by-in-cte` | COMMENT | COMMENT | 1 | `dbt-patterns:order-by-no-limit` |
| s033 | `demo/s033-function-filter-column` | COMMENT | COMMENT | 3 | `rule-catalog:function-filter-column`, `altimate_core.check:non_sargable_predicate` |
| s034 | `demo/s034-implicit-comma-join` | COMMENT | COMMENT | 3 | `rule-catalog:implicit-cross-join-comma`, `altimate_core.check:implicit_cross_join` |
| s035 | `demo/s035-natural-join` | REQUEST_CHANGES | REQUEST_CHANGES | 3 | `dbt-patterns:natural-join`, core equivalence |
| s036 | `demo/s036-case-without-else` | COMMENT | COMMENT | 2 | `dbt-patterns:case-no-else`, core equivalence |
| s037 | `demo/s037-division-no-guard` | COMMENT | COMMENT | 2 | `altimate_core.check:division_by_column_no_guard`, core equivalence |
| s038 | `demo/s038-equals-null-filter` | COMMENT | COMMENT | 2 | `altimate_core.check:not_null_comparison`, core equivalence |
| s039 | `demo/s039-leading-wildcard-like` | COMMENT | COMMENT | 4 | `altimate_core.check:like_leading_wildcard`, `altimate_core.check:case_sensitive_like` |
| s040 | `demo/s040-between-date-boundary` | COMMENT | COMMENT | 3 | `dbt-patterns:between-timestamp`, `dbt-patterns:hardcoded-date` |
| s041 | `demo/s041-order-by-no-limit` | COMMENT | COMMENT | 1 | `dbt-patterns:order-by-no-limit` |
| s042 | `demo/s042-offset-no-order` | COMMENT | COMMENT | 2 | `dbt-patterns:offset-no-order`, core equivalence |
| s043 | `demo/s043-random-column` | COMMENT | COMMENT | 2 | `dbt-patterns:random-nondeterminism`, core equivalence |
| s044 | `demo/s044-full-refresh-config` | COMMENT | COMMENT | 2 | `dbt-patterns:full-refresh-true`, config-block change |
| s045 | `demo/s045-hardcoded-date-filter` | COMMENT | COMMENT | 2 | `dbt-patterns:hardcoded-date`, core equivalence |
| s046 | `demo/s046-regexp-filter` | COMMENT | COMMENT | 3 | `rule-catalog:regexp-heavy`, core equivalence |
| s047 | `demo/s047-cast-as-text` | COMMENT | COMMENT | 2 | `rule-catalog:cast-as-text`, core equivalence |
| s048 | `demo/s048-interval-literal` | COMMENT | COMMENT | 2 | `rule-catalog:interval-string-literal`, core equivalence |
| s049 | `demo/s049-date-plus-integer` | COMMENT | COMMENT | 2 | `rule-catalog:date-plus-integer`, core equivalence |
| s050 | `demo/s050-order-by-random` | COMMENT | COMMENT | 3 | `rule-catalog:order-by-random`, `dbt-patterns:random-nondeterminism` |

## Reviewer Fixes From Corpus Work

- `--no-ai` now maps to `ai=false` in the review CLI.
- Schema YAML catalog rules now run during dbt review, covering metadata/test
  weakening rules.
- YAML classification now avoids non-dbt YAML such as GitHub workflows, fixing a
  false positive found by `demo/safe-refactor`.
