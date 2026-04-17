# Altimate Code — Extension Ecosystem Plan

> **Purpose:** Enable anyone — vendors, solution architects, team leads, individual engineers — to extend Altimate Code with packs that bundle skills, MCP servers, and instructions.
>
> **Date:** 2026-03-28 | **Status:** Validated through 5 scenario simulations (12 personas)
>
> **Key rename:** "Recipe" → "Pack" (differentiation from Goose, clearer mental model)

### Simulation Results (2026-03-28)
| Scenario | Score | Key Finding |
|----------|-------|-------------|
| Snowflake (Large Enterprise) | 5/10 | Demo-ready core, 5 deal blockers |
| Dagster (Growth Startup) | 6/10 | Would partner conditionally |
| Fortune 500 Bank (Enterprise) | 3/10 | Missing enforcement, use AGENTS.md today |
| Solo Consultant (SA) | 5/10 | Best natural fit, needs `pack switch` + cleanup |
| Series A Self-Serve | 3/10 | Nobody discovers pack without being told |

**Universal finding:** Authoring experience is good. Single-developer workflow works. Discovery and multi-person story are broken. Auto-detect on startup is the #1 priority.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Industry Landscape — How Others Do It](#2-industry-landscape)
3. [Our Extensibility Architecture](#3-our-extensibility-architecture)
4. [The Three-Layer Partner Model](#4-the-three-layer-partner-model)
5. [Layer 1: Agent Skills (SKILL.md)](#5-layer-1-agent-skills)
6. [Layer 2: MCP Servers](#6-layer-2-mcp-servers)
7. [Layer 3: Plugins (Deep Integration)](#7-layer-3-plugins)
8. [Packs: The Distribution Unit](#8-packs-the-distribution-unit)
9. [data-engineering-skills: The Open-Source Foundation](#9-data-engineering-skills-the-open-source-foundation)
10. [Onboarding Playbook](#10-onboarding-playbook)
11. [What We Need to Build](#11-what-we-need-to-build)
12. [Competitive Positioning](#12-competitive-positioning)
13. [Appendix: Research Sources](#13-appendix)

---

## 1. Executive Summary

The data engineering agent space is converging on **three complementary extension layers**:

| Layer | What It Does | Portability | Effort to Build | Example |
|-------|-------------|-------------|-----------------|---------|
| **Agent Skills** | Teaches the AI *how to think* about tasks | Universal (30+ products) | Low (markdown) | "How to debug a dbt model" |
| **MCP Servers** | Gives the AI *tools to execute* tasks | Universal (any MCP client) | Medium (code) | `dbt build`, `dagster materialize` |
| **Plugins** | Deep platform integration (auth, UI, hooks) | Altimate-specific | High (TypeScript) | Custom auth flow, tool interception |

**Our strategy:** Make Altimate Code the best host for data engineering extensions by providing all three layers, with `AltimateAI/data-engineering-skills` as the open-source foundation that any vendor can contribute to.

**Why partners should care:**
- Skills authored once work across Claude Code, Cursor, VS Code Copilot, Gemini CLI, OpenCode, and 25+ other agents (via the [agentskills.io](https://agentskills.io) open standard)
- MCP servers work across Goose, Claude Desktop, Continue.dev, Cline, and every MCP-compatible client
- Partners get distribution to every data engineer using AI coding agents, not just Altimate Code users

---

## 2. Industry Landscape

### 2.1 How Goose (Block) Does It

Goose made the boldest architectural decision: **Extensions ARE MCP servers.** No proprietary format.

**Key patterns worth adopting:**

| Pattern | How Goose Does It | Our Equivalent |
|---------|-------------------|----------------|
| Extension = MCP server | Any MCP server is auto-discovered | We support this via `config.mcp` |
| **Recipes** | YAML bundles: extensions + prompts + settings + parameters | **Packs** (PACK.yaml) — our equivalent |
| Deep links | `goose://extension?cmd=...` one-click install | Not yet |
| Extension directory | Curated browse page (70+ servers) | Not yet |
| Custom distros | Full white-label with bundled extensions | Possible via our config system |
| Subagent composition | Recipes spawn parallel sub-agents | We have agents but no pack system yet |
| Malware scanning | Auto-scan before extension activation | Not yet |

**Goose's real partner integrations:**
- **DataHub + Block:** DataHub MCP server for metadata intelligence
- **OpenMetadata:** Published a Goose Recipe (not just extension)
- **Dagster:** Ships `dagster-mcp` that works with any MCP client including Goose
- **Docker:** Containerized extension execution

**Goose's gaps (our opportunity):**
- No formal partner program or certification
- No marketplace economics (no paid extensions)
- No extension quality metrics or ratings
- No automated testing framework for extensions
- Extension discovery relies on external directories

### 2.2 How OpenCode Upstream Does It

OpenCode (our upstream fork) has a mature plugin system with 50+ community plugins:

**Plugin hooks (20+ interception points):**
```
auth, event, config, chat.message, chat.params, chat.headers,
permission.ask, command.execute.before, tool.execute.before,
tool.execute.after, tool.definition, shell.env,
experimental.chat.system.transform, experimental.session.compacting
```

**Plugin distribution:** npm packages (prefix `opencode-`) or local files in `.opencode/plugins/`

**Skill loading hierarchy (8 sources):**
1. Built-in (embedded at build time)
2. Filesystem builtin (`~/.altimate/builtin/`)
3. External directories (`.claude/skills/`, `.agents/skills/`)
4. Global home-directory skills
5. Project-level skills (walked up directory tree)
6. `.opencode/skill/` directories
7. Config `skills.paths` (additional directories)
8. Config `skills.urls` (remote — fetches `index.json` then downloads files)

**Key insight:** We already inherit all of this. The question is what we build ON TOP of it.

### 2.3 Industry-Wide Convergence

| Product | Skills | MCP | Plugins | Marketplace |
|---------|--------|-----|---------|-------------|
| Claude Code | SKILL.md | Yes | Yes (.claude-plugin) | Yes (official) |
| Goose | No | Yes (primary) | No (MCP only) | Browse page |
| Continue.dev | Rules | Yes (primary) | Config-based | Continue Hub |
| Cline | SKILL.md | Yes | VS Code ext | VS Code marketplace |
| Cursor | Rules | Yes | No | No |
| Codex CLI | SKILL.md | Planned | No | No |
| Gemini CLI | SKILL.md | Yes | No | No |
| **Altimate Code** | SKILL.md | Yes | Yes (hooks) | **Not yet** |

**The market signal is clear:** MCP for tools, Skills for knowledge, Plugins for deep integration. All three matter.

### 2.4 Data Vendor MCP Servers (Already Shipping)

| Vendor | MCP Server | Tools | Maturity |
|--------|-----------|-------|----------|
| **dbt** | `dbt-mcp` | 58 tools (SQL, Semantic Layer, Discovery, Admin, CLI, codegen, docs) | Production |
| **Dagster** | `dg[mcp]` | CLI wrapper, scaffold, YAML config, code quality | Production |
| **Airbyte** | 3 servers: PyAirbyte MCP, Knowledge MCP, Connector Builder MCP | Pipeline generation, docs search, 600+ connectors | Production |
| **Snowflake** | Cortex MCP | Query, schema, governance | Beta |
| **DataHub** | DataHub MCP | Metadata, lineage, governance | Production |
| **OpenMetadata** | OpenMetadata MCP | Governance, quality, profiling | Production |

**Critical realization:** These vendors already ship MCP servers. Our job is to make Altimate Code the BEST host for these servers by adding data-engineering-specific skills on top.

---

## 3. Our Extensibility Architecture

### 3.1 What We Already Have

```
┌─────────────────────────────────────────────────────────┐
│                    Altimate Code                         │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  Skills   │  │   MCP    │  │ Plugins  │  │  Tools  │ │
│  │ (SKILL.md)│  │ Servers  │  │ (Hooks)  │  │ (Zod)   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │              │              │              │      │
│  ┌────┴──────────────┴──────────────┴──────────────┴───┐ │
│  │              Agent Runtime (LLM Loop)                │ │
│  └─────────────────────┬───────────────────────────────┘ │
│                        │                                  │
│  ┌─────────────────────┴───────────────────────────────┐ │
│  │     SDK (@altimate/cli-sdk) — REST API + Types      │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Current extension points:**

| Extension Point | Location | Partner Access | Gap |
|----------------|----------|---------------|-----|
| Skills (SKILL.md) | `packages/opencode/src/skill/` | Git repos, URLs, local dirs | No registry, no versioning |
| MCP Servers | `packages/opencode/src/mcp/` | Config YAML, auto-discovery | No bundled data-eng servers |
| Plugins (npm) | `packages/plugin/` | npm packages, local files | No marketplace |
| Tools (Zod) | `packages/opencode/src/tool/` | Config dirs, plugins | No external tool packaging |
| Providers | `packages/opencode/src/provider/` | Config, custom loaders | No plugin-based registration |
| SDK | `packages/sdk/js/` | REST API, OpenAPI types | No WebSocket, subprocess only |

### 3.2 Config-Level Extension

Partners can configure extensions via `opencode.jsonc` or `.altimate-code/`:

```jsonc
{
  // Skills from partner repos
  "skills": {
    "paths": ["./vendor-skills/dagster/"],
    "urls": ["https://raw.githubusercontent.com/DagsterHQ/dagster-skills/main/"]
  },

  // Partner MCP servers
  "mcp": {
    "dagster": {
      "type": "stdio",
      "command": ["uvx", "dg", "mcp", "serve"],
      "env": { "DAGSTER_HOME": "/path/to/dagster" }
    },
    "dbt": {
      "type": "stdio",
      "command": ["uvx", "dbt-mcp"],
      "env": { "DBT_PROJECT_DIR": "./", "DBT_PROFILES_DIR": "~/.dbt" }
    }
  },

  // Partner plugins
  "plugin": ["@dagster/altimate-plugin@latest"]
}
```

---

## 4. The Three-Layer Partner Model

We propose a **progressive complexity** model where partners choose their integration depth:

```
                    Effort ──────────────────────►

  ┌─────────────────────────────────────────────────────┐
  │                                                      │
  │   Layer 1          Layer 2          Layer 3          │
  │   ────────         ────────         ────────         │
  │                                                      │
  │   SKILL.md    ──►  MCP Server  ──►  Plugin           │
  │   (Markdown)       (Python/TS)      (TypeScript)     │
  │                                                      │
  │   Teaches HOW      Provides TOOLS   Deep platform    │
  │   to approach      to execute       integration      │
  │   tasks            tasks            (auth, UI, hooks)│
  │                                                      │
  │   ~1 day           ~1 week          ~2-4 weeks       │
  │                                                      │
  │   Works in 30+     Works in any     Altimate-specific│
  │   AI agents        MCP client       but most powerful│
  │                                                      │
  └─────────────────────────────────────────────────────┘
```

Most partners start at Layer 1, add Layer 2 if they have an API/CLI, and only reach Layer 3 for deep integrations.

---

## 5. Layer 1: Agent Skills (SKILL.md)

### 5.1 Why Skills Matter

Skills are the **highest-leverage, lowest-effort** extension point. They encode expert knowledge about how to use a vendor's tool.

**Without a skill:** "Hey Claude, create a Dagster asset" → generic, possibly wrong output
**With a skill:** "Hey Claude, create a Dagster asset" → follows Dagster's opinionated patterns, uses `dg` CLI, validates with type checking

### 5.2 Skill Authoring Guide for Partners

**File structure:**
```
dagster-skills/
├── skills/
│   ├── dagster/
│   │   ├── creating-dagster-assets/
│   │   │   └── SKILL.md
│   │   ├── debugging-dagster-runs/
│   │   │   └── SKILL.md
│   │   ├── scheduling-dagster-jobs/
│   │   │   └── SKILL.md
│   │   └── testing-dagster-assets/
│   │       └── SKILL.md
│   └── index.json          # For remote discovery
├── .claude-plugin/
│   └── marketplace.json    # For Claude Code marketplace
├── CONTRIBUTING.md
└── README.md
```

**SKILL.md format:**
```yaml
---
name: creating-dagster-assets
description: |
  Creates Dagster assets following project conventions. Use when:
  (1) Creating new software-defined assets
  (2) Task mentions "create", "build", "add" a Dagster asset
  (3) Working with Dagster's asset-based orchestration
---

# Creating Dagster Assets

**Read project structure before writing. Validate after creation.**

## Critical Rules
1. ALWAYS use `@asset` decorator, never raw `@op` for new work
2. ALWAYS define `AssetSpec` with proper metadata
3. ALWAYS add asset checks for data quality
4. Use `dg` CLI for scaffolding when available

## Workflow
1. **Explore** — Read existing assets in the project for conventions
2. **Scaffold** — Use `dg scaffold asset` if `dg` CLI available
3. **Implement** — Write the asset following project patterns
4. **Test** — Run `dagster asset materialize` to verify
5. **Validate** — Check asset appears in Dagster UI lineage graph

## Anti-Patterns
- Do NOT use `@op` + `@job` for new data assets (legacy pattern)
- Do NOT hardcode partition definitions (use config)
- Do NOT skip `@asset_check` for critical data assets
```

**`index.json` format (for remote discovery via `skills.urls`):**
```json
{
  "skills": [
    {
      "name": "creating-dagster-assets",
      "description": "Creates Dagster assets following best practices",
      "files": [
        "skills/dagster/creating-dagster-assets/SKILL.md"
      ]
    }
  ]
}
```

**`marketplace.json` format (for Claude Code plugin marketplace):**
```json
{
  "name": "dagster-skills",
  "owner": { "name": "Dagster Labs", "email": "oss@dagster.io" },
  "metadata": {
    "description": "Expert skills for Dagster asset orchestration",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "dagster-core-skills",
      "description": "Core Dagster development skills",
      "source": "./",
      "skills": [
        "./skills/dagster/creating-dagster-assets",
        "./skills/dagster/debugging-dagster-runs",
        "./skills/dagster/scheduling-dagster-jobs",
        "./skills/dagster/testing-dagster-assets"
      ]
    }
  ]
}
```

### 5.3 Skill Quality Checklist

| Criterion | Required | Description |
|-----------|----------|-------------|
| Actionable workflow | Yes | Step-by-step, not reference docs |
| Read-before-write | Yes | Always explore existing patterns first |
| Verification step | Yes | How to confirm the work is correct |
| Anti-patterns section | Recommended | Common mistakes to avoid |
| Tool references | Recommended | Which MCP tools to use if available |
| Benchmark tested | Recommended | Measured improvement on real tasks |

### 5.4 Portability

Skills authored for Altimate Code automatically work in:
- Claude Code (native SKILL.md support)
- Cursor (via rules import)
- VS Code Copilot (via agent skills)
- Gemini CLI (SKILL.md compatible)
- Codex CLI (SKILL.md compatible)
- Any product supporting the [agentskills.io](https://agentskills.io) standard

This is the **key selling point for partners**: write once, distribute everywhere.

---

## 6. Layer 2: MCP Servers

### 6.1 Why MCP Servers

MCP servers give the AI actual tools to call. While skills teach *how to think*, MCP servers provide *ability to act*.

**The combination is powerful:**
- Skill says: "Run `dbt build --select model_name` to verify your changes"
- MCP server provides: the `dbt_build` tool that actually executes it

### 6.2 What Partners Already Have

Most data vendors already ship MCP servers:

**dbt (58 tools):**
```
dbt_build, dbt_run, dbt_test, dbt_compile, dbt_parse,
semantic_layer_query, discovery_api_query, admin_api_*,
code_generate_model, docs_search, ...
```

**Dagster:**
```
dg scaffold, dg asset materialize, dg check,
pipeline status, run logs, sensor management, ...
```

**Airbyte:**
```
create_pipeline, list_connectors, sync_connection,
search_docs, build_connector, ...
```

### 6.3 MCP Server Integration Guide for Partners

**Option A: Partner publishes MCP server, we document the config**

The partner publishes their MCP server to PyPI/npm. We add documentation and a recommended configuration:

```jsonc
// Recommended config for Altimate Code users
{
  "mcp": {
    "dagster": {
      "type": "stdio",
      "command": ["uvx", "dg", "mcp", "serve"],
      "env": {
        "DAGSTER_HOME": "${DAGSTER_HOME}"
      }
    }
  }
}
```

**Option B: Bundle as part of a plugin (recommended for deep integration)**

The partner's plugin includes `.mcp.json` that auto-configures their MCP server:

```json
// .mcp.json inside the plugin package
{
  "mcpServers": {
    "dagster": {
      "type": "stdio",
      "command": ["uvx", "dg", "mcp", "serve"],
      "description": "Dagster asset orchestration"
    }
  }
}
```

**Option C: Altimate Code ships pre-configured connections**

For strategic partners, we bundle MCP server configs that auto-detect the tool:
- Detect `dbt_project.yml` → suggest enabling dbt MCP
- Detect `dagster.yaml` → suggest enabling Dagster MCP
- Detect `airbyte/` directory → suggest enabling Airbyte MCP

### 6.4 MCP Server Quality Requirements

| Criterion | Required | Description |
|-----------|----------|-------------|
| Tool descriptions | Yes | Clear, actionable descriptions for each tool |
| Error messages | Yes | Structured errors the LLM can reason about |
| Timeout handling | Yes | Graceful handling of long-running operations |
| Auth documentation | Yes | Clear setup instructions for API keys/tokens |
| < 20 tools exposed | Recommended | Semantic Kernel research shows LLMs degrade above 20 |
| Tool filtering | Recommended | Support `available_tools` to limit exposed surface |

---

## 7. Layer 3: Plugins (Deep Integration)

### 7.1 When Partners Need Plugins

Plugins are for partners who need to:
- Add custom authentication flows (OAuth with their cloud service)
- Intercept and modify tool execution (add warehouse-specific context)
- Inject system prompts (add vendor-specific instructions)
- Modify chat parameters (adjust for their use case)
- Add custom tools with complex logic

### 7.2 Plugin Interface

```typescript
import type { Plugin, PluginInput, Hooks, ToolDefinition } from "@altimate/cli-plugin"

const dagsterPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const { client, project, directory, $ } = input

  return {
    // Add custom tools
    tool: {
      "dagster.materialize": {
        description: "Materialize a Dagster asset",
        parameters: z.object({
          asset_key: z.string().describe("The asset key to materialize"),
          partition: z.string().optional(),
        }),
        execute: async (args) => {
          const result = await $`dg asset materialize ${args.asset_key}`
          return { title: "Materialized", output: result.stdout, metadata: {} }
        }
      }
    },

    // Custom auth flow
    auth: {
      match: (provider) => provider.id === "dagster-cloud",
      login: async () => { /* OAuth flow */ },
      logout: async () => { /* Cleanup */ },
    },

    // Intercept tool execution
    "tool.execute.before": async (input, output) => {
      // Add Dagster context to SQL tools
      if (input.toolID.startsWith("sql.")) {
        output.args = { ...output.args, context: "dagster-managed" }
      }
    },

    // Inject system prompt
    "experimental.chat.system.transform": async (input, output) => {
      output.system += "\nThis project uses Dagster for orchestration. Prefer asset-based patterns."
    },

    // React to events
    event: async ({ event }) => {
      if (event.type === "session.start") {
        // Detect Dagster project and auto-configure
      }
    }
  }
}

export default dagsterPlugin
```

### 7.3 Available Hook Points

| Hook | When It Fires | Partner Use Case |
|------|--------------|-----------------|
| `auth` | Authentication needed | OAuth with vendor cloud |
| `event` | Any system event | Project detection, telemetry |
| `config` | Config loaded | Inject vendor-specific defaults |
| `chat.message` | Message received | Message preprocessing |
| `chat.params` | Before LLM call | Adjust temperature, model |
| `chat.headers` | Before LLM call | Add custom headers |
| `permission.ask` | Permission requested | Auto-approve vendor tools |
| `command.execute.before` | Before command runs | Modify command |
| `tool.execute.before` | Before tool runs | Modify tool arguments |
| `tool.execute.after` | After tool runs | Process/enrich output |
| `tool.definition` | Tool registered | Modify tool descriptions |
| `shell.env` | Shell command runs | Inject env vars |
| `experimental.chat.system.transform` | System prompt built | Add vendor context |
| `experimental.session.compacting` | Context compaction | Preserve vendor state |

### 7.4 Plugin Distribution

```bash
# Published to npm
npm publish @dagster/altimate-plugin

# Users install via config
# opencode.jsonc:
{
  "plugin": ["@dagster/altimate-plugin@latest"]
}

# Or via CLI
altimate-code plugin install @dagster/altimate-plugin
```

### 7.5 Plugin Package Structure

```
@dagster/altimate-plugin/
├── package.json
│   {
│     "name": "@dagster/altimate-plugin",
│     "version": "1.0.0",
│     "main": "./dist/index.js",
│     "peerDependencies": {
│       "@altimate/cli-plugin": "^1.2.0"
│     }
│   }
├── src/
│   └── index.ts          # Default export: Plugin function
├── skills/               # Bundled skills (optional)
│   └── dagster/
│       └── creating-assets/SKILL.md
├── .mcp.json             # Bundled MCP config (optional)
└── README.md
```

---

## 8. Packs: The Distribution Unit

### 8.1 The Missing Piece

Goose's most innovative pattern is **Recipes** — YAML files that bundle extensions + prompts + settings into shareable workflows. We should adopt this concept (renamed to **Packs** for differentiation).

**Why packs matter for partners:**
- A Dagster skill alone is useful. A Dagster skill + Dagster MCP server + curated prompt + recommended settings = a **complete workflow**.
- Packs are the unit of distribution that partners can share with their community.

### 8.2 Proposed Pack Format

```yaml
# dagster-asset-development/PACK.yaml
name: dagster-asset-development
version: "1.0"
description: "Complete workflow for building Dagster assets with AI assistance"

# Skills to activate
skills:
  - source: "github:DagsterHQ/dagster-skills"
    select: ["creating-dagster-assets", "testing-dagster-assets"]

# MCP servers to enable
mcp:
  dagster:
    type: stdio
    command: ["uvx", "dg", "mcp", "serve"]
    env_keys: ["DAGSTER_HOME"]

# Plugin to install (optional)
plugins:
  - "@dagster/altimate-plugin@^1.0"

# System instructions added to every conversation
instructions: |
  This project uses Dagster for data orchestration.
  Always prefer asset-based patterns over op/job patterns.
  Use the `dg` CLI for scaffolding and validation.

# Parameters the user must provide
parameters:
  - key: dagster_home
    description: "Path to your Dagster project"
    required: true
    env: DAGSTER_HOME

# Recommended settings
settings:
  tools:
    dagster.materialize: true
    dagster.check: true
```

### 8.3 Pack Installation

```bash
# From URL
altimate-code pack install https://dagster.io/packs/asset-development

# From GitHub
altimate-code pack install DagsterHQ/dagster-packs/asset-development

# One-liner deep link (for docs/blog posts)
altimate-code://pack?url=https://dagster.io/packs/asset-development
```

### 8.4 Pack as the Partner Onboarding Unit

When a partner says "I want my tool to work with Altimate Code," the deliverable is a pack:
1. Partner writes skills (Layer 1) — 1 day
2. Partner already has MCP server (Layer 2) — 0 days (usually exists)
3. Partner bundles into pack — 1 hour
4. Pack goes into their docs: "Use Dagster with AI → install this pack"

---

## 9. data-engineering-skills: The Open-Source Foundation

### 9.1 Current State

**Repo:** [AltimateAI/data-engineering-skills](https://github.com/AltimateAI/data-engineering-skills) (73 stars, MIT licensed)

**Current skills (10):**
| Vendor | Skills | Benchmark Impact |
|--------|--------|-----------------|
| dbt | 7 (create, debug, test, document, migrate, refactor, incremental) | +7% on ADE-bench (46.5% → 53%) |
| Snowflake | 3 (find expensive queries, optimize by ID, optimize by text) | 84% pass on TPC-H 1TB |

**Already uses Claude Code plugin format** (`.claude-plugin/marketplace.json`)

### 9.2 Strategy: Make It the Central Hub

Transform `data-engineering-skills` from "our skills repo" to "the community skills repo for data engineering":

```
data-engineering-skills/
├── skills/
│   ├── dbt/                    # ✅ Exists (7 skills)
│   ├── snowflake/              # ✅ Exists (3 skills)
│   ├── dagster/                # 🆕 Partner-contributed
│   ├── airbyte/                # 🆕 Partner-contributed
│   ├── fivetran/               # 🆕 Partner-contributed
│   ├── airflow/                # 🆕 Community-contributed
│   ├── spark/                  # 🆕 Community-contributed
│   ├── bigquery/               # 🆕 Community-contributed
│   ├── databricks/             # 🆕 Community-contributed
│   └── great-expectations/     # 🆕 Community-contributed
├── packs/                       # 🆕 Bundled packs
│   ├── dagster-development/PACK.yaml
│   ├── dbt-snowflake-pipeline/PACK.yaml
│   └── airbyte-ingestion/PACK.yaml
├── .claude-plugin/
│   └── marketplace.json
├── benchmarks/                 # 🆕 Benchmark results per skill
│   ├── ade-bench/
│   └── spider2-dbt/
├── CONTRIBUTING.md             # Enhanced partner guide
├── PARTNER_GUIDE.md            # 🆕 Detailed partner onboarding
└── README.md
```

### 9.3 Why This Works for Partners

1. **Low barrier:** Partner writes 3-5 SKILL.md files in a PR — no SDK, no build system
2. **Credibility:** Published benchmarks prove skills improve AI performance
3. **Distribution:** Every Altimate Code user gets the skills; Claude Code users can install via marketplace
4. **Cross-promotion:** Partner's name appears in the repo, README, and marketplace listing
5. **Portable:** Skills work across 30+ AI agent products (not locked to Altimate Code)

### 9.4 Partner Contribution Template

```markdown
<!-- PR template for partner skill contributions -->

## Vendor: [Dagster]

### Skills Added
- [ ] `creating-dagster-assets` — Asset creation workflow
- [ ] `debugging-dagster-runs` — Run failure diagnosis
- [ ] `testing-dagster-assets` — Asset testing patterns

### Quality Checklist
- [ ] Each skill has actionable workflow steps (not reference docs)
- [ ] Each skill has a verification step
- [ ] Each skill has an anti-patterns section
- [ ] Skills reference MCP tools where applicable
- [ ] Skills tested with Claude/GPT-4 on real tasks
- [ ] Benchmark results included (if available)

### MCP Server (optional)
- Package: `dg[mcp]`
- Install: `pip install "dg[mcp]"`
- Docs: https://dagster.io/docs/mcp

### Pack (optional)
- [ ] PACK.yaml included in `packs/`
```

---

## 10. Partner Onboarding Playbook

### 10.1 Timeline

```
Week 0 (Kickoff)
├── Partner intro call
├── Share this document + CONTRIBUTING.md
└── Partner identifies 3-5 initial skills

Week 1 (Skills)
├── Partner writes SKILL.md files
├── We review for quality (checklist above)
└── PR merged to data-engineering-skills

Week 2 (MCP — if applicable)
├── Partner confirms their MCP server works with Altimate Code
├── We add recommended config to our docs
└── Test skill + MCP combination

Week 3 (Pack + Launch)
├── Bundle into PACK.yaml
├── Co-authored blog post / announcement
├── Listed in our extension directory
└── Partner adds "Works with Altimate Code" badge to their docs
```

### 10.2 Support We Provide

| Support | Description |
|---------|-------------|
| Skill review | Code review of SKILL.md files for quality |
| MCP testing | Verify their MCP server works in our runtime |
| Benchmark run | Run their skills through ADE-bench or Spider2 |
| Co-marketing | Blog post, social, newsletter mention |
| Badge/logo | "Works with Altimate Code" badge for their docs |
| Direct Slack channel | Shared Slack channel for partner support |

### 10.3 What Partners Deliver

| Deliverable | Required? | Format |
|-------------|-----------|--------|
| 3-5 SKILL.md files | Yes | Markdown (PR to data-engineering-skills) |
| MCP server config | If they have one | JSON snippet for our docs |
| PACK.yaml | Recommended | YAML file |
| Plugin package | Optional | npm package |
| Blog post draft | Recommended | Markdown (co-authored) |

---

## 11. What We Need to Build

### 11.1 Priority 1: Pack System (Weeks 1-3)

The single biggest gap vs. Goose. Packs bundle skills + MCP + plugins + instructions into one installable unit.

**Implementation:**
- PACK.yaml schema and parser
- `altimate-code pack install <source>` CLI command
- Pack auto-detection (suggest pack when project type detected)
- Pack storage in `~/.altimate/packs/`

**Files to modify:**
- New: `packages/opencode/src/pack/` (schema, loader, installer)
- New: `packages/opencode/src/cli/cmd/pack.ts` (CLI command)
- Modify: `packages/opencode/src/config/` (pack config integration)

### 11.2 Priority 2: Extension Directory (Weeks 2-4)

A browseable catalog of skills, MCP servers, and packs.

**Options:**
- **Minimal:** Curated page on docs site (like Goose's browse page)
- **Medium:** GitHub-based registry (index.json in a repo, auto-generated site)
- **Full:** API-backed marketplace with search, ratings, install counts

**Recommendation:** Start with a GitHub-based registry. The `data-engineering-skills` repo already has `index.json` support via our `Discovery.pull()` mechanism.

### 11.3 Priority 3: Auto-Detection & Suggestion (Weeks 3-5)

When a user opens Altimate Code in a Dagster project, automatically suggest:
- "Detected Dagster project. Install Dagster skills + MCP server?"

**Implementation:**
- Project type detection (look for `dagster.yaml`, `dbt_project.yml`, `airbyte/`, etc.)
- Suggestion UI in TUI
- One-command install of recommended pack

### 11.4 Priority 4: Partner SDK Documentation (Week 1)

Publish clear documentation for each layer:
- Skill Authoring Guide (from Section 5 above)
- MCP Integration Guide (from Section 6 above)
- Plugin Development Guide (from Section 7 above)
- Pack Bundling Guide (from Section 8 above)

### 11.5 Priority 5: Skill Versioning (Weeks 4-6)

Current gap: no way to pin skill versions or handle updates.

**Proposed:** Use git tags/releases in skill repos. `skills.urls` entries become:
```json
{
  "skills": {
    "urls": ["https://github.com/DagsterHQ/dagster-skills/releases/download/v1.2.0/"]
  }
}
```

### 11.6 Engineering Work Summary

| Item | Effort | Priority | Dependency |
|------|--------|----------|------------|
| PACK.yaml schema + parser | 3 days | P0 | None |
| `pack install` CLI command | 2 days | P0 | Schema |
| Pack auto-detection | 2 days | P1 | Pack system |
| Extension directory (GitHub-based) | 3 days | P1 | None |
| Partner SDK documentation site | 3 days | P1 | None |
| Skill versioning (git tags) | 2 days | P2 | None |
| Deep links (`altimate-code://`) | 2 days | P2 | Pack system |
| Extension malware scanning | 3 days | P3 | None |
| Install count telemetry | 1 day | P3 | None |

---

## 12. Competitive Positioning

### 12.1 Our Advantages vs. Goose

| Dimension | Goose | Altimate Code | Winner |
|-----------|-------|---------------|--------|
| Data engineering focus | Generic | Purpose-built (99+ DE tools) | **Altimate** |
| Skills system | No skills | SKILL.md + benchmark-proven | **Altimate** |
| MCP support | Primary interface | Full support + auto-detect | Tie |
| Plugin hooks | None (MCP only) | 20+ hooks for deep integration | **Altimate** |
| Recipes / Packs | Yes (mature) | Packs (planned) | **Goose** |
| Extension directory | 70+ servers listed | Not yet (planned) | **Goose** |
| Deep links | Yes | Not yet (planned) | **Goose** |
| Warehouse integrations | None built-in | 10 warehouses native | **Altimate** |
| SQL/dbt tools | Via MCP only | 99+ native tools | **Altimate** |
| Custom distros | Documented | Possible but undocumented | **Goose** |

### 12.2 Our Advantages vs. Generic AI Agents

- **Vertical expertise:** 11 data engineering skills + 99 specialized tools
- **Benchmark-proven:** ADE-bench, Spider2-dbt results published
- **Warehouse-native:** Direct connections to 10 data warehouses
- **dbt-native:** Deep dbt integration (not just MCP proxy)
- **Python bridge:** Full Python analysis engine (altimate-engine)

### 12.3 Positioning Statement

> **Altimate Code is the AI data engineering agent that works with your entire data stack.** Install skills and MCP servers from your favorite tools — dbt, Dagster, Airbyte, Snowflake, and more — and get an AI assistant that truly understands your data platform.

---

## 13. Appendix

### 13.1 Research Sources

**Goose (Block):**
- [GitHub](https://github.com/block/goose) | [Architecture](https://block.github.io/goose/docs/goose-architecture/) | [Extensions](https://block.github.io/goose/docs/getting-started/using-extensions/) | [Custom Extensions Tutorial](https://block.github.io/goose/docs/tutorials/custom-extensions/) | [Recipes](https://block.github.io/goose/docs/guides/recipes/) | [Custom Distros](https://github.com/block/goose/blob/main/CUSTOM_DISTROS.md) | [Browse Extensions](https://block.github.io/goose/extensions/)

**Data Vendor MCP Servers:**
- [dbt MCP](https://docs.getdbt.com/docs/cloud/mcp-server) (58 tools) | [Dagster MCP](https://dagster.io/blog/dagsters-mcp-server) | [Airbyte MCP](https://airbyte.com/blog/how-we-built-an-mcp-server-to-create-data-pipelines) | [DataHub MCP](https://datahub.com/blog/datahub-mcp-server-block-ai-agents-use-case/) | [OpenMetadata Recipe](https://blog.open-metadata.org/announcing-our-first-openmetadata-goose-recipe-67d9249c2fd3)

**Extension Ecosystems:**
- [agentskills.io](https://agentskills.io) (open standard, 30+ adopters) | [MCP Registry](https://registry.modelcontextprotocol.io) | [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) (50+ plugins) | [SkillsMP](https://skillsmp.com/) (2,300+ skills) | [awesome-agent-skills](https://github.com/heilcheng/awesome-agent-skills) (1,300+ skills)

**Framework Patterns:**
- [Composio](https://github.com/ComposioHQ/composio) (hub-and-spoke providers) | [LangChain](https://github.com/langchain-ai/langchain) (separate packages) | [CrewAI](https://github.com/crewai/crewai) (decorator + class tools) | [Semantic Kernel](https://learn.microsoft.com/semantic-kernel/) (DI plugins, <20 tool recommendation)

**Partner Ecosystem Benchmarks:**
- Marketplace review processes: 24 hours (Zoho) to 10 business days (HubSpot)
- Recertification: every 2 years
- VS Code pattern (5-day domain verification, automated checks) = lightest weight

### 13.2 Glossary

| Term | Definition |
|------|-----------|
| **SKILL.md** | Markdown file with YAML frontmatter teaching an AI how to approach a task |
| **MCP** | Model Context Protocol — standard for AI tools (Anthropic-led, adopted by industry) |
| **MCP Server** | A process that exposes tools/resources via the MCP protocol |
| **Plugin** | npm package that hooks into Altimate Code's runtime (auth, tools, chat) |
| **Pack** | YAML bundle of skills + MCP + plugins + instructions (PACK.yaml) |
| **Hook** | Interception point in plugin system (e.g., `tool.execute.before`) |
| **Agent Skills Standard** | Open standard at agentskills.io for portable AI skills |
