# RFC: Modular Domain-Specific System Prompts

**Status:** Proposed
**Author:** Kulvir Gahlawat
**Created:** 2026-03-26
**Last Updated:** 2026-03-26

---

## Problem Statement

The altimate-code system prompt is becoming increasingly dbt/Snowflake-specific. As we add support for more platforms (MongoDB, Postgres standalone, Databricks notebooks, BigQuery, etc.), the single monolithic prompt approach creates two problems:

1. **Irrelevant context** — A MongoDB user receives 150+ lines of dbt-specific instructions (model layers, `dbt deps`, staging/intermediate/marts, lineage verification workflow) that don't apply to their environment. This wastes context window tokens and confuses the model.

2. **Scaling friction** — Adding deep domain knowledge for a new platform (e.g., MongoDB aggregation patterns, Databricks Unity Catalog, BigQuery slot management) means either bloating the single prompt further or leaving the new platform underserved.

### Concrete Example

The latest commit (`abcaa1d52`) adds full MongoDB driver support (581 lines, 90 E2E tests). But the system prompt (`builder.txt`) still opens with:

> *"You are altimate-code in builder mode — a data engineering agent specializing in **dbt models, SQL, and data pipelines**."*

A MongoDB user gets instructions to:
- Run `altimate-dbt build` (no dbt project exists)
- Place models in `staging/`, `intermediate/`, `marts/` (MongoDB has collections, not model layers)
- Run `dbt deps` before building (no `packages.yml`)
- Use `lineage_check` for column-level data flow (document databases don't have fixed columns)
- Follow the 4-step "dbt Verification Workflow" (none of it applies)

Meanwhile, there are zero MongoDB-specific instructions (when to use aggregation pipelines vs find, document schema patterns, BSON type handling, etc.).

---

## Proposed Solution: Composable Domain Prompts

Split the agent prompt into a **thin universal base** + **composable domain modules** that are selected based on the detected environment.

### Architecture Overview

```text
┌─────────────────────────────────────────────────────────┐
│                  System Prompt Assembly                   │
├─────────────────────────────────────────────────────────┤
│  1. Provider prompt        (model-specific)             │  ← unchanged
│  2. Agent base prompt      (role-specific, universal)   │  ← NEW (slimmed)
│  3. Domain prompts         (environment-specific)       │  ← NEW LAYER
│  4. Environment info       (working dir, platform)      │  ← unchanged
│  5. Skills list            (filtered by fingerprint)    │  ← unchanged
│  6. Knowledge injection    (training + memory)          │  ← unchanged
│  7. User instructions      (CLAUDE.md, AGENTS.md)       │  ← unchanged
└─────────────────────────────────────────────────────────┘
```

The key change is splitting layer 2 (currently `builder.txt` / `analyst.txt`) into a base + domain modules, and adding layer 3 as a new composition step.

### File Structure

```text
packages/opencode/src/altimate/prompts/
├── builder-base.txt          # Universal builder principles (~40 lines)
├── analyst-base.txt          # Universal analyst principles (~25 lines)
├── domain/
│   ├── dbt.txt               # dbt workflows, altimate-dbt, model layers (implemented)
│   ├── dbt-analyst.txt        # dbt read-only context for analyst agent (implemented)
│   ├── sql.txt               # SQL pre-execution protocol, validation (implemented)
│   ├── sql-analyst.txt        # SQL analysis protocol for analyst agent (implemented)
│   ├── snowflake.txt          # Snowflake FinOps, credits, warehouses (implemented)
│   ├── mongodb.txt            # Document patterns, MQL, aggregation (implemented)
│   ├── training.txt           # Teammate training, always included (implemented)
│   ├── databricks.txt         # Unity Catalog, notebooks, clusters (future)
│   ├── postgres.txt           # Extensions, VACUUM, pg_stat (future)
│   ├── bigquery.txt           # Partitioning, slots, cost model (future)
│   ├── mysql.txt              # MySQL/MariaDB specifics (future)
│   ├── redshift.txt           # Redshift specifics (future)
│   └── airflow.txt            # DAGs, operators, scheduling (future)
```

---

## How It Works

### Step 1: Detect Environment Tags

The fingerprint system detects what technologies are present in the user's environment. Tags are collected from multiple signal sources (see [Tag Resolution](#tag-resolution-how-tags-are-decided) below).

Example outputs:
- dbt + Snowflake project: `["dbt", "snowflake", "sql", "data-engineering"]`
- MongoDB app: `["mongodb"]`
- Postgres via env vars: `["postgres", "sql"]`
- Databricks + Airflow: `["databricks", "airflow", "sql"]`

### Step 2: Compose Domain Prompts

A mapping from tags to domain prompt files determines which modules are included:

```typescript
const TAG_TO_DOMAIN: Record<string, string> = {
  dbt:         DOMAIN_DBT,
  sql:         DOMAIN_SQL,
  snowflake:   DOMAIN_SNOWFLAKE,
  mongodb:     DOMAIN_MONGODB,
  databricks:  DOMAIN_DATABRICKS,
  postgres:    DOMAIN_POSTGRES,
  bigquery:    DOMAIN_BIGQUERY,
  mysql:       DOMAIN_MYSQL,
  redshift:    DOMAIN_REDSHIFT,
  airflow:     DOMAIN_AIRFLOW,
}
```

### Step 3: Assemble Final Prompt

```typescript
// In agent.ts or a new domain composition module
const agentPrompt = [
  PROMPT_BUILDER_BASE,           // universal principles
  ...composeDomainPrompts(),     // environment-specific modules
  PROMPT_TRAINING,               // teammate training (always included)
].join("\n\n")
```

### Token Impact

| Scenario | Today (lines) | After (lines) | Change |
|---|---|---|---|
| dbt + Snowflake project | ~200 (all of builder.txt) | ~150 (base + dbt + sql + snowflake + training) | -25% |
| Pure MongoDB project | ~200 (all irrelevant dbt/SQL) | ~70 (base + mongodb + training) | -65% |
| Postgres + SQL (no dbt) | ~200 (dbt instructions wasted) | ~70 (base + sql + postgres + training) | -65% |
| dbt + BigQuery + Airflow | ~200 (missing BQ/Airflow specifics) | ~130 (base + dbt + sql + bigquery + airflow + training) | -35%, +relevance |

---

## Tag Resolution: How Tags Are Decided

This is the core question: how does the system determine what technologies the user is working with?

### Signal Sources

There are 6 signal sources, 4 of which already exist as built code in the repository:

#### Signal 1: File Detection (exists today, feeds fingerprint)

**Location:** `packages/opencode/src/altimate/fingerprint/index.ts:70-141`

Checks for convention config files in the project directory:

| File/Directory | Tags Produced |
|---|---|
| `dbt_project.yml` | `dbt`, `data-engineering` |
| `dbt_packages.yml` | `dbt-packages` |
| `profiles.yml` (parses `type:` field) | `snowflake`, `bigquery`, `postgres`, `databricks`, etc. |
| `.sqlfluff` or any `*.sql` files | `sql` |
| `airflow.cfg` or `dags/` directory | `airflow` |
| `databricks.yml` | `databricks` |

**Strengths:** Fast, no side effects, works offline, no dependencies.
**Weaknesses:** Misses non-file-configured environments. A MongoDB user with connections only in `connections.json` or env vars gets zero tags.

#### Signal 2: Connection Registry (wired to fingerprint)

**Location:** `packages/opencode/src/altimate/native/connections/registry.ts:316-352`

The `list()` function returns every configured connection with its `type` field. This is the richest signal — it knows about connections from:
- `~/.altimate-code/connections.json` (global)
- `.altimate-code/connections.json` (project-local)
- `ALTIMATE_CODE_CONN_*` environment variables

The `DRIVER_MAP` (line 115) supports: `postgres`, `snowflake`, `bigquery`, `mysql`, `sqlserver`, `databricks`, `duckdb`, `oracle`, `sqlite`, `mongodb`.

**Strengths:** Catches all configured connections regardless of project file structure.
**Weaknesses:** Only catches connections the user has explicitly configured. First-time users who haven't run `/discover` yet won't have connections.

#### Signal 3: dbt Profile Discovery (wired to fingerprint)

**Location:** `packages/opencode/src/altimate/native/connections/dbt-profiles.ts`

Reads `~/.dbt/profiles.yml` (the global dbt config, not just the project's `profiles.yml`) and parses adapter types. Resolves Jinja `{{ env_var('NAME') }}` patterns.

**Strengths:** Catches dbt users whose `profiles.yml` is in the default location, not the project root.
**Weaknesses:** Only relevant for dbt users.

#### Signal 4: Environment Variable Detection (wired to fingerprint)

**Location:** `packages/opencode/src/altimate/tools/project-scan.ts:115-289`

Detects warehouse types from known environment variable patterns:

| Env Vars | Tag |
|---|---|
| `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER` | `snowflake` |
| `PGHOST`, `PGDATABASE` | `postgres` |
| `DATABRICKS_HOST`, `DATABRICKS_TOKEN` | `databricks` |
| `GOOGLE_APPLICATION_CREDENTIALS`, `BIGQUERY_PROJECT` | `bigquery` |
| `MYSQL_HOST`, `MYSQL_DATABASE` | `mysql` |
| `ORACLE_HOST`, `ORACLE_SID` | `oracle` |
| `MONGODB_URI`, `MONGO_URI` | `mongodb` |
| `DATABASE_URL` (parses scheme) | varies |

**Strengths:** Catches cloud-configured environments (CI/CD, Codespaces, Docker Compose) where credentials come from env vars.
**Weaknesses:** False positives if old/unused env vars are still set.

#### Signal 5: Dependency File Scanning (wired to fingerprint)

**Location:** `packages/opencode/src/altimate/fingerprint/index.ts` (`detectDependencies`)

Greps common dependency manifests (`requirements.txt`, `pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, etc.) for unambiguous package identifiers like `snowflake-connector`, `pymongo`, `dbt-bigquery`, `apache-airflow-providers-snowflake`, etc.

**Strengths:** Dependencies are intentional declarations — much higher signal than env vars. Catches composite environments (e.g., Airflow+Snowflake via `airflow-providers-snowflake`). Adding a signal is one line in the `DEPENDENCY_SIGNALS` map.
**Weaknesses:** Only matches known package names. New/obscure packages need to be added manually.

#### Signal 6: Docker Container Discovery (opt-in, NOT wired)

**Location:** `packages/opencode/src/altimate/native/connections/docker-discovery.ts`

Uses `dockerode` to detect running database containers by matching image names (postgres, mysql, oracle, etc.).

**Strengths:** Catches local development databases.
**Weaknesses:** Expensive (shells out to Docker daemon). Should NOT run automatically in fingerprint detection. Already available via `warehouse_discover` tool and `/discover` skill — when users add discovered connections, they flow into Signal 2 (connection registry).

**Recommendation:** Do not wire this into automatic fingerprint detection. Leave it as opt-in via `/discover`.

#### Signal 7: User Config Override (implemented)

An explicit `domains` field in `.opencode/config.json`:

```json
{
  "experimental": {
    "domains": ["mongodb", "sql"]
  }
}
```

**Purpose:** Override for when auto-detection is wrong, incomplete, or the user wants to force specific domain prompts.

**Behavior:** When set, this **replaces** auto-detection entirely (not additive). If a user says "I only care about MongoDB", we shouldn't inject dbt instructions just because a stale `dbt_project.yml` exists in the directory.

### Resolution Strategy

Tags from signals 1-4 are **unioned** (additive). Signal 5 is excluded from auto-detection. Signal 6, when set, overrides everything.

```text
┌──────────────────────────────────────────────────────┐
│                    Tag Resolution                     │
├──────────────────────────────────────────────────────┤
│                                                      │
│  User config ("domains": [...])  ──── if set, STOP  │
│           │ not set                                  │
│           v                                          │
│  ┌─ File detection ────────┐                         │
│  ├─ Connection registry ───┤  <- all run in parallel │
│  ├─ dbt profiles (~/.dbt/) ┤                         │
│  └─ Environment variables ─┘                         │
│           │                                          │
│           v                                          │
│      Deduplicate + Normalize aliases                 │
│      (postgresql -> postgres, mongo -> mongodb, etc) │
│           │                                          │
│           v                                          │
│    Final tag set -> domain prompt composition        │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Implicit Tag Rules

Some tags should be **implied** by others to avoid missing common cross-cutting modules:

| If tag detected | Also include |
|---|---|
| `dbt` | `sql` (dbt generates SQL) |
| `snowflake` | `sql` |
| `bigquery` | `sql` |
| `postgres` | `sql` |
| `redshift` | `sql` |
| `mysql` | `sql` |
| `databricks` | `sql` |
| `duckdb` | `sql` |

MongoDB is the exception — it does NOT imply `sql` since MongoDB uses MQL, not SQL.

### Alias Normalization

Driver type names vary. Normalize to canonical tag names:

| Input (from driver/config) | Canonical Tag |
|---|---|
| `postgresql` | `postgres` |
| `mongo` | `mongodb` |
| `mariadb` | `mysql` |
| `mssql` | `sqlserver` |

### Fallback Behavior

If no tags are detected from any signal source AND no config override is set:
- Include `sql` + `dbt` as defaults
- This preserves current behavior for unfingerprinted projects
- Prevents a blank/useless system prompt for first-time users

---

## Prompt Decomposition Plan

### What Goes Into `builder-base.txt` (~40 lines)

Universal principles that apply to ANY data environment:

- Identity line ("You are altimate-code in builder mode — a data engineering agent")
- Core principles: understand before writing, follow conventions, validate output, fix everything
- Tool capabilities (universal): read/write files, bash, grep, glob, tool_lookup
- Self-review checklist (generic: re-read, check edge cases, validate)
- Workflow skeleton: explore -> write -> verify

### What Goes Into `analyst-base.txt` (~25 lines)

Universal analyst identity and read-only constraints:

- Identity line
- Read-only constraint declaration
- Cost-conscious exploration protocol (universal: LIMIT, iterative optimization, session cost tracking)
- The competitive advantage framing ("your users generate insights, not warehouse bills")

### What Goes Into `domain/dbt.txt` (~80 lines)

Everything currently in `builder.txt` that is dbt-specific:

- `altimate-dbt` commands (build, compile, columns, execute, info)
- "Never call raw `dbt` directly"
- Pre-first-build `dbt deps` check
- Full project build requirement
- dbt model creation conventions (staging/intermediate/marts, schema.yml)
- dbt Verification Workflow (compile -> analyze -> lineage -> test coverage)
- dbt-specific pitfalls (stopping at compile, skipping full build, ignoring pre-existing failures)
- dbt skill mappings (/dbt-develop, /dbt-test, /dbt-docs, /dbt-troubleshoot, /dbt-analyze)
- Proactive invocation rules for dbt skills

### What Goes Into `domain/sql.txt` (~30 lines)

SQL-universal instructions (applies to any SQL warehouse):

- Pre-Execution Protocol (analyze -> validate -> execute)
- `sql_analyze`, `altimate_core_validate` workflow
- Cost advocacy framing ("every credit saved is trust earned")
- CTE preference, column casing awareness, fan-out join warnings
- SQL skill mappings (/sql-review, /query-optimize, /sql-translate, /lineage-diff)
- SQL pitfalls (writing without checking columns, NULL vs 0 confusion)

### What Goes Into `domain/snowflake.txt` (~20 lines)

Snowflake-specific:

- FinOps tools (finops_analyze_credits, finops_warehouse_advice, finops_expensive_queries, finops_unused_resources)
- RBAC tools (finops_role_grants, finops_role_hierarchy, finops_user_roles)
- /cost-report skill mapping
- Snowflake-specific considerations (credit-based cost model, warehouse sizing, data sharing)

### What Goes Into `domain/mongodb.txt` (~30 lines)

MongoDB-specific (new):

- Document-oriented thinking (collections not tables, documents not rows, flexible schemas)
- MQL operations via `sql_execute` with JSON command format
- Aggregation pipeline patterns vs find operations
- BSON type awareness (ObjectId, Decimal128, Date serialization)
- Schema inspection via document sampling (not fixed DDL)
- Index management patterns
- No dbt, no SQL, no lineage — different mental model entirely
- Cross-database query patterns

### What Goes Into `domain/training.txt` (~20 lines)

Teammate training section (always included):

- "You are a trainable AI teammate" framing
- Applying training: check patterns before writing, attribute when influenced, flag conflicts
- Detecting corrections: explicit and implicit
- Training tools: training_save, training_list, training_remove
- Learning skills: /teach, /train, /training-status

### Future Domain Modules (not in initial implementation)

| Module | When to build |
|---|---|
| `domain/databricks.txt` | When we have Databricks-specific tools/skills beyond the driver |
| `domain/bigquery.txt` | When we add BQ-specific cost/slot management tools |
| `domain/postgres.txt` | When we add Postgres-specific tools (EXPLAIN ANALYZE, pg_stat, extensions) |
| `domain/redshift.txt` | When we add Redshift-specific tools |
| `domain/airflow.txt` | When we add Airflow DAG management tools/skills |
| `domain/mysql.txt` | When we add MySQL-specific tools |

For now, these platforms are served by the `sql.txt` base module. Domain-specific modules are added when there's enough platform-specific content to justify a separate file.

---

## Implementation Plan

### Phase 1: Fingerprint Expansion (prerequisite)

Wire signals 2-4 into the fingerprint detector and add the config override.

**Files to modify:**
- `packages/opencode/src/altimate/fingerprint/index.ts` — add `detectConnections()`, `detectEnvVars()`, `detectDbtProfiles()`, `normalizeDriverTag()`, config override check
- `packages/opencode/src/config/config.ts` — add `domains` field to `experimental` schema

**Estimated effort:** ~50 lines of new code, mostly plumbing to existing infrastructure.

**Key implementation details:**

```typescript
// fingerprint/index.ts additions

async function detectConnections(tags: string[]): Promise<void> {
  try {
    // Import lazily to avoid circular deps — registry loads at session start
    const { list } = await import("../../altimate/native/connections/registry")
    const { warehouses } = list()
    for (const w of warehouses) {
      const t = w.type?.toLowerCase()
      if (t) tags.push(normalizeDriverTag(t))
    }
  } catch { /* registry not loaded — skip */ }
}

async function detectEnvVars(tags: string[]): Promise<void> {
  const checks: [string[], string][] = [
    [["SNOWFLAKE_ACCOUNT"], "snowflake"],
    [["PGHOST", "PGDATABASE"], "postgres"],
    [["DATABRICKS_HOST"], "databricks"],
    [["GOOGLE_APPLICATION_CREDENTIALS", "BIGQUERY_PROJECT"], "bigquery"],
    [["MYSQL_HOST"], "mysql"],
    [["ORACLE_HOST"], "oracle"],
    [["MONGODB_URI", "MONGO_URI"], "mongodb"],
  ]
  for (const [vars, tag] of checks) {
    if (vars.some(v => process.env[v])) tags.push(tag)
  }
  // DATABASE_URL scheme parsing
  const dbUrl = process.env.DATABASE_URL
  if (dbUrl) {
    const scheme = dbUrl.split("://")[0]
    const map: Record<string, string> = {
      postgres: "postgres", postgresql: "postgres",
      mysql: "mysql", mongodb: "mongodb", "mongodb+srv": "mongodb",
    }
    if (map[scheme]) tags.push(map[scheme])
  }
}

function normalizeDriverTag(type: string): string {
  const aliases: Record<string, string> = {
    postgresql: "postgres",
    mongo: "mongodb",
    mariadb: "mysql",
    mssql: "sqlserver",
  }
  return aliases[type] ?? type
}
```

### Phase 2: Prompt Decomposition

Split `builder.txt` and `analyst.txt` into base + domain modules.

**Files to create:**
- `packages/opencode/src/altimate/prompts/builder-base.txt`
- `packages/opencode/src/altimate/prompts/analyst-base.txt`
- `packages/opencode/src/altimate/prompts/domain/dbt.txt`
- `packages/opencode/src/altimate/prompts/domain/sql.txt`
- `packages/opencode/src/altimate/prompts/domain/snowflake.txt`
- `packages/opencode/src/altimate/prompts/domain/mongodb.txt`
- `packages/opencode/src/altimate/prompts/domain/training.txt`

**Files to modify:**
- `packages/opencode/src/altimate/prompts/builder.txt` — becomes the assembled output (or removed in favor of runtime composition)
- `packages/opencode/src/altimate/prompts/analyst.txt` — same

**Key constraint:** Each domain module must be **self-contained and coherent** when read alone. No cross-references between domain modules (e.g., `dbt.txt` should not reference Snowflake-specific behavior).

### Phase 3: Composition Logic

Build the composition function and wire it into agent prompt assembly.

**Files to create:**
- `packages/opencode/src/altimate/prompts/compose.ts` — domain prompt composition function

**Files to modify:**
- `packages/opencode/src/agent/agent.ts` — use composition instead of static `PROMPT_BUILDER` / `PROMPT_ANALYST`

**Key implementation:**

```typescript
// packages/opencode/src/altimate/prompts/compose.ts

import { Fingerprint } from "../fingerprint"
import { Config } from "../../config/config"

import DOMAIN_DBT from "./domain/dbt.txt"
import DOMAIN_SQL from "./domain/sql.txt"
import DOMAIN_SNOWFLAKE from "./domain/snowflake.txt"
import DOMAIN_MONGODB from "./domain/mongodb.txt"
import DOMAIN_TRAINING from "./domain/training.txt"
// ... future imports

const TAG_TO_DOMAIN: Record<string, string> = {
  dbt:         DOMAIN_DBT,
  sql:         DOMAIN_SQL,
  snowflake:   DOMAIN_SNOWFLAKE,
  mongodb:     DOMAIN_MONGODB,
  // databricks, postgres, bigquery, etc. added as domain files are created
}

// Tags that imply other tags
const TAG_IMPLICATIONS: Record<string, string[]> = {
  dbt:        ["sql"],
  snowflake:  ["sql"],
  bigquery:   ["sql"],
  postgres:   ["sql"],
  redshift:   ["sql"],
  mysql:      ["sql"],
  databricks: ["sql"],
  duckdb:     ["sql"],
  // mongodb does NOT imply sql
}

export function composeDomainPrompts(baseTxt: string): string {
  const fp = Fingerprint.get()
  let tags = fp?.tags ?? []

  // Apply implications (e.g., dbt -> sql)
  const expanded = new Set(tags)
  for (const tag of tags) {
    const implied = TAG_IMPLICATIONS[tag]
    if (implied) implied.forEach(t => expanded.add(t))
  }
  tags = [...expanded]

  // Collect matching domain prompts (deduplicated, ordered)
  const seen = new Set<string>()
  const domains: string[] = []
  for (const tag of tags) {
    const domain = TAG_TO_DOMAIN[tag]
    if (domain && !seen.has(tag)) {
      domains.push(domain)
      seen.add(tag)
    }
  }

  // Fallback: if no domains matched, include sql + dbt (current behavior)
  if (domains.length === 0) {
    domains.push(DOMAIN_SQL, DOMAIN_DBT)
  }

  // Always include training
  domains.push(DOMAIN_TRAINING)

  return [baseTxt, ...domains].join("\n\n")
}
```

Then in `agent.ts`:

```typescript
import PROMPT_BUILDER_BASE from "../altimate/prompts/builder-base.txt"
import PROMPT_ANALYST_BASE from "../altimate/prompts/analyst-base.txt"
import { composeDomainPrompts } from "../altimate/prompts/compose"

// ...

builder: {
  prompt: composeDomainPrompts(PROMPT_BUILDER_BASE),
  // ...
},
analyst: {
  prompt: composeDomainPrompts(PROMPT_ANALYST_BASE),
  // ...
},
```

### Phase 4: Feature Flag & Rollout

Gate behind a config flag for safe rollout:

```json
{
  "experimental": {
    "modular_prompts": true
  }
}
```

When `false` (default initially), use the current monolithic `builder.txt`/`analyst.txt`. When `true`, use the composed domain prompts. This allows A/B testing and safe rollback.

### Phase 5: Tracing & Observability

Add tracing to see which domain modules are being injected:

```typescript
Tracer.active?.logSpan({
  name: "domain-prompt-composition",
  startTime,
  endTime: Date.now(),
  input: { agent: agent.name, detectedTags: tags },
  output: {
    domainsIncluded: [...seen],
    fallbackUsed: domains.length === 0,
    totalLines: result.split("\n").length,
  },
})
```

This lets us monitor:
- What environments users are working in (tag distribution)
- Whether fallback is firing too often (fingerprint gaps)
- Prompt size reduction metrics

---

## Testing Strategy

### Unit Tests

1. **Tag resolution tests** — given specific file/connection/env combinations, verify correct tags
2. **Composition tests** — given specific tag sets, verify correct domain modules are included
3. **Alias normalization tests** — `postgresql` -> `postgres`, `mongo` -> `mongodb`, etc.
4. **Implication tests** — `dbt` implies `sql`, `mongodb` does NOT imply `sql`
5. **Fallback tests** — no tags detected -> includes sql + dbt defaults
6. **Config override tests** — explicit `domains` config overrides all auto-detection

### Integration Tests

1. **dbt + Snowflake project** — verify dbt.txt + sql.txt + snowflake.txt are included, mongodb.txt is not
2. **MongoDB-only project** — verify mongodb.txt is included, dbt.txt and sql.txt are not
3. **Empty project** — verify fallback behavior (sql + dbt defaults)
4. **Config override** — verify `"domains": ["mongodb"]` produces only mongodb.txt

### Smoke Tests

1. Run altimate-code in a dbt project — verify builder behavior is unchanged
2. Run altimate-code in a directory with only `connections.json` pointing to MongoDB — verify MongoDB-relevant instructions appear

---

## Migration Path

### Backward Compatibility

- Feature-flagged behind `experimental.modular_prompts` (default: `false`)
- When disabled, existing `builder.txt` and `analyst.txt` are used unchanged
- When enabled, the composed prompt produces equivalent output for dbt+Snowflake environments (since those domain modules contain the same content that was extracted from `builder.txt`)
- The fingerprint detection expansion (Phase 1) has no effect on users who don't enable the feature flag

### Deprecation of Monolithic Prompts

Once modular prompts are validated:
1. Flip `modular_prompts` default to `true`
2. Keep `builder.txt` and `analyst.txt` as unused files for one release cycle
3. Remove them in the following release

---

## Open Questions

1. **Should the analyst agent get the same domain modules as the builder?** The analyst has a slimmer prompt today (65 lines vs 200). Some domain content (like dbt verification workflow) doesn't apply in read-only mode. Options:
   - Same domain modules for both agents (simpler, some irrelevant content in analyst)
   - Agent-variant domain modules (e.g., `domain/dbt-builder.txt` vs `domain/dbt-analyst.txt`) — more granular but more files
   - Single domain module with agent-conditional sections marked by comments (parsed at composition time)

2. **Should skills filtering also use domain tags?** Currently skills are filtered by the LLM-based skill selector (`experimental.env_fingerprint_skill_selection`). Domain tags could provide a simpler, deterministic filter: only show dbt skills if `dbt` tag is present.

3. **How do we handle multi-adapter dbt projects?** A dbt project might target Snowflake in production and DuckDB locally. `profiles.yml` might have multiple targets. Should we include domain prompts for all adapters in the profiles, or only the active target?

4. **Domain prompt ordering** — does the order of domain modules in the prompt matter? If so, should more relevant/specific modules come first or last? (Models typically weight later content slightly higher.)

---

## Appendix: Current System Prompt Assembly

For reference, here's how the system prompt is currently assembled:

**File:** `packages/opencode/src/session/prompt.ts:720-729`

```typescript
const system = [
  ...(await SystemPrompt.environment(model)),
  ...(skills ? [skills] : []),
  ...(knowledgeInjection ? [knowledgeInjection] : []),
  ...(await InstructionPrompt.system()),
]
```

**File:** `packages/opencode/src/session/llm.ts:67-80`

```typescript
const system = []
system.push(
  [
    ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
    ...input.system,
    ...(input.user.system ? [input.user.system] : []),
  ]
    .filter((x) => x)
    .join("\n"),
)
```

The agent's `.prompt` field (currently `PROMPT_BUILDER` or `PROMPT_ANALYST`) is the first thing in the system prompt, followed by environment info, skills, knowledge injection, and user instructions. The domain composition would replace the static `.prompt` field with a dynamically composed string.

---

## Appendix: Supported Driver Types

From `packages/opencode/src/altimate/native/connections/registry.ts:115-131`:

```typescript
const DRIVER_MAP: Record<string, string> = {
  postgres:    "@altimateai/drivers/postgres",
  postgresql:  "@altimateai/drivers/postgres",
  redshift:    "@altimateai/drivers/redshift",
  snowflake:   "@altimateai/drivers/snowflake",
  bigquery:    "@altimateai/drivers/bigquery",
  mysql:       "@altimateai/drivers/mysql",
  mariadb:     "@altimateai/drivers/mysql",
  sqlserver:   "@altimateai/drivers/sqlserver",
  mssql:       "@altimateai/drivers/sqlserver",
  databricks:  "@altimateai/drivers/databricks",
  duckdb:      "@altimateai/drivers/duckdb",
  oracle:      "@altimateai/drivers/oracle",
  sqlite:      "@altimateai/drivers/sqlite",
  mongodb:     "@altimateai/drivers/mongodb",
  mongo:       "@altimateai/drivers/mongodb",
}
```

11 unique database types. Each is a candidate for a domain prompt module (though many will share `sql.txt` as their primary module until platform-specific content is developed).
