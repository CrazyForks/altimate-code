# Altimate-Code UX Evaluation Report

**Date:** 2026-03-15
**Method:** 10-dimension parallel simulation via codebase analysis
**Overall Score: 6.9/10**

## Scorecard

| # | Dimension | Score | Verdict |
|---|-----------|-------|---------|
| 1 | Onboarding & First Run | **6.3** | Powerful but unfriendly to first-timers |
| 2 | Tool & Skill Discovery | **7.0** | 83+ tools, great naming, weak CLI discovery |
| 3 | Error Handling | **5.5** | Generic catch-all everywhere, no actionable guidance |
| 4 | Configuration & Settings | **7.0** | Flexible 7-level hierarchy, no setup wizard |
| 5 | Core SQL/dbt Workflows | **7.2** | Strong analysis pipeline, plain ASCII output |
| 6 | TUI & Visual UX | **7.5** | Polished Solid.js TUI, 34 themes, rich keybindings |
| 7 | Documentation | **7.2** | Good MkDocs site, missing warehouse-specific guides |
| 8 | Testing & Reliability | **6.5** | Critical gaps: 0 tests for connectors, finops, dbt |
| 9 | Memory & Sessions | **7.2** | Solid persistence, no session resume or CLI commands |
| 10 | Security & Secrets | **7.2** | Keyring integration strong, error masking weak |

---

## Things We Do Well

### 1. Agent Prompt Design (Best-in-class)

The agent prompts (builder, analyst, validator, executive) are exceptionally well-crafted. The builder's mandatory pre-execution protocol (analyze -> validate -> execute), the analyst's cost-conscious exploration rules, and the executive's hard ban on SQL jargon show real product thinking. These aren't generic "be helpful" prompts -- they encode domain expertise.

### 2. Pre-Execution SQL Validation Pipeline

Every query goes through anti-pattern analysis before execution. HIGH severity issues block execution entirely. This is a genuine cost-saving feature for cloud warehouses -- most competitors don't do this.

### 3. Secure Credential Storage

OS keyring integration with graceful JSON fallback, sensitive fields separated from config files, auth files written with `0o600` permissions. The credential architecture is production-grade.

### 4. 34 Built-in Themes + Custom Altimate Theme

The TUI investment is serious -- 34 themes including Dracula, Catppuccin, Nord, Tokyo Night, plus a custom Altimate theme with peach/orange primary colors. Professional visual identity.

### 5. PII Detection (50+ patterns)

Schema-level PII scanning with 50+ regex patterns, smart false-positive filtering (ignores `_count`, `_flag` suffixes), confidence scoring, and category aggregation. This is a differentiating feature.

### 6. Session Forking & Timeline

Users can fork conversations from any message, creating branching session trees. This is unique among CLI AI tools and enables powerful exploratory workflows.

### 7. Comprehensive Tool Coverage

83+ custom tools spanning SQL, schema, warehouse, dbt, finops, and memory -- all with consistent `category_action` naming (e.g., `sql_analyze`, `schema_inspect`, `finops_expensive_queries`). Naming is intuitive and consistent.

### 8. Warehouse Auto-Discovery

The `/discover` command scans Docker containers, dbt profiles, and environment variables to auto-detect warehouse connections. Smart onboarding feature.

### 9. Memory System with Auditing

Cross-session memory with TTL support, citation tracking, tag-based organization, and audit logging. Blocks are auto-injected into new sessions within an 8KB budget.

### 10. Prompt Enhancement

Research-backed prompt enhancement (based on AutoPrompter paper) that adds specifics, action plans, scope, and verification steps. Cost-optimized to use the small model.

---

## Major Experience Gaps

### P0: Critical -- Blocking new user adoption

#### 1. No Setup Wizard / First-Run Onboarding

**Impact:** Users install, run `altimate`, and hit a wall. No interactive guide to configure a provider, add a warehouse, or understand agent modes. The `/discover` command exists but requires an LLM key first (chicken-and-egg).

**Fix:** Add `altimate init` that walks through: (1) select LLM provider, (2) add API key, (3) detect warehouses, (4) run schema index. Show this automatically on first run.

#### 2. Error Messages Are Generic Everywhere

**Impact:** Every tool uses the same pattern: `"Failed to X: ${msg}"`. No distinction between parse errors, auth failures, timeouts, or missing dependencies. Users can't self-diagnose.

**Examples:**

- `"Failed to analyze SQL: ${msg}"` -- Is this a parse error or missing schema?
- `"Failed to add warehouse"` -- Wrong password? Unreachable host? Missing driver?
- `"Python bridge failed after max restarts"` -- What broke? How to fix?

**Fix:** Categorize errors (validation, auth, timeout, bridge) with specific recovery guidance. Add `--verbose` flag for stack traces.

#### 3. Zero Test Coverage on Critical Paths

**Impact:** Warehouse connectors (10 modules, 2000+ LOC), finops (5 modules, 1300 LOC), and dbt integration (4 modules, 600 LOC) have zero unit tests. Production bugs are discovered only via the Spider 2.0 benchmark or user reports.

**Fix:** Week 1: connector + finops unit tests with fixtures. Week 2: dbt tests extracted from benchmark. Add coverage enforcement to CI.

### P1: High -- Degrading daily experience

#### 4. Plain ASCII Output with No Formatting

**Impact:** Query results, SQL analysis, and dbt output are all plain text -- no colors, no syntax highlighting, no smart column formatting. NULL values, dates, and large numbers are all `String(v)`. Long results have no pagination.

**Fix:** ANSI colors for SQL keywords, type-aware column formatting, pager for long output, export to CSV/JSON.

#### 5. No Warehouse Context Switching

**Impact:** Users must pass `warehouse: "name"` to every tool call. No "default warehouse" concept. Multi-project work is painful. Cross-warehouse lineage doesn't exist.

**Fix:** Add `warehouse set <name>`, store in workspace config, auto-detect from dbt project.

#### 6. No CLI Tool Discovery

**Impact:** 83+ tools exist but there's no `altimate tools list` command, no tool browser in the TUI, and no `/tools` command. Users must read external docs to discover what's available.

**Fix:** Add `altimate tools list [--category sql|dbt|finops]` and a TUI tool browser panel.

#### 7. No Session Resume or Message History

**Impact:** Past sessions are write-only -- users can list and delete but can't view messages, resume conversations, or export transcripts. Session search only matches titles, not content.

**Fix:** Add `session resume <id>`, `session view <id>`, `session export <id>`, and full-text search.

#### 8. Token/Cost Visibility Missing

**Impact:** No token usage display, no cost tracking, no budget warnings in the TUI. The analyst prompt says "keep a mental running total" -- that's not a product feature.

**Fix:** Add token counter and estimated cost in the TUI header/footer.

### P2: Medium -- Polish and hardening

#### 9. dbt Output is Raw and Verbose

Users see raw `dbt run` stdout including manifest hashes and timing info. No summary ("3 models created, 2 tests passed, 1 failed"). The `--json` flag isn't leveraged.

#### 10. Schema Search Requires Manual Pre-indexing

`schema_search` fails if user hasn't run `schema_index` first, with a vague error. Should auto-trigger or surface clear guidance.

#### 11. Secrets Exposed in Error Messages

Exception details can leak connection strings, SQL with embedded credentials, and stack traces when `ALTIMATE_ENGINE_DEBUG` is set. No masking utility exists.

#### 12. No TypeScript Strict Mode or Type Checking in CI

`noUncheckedIndexedAccess: false`, no `strict: true`, no `tsc --noEmit` in CI. Type errors can ship to production undetected.

#### 13. Per-Warehouse Setup Guides Missing from Docs

The docs site is comprehensive (7.2/10) but has no step-by-step guides for Snowflake key-pair auth, BigQuery service accounts, or Databricks token setup -- the exact things new users need.

#### 14. MCP Server Failures Are Silent

When optional MCP servers fail to initialize, they're silently skipped. Users don't know tools are missing until they try to use them.

#### 15. Config File Permissions Not Enforced

`opencode.json` files are written with default permissions (not `0o600`). Auth files are secured, but config files with `{env:API_KEY}` references are exposed.

---

## Quick Wins (< 1 day each)

| Fix | Impact | Effort |
|-----|--------|--------|
| Add `altimate tools list` CLI command | Tool discovery | 2-4 hours |
| Parse dbt JSON output into summary | dbt UX | 3-4 hours |
| Add `--verbose` flag for stack traces | Debugging | 2-3 hours |
| Pre-flight API key validation | Error clarity | 1-2 hours |
| Add token counter to TUI header | Cost awareness | 3-4 hours |
| Auto-trigger `schema_index` on first search | Schema UX | 1-2 hours |
| Enable TypeScript strict mode | Reliability | 2-3 hours |
| Surface MCP failures in session header | Transparency | 2-3 hours |

---

## Strategic Recommendations

1. **Invest in the first 5 minutes**: Onboarding is 6.3/10. The product is powerful but punishes new users. An `altimate init` wizard would be the single highest-ROI investment.

2. **Output is the product**: Users spend 80% of their time reading output. Plain ASCII tables are not acceptable when competitors have syntax highlighting and smart formatting. This is the area where polish = retention.

3. **Test the money paths**: Connectors, finops, and dbt have zero tests. These are the features that differentiate you from generic coding assistants. Test them first.

4. **Error messages are your second UI**: Every generic "Failed to X" message is a user dropping off. Invest in categorized, actionable errors with recovery paths.

5. **The agent prompts are your moat**: The builder/analyst/validator/executive system is genuinely differentiated. Double down on prompt quality, add enforcement gates for self-review checklists, and build automated cost thresholds.

---

## Detailed Dimension Reports

### 1. Onboarding & First Run (6.3/10)

**Installation (7/10):** Multiple methods (npm, Homebrew, curl), smart binary detection with platform/arch variants, AVX2 detection for optimized binaries. Postinstall welcome box is a nice touch but suppressed by npm v7+.

**First Run (6/10):** Database migration shows progress bar (good). No setup wizard, no default agent guidance, no "what to do next" prompt. Users must know to run `altimate providers` to add API keys.

**Configuration (5/10):** Manual provider setup required. No auto-discovery of existing credentials from env vars. Config file format not explained in CLI help. Error when provider missing is a generic HTTP 500.

**Warehouse Setup (7/10):** `/discover` is powerful (Docker scanning, dbt profiles, env vars) but requires LLM key first. No fallback for local-only warehouse setup.

**Key files:** `bin/altimate`, `src/index.ts`, `src/cli/welcome.ts`, `src/cli/cmd/providers.ts`

### 2. Tool & Skill Discovery (7.0/10)

**Inventory (10/10):** 83+ custom tools organized by category: SQL (10), Schema (8), Warehouse (5), dbt (4), FinOps (7), altimate-core (29), Memory (5).

**Naming (9/10):** Excellent consistency with `category_action` pattern. Intuitive verbs (analyze, optimize, translate, inspect, search).

**CLI Discovery (3/10):** No `--list-tools` command, no tool browser in TUI, no `/tools` slash command. Users must read external docs.

**Documentation (9/10):** Comprehensive external docs with 8 markdown files organized by category, covering 55+ tools with examples.

**Key files:** `src/tool/registry.ts`, `src/altimate/tools/*.ts`, `docs/docs/data-engineering/tools/`

### 3. Error Handling (5.5/10)

**Bridge (6/10):** Python bridge has restart logic (MAX_RESTARTS=2, 30s timeout) but stderr messages don't bubble to users. "Failed after max restarts" gives no context on which phase failed (uv download, venv, pip install).

**Warehouse (4/10):** No connection testing before operations, no retry mechanism, no distinction between transient vs permanent errors. Generic "Unknown error" fallback.

**Provider (6/10):** Sophisticated API error parsing (context overflow detection, gateway/proxy detection) but no pre-flight API key validation. Missing vs expired vs revoked keys all look the same.

**Tools (4/10):** Every tool follows identical catch-all pattern. No error categorization, weak guidance ("Ensure dbt-core is installed" -- how?).

**Graceful Degradation (3/10):** MCP failures silently skipped. No user notification that tools are missing.

**Key files:** `src/altimate/bridge/client.ts`, `src/provider/error.ts`, `src/mcp/index.ts`

### 4. Configuration & Settings (7.0/10)

**Hierarchy (8/10):** 7-level config precedence (remote org -> global -> custom -> project -> directory -> inline -> managed). Well-designed for enterprise.

**Secrets (8/10):** OS keyring for sensitive fields, `{env:...}` and `{file:...}` substitution patterns, dual naming support (.opencode + .altimate-code).

**Warehouse Setup (7/10):** 10 warehouses supported, SSH tunneling, dbt profile discovery. But no interactive wizard.

**Validation (5/10):** Zod schema validation catches issues but error messages don't suggest fixes. "Unsupported connector type" doesn't list supported types.

**Key files:** `src/config/config.ts`, `src/config/paths.ts`, `altimate_engine/credential_store.py`, `altimate_engine/connections.py`

### 5. Core SQL/dbt Workflows (7.2/10)

**SQL Analysis (7.5/10):** 19 anti-pattern rules with confidence scoring. Pre-execution protocol is mandatory in builder agent. But result formatting is minimal ASCII.

**dbt (7.8/10):** Comprehensive verification loop (compile -> analyze -> lineage -> tests). Manifest parsing, selector support, skill integration. But raw stdout output, no summary parsing.

**Query Execution (6.8/10):** 10 warehouses, graceful errors, LIMIT enforcement. But no timeout control, no cost estimation, no connection pooling.

**Schema Exploration (7.2/10):** Three-tier discovery (list -> inspect -> search). Schema indexing enables fast search. But requires manual pre-indexing, no visualization, PII detection separate.

**Multi-Warehouse (5.9/10):** Named connections work but no default warehouse, no context switching, no cross-warehouse lineage.

**Key files:** `src/altimate/tools/sql-*.ts`, `src/altimate/tools/dbt-*.ts`, `src/altimate/prompts/*.txt`, `altimate_engine/sql/executor.py`

### 6. TUI & Visual UX (7.5/10)

**Components (8/10):** 23 dialog components, fuzzy search in selects, Solid.js reactive patterns with proper memoization.

**Branding (8/10):** Custom ASCII logo with 3D shadow rendering, dynamic terminal titles, dedicated color palette.

**Input (8/10):** Multi-line (Shift+Enter), frecency-based suggestions, file attachment with @, drag-and-drop images, shell mode with ! prefix, stash system.

**Sessions (8/10):** Grouped by date, live status indicators, timeline forking, double-confirm on delete.

**Responsive (8/10):** Intelligent sidebar at 120+ chars, auto-hide on narrow terminals, dynamic dialog sizing.

**Missing:** Token/cost display, progress bars for long operations, full-text session search, interactive tutorial.

**Key files:** `src/cli/cmd/tui/`, `src/cli/logo.ts`, themes in `src/cli/cmd/tui/theme/`

### 7. Documentation (7.2/10)

**Framework (9/10):** MkDocs Material with dark/light mode, search, syntax highlighting. Professional setup.

**Tool Docs (9/10):** 55+ tools documented across 8 category files with examples and parameter descriptions.

**Getting Started (8/10):** Clear installation, config examples for 7+ warehouses, `/discover` walkthrough.

**Gaps:** No per-warehouse setup guides (Snowflake key-pair, BigQuery service account), no API reference, no architecture docs, no runnable example projects, no video tutorials. SDK docs only 45 lines. Changelog not linked in mkdocs.yml.

**Key files:** `docs/mkdocs.yml`, `docs/docs/getting-started.md`, `docs/docs/data-engineering/tools/`

### 8. Testing & Reliability (6.5/10)

**Coverage:** ~33% TypeScript (284 test files / 417 source), ~52% Python (23 test modules / 44 source). Bridge and file ops well-tested.

**Critical Gaps:** 0 tests for: warehouse connectors (10 modules), finops (5 modules), dbt integration (4 modules), server RPC dispatch (1031 LOC).

**CI (8/10):** Good workflow structure (TS tests, Python tests across 3.10-3.12, ruff linting, marker guard). But no TypeScript type checking, no coverage reporting.

**Type Safety (6/10):** `noUncheckedIndexedAccess: false`, no strict mode. Python typing moderate.

**Key files:** `packages/opencode/test/`, `packages/altimate-engine/tests/`, `.github/workflows/ci.yml`

### 9. Memory & Sessions (7.2/10)

**Memory (8/10):** YAML-frontmatter markdown files, two-tier scoping (global/project), TTL support, citations, tags, audit logging. 5 agent-facing tools. Auto-injection within 8KB budget.

**Sessions (5.5/10):** Can list and delete. Missing: resume, message history, content search, export, session metadata (agent used, tool count).

**Context (7/10):** Smart compaction with overflow detection, observation masks for pruned output. But no context budget visibility, no proactive pruning.

**Prompt Enhancement (7/10):** 5 enhancement categories, 15s timeout, small model optimization. But opt-in only.

**Key files:** `src/memory/`, `src/session/`, `src/altimate/enhance-prompt.ts`

### 10. Security & Secrets (7.2/10)

**Credentials (8/10):** OS keyring with fallback, sensitive fields separated from config, auth at 0o600. But keyring fallback is silent, connection strings not parsed for embedded credentials.

**API Keys (6/10):** Env var support, OAuth flow. But no masking in logs/errors, no rotation support, no format validation.

**Output (5/10):** Exception details exposed with `ALTIMATE_ENGINE_DEBUG`. Query text returned unsanitized from history. Connection strings in error messages.

**PII (8/10):** 50+ patterns, smart filtering, confidence scoring. Detection only -- no automatic masking.

**Dependencies (6/10):** No `npm audit` or `pip audit` in CI, no Dependabot.

**Key files:** `altimate_engine/credential_store.py`, `src/auth/service.ts`, `altimate_engine/schema/pii_detector.py`
