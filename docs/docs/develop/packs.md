# Building Packs

This guide is for anyone who wants to **create and distribute packs** — vendors, solution architects, team leads, or community contributors. For using packs, see [Configure > Packs](../configure/packs.md).

## What's in a Pack?

A pack is a `PACK.yaml` file that bundles:

- **Skills** — teach the AI how to approach tasks (from any Git repo)
- **MCP servers** — give the AI tools to execute tasks (standard MCP protocol)
- **Instructions** — project-specific rules injected into every conversation
- **Detection rules** — auto-suggest the pack when matching files exist

## Tutorial: Build Your First Pack in 5 Minutes

### Step 1: Scaffold

```bash
altimate-code pack create my-first-pack
```

This creates `.opencode/packs/my-first-pack/PACK.yaml`:

```yaml
name: my-first-pack
description: TODO — describe what this pack configures
version: 1.0.0

skills:
  # - source: "owner/repo"
  #   select: ["skill-a", "skill-b"]

mcp:
  # my-server:
  #   command: ["uvx", "my-mcp-server"]
  #   env_keys: ["MY_API_KEY"]

detect:
  # - files: ["config.yaml"]
  #   message: "Detected my-tool — activate pack?"

instructions: |
  TODO — add project-specific instructions here.
```

### Step 2: Edit

Fill in real content. Here's a complete example for an internal team:

```yaml
name: acme-data-team
description: ACME Corp data engineering standards and conventions
version: 1.0.0

skills:
  - source: "AltimateAI/data-engineering-skills"
    select:
      - creating-dbt-models
      - testing-dbt-models
      - debugging-dbt-errors

mcp:
  dbt:
    type: stdio
    command: ["uvx", "dbt-mcp"]
    env:
      DBT_PROJECT_DIR: "./"
    env_keys: ["DBT_PROJECT_DIR"]
    description: "dbt MCP server for model development"

detect:
  - files: ["dbt_project.yml"]
    message: "Detected dbt project — activate ACME data team pack?"

instructions: |
  ## ACME Data Team Conventions

  - Table naming: dim_*, fct_*, stg_*, int_*
  - All models must have unique + not_null tests on primary keys
  - Use ref() for all model references
  - Warehouse sizing: XS for dev, M for staging, L for prod
  - Code review required for any model touching PII columns
```

### Step 3: Validate

```bash
altimate-code pack validate my-first-pack
```

Output:
```
Validating: my-first-pack

  ✓ Name "my-first-pack" is valid
  ✓ Description present
  ✓ Version "1.0.0" is valid semver
  ✓ 1 skill source(s) defined
  ✓ MCP "dbt": command defined
  ⚠ MCP "dbt": env var DBT_PROJECT_DIR is NOT set
  ✓ 1 detection rule(s) defined
  ✓ Instructions present (10 lines)

Validation: PASS
```

### Step 4: Activate

```bash
altimate-code pack activate my-first-pack
```

### Step 5: Share

Commit the pack to your repo. Others install with:

```bash
altimate-code pack install owner/repo
```

## PACK.yaml Schema Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Lowercase, hyphens, 2-64 chars. Must match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` |
| `description` | string | One-line summary of what the pack configures |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | string | `"1.0.0"` | Semver version |
| `author` | string | — | Author name or organization |
| `tier` | string | `"community"` | Trust tier: `built-in`, `verified`, `community`, `archived` |
| `skills` | array | `[]` | Skills to install (see below) |
| `skill_groups` | object | `{}` | Grouped skills with activation modes (see below) |
| `mcp` | object | `{}` | MCP servers to configure (see below) |
| `plugins` | array | `[]` | npm packages to install |
| `instructions` | string | — | Text injected into every AI conversation |
| `detect` | array | `[]` | File patterns that trigger pack suggestion |

### Skills

Skills reference external repositories containing `SKILL.md` files:

```yaml
skills:
  # Install specific skills from a repo
  - source: "AltimateAI/data-engineering-skills"
    select:
      - creating-dbt-models
      - testing-dbt-models

  # Install all skills from a repo (omit select)
  - source: "owner/skills-repo"

  # Reference an already-installed skill by name
  - "my-existing-skill"
```

The `source` field accepts:
- GitHub shorthand: `owner/repo`
- Full URL: `https://github.com/owner/repo`
- Local path: `./my-skills`

### Skill Groups

For packs with many skills, organize them into packs with activation modes:

```yaml
skill_groups:
  core:
    description: "Essential skills loaded every session"
    activation: always
    skills:
      - source: "owner/repo"
        select: ["skill-a", "skill-b"]

  advanced:
    description: "Skills loaded when matching files exist"
    activation: detect
    detect:
      - files: ["**/advanced/**"]
    skills:
      - source: "owner/repo"
        select: ["skill-c"]

  specialized:
    description: "Skills loaded only on explicit request"
    activation: manual
    skills:
      - source: "owner/repo"
        select: ["skill-d"]
```

| Activation | Behavior |
|-----------|----------|
| `always` | Skills loaded every session when pack is active |
| `detect` | Skills loaded when matching files exist in the project |
| `manual` | Skills loaded only when the user explicitly requests them |

!!! note
    When `skill_groups` is present, it takes precedence over the flat `skills` array. Use one or the other, not both.

### MCP Servers

Configure MCP (Model Context Protocol) servers that give the AI tools to call:

```yaml
mcp:
  my-server:
    type: stdio                    # "stdio" for local, "sse" or "remote" for HTTP
    command: ["uvx", "my-server"]  # Command to start the server
    args: ["--port", "8080"]       # Additional arguments (merged with command)
    env:                           # Environment variables passed to the server
      API_KEY: "default-value"
    env_keys: ["API_KEY"]          # Env vars the user must set (warns if missing)
    description: "What this server provides"
```

**Type mapping:** The pack uses user-friendly names that are translated to the config format:

| Pack type | Config type | Use case |
|----------|-----------|----------|
| `stdio` (default) | `local` | Local process via stdin/stdout |
| `sse` | `remote` | Server-sent events over HTTP |
| `streamable-http` | `remote` | Streamable HTTP |

**Environment variables:**

- `env`: Default values passed to the MCP server process
- `env_keys`: Names of variables the user must set. Pack activation warns if these are missing. Use this for API keys and secrets that shouldn't have defaults.

### Plugins

Packs can list npm plugin packages to extend altimate-code with custom hooks, auth flows, tools, and providers. On `pack activate`, the plugin specs are appended to your project's `plugin[]` config; on `pack deactivate` they're removed unless another active pack still lists them (reference-counted).

```yaml
plugins:
  - "@dagster/altimate-plugin@^1.0"
  - "@atlan/governance-plugin@latest"
  - "file:///Users/me/local-plugin"
```

**Format:** Each entry is an npm package spec (`name`, `name@version`, or `file://path`). At load time, altimate-code installs the package via Bun and loads its exported `Plugin` function, which can register hooks for:

| Hook | Purpose |
|------|---------|
| `auth` | Custom OAuth / API-key flows for vendor providers |
| `tool` | Ship custom tools usable by the AI |
| `tool.execute.before` / `.after` | Cost guards, audit logging, write gating |
| `permission.ask` | Custom permission prompts |
| `chat.params` / `chat.headers` | Modify outgoing model requests |
| `command.execute.before` | Intercept shell commands |
| `shell.env` | Inject env vars for tools |

See the [`@opencode-ai/plugin`](https://www.npmjs.com/package/@opencode-ai/plugin) package for the full hook surface.

!!! warning
    Plugins run with full Node.js privileges. Only activate packs from trusted sources — `pack activate` always warns when it is about to install plugin packages.

### Detection Rules

Auto-suggest the pack when certain files exist in the project:

```yaml
detect:
  - files: ["dbt_project.yml", "dbt_project.yaml"]
    message: "Detected dbt project — activate this pack?"

  - files: ["**/dagster/**", "workspace.yaml"]
    message: "Detected Dagster project"
```

- `files`: Array of glob patterns matched against the project directory
- `message`: Optional suggestion text shown to the user

Users discover matching packs via `pack detect` or `pack list --detect`. The TUI also shows a nudge on startup when matching packs are found.

### Instructions

Free-form text injected into the AI's system context for every conversation when the pack is active:

```yaml
instructions: |
  ## Team Conventions

  - Use snake_case for all column names
  - All monetary values in cents (integer), not dollars
  - Every model must have a primary key test
  - Do NOT use SELECT * in production models
```

**Best practices for instructions:**

- Keep them under 50 lines — longer instructions consume more context tokens
- Be specific and actionable — "use snake_case" is better than "follow naming conventions"
- Use markdown headers to organize sections
- Include "DO NOT" rules for common mistakes
- Avoid duplicating what skills already teach

## Trust & Integrity

Every installed pack gets a `manifest.json` written next to `PACK.yaml` containing a SHA256 hash of the pack's content. On every load, altimate-code re-hashes the pack and compares against the manifest:

- **Hash match:** pack is trusted as-installed.
- **Hash mismatch:** the runtime logs a warning and `pack activate` prints an **INTEGRITY WARNING** prompting the user. This protects against accidental corruption and naive tampering — it is **not** a substitute for code signing.

### Tier enforcement

Trust tiers (`built-in`, `verified`, `community`, `archived`) are enforced at load time against hardcoded allowlists:

- Packs claiming `built-in` or `verified` that are **not** in the allowlist are automatically **downgraded to `community`** and logged.
- The CLI prints a **TIER DOWNGRADE** notice during `pack activate`.
- For local development, you can inject entries via env vars: `ALTIMATE_CODE_VERIFIED_PACKS=my-pack,other-pack` and `ALTIMATE_CODE_BUILTIN_PACKS=...`.

This means: **claiming a tier in `PACK.yaml` does not grant that tier.** The allowlist is the root of trust. To become verified, partners submit PRs to the registry review process.

### Telemetry events

The pack system emits these events for operators monitoring the installed base:

| Event | Fields | Emitted when |
|-------|--------|-------------|
| `pack_created` | `pack_name` | `pack create` scaffolds a new pack |
| `pack_installed` | `install_source`, `pack_count`, `pack_names` | `pack install` completes |
| `pack_applied` | `pack_name`, `skill_count`, `mcp_count`, `plugin_count`, `has_instructions`, `tier`, `tamper_detected`, `tier_downgraded` | `pack activate` completes |
| `pack_deactivated` | `pack_name`, `mcp_cleaned`, `plugins_cleaned`, `instructions_cleaned` | `pack deactivate` completes |
| `pack_removed` | `pack_name` | `pack remove` completes |
| `pack_integrity_warning` | `pack_name`, `warning` (`tamper_detected`\|`tier_downgraded`), `claimed_tier` | Loaded pack fails integrity or tier check |

Vendors authoring plugins can emit their own telemetry by calling `Telemetry.track(...)` from plugin hooks — attach `pack_name` in a custom event type to correlate with the lifecycle events above.

## Publishing to the Registry

The pack registry is hosted at [AltimateAI/data-engineering-skills](https://github.com/AltimateAI/data-engineering-skills).

### For Community Contributors

1. Create your pack in your own GitHub repo
2. Test with `pack validate` and `pack activate`
3. Submit a PR to [data-engineering-skills](https://github.com/AltimateAI/data-engineering-skills) adding an entry to `registry.json`:

```json
{
  "name": "my-pack",
  "description": "What it does",
  "version": "1.0.0",
  "author": "Your Name",
  "tier": "community",
  "repo": "your-org/your-repo",
  "path": "packs/my-pack",
  "tags": ["dbt", "bigquery"],
  "detect": ["dbt_project.yml"]
}
```

### For Vendors (Verified Tier)

To get your pack listed as `verified`:

1. Create skills and a pack in your organization's GitHub repo
2. Test thoroughly with `pack validate` and real-world projects
3. Submit a PR to the registry with `"tier": "verified"`
4. The Altimate team reviews the pack for quality and correctness
5. Once approved, your pack appears with a `[verified]` badge

**Verified tier requirements:**

- Skills follow the [Agent Skills](https://agentskills.io) specification
- MCP server is published to PyPI or npm
- Detection rules are accurate (no false positives)
- Instructions are clear and well-structured
- Pack is actively maintained

## Examples

### Instructions-Only Pack (Team Standards)

No skills, no MCP — just team conventions:

```yaml
name: team-standards
description: Engineering standards for the analytics team
version: 1.0.0

instructions: |
  - All SQL in lowercase
  - CTEs over subqueries
  - No SELECT * in production
  - Every PR needs a dbt test

detect:
  - files: ["dbt_project.yml"]
```

### MCP-Only Pack (Tool Integration)

No skills, no instructions — just MCP configuration:

```yaml
name: airbyte-connector
description: Airbyte PyAirbyte MCP server for data pipeline development
version: 1.0.0

mcp:
  airbyte:
    type: stdio
    command: ["uvx", "pyairbyte-mcp"]
    env_keys: ["AIRBYTE_API_KEY"]
    description: "PyAirbyte — generate pipelines with 600+ connectors"

detect:
  - files: ["**/airbyte_*.py", "airbyte.yaml"]
```

### Full Pack (Skills + MCP + Instructions)

The complete package:

```yaml
name: dbt-snowflake
description: Complete dbt + Snowflake development setup
version: 1.0.0
author: Altimate AI
tier: built-in

skills:
  - source: "AltimateAI/data-engineering-skills"
    select:
      - creating-dbt-models
      - testing-dbt-models
      - debugging-dbt-errors

mcp:
  dbt:
    type: stdio
    command: ["uvx", "dbt-mcp"]
    env:
      DBT_PROJECT_DIR: "./"
      DBT_PROFILES_DIR: "~/.dbt"
    env_keys: ["DBT_PROJECT_DIR", "DBT_PROFILES_DIR"]
    description: "dbt MCP server — SQL execution, semantic layer, discovery API"

instructions: |
  This project uses dbt with Snowflake.
  - Use ref() for all model references
  - Follow staging → intermediate → marts layering
  - Run dbt build (not just compile) to verify changes

detect:
  - files: ["dbt_project.yml"]
    message: "Detected dbt project — activate dbt-snowflake pack?"
```

## Troubleshooting

### Pack not showing in `pack list`

- Check the `PACK.yaml` file is valid: `pack validate <name>`
- Ensure the file is named exactly `PACK.yaml` (case-sensitive)
- Check the pack directory is under `.opencode/packs/` or another scanned location

### Skills fail to install during `pack activate`

- The `source` repo must be accessible (public GitHub or reachable URL)
- Skills that already exist locally are skipped with a warning
- If a source fails, other components (MCP, instructions) still install

### MCP server doesn't start after activation

- Check `pack validate` for missing environment variables
- Set required env vars in your shell profile or `.env` file
- Verify the MCP command is installed: run the command manually (e.g., `uvx dbt-mcp --help`)

### `pack deactivate` didn't clean up

- `pack deactivate` removes: instruction files, active-packs entry, and MCP config entries
- Skills installed by the pack are NOT removed (they may be shared with other packs)
- To fully clean up skills, remove them from `.opencode/skills/` manually
