# dbt PR Review

Cloudflare-style AI code review specialized for dbt/SQL. `dbt-pr-review` produces
a single, **signed** verdict on a pull request — `APPROVE`, `COMMENT`, or
`REQUEST_CHANGES` — where every blocking finding is backed by a deterministic
engine call, not a model's opinion:

- **column-lineage / DAG blast radius** — which downstream models a change breaks
- **query equivalence** — whether a "refactor" provably returns the same rows
- **PII classification** — columns that newly expose sensitive data
- **A–F grade + anti-patterns** — readability, correctness, warehouse-cost issues

The verdict is signed into a replayable envelope keyed to your dbt manifest, so it
is tamper-evident and reproducible.

---

## Quick start (local)

Run the reviewer on your working-tree changes against `origin/main`:

```bash
altimate review                 # human-readable summary
altimate review --json          # the full signed verdict envelope
altimate review --mode gate     # exit non-zero on REQUEST_CHANGES (for CI gating)
```

Options:

| Flag | Description |
|------|-------------|
| `--base <ref>` | Base git ref. Defaults to the merge-base with `origin/main`. |
| `--head <ref>` | Head git ref. Omit to review the working tree. |
| `--manifest <path>` | Path to the compiled `manifest.json` (default `target/manifest.json`). |
| `--mode comment\|gate` | `comment` never blocks; `gate` exits non-zero on `REQUEST_CHANGES`. |
| `--severity <level>` | Minimum severity to surface: `critical`, `warning`, `suggestion`. |
| `--post` | Post the verdict to the GitHub PR (uses `GITHUB_TOKEN` + the Actions event). |
| `--json` / `--output <file>` | Emit the verdict envelope as JSON. |

> **Full vs lint-only.** With a compiled `manifest.json` present, the reviewer
> proves lineage and equivalence exactly. Without it (or without a warehouse) it
> runs **lint-only** and conservatively *warns* on changes it cannot prove safe —
> clearly labeled, never mistaken for a full verdict. Run `dbt compile` first for
> the full verdict.

## GitHub Action

Add the review to any repo with a workflow that compiles the project, then runs
the review action:

```yaml
name: dbt PR Review
on:
  pull_request:
    paths: ['models/**', 'macros/**', 'snapshots/**', '**/*.sql', '**/*.yml']
permissions:
  contents: read
  pull-requests: write     # post the summary + inline review
  checks: write            # the verdict check (gate mode)
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      # Produce target/manifest.json for the full verdict (adapter-specific).
      - run: pip install dbt-core dbt-bigquery && dbt deps && dbt compile
      - uses: AltimateAI/altimate-code/github/review@v1
        with:
          mode: comment                       # `gate` to block merges
          manifest_path: target/manifest.json
          severity_threshold: suggestion
```

Re-pushing commits updates the same summary comment in place; fixed findings are
dropped on the next run. GitLab CI is supported via `altimate review --post` in a
pipeline job.

## Configuration — `.altimate/review.yml`

Per-repo configuration, the analogue of an `AGENTS.md`. Tune the rubric, choose
reviewer lanes, and pick comment-vs-gate without forking:

```yaml
mode: comment                 # comment | gate
severityThreshold: suggestion
manifestPath: target/manifest.json
dialect: snowflake
reviewers: []                 # empty = risk-tier defaults; or pin lanes
exclude:
  - models/legacy/**
rubric:
  blockOn: [lineage_breakage, contract_violation, pii_exposure, semantic_change]
  warningPatternThreshold: 3
  thresholds:
    warehouseCostMinRows: 1000000
  exclusions:
    allowSelectStarInStaging: true
    skipNonProdModels: true
```

## How models are rendered (Jinja → analyzable SQL)

dbt models are Jinja templates, so the SQL engine needs *rendered* SQL. The
reviewer does **not** re-implement Jinja — it consumes dbt's own compiled output
(the same render-then-analyze split dbt-Fusion uses, and what Datafold/Recce do):

1. **Deterministic `dbt-patterns` lane** reads the **raw** model + diff — it needs
   the Jinja (`{{ config(materialized) }}`, `is_incremental()`, `{{ ref }}`) and
   the unified diff to detect structural anti-patterns. This lane needs no
   warehouse and catches the majority of real-world failures.
2. **Engine lanes** (equivalence, grade, lint, PII) consume **dbt-compiled SQL**
   from `target/compiled/<project>/…` (HEAD) and `target-base/compiled/…` (BASE),
   produced by `dbt compile`. To enable full equivalence verdicts, compile both
   the base and head refs in CI (the base into `target-base/`, the Recce
   convention). Without compiled SQL the engine lanes fall back to raw and stay
   *undecidable* (never fabricated) — the `dbt-patterns` lane still runs.

## How it works

1. **Risk-tiering (no LLM).** A deterministic pre-pass classifies the change on
   *data* signals — blast radius, PII/contract/source touch, materialization and
   incremental-logic changes — into `trivial` / `lite` / `full`. Expensive lanes
   only fire when the change warrants them. Any PII, source, contract, snapshot,
   or migration touch is always `full`.
2. **Engine-backed lanes.** For each changed model the relevant lanes run against
   the Rust core: lineage/impact, equivalence on before/after SQL, PII via the
   composite check, and SQL grade/anti-patterns.
3. **Rubric → verdict.** Findings map to a verdict by a versioned rubric (data,
   not prompt): any blocking-category `critical` → `REQUEST_CHANGES`; ≥3 warnings
   → risk pattern → `REQUEST_CHANGES`; only suggestions → `COMMENT`; nothing →
   `APPROVE`. In `comment` mode, `REQUEST_CHANGES` is posted as comments rather
   than blocking.
4. **Signed envelope.** The verdict is HMAC-signed (`ALTIMATE_REVIEW_SIGNING_KEY`)
   and includes the manifest hash, so it is replayable and tamper-evident.

## The safety invariant

Query equivalence is undecidable in general. An **undecidable** equivalence
result is always a `warning` with `confidence: unknown` — **never** a block. The
reviewer never claims a refactor is unsafe when it could not prove it; it asks you
to verify with a data-diff instead. A false "this is safe" is worse than a noisy
warning, so the rubric clamps unknown/low-confidence findings out of `critical`.

## Agent & skill

- Agent: `reviewer` (read-only) — `altimate --agent reviewer`.
- Skill: `/dbt-pr-review` — runs the verdict engine and presents the findings.
- Tool: `dbt_pr_review` — callable from any agent.
