# Theme L: Developer Experience & CLI Patterns for Data Validation Tools

_Iteration 3 — 2026-03-13 (Deep Web Research Edition)_

> Deep research into CLI UX patterns, output format standards, CI/CD integration, configuration UX,
> error messaging, and notification patterns across the data validation tool landscape.
> Focused on informing Reladiff's developer experience design.

---

## 1. CLI UX Patterns in Data Tools

### 1.1 How Leading Tools Structure CLI Output

#### dbt

dbt's CLI output follows a **timestamped event stream** pattern:

```
23:30:16  Running with dbt=1.8.0
23:30:17  Found 15 models, 8 tests, 3 sources
23:30:18  Concurrency: 4 threads (target='dev')
23:30:19  1 of 15 OK created sql table model analytics.dim_customers .... [SELECT 1204 in 2.31s]
23:30:20  2 of 15 OK created sql table model analytics.fct_orders ...... [SELECT 8437 in 1.89s]
...
23:30:45  Finished running 15 models, 8 tests in 0 hours 0 minutes and 29.12 seconds.
23:30:45  Done. PASS=27 WARN=0 ERROR=1 SKIP=0 TOTAL=28
```

Key patterns:
- **Timestamped lines** with simple `HH:MM:SS` prefix (text format, the default)
- **Progress counter**: "N of M" to show position in run
- **Status badges**: `OK`, `ERROR`, `WARN`, `SKIP` inline with each result
- **Duration**: Per-model timing (`[SELECT 1204 in 2.31s]`) and total run time
- **Summary line**: Aggregated counts at the end (`PASS=27 WARN=0 ERROR=1 SKIP=0 TOTAL=28`)
- **Three log formats**: `text` (default console), `debug` (verbose with thread IDs), `json` (structured)
- **Color control**: `--use-colors` / `--no-use-colors` flags; respects terminal detection
- **Quiet mode**: `-q` / `--quiet` suppresses non-error output

Sources: [dbt Logs Reference](https://docs.getdbt.com/reference/global-configs/logs), [dbt Events and Logging](https://docs.getdbt.com/reference/events-logging)

#### SodaCL / Soda Core

Soda uses a **scan summary** pattern with per-check results:

```
Soda Library 1.5.x
Soda Core 3.3.x
Scan summary:
6/9 checks PASSED:
    paxstats in paxstats2
        row_count > 0 [PASSED]
            check_value: 15007
        Look for PII [PASSED]
        duplicate_percent(id) = 0 [PASSED]
            check_value: 0.0
            row_count: 15007
            duplicate_count: 0
        missing_count(adjusted_passenger_count) = 0 [PASSED]
            check_value: 0
        anomaly detection for row_count [PASSED]
            check_value: 0.0
        Schema Check [PASSED]
1/9 checks WARNED:
    paxstats in paxstats2
        Abnormally large PAX count [WARNED]
            check_value: 659837
2/9 checks FAILED:
    paxstats in paxstats2
        Validate terminal ID [FAILED]
            check_value: 27
        Verify 2-digit IATA [FAILED]
            check_value: 3
```

Key patterns:
- **Three-state results**: `[PASSED]`, `[WARNED]`, `[FAILED]` with bracket-style badges
- **Grouped by status**: Passed checks first, then warnings, then failures
- **Check values shown**: Actual measured values displayed below each check
- **Hierarchical indentation**: Dataset > Check > Details
- **Programmatic exit codes**: `scan.has_failures()` returns truthy for CI gating

Sources: [Soda Core Cheatsheet](https://dataengineer.wiki/cheatsheets/soda-core/), [Run a Scan](https://docs.soda.io/run-a-scan)

#### Great Expectations

Great Expectations takes a **binary pass/fail** approach for CLI output, but generates rich **HTML Data Docs** for detailed results:

- CLI returns POSIX exit codes: `0` with "Validation succeeded!" or `1` with "Validation failed!"
- Detailed results rendered as **interactive HTML reports** (Data Docs) opened in browser
- JSON validation results stored in Validation Result Stores for programmatic consumption
- Each `ExpectationValidationResult` contains: `success` (boolean), `expectation_config`, `result` (observed values)
- `CheckpointResult` includes: `run_id`, `run_results` dict, `checkpoint_config`, overall `success`

Sources: [Validation Result](https://docs.greatexpectations.io/docs/0.18/reference/learn/terms/validation_result/), [Data Docs](https://docs.greatexpectations.io/docs/0.18/reference/learn/terms/data_docs/)

#### Data Contract CLI

The `datacontract-cli` uses a **Rich-formatted table** for test results:

```
Testing https://datacontract.com/orders-v1.odcs.yaml
+--------+----------------------------------------------+-----------------+---------+
| Result | Check                                        | Field           | Details |
+--------+----------------------------------------------+-----------------+---------+
| passed | Check that field 'order_id' is present       | orders.order_id |         |
| passed | Check that unique field order_id has no      | orders.order_id |         |
|        | duplicate values                             |                 |         |
+--------+----------------------------------------------+-----------------+---------+
Data contract is valid. Run 25 checks. Took 3.938887 seconds.
```

Sources: [datacontract-cli GitHub](https://github.com/datacontract/datacontract-cli)

#### SQLMesh table_diff

SQLMesh structures output into three distinct sections:

```
Schema Diff:
  Schemas match

Row Counts:
|- FULL MATCH: 450 rows (90.0%)
|- COMMON: 500 rows
|- PROD ONLY: 25 rows
\- DEV ONLY: 30 rows

COMMON ROWS column comparison stats:
         pct_match
item_id       83.3
amount        99.8
status       100.0
```

Key patterns:
- **Tree-style layout** using Unicode box-drawing characters
- **Three sections**: Schema Diff, Row Counts, Column Stats
- **Percentage match** per column for joined rows
- **`--show-sample` flag** reveals sample differing rows with `s__` (source) and `t__` (target) prefixes
- **Terminology**: `FULL MATCH`, `PARTIAL MATCH`, `SOURCE ONLY`, `TARGET ONLY`

Sources: [SQLMesh Table Diff Guide](https://sqlmesh.readthedocs.io/en/stable/guides/tablediff/)

### 1.2 Terminal Output Formatting Libraries

The dominant Python libraries for CLI output formatting in data tools:

| Library | Used By | Capabilities |
|---------|---------|-------------|
| **Rich** | datacontract-cli, dbt (partial), Textual-based tools | Tables, progress bars, trees, panels, syntax highlighting, markdown rendering |
| **Click** | dbt, Soda Core, many data tools | Argument parsing, help text, colored output |
| **Typer** | Modern CLIs | Click-based with type hints, auto-completion |
| **rich-click** | Bridge library | Rich-formatted Click help output |
| **Tabulate** | Lightweight tools | Simple ASCII/Unicode table rendering |

**Best practice from Typer docs**: "Typer is useful for structuring the CLI (options, arguments, subcommands). Rich is useful for displaying information. Combine both for best results."

Sources: [Rich GitHub](https://github.com/Textualize/rich), [rich-click](https://github.com/ewels/rich-click), [Typer Printing](https://typer.tiangolo.com/tutorial/printing/)

### 1.3 Interactive vs Batch Mode

The CLI Guidelines (clig.dev) provide definitive guidance:

- **Detect TTY**: Only use prompts, interactive elements, or pagers when stdin is a TTY
- **`--no-input` flag**: Disable all prompts; fail with instructions if input is required
- **Dangerous operations**: Confirm before destructive actions (mild = optional, moderate = y/n prompt, severe = type resource name)
- **Progress indicators**: Show within 100ms for long-running operations; use animated components
- **Pager support**: Use `less -FIRX` for large output

**Reladiff-specific insight**: Reladiff already has `-i, --interactive` for query confirmation. This is the right pattern -- interactive is opt-in, batch is default.

Sources: [Command Line Interface Guidelines](https://clig.dev/)

---

## 2. Output Format Standards

### 2.1 JSON Output for CI/CD Integration

Every serious data tool provides structured JSON output:

#### dbt's Approach (Two Levels)

1. **Structured log stream** (`--log-format json`):
```json
{
  "info": {
    "level": "info",
    "invocation_id": "abc123",
    "ts": "2024-01-15T23:30:16.123Z",
    "thread": "MainThread",
    "msg": "Running with dbt=1.8.0"
  },
  "data": {
    "node_info": {
      "unique_id": "model.analytics.dim_customers",
      "node_status": "success",
      "execution_time": 2.31
    }
  }
}
```

2. **Artifact file** (`target/run_results.json`):
```json
{
  "results": [
    {
      "status": "pass",
      "timing": [
        {"name": "compile", "started_at": "...", "completed_at": "..."},
        {"name": "execute", "started_at": "...", "completed_at": "..."}
      ],
      "execution_time": 2.31,
      "failures": 0,
      "unique_id": "test.analytics.not_null_orders_id",
      "compiled_code": "SELECT count(*) FROM ..."
    }
  ]
}
```

Sources: [dbt run_results.json](https://docs.getdbt.com/reference/artifacts/run-results-json), [dbt Logs](https://docs.getdbt.com/reference/global-configs/logs)

#### Reladiff's Approach

Reladiff supports `--json` for JSONL (JSON Lines) output and git-like `+`/`-` diff notation:

```
- (1001, 'Alice', 100.00)
+ (1001, 'Alice', 105.00)
- (1002, 'Bob', 200.00)
```

With `--stats`, provides statistical summary instead of row-level diffs.

Sources: [Reladiff User Guide](https://reladiff.readthedocs.io/en/latest/how-to-use.html)

#### csv-diff (simonw)

Provides both human-readable and JSON output:

```json
{
  "added": [{"id": "3", "name": "Charlie", "age": "30"}],
  "removed": [{"id": "2", "name": "Bob", "age": "25"}],
  "changed": [
    {
      "key": "1",
      "changes": {"age": ["4", "5"]}
    }
  ],
  "columns_added": [],
  "columns_removed": []
}
```

Sources: [csv-diff GitHub](https://github.com/simonw/csv-diff)

### 2.2 JUnit XML for Test Runners

JUnit XML is the **de facto standard** for exchanging test results between CI systems. Natively supported by GitHub Actions, GitLab CI, Jenkins, Azure Pipelines, and others.

**Structure for data validation**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="data-validation" tests="5" failures="1" errors="0" time="12.34">
    <testcase name="row_count_match" classname="orders_table" time="2.1">
    </testcase>
    <testcase name="schema_compatibility" classname="orders_table" time="0.5">
      <failure message="Column 'amount' type mismatch: DECIMAL(10,2) vs FLOAT">
        Source: DECIMAL(10,2)
        Target: FLOAT
        Impact: Potential precision loss
      </failure>
    </testcase>
    <testcase name="primary_key_coverage" classname="orders_table" time="3.2">
    </testcase>
  </testsuite>
</testsuites>
```

**Key insight from Checkov**: CLI tools that support multiple output formats (`cli`, `json`, `junitxml`, `sarif`, `csv`, `github_markdown`) gain broad CI/CD compatibility. Checkov's approach of supporting all major formats is the gold standard.

Sources: [JUnit XML Format](https://github.com/testmoapp/junitxml), [Checkov Output Formats](https://www.checkov.io/2.Basics/Reviewing%20Scan%20Results.html)

### 2.3 SARIF for Code Quality Platforms

SARIF (Static Analysis Results Interchange Format) is an OASIS standard (v2.1.0) for representing static analysis output. While primarily used for code analysis, it is applicable to data validation:

```json
{
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
  "version": "2.1.0",
  "runs": [{
    "tool": {
      "driver": {
        "name": "reladiff",
        "version": "1.0.0",
        "rules": [{
          "id": "RDIFF001",
          "name": "RowCountMismatch",
          "shortDescription": { "text": "Row counts differ between source and target" }
        }]
      }
    },
    "results": [{
      "ruleId": "RDIFF001",
      "level": "error",
      "message": { "text": "Source has 1000 rows, target has 950 rows (50 missing)" },
      "locations": [{
        "physicalLocation": {
          "artifactLocation": { "uri": "database://prod/orders" }
        }
      }]
    }]
  }]
}
```

**Relevance to Reladiff**: SARIF integration would allow diff results to appear in GitHub's "Code Scanning" tab alongside other quality findings. This is a differentiator no data diff tool currently offers.

Sources: [SARIF Specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html), [Sonar SARIF Guide](https://www.sonarsource.com/resources/library/sarif/), [Checkov SARIF](https://www.checkov.io/8.Outputs/SARIF.html)

### 2.4 Markdown Output for PR Comments

**Datafold's PR Comment Pattern**:

When a PR is opened, Datafold automatically posts a comment containing:
- **Schema differences**: Added/removed/modified columns
- **Primary key analysis**: Coverage and orphan rows
- **Row-level summary**: Row count changes, matched vs unmatched rows
- **Column-level statistics**: Per-column match percentages
- **Downstream impact**: Affected BI tools, reverse ETL pipelines, and dependent models
- **Link to full diff**: Click-through to Datafold web app for value-level exploration

The comment is structured as a collapsible Markdown summary with expandable sections for each model.

**Recce's Approach**: Uses clipboard-friendly screenshots of check results that users paste into PR comments. Supports exporting entire Recce environments for sharing.

**dbt-audit-helper's Output** (for manual PR comments):
```
| status         | count | percent |
|----------------|-------|---------|
| perfect_match  | 9500  | 95.0%   |
| both_are_null  | 200   | 2.0%    |
| missing_from_a | 150   | 1.5%    |
| missing_from_b | 100   | 1.0%    |
| value_mismatch | 50    | 0.5%    |
```

**Recommended PR comment structure for Reladiff**:

```markdown
## Reladiff: Data Comparison Results

**Source**: `prod.public.orders` | **Target**: `staging.public.orders`

### Summary
| Metric | Value |
|--------|-------|
| Rows in Source | 10,000 |
| Rows in Target | 10,050 |
| Matched Rows | 9,900 |
| Source Only | 100 |
| Target Only | 150 |

### Column Match Rates
| Column | Match % | Mismatches |
|--------|---------|------------|
| order_id | 100.0% | 0 |
| amount | 98.5% | 148 |
| status | 99.9% | 10 |

<details>
<summary>Sample Differences (5 of 148)</summary>

| order_id | source_amount | target_amount |
|----------|--------------|---------------|
| 1001 | 100.00 | 105.00 |
| 1042 | 250.50 | 250.49 |
</details>
```

Sources: [Datafold CI](https://docs.datafold.com/deployment-testing/how-it-works), [Recce GitHub](https://github.com/DataRecce/recce), [dbt-audit-helper](https://github.com/dbt-labs/dbt-audit-helper)

---

## 3. CI/CD Integration Patterns

### 3.1 Datafold CI Workflow

Datafold's CI operates as a **fully automated loop**:

1. Developer pushes to PR branch
2. CI builds staging data (`dbt run --select state:modified+`)
3. Two `manifest.json` versions submitted to Datafold (prod vs PR code)
4. Datafold identifies modified models via code diff
5. Datafold queries warehouse to run Data Diffs on modified models
6. Results posted as PR comment with downstream impact analysis
7. Developer clicks through to Datafold app for value-level exploration

**Slim Diff** optimization: Only diffs modified models in CI, not all models. Configurable per-model via dbt YAML.

Sources: [Datafold CI](https://docs.datafold.com/deployment-testing/how-it-works), [Slim CI with Datafold](https://www.datafold.com/blog/slim-ci-the-cost-effective-solution-for-successful-deployments-in-dbt-cloud/)

### 3.2 dbt Cloud CI Jobs

dbt Cloud CI uses **state-aware selectors** for efficient PR validation:

- `state:modified+` selector builds only modified nodes and their children ("Slim CI")
- PR jobs run in isolated staging schemas (e.g., `dbt_cloud_pr_123_456`)
- Exit codes drive GitHub status checks: pass/fail gates on merge
- `run_results.json` artifact available for downstream analysis

Sources: [dbt CI Jobs](https://docs.getdbt.com/docs/deploy/ci-jobs), [dbt CI Guide](https://docs.getdbt.com/guides/set-up-ci)

### 3.3 Great Expectations in GitHub Actions

Great Expectations provides a GitHub Actions integration pattern:

```yaml
name: Data Quality
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run GX Checkpoint
        run: |
          pip install great_expectations
          python -c "
          import great_expectations as gx
          context = gx.get_context()
          result = context.run_checkpoint('my_checkpoint')
          if not result.success:
              raise RuntimeError('Validation failed!')
          "
      - name: Comment PR
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            // Post validation results as PR comment
```

Sources: [GX GitHub Actions Blog](https://greatexpectations.io/blog/github-actions/)

### 3.4 Soda GitHub Action

Soda provides an official GitHub Action that:

1. Runs `soda scan` using a Docker image
2. Posts scan results as a **PR comment** automatically
3. Sends email notifications on failures
4. Requires Soda Cloud API keys for license validation

```yaml
name: Soda Data Quality
on: pull_request
jobs:
  soda-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: sodadata/soda-github-action@v1
        with:
          soda_library_version: v1.5.x
          data_source: my_datasource
          configuration: ./soda/configuration.yml
          checks: ./soda/checks.yml
        env:
          SODA_CLOUD_API_KEY: ${{ secrets.SODA_CLOUD_API_KEY }}
          SODA_CLOUD_API_SECRET: ${{ secrets.SODA_CLOUD_API_SECRET }}
```

Sources: [Soda GitHub Action](https://github.com/sodadata/soda-github-action), [Soda GitHub Integration](https://docs.soda.io/integrate-soda/integrate-github)

### 3.5 Recommended Reladiff CI Pattern

A GitHub Action for Reladiff should follow this structure:

```yaml
name: Data Diff
on:
  pull_request:
    paths:
      - 'models/**'
      - 'dbt_project.yml'

jobs:
  data-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build staging models
        run: dbt run --select state:modified+ --defer --state ./prod-manifest/

      - name: Run Reladiff
        id: diff
        run: |
          reladiff $PROD_DB_URI $TABLE_NAME $STAGING_DB_URI $TABLE_NAME \
            -k id --json --stats \
            > diff-results.json

      - name: Post PR Comment
        uses: actions/github-script@v7
        with:
          script: |
            const results = require('./diff-results.json');
            // Format as markdown table and post

      - name: Upload JUnit Results
        if: always()
        uses: dorny/test-reporter@v1
        with:
          name: Data Diff Results
          path: diff-results.xml
          reporter: java-junit

      - name: Gate on failures
        run: |
          if [ $(jq '.failures' diff-results.json) -gt 0 ]; then
            echo "::error::Data diff detected failures"
            exit 1
          fi
```

**Key design decisions**:
- **Exit codes**: `0` = no differences, `1` = differences found (configurable threshold), `2` = execution error
- **Artifact upload**: Both JSON and JUnit XML for different consumers
- **PR comment**: Markdown summary with collapsible details
- **Branch protection**: Non-zero exit blocks merge when configured as required check

---

## 4. Configuration UX

### 4.1 YAML Config File Patterns

#### dbt's `profiles.yml` (Connection Config)

```yaml
my_project:
  target: dev
  outputs:
    dev:
      type: snowflake
      account: "{{ env_var('SNOWFLAKE_ACCOUNT') }}"
      user: "{{ env_var('SNOWFLAKE_USER') }}"
      password: "{{ env_var('SNOWFLAKE_PASSWORD') }}"
      database: ANALYTICS
      schema: DEV_JANE
      threads: 4
    prod:
      type: snowflake
      account: "{{ env_var('SNOWFLAKE_ACCOUNT') }}"
      user: "{{ env_var('SNOWFLAKE_USER') }}"
      password: "{{ env_var('SNOWFLAKE_PASSWORD') }}"
      database: ANALYTICS
      schema: PROD
      threads: 8
```

Key patterns:
- **Environment variable interpolation**: `{{ env_var('...') }}`
- **Multiple targets** (environments) under one profile
- **Lives outside project directory** (`~/.dbt/profiles.yml`) to prevent credential leaks
- **Overridable via env var**: `DBT_PROFILES_DIR` or `--profiles-dir`

Sources: [dbt profiles.yml](https://docs.getdbt.com/docs/core/connect-data-platform/connection-profiles)

#### SodaCL Config Pattern

**`configuration.yml`** (connection):
```yaml
data_source my_datasource:
  type: snowflake
  connection:
    username: ${SNOWFLAKE_USER}
    password: ${SNOWFLAKE_PASSWORD}
    account: ${SNOWFLAKE_ACCOUNT}
    database: ANALYTICS
    schema: PUBLIC
    warehouse: COMPUTE_WH
    role: SODA_ROLE
```

**`checks.yml`** (validation rules):
```yaml
checks for orders:
  - row_count > 0
  - missing_count(order_id) = 0
  - duplicate_count(order_id) = 0
  - freshness(created_at) < 2d
  - invalid_count(status) = 0:
      valid values: ["pending", "shipped", "delivered", "cancelled"]
  - schema:
      fail:
        when required column missing: [order_id, customer_id, amount]
  - missing_count(email):
      warn: when > 5
      fail: when > 50
```

Key patterns:
- **Human-readable DSL**: `row_count > 0` reads like English
- **Warn vs fail thresholds**: Two severity levels per check
- **Separation of concerns**: Connection config vs check definitions in separate files
- **Environment variable substitution**: `${VAR_NAME}` syntax

Sources: [Soda Core Cheatsheet](https://dataengineer.wiki/cheatsheets/soda-core/)

#### Reladiff's TOML Config

```toml
[database.production_pg]
driver = "postgresql"
user = "postgres"
password = "Password1"

[run.default]
update_column = "timestamp"
verbose = true

[run.orders_diff]
verbose = false
1.database = "production_pg"
1.table = "orders"
2.database = "postgresql://staging:Password1@staging-host/"
2.table = "orders"
```

Key patterns:
- **TOML format** (less common in data tools, most use YAML)
- **Named database definitions** reusable across runs
- **Named run configurations** for repeatable diffs
- **Inline URIs or references** to named databases

Sources: [Reladiff User Guide](https://reladiff.readthedocs.io/en/latest/how-to-use.html)

#### Data Contract Specification

```yaml
dataContractSpecification: 0.9.3
id: urn:datacontract:checkout:orders-latest
info:
  title: Orders
  version: 1.0.0
servers:
  production:
    type: snowflake
    account: "xxxxxx"
    database: ANALYTICS
    schema: PUBLIC
models:
  orders:
    fields:
      order_id:
        type: varchar
        required: true
        unique: true
        primary: true
      amount:
        type: decimal
        precision: 10
        scale: 2
quality:
  type: SodaCL
  specification:
    checks for orders:
      - row_count > 0
      - duplicate_count(order_id) = 0
```

Sources: [Data Contract CLI](https://github.com/datacontract/datacontract-cli), [Data Contract Specification](http://datacontract.com/versions/0.9.0/)

### 4.2 Credentials Management Best Practices

From the CLI Guidelines (clig.dev) and real-world patterns:

| Method | Security | UX | Used By |
|--------|----------|-----|---------|
| **Environment variables** | Medium (leaks in `ps`, logs) | Easy | dbt, Soda, most tools |
| **Credential files** (outside project) | High | Good | dbt (`~/.dbt/`), AWS (`~/.aws/`) |
| **`--password-file`** | High | Moderate | CLI Guidelines recommendation |
| **stdin** | High | Manual | pg_dump, mysql |
| **Keyring/vault** | Highest | Complex | Enterprise tools |
| **`.env` files** | Medium | Easy | Local development |

**Critical rule**: Never accept secrets via command-line flags (they leak into `ps` output and shell history).

**Configuration precedence** (highest to lowest):
1. Command-line flags
2. Environment variables
3. Project-level config (`.reladiff.toml`)
4. User-level config (`~/.config/reladiff/config.toml`)
5. System-wide config

Sources: [CLI Guidelines](https://clig.dev/)

---

## 5. Error Messages & Diagnostics

### 5.1 What Makes Good Error Messages in Data Tools

From the CLI Guidelines and UX research:

**The anatomy of a great data tool error message**:

```
Error: Row count mismatch in 'orders' table

  Source (prod.public.orders):  10,000 rows
  Target (staging.public.orders): 9,850 rows
  Difference: 150 rows (1.5%) missing from target

  Possible causes:
    - Recent deletions not yet replicated
    - Filter predicate excluding rows
    - Ingestion pipeline delay

  To investigate:
    reladiff postgresql:///prod orders postgresql:///staging orders \
      -k order_id --show-sample --limit 20
```

**Key principles**:
1. **State what went wrong** (not just an error code)
2. **Show the actual values** (source vs target, expected vs actual)
3. **Suggest causes** (domain-specific knowledge)
4. **Provide next steps** (runnable command to investigate further)
5. **Place critical info at the end** (where eyes naturally focus in terminal)
6. **Catch errors and rewrite them for humans** -- avoid raw stack traces in normal mode
7. **Map exit codes to failure modes** so scripts can distinguish error types

Sources: [CLI Guidelines](https://clig.dev/), [Error Handling in CLI Tools](https://medium.com/@czhoudev/error-handling-in-cli-tools-a-practical-pattern-thats-worked-for-me-6c658a9141a9)

### 5.2 Presenting Diff Results: Progressive Disclosure

The most effective data diff tools use a **three-level progressive disclosure** pattern:

#### Level 1: Summary Card (Always Shown)

```
+-------------------------------------------------+
|  Reladiff: orders (prod vs staging)             |
|                                                 |
|  Schema:  Match                                 |
|  Rows:    10,000 vs 9,850 (150 missing)         |
|  Columns: 3/12 have differences                 |
|  Status:  FAIL (threshold: 0.1%, actual: 1.5%)  |
|  Time:    4.2s                                  |
+-------------------------------------------------+
```

#### Level 2: Column Statistics (`--verbose` or `-v`)

```
Column Match Rates:
  order_id     100.0%  ##############################  (0 mismatches)
  customer_id  100.0%  ##############################  (0 mismatches)
  amount        98.5%  #############################.  (148 mismatches)
  status        99.9%  ##############################  (10 mismatches)
  created_at   100.0%  ##############################  (0 mismatches)
  ...

Row Distribution:
  Matched:      9,850 (98.5%)
  Source only:    100 (1.0%)
  Target only:     50 (0.5%)
```

#### Level 3: Sample Rows (`--show-sample` or `--debug`)

```
Sample differences (amount column, 5 of 148):
+----------+----------------+----------------+----------+
| order_id | source_amount  | target_amount  | delta    |
+----------+----------------+----------------+----------+
| 1001     | 100.00         | 105.00         | +5.00    |
| 1042     | 250.50         | 250.49         | -0.01    |
| 1099     | 75.00          | NULL           | -75.00   |
| 1150     | 1234.56        | 1234.57        | +0.01    |
| 1203     | 500.00         | 499.99         | -0.01    |
+----------+----------------+----------------+----------+

Source-only rows (5 of 100):
+----------+-------------+----------+------------+
| order_id | customer_id | amount   | status     |
+----------+-------------+----------+------------+
| 2001     | 501         | 150.00   | pending    |
| 2002     | 502         | 200.00   | shipped    |
| ...      | ...         | ...      | ...        |
+----------+-------------+----------+------------+
```

### 5.3 Statistical Summaries

For numeric columns, data diff tools should provide:

```
Column: amount
  Min diff:     -75.00
  Max diff:     +5.00
  Mean diff:    -0.23
  Median diff:  -0.01
  Std dev:      2.41
  Within 0.01:  92.3% (136/148)
  Within 1.00:  97.9% (145/148)
  Exact match:  98.5% (9852/10000)
```

This pattern is inspired by how Recce presents profile diffs and how SQLMesh shows `pct_match` per column.

Sources: [Recce Data Validation](https://github.com/DataRecce/recce), [SQLMesh Table Diff](https://sqlmesh.readthedocs.io/en/stable/guides/tablediff/)

---

## 6. Notification & Alerting Integration

### 6.1 Slack Notifications

**Patterns from the ecosystem**:

| Tool | Slack Integration | Message Content |
|------|-------------------|-----------------|
| **Great Expectations** | `SlackNotificationAction` in checkpoint config | Pass/fail status, failed expectation list, Data Docs links |
| **DQOps** | Webhook-based, per-connection or global config | Incident status, View-in-DQOps link, severity level |
| **Elementary** | Built-in CLI alerter (`edr send-report`) | dbt test failures, model failures, anomaly detection results |
| **Monte Carlo** | Native Slack app integration | Auto-detected anomalies, affected tables, downstream impact |
| **Soda** | Via Soda Cloud platform | Scan results, check failures, trend data |

**Great Expectations Slack Config**:
```yaml
action_list:
  - name: send_slack_notification
    action:
      class_name: SlackNotificationAction
      slack_webhook: ${SLACK_WEBHOOK_URL}
      notify_on: failure        # all | success | failure
      notify_with:
        - local_site            # Which Data Docs to link
      show_failed_expectations: true
      renderer:
        module_name: great_expectations.render.renderer.slack_renderer
        class_name: SlackRenderer
```

Sources: [GX Slack Action](https://docs.greatexpectations.io/docs/0.18/oss/guides/validation/validation_actions/how_to_trigger_slack_notifications_as_a_validation_action/), [DQOps Slack Integration](https://dqops.com/docs/integrations/slack/configuring-slack-notifications/)

**Recommended Slack message format for Reladiff**:

```json
{
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "Data Diff Failed: orders"
      }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Source:*\nprod.public.orders" },
        { "type": "mrkdwn", "text": "*Target:*\nstaging.public.orders" },
        { "type": "mrkdwn", "text": "*Rows Compared:*\n10,000" },
        { "type": "mrkdwn", "text": "*Differences:*\n158 (1.58%)" }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Columns with differences:*\n- `amount` -- 98.5% match (148 mismatches)\n- `status` -- 99.9% match (10 mismatches)"
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View Full Report" },
          "url": "https://..."
        }
      ]
    }
  ]
}
```

### 6.2 PagerDuty / OpsGenie Integration

**Monte Carlo's pattern** (the gold standard for data alerting):

- **Bidirectional sync**: Incident status syncs between Monte Carlo and PagerDuty
- **Routing rules**: Alerts routed by dataset ownership, incident type, severity
- **Alert deduplication**: PagerDuty Event Intelligence suppresses multiple alerts for one incident
- **Escalation policies**: Critical data quality issues escalate through on-call rotations
- **Notification channels**: Slack, Teams, Email, PagerDuty, OpsGenie, Webex, Jira, ServiceNow, webhooks

**Implementation for Reladiff**:

Rather than building native PagerDuty/OpsGenie integration, Reladiff should:
1. **Emit webhook payloads** with a standard schema
2. **Support PagerDuty Events API v2** format directly
3. Let users configure webhook endpoints in TOML config

```toml
[notifications.pagerduty]
enabled = true
routing_key = "${PAGERDUTY_ROUTING_KEY}"
severity = "critical"  # critical | error | warning | info
trigger_on = "failure"  # failure | always | threshold

[notifications.slack]
enabled = true
webhook_url = "${SLACK_WEBHOOK_URL}"
channel = "#data-quality"
trigger_on = "always"

[notifications.webhook]
enabled = true
url = "https://hooks.example.com/data-quality"
method = "POST"
headers = { "Authorization" = "Bearer ${WEBHOOK_TOKEN}" }
trigger_on = "failure"
```

Sources: [Monte Carlo PagerDuty Integration](https://docs.getmontecarlo.com/docs/pagerduty), [Monte Carlo Alerting](https://www.montecarlodata.com/blog-automatic-detection-and-alerting-for-data-incidents-with-monte-carlo/), [DQOps Webhooks](https://dqops.com/docs/integrations/webhooks/)

### 6.3 Email Digest Pattern

For scheduled/batch data validation, email digests should follow:

```
Subject: [FAIL] Reladiff Daily Report -- 3 tables with differences

Summary:
  Compared: 15 table pairs
  Passed:   12
  Failed:   3
  Duration: 45.2s

Failed Tables:
  1. orders (prod vs staging) -- 158 row differences (1.58%)
  2. customers (prod vs staging) -- 12 schema mismatches
  3. events (prod vs staging) -- 5,000 source-only rows

Full report: https://...
```

---

## 7. Synthesis: Recommended DX Architecture for Reladiff

### 7.1 Output Mode Matrix

| Mode | Flag | Format | Use Case |
|------|------|--------|----------|
| **Human** (default) | (none) | Rich-formatted tables, colors, summary card | Interactive terminal use |
| **Quiet** | `-q` / `--quiet` | Pass/fail only | Scripts, CI gates |
| **Verbose** | `-v` / `--verbose` | Summary + column stats + sample rows | Debugging, investigation |
| **JSON** | `--json` | JSONL structured output | CI/CD pipelines, programmatic consumption |
| **JUnit XML** | `--junit` | JUnit XML test report | GitHub Actions, Jenkins test reporting |
| **SARIF** | `--sarif` | SARIF v2.1.0 | GitHub Code Scanning, quality platforms |
| **Markdown** | `--markdown` | GFM tables | PR comments, documentation |

### 7.2 Exit Code Specification

| Code | Meaning | Usage |
|------|---------|-------|
| `0` | No differences found | CI pass |
| `1` | Differences found (within threshold if set) | CI conditional |
| `2` | Differences exceed threshold | CI fail |
| `3` | Execution error (connection, permissions, etc.) | Infrastructure issue |
| `4` | Configuration error (invalid TOML, missing required fields) | User error |

### 7.3 Configuration File Hierarchy

```
~/.config/reladiff/config.toml     # User-level defaults (credentials, preferences)
.reladiff.toml                      # Project-level config (table pairs, thresholds)
CLI flags                           # Per-invocation overrides
Environment variables               # CI/CD secrets
```

### 7.4 Recommended Feature Priorities

**P0 (Must Have)**:
1. Human-readable terminal output with Rich tables and summary card
2. JSON output (`--json`) for CI/CD
3. Meaningful exit codes (0/1/2/3)
4. Git-like `+`/`-` diff notation (already exists in Reladiff)
5. `--quiet` and `--verbose` modes
6. Progress indicators for long-running diffs

**P1 (High Value)**:
1. Markdown output (`--markdown`) for PR comments
2. JUnit XML output (`--junit`) for test runners
3. GitHub Action (official or documented workflow)
4. Slack webhook notification support
5. Threshold configuration (fail if diff exceeds N%)

**P2 (Differentiators)**:
1. SARIF output for GitHub Code Scanning integration
2. PR comment bot (auto-post diff results to PRs)
3. PagerDuty Events API v2 support
4. Column-level statistical summaries
5. Progressive disclosure (summary -> stats -> samples)

**P3 (Nice to Have)**:
1. HTML report generation (like GX Data Docs)
2. Email digest support
3. OpsGenie/ServiceNow webhook support
4. Interactive TUI mode for exploring diffs

---

## 8. Competitive Positioning

### 8.1 Feature Matrix: Data Diff CLI Tools

| Feature | Reladiff | SQLMesh | Datafold (OSS) | csv-diff | dbt-audit-helper |
|---------|----------|---------|----------------|----------|-----------------|
| Cross-database | Yes | Yes | Yes (archived) | No | No |
| CLI output | `+`/`-` diff | Rich tables | Basic | Human + JSON | SQL result set |
| JSON output | JSONL | No | No | Yes | No |
| JUnit XML | No | No | No | No | No |
| SARIF | No | No | No | No | No |
| Markdown | No | No | No | No | No |
| PR comments | No | No | Via Cloud | No | Manual |
| Config file | TOML | YAML | YAML | N/A | dbt YAML |
| Stats mode | `--stats` | `pct_match` | No | No | Match categories |
| Sample rows | No native | `--show-sample` | No | `--show-unchanged` | No |
| Schema diff | No | Yes | No | Column add/remove | Column comparison |
| Threshold config | No | No | No | No | No |
| Slack integration | No | No | Via Cloud | No | No |
| GitHub Action | No | Built-in CI | Via Cloud | No | No |
| Active maintenance | Yes | Yes | Archived (2024) | Low activity | Active |

### 8.2 Reladiff's Unique Advantages

1. **Performance**: Bisection algorithm minimizes data transfer for cross-database diffs
2. **Database breadth**: 12+ databases supported
3. **Open source**: Fork of archived data-diff, actively maintained
4. **Python API**: Usable as both CLI and library
5. **Algorithm choice**: `joindiff` (same DB) vs `hashdiff` (cross-DB) vs `auto`

### 8.3 Key Gaps to Address

1. **Output formatting**: Currently minimal (`+`/`-` lines). Needs Rich-based summary tables.
2. **Multiple output formats**: Only JSON and text. Missing JUnit, SARIF, Markdown.
3. **CI/CD integration**: No GitHub Action, no PR comment support.
4. **Schema diff**: Not currently shown.
5. **Statistical summaries**: `--stats` exists but limited.
6. **Notification hooks**: No Slack/webhook support.
7. **Threshold configuration**: No fail-if-exceeds-N% pattern.
8. **Progressive disclosure**: No `--verbose` / `--quiet` hierarchy.

---

## Sources

### CLI Design & UX
- [Command Line Interface Guidelines](https://clig.dev/)
- [Thoughtworks CLI Design Guidelines](https://www.thoughtworks.com/en-us/insights/blog/engineering-effectiveness/elevate-developer-experiences-cli-design-guidelines)
- [Error Handling in CLI Tools](https://medium.com/@czhoudev/error-handling-in-cli-tools-a-practical-pattern-thats-worked-for-me-6c658a9141a9)
- [HackerNoon: CLI Tools Developers Love](https://hackernoon.com/how-to-design-a-cli-tool-that-developers-actually-love-using)

### Data Validation Tools
- [dbt CLI Command Reference](https://docs.getdbt.com/reference/dbt-commands)
- [dbt Logs Reference](https://docs.getdbt.com/reference/global-configs/logs)
- [dbt run_results.json](https://docs.getdbt.com/reference/artifacts/run-results-json)
- [dbt severity, error_if, warn_if](https://docs.getdbt.com/reference/resource-configs/severity)
- [Soda Core Cheatsheet](https://dataengineer.wiki/cheatsheets/soda-core/)
- [Soda Run a Scan](https://docs.soda.io/run-a-scan)
- [Great Expectations Validation Result](https://docs.greatexpectations.io/docs/0.18/reference/learn/terms/validation_result/)
- [Great Expectations Data Docs](https://docs.greatexpectations.io/docs/0.18/reference/learn/terms/data_docs/)
- [Great Expectations CheckpointResult](https://docs.greatexpectations.io/docs/0.18/reference/api/checkpoint/types/checkpoint_result/checkpointresult_class/)
- [Data Contract CLI](https://github.com/datacontract/datacontract-cli)
- [Data Contract Specification](http://datacontract.com/versions/0.9.0/)

### Data Diff Tools
- [Reladiff Documentation](https://reladiff.readthedocs.io/en/latest/how-to-use.html)
- [Reladiff GitHub](https://github.com/erezsh/reladiff)
- [How Reladiff Works](https://eshsoft.com/blog/how-reladiff-works)
- [SQLMesh Table Diff Guide](https://sqlmesh.readthedocs.io/en/stable/guides/tablediff/)
- [SQLMesh table_diff CLI issue #2645](https://github.com/TobikoData/sqlmesh/issues/2645)
- [Datafold CI How It Works](https://docs.datafold.com/deployment-testing/how-it-works)
- [Datafold Open Source vs Cloud](https://www.datafold.com/blog/the-lowdown-open-source-data-diff-vs-datafold-cloud)
- [csv-diff](https://github.com/simonw/csv-diff)
- [dbt-audit-helper](https://github.com/dbt-labs/dbt-audit-helper)
- [dbt-audit-helper for Migration](https://docs.getdbt.com/blog/audit-helper-for-migration)
- [Recce Data Validation](https://github.com/DataRecce/recce)
- [Recce: What is a Data Diff](https://reccehq.com/ai-blog/what-is-a-data-diff/)
- [daff table diff](https://github.com/paulfitz/daff)

### Output Format Standards
- [JUnit XML Format](https://github.com/testmoapp/junitxml)
- [SARIF Specification v2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
- [Sonar SARIF Guide](https://www.sonarsource.com/resources/library/sarif/)
- [Checkov Output Formats](https://www.checkov.io/2.Basics/Reviewing%20Scan%20Results.html)
- [Checkov SARIF](https://www.checkov.io/8.Outputs/SARIF.html)
- [GitLab Unit Test Report Examples](https://docs.gitlab.com/ci/testing/unit_test_report_examples/)

### CI/CD Integration
- [dbt CI Jobs](https://docs.getdbt.com/docs/deploy/ci-jobs)
- [dbt CI Guide](https://docs.getdbt.com/guides/set-up-ci)
- [Datafold Slim CI](https://www.datafold.com/blog/slim-ci-the-cost-effective-solution-for-successful-deployments-in-dbt-cloud/)
- [Datafold Building CI Pipeline for dbt](https://www.datafold.com/blog/building-your-first-ci-pipeline-for-your-dbt-project/)
- [Soda GitHub Action](https://github.com/sodadata/soda-github-action)
- [Soda GitHub Integration](https://docs.soda.io/integrate-soda/integrate-github)
- [GX GitHub Actions Integration](https://greatexpectations.io/blog/github-actions/)

### Notification & Alerting
- [GX Slack Notification Action](https://docs.greatexpectations.io/docs/0.18/oss/guides/validation/validation_actions/how_to_trigger_slack_notifications_as_a_validation_action/)
- [DQOps Slack Notifications](https://dqops.com/docs/integrations/slack/configuring-slack-notifications/)
- [DQOps Webhooks](https://dqops.com/docs/integrations/webhooks/)
- [DQOps Incident Management](https://dqops.com/docs/dqo-concepts/grouping-data-quality-issues-to-incidents/)
- [Monte Carlo PagerDuty](https://docs.getmontecarlo.com/docs/pagerduty)
- [Monte Carlo Alerting](https://www.montecarlodata.com/blog-automatic-detection-and-alerting-for-data-incidents-with-monte-carlo/)
- [Monte Carlo Alert Strategies](https://www.montecarlodata.com/blog-top-data-quality-alert-strategies-from-3-real-data-teams/)
- [Elementary Data](https://github.com/elementary-data/elementary)
- [Elementary dbt Observability](https://www.elementary-data.com/post/dbt-observability-101-how-to-monitor-dbt-run-and-test-results)

### Terminal Formatting Libraries
- [Rich Library](https://github.com/Textualize/rich)
- [Rich Progress Display](https://rich.readthedocs.io/en/latest/progress.html)
- [rich-click](https://github.com/ewels/rich-click)
- [Typer Printing](https://typer.tiangolo.com/tutorial/printing/)

### Configuration Patterns
- [dbt profiles.yml](https://docs.getdbt.com/docs/core/connect-data-platform/connection-profiles)
- [Data Contract Specification](http://datacontract.com/versions/0.9.0/)
- [Soda Data Contracts](https://docs.soda.io/soda-v3/data-contracts/data-contracts-verify)
