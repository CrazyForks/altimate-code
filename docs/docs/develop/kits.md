# Building Kits

This guide is for anyone who wants to **create and distribute kits** — vendors, solution architects, team leads, or community contributors. For using kits, see [Configure > Kits](../configure/kits.md).

## What's in a Kit?

A kit is a `KIT.yaml` file that bundles:

- **Skills** — teach the AI how to approach tasks (from any Git repo)
- **MCP servers** — give the AI tools to execute tasks (standard MCP protocol)
- **Instructions** — project-specific rules injected into every conversation
- **Detection rules** — auto-suggest the kit when matching files exist

## Tutorial: Build Your First Kit in 5 Minutes

### Step 1: Scaffold

```bash
altimate-code kit create my-first-kit
```

This creates `.opencode/kits/my-first-kit/KIT.yaml`:

```yaml
name: my-first-kit
description: TODO — describe what this kit configures
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
  #   message: "Detected my-tool — activate kit?"

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
    message: "Detected dbt project — activate ACME data team kit?"

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
altimate-code kit validate my-first-kit
```

Output:
```
Validating: my-first-kit

  ✓ Name "my-first-kit" is valid
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
altimate-code kit activate my-first-kit
```

### Step 5: Share

Commit the kit to your repo. Others install with:

```bash
altimate-code kit install owner/repo
```

## KIT.yaml Schema Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Lowercase, hyphens, 2-64 chars. Must match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` |
| `description` | string | One-line summary of what the kit configures |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | string | `"1.0.0"` | Semver version |
| `author` | string | — | Author name or organization |
| `tier` | string | `"community"` | Trust tier: `built-in`, `verified`, `community`, `archived` |
| `skills` | array | `[]` | Skills to install (see below) |
| `skill_packs` | object | `{}` | Grouped skills with activation modes (see below) |
| `mcp` | object | `{}` | MCP servers to configure (see below) |
| `plugins` | array | `[]` | npm packages to install |
| `instructions` | string | — | Text injected into every AI conversation |
| `detect` | array | `[]` | File patterns that trigger kit suggestion |

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

### Skill Packs

For kits with many skills, organize them into packs with activation modes:

```yaml
skill_packs:
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
| `always` | Skills loaded every session when kit is active |
| `detect` | Skills loaded when matching files exist in the project |
| `manual` | Skills loaded only when the user explicitly requests them |

!!! note
    When `skill_packs` is present, it takes precedence over the flat `skills` array. Use one or the other, not both.

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

**Type mapping:** The kit uses user-friendly names that are translated to the config format:

| Kit type | Config type | Use case |
|----------|-----------|----------|
| `stdio` (default) | `local` | Local process via stdin/stdout |
| `sse` | `remote` | Server-sent events over HTTP |
| `streamable-http` | `remote` | Streamable HTTP |

**Environment variables:**

- `env`: Default values passed to the MCP server process
- `env_keys`: Names of variables the user must set. Kit activation warns if these are missing. Use this for API keys and secrets that shouldn't have defaults.

### Detection Rules

Auto-suggest the kit when certain files exist in the project:

```yaml
detect:
  - files: ["dbt_project.yml", "dbt_project.yaml"]
    message: "Detected dbt project — activate this kit?"

  - files: ["**/dagster/**", "workspace.yaml"]
    message: "Detected Dagster project"
```

- `files`: Array of glob patterns matched against the project directory
- `message`: Optional suggestion text shown to the user

Users discover matching kits via `kit detect` or `kit list --detect`. The TUI also shows a nudge on startup when matching kits are found.

### Instructions

Free-form text injected into the AI's system context for every conversation when the kit is active:

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

## Publishing to the Registry

The kit registry is hosted at [AltimateAI/data-engineering-skills](https://github.com/AltimateAI/data-engineering-skills).

### For Community Contributors

1. Create your kit in your own GitHub repo
2. Test with `kit validate` and `kit activate`
3. Submit a PR to [data-engineering-skills](https://github.com/AltimateAI/data-engineering-skills) adding an entry to `registry.json`:

```json
{
  "name": "my-kit",
  "description": "What it does",
  "version": "1.0.0",
  "author": "Your Name",
  "tier": "community",
  "repo": "your-org/your-repo",
  "path": "kits/my-kit",
  "tags": ["dbt", "bigquery"],
  "detect": ["dbt_project.yml"]
}
```

### For Vendors (Verified Tier)

To get your kit listed as `verified`:

1. Create skills and a kit in your organization's GitHub repo
2. Test thoroughly with `kit validate` and real-world projects
3. Submit a PR to the registry with `"tier": "verified"`
4. The Altimate team reviews the kit for quality and correctness
5. Once approved, your kit appears with a `[verified]` badge

**Verified tier requirements:**

- Skills follow the [Agent Skills](https://agentskills.io) specification
- MCP server is published to PyPI or npm
- Detection rules are accurate (no false positives)
- Instructions are clear and well-structured
- Kit is actively maintained

## Examples

### Instructions-Only Kit (Team Standards)

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

### MCP-Only Kit (Tool Integration)

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

### Full Kit (Skills + MCP + Instructions)

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
    message: "Detected dbt project — activate dbt-snowflake kit?"
```

## Troubleshooting

### Kit not showing in `kit list`

- Check the `KIT.yaml` file is valid: `kit validate <name>`
- Ensure the file is named exactly `KIT.yaml` (case-sensitive)
- Check the kit directory is under `.opencode/kits/` or another scanned location

### Skills fail to install during `kit activate`

- The `source` repo must be accessible (public GitHub or reachable URL)
- Skills that already exist locally are skipped with a warning
- If a source fails, other components (MCP, instructions) still install

### MCP server doesn't start after activation

- Check `kit validate` for missing environment variables
- Set required env vars in your shell profile or `.env` file
- Verify the MCP command is installed: run the command manually (e.g., `uvx dbt-mcp --help`)

### `kit deactivate` didn't clean up

- `kit deactivate` removes: instruction files, active-kits entry, and MCP config entries
- Skills installed by the kit are NOT removed (they may be shared with other kits)
- To fully clean up skills, remove them from `.opencode/skills/` manually
