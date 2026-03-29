# Kits

Kits bundle skills, MCP servers, and instructions into a single activatable unit. Instead of configuring each piece separately, activate a kit to get a complete development setup.

## Quick Start

```bash
# List available kits
altimate-code kit list

# Auto-detect kits for your project
altimate-code kit detect

# Activate a kit
altimate-code kit activate dbt-snowflake

# Check active kits
altimate-code kit status

# Deactivate
altimate-code kit deactivate dbt-snowflake
```

## Installing Kits

Install kits from GitHub repositories or local paths:

```bash
# From GitHub
altimate-code kit install AltimateAI/data-engineering-skills

# From local path
altimate-code kit install ./my-kits

# Install globally (available in all projects)
altimate-code kit install AltimateAI/data-engineering-skills --global
```

## KIT.yaml Format

Kits are defined in `KIT.yaml` files:

```yaml
name: my-kit
description: What this kit configures
version: 1.0.0

# Skills to install
skills:
  - source: "owner/repo"
    select: ["skill-a", "skill-b"]

# MCP servers to configure
mcp:
  server-name:
    type: stdio
    command: ["uvx", "my-mcp-server"]
    env_keys: ["API_KEY"]
    description: "Server description"

# Instructions for every conversation
instructions: |
  Project-specific conventions and rules.

# Auto-detection rules
detect:
  - files: ["config.yaml"]
    message: "Detected my-tool — activate kit?"
```

## What `kit activate` Does

When you activate a kit, it:

1. **Installs skills** from referenced repositories into `.opencode/skills/`
2. **Configures MCP servers** by merging entries into your project's config file
3. **Creates instruction files** at `.opencode/instructions/kit-<name>.md`
4. **Registers the kit** as active in `.opencode/active-kits`

All changes are reversible with `kit deactivate`.

## Creating Your Own Kit

```bash
altimate-code kit create my-team-standards
```

This scaffolds `.opencode/kits/my-team-standards/KIT.yaml` with a template. Edit it, then activate:

```bash
altimate-code kit activate my-team-standards
```

### Validating

Check your kit for issues before sharing:

```bash
altimate-code kit validate my-team-standards
```

## Multiple Active Kits

You can activate multiple kits simultaneously. Their MCP servers are merged and instruction files coexist:

```bash
altimate-code kit activate dbt-snowflake
altimate-code kit activate my-team-standards
altimate-code kit status  # shows both
```

## Trust Tiers

| Tier | Description |
|------|-------------|
| `built-in` | Ships with Altimate Code, maintained by the team |
| `verified` | Published by official vendors, reviewed |
| `community` | Created by anyone, use at your discretion |

## Kit Locations

Kits are discovered from:

1. **Project**: `.opencode/kits/` and `.altimate-code/kits/`
2. **Global**: `~/.config/altimate-code/kits/`
3. **Config paths**: `kits.paths` in your config file
4. **Installed**: `~/.local/share/altimate-code/kits/`

## CLI Reference

| Command | Description |
|---------|-------------|
| `kit list` | List all available kits |
| `kit list --json` | JSON output for scripting |
| `kit list --detect` | Show only project-matching kits |
| `kit create <name>` | Scaffold a new kit |
| `kit show <name>` | Display full kit details |
| `kit install <source>` | Install from GitHub or local path |
| `kit activate <name>` | Install skills, configure MCP, enable |
| `kit activate <name> --yes` | Skip confirmation prompt |
| `kit deactivate <name>` | Remove from active kits, clean up |
| `kit remove <name>` | Delete an installed kit |
| `kit detect` | Find kits matching current project |
| `kit search [query]` | Search the kit registry |
| `kit status` | Show active kits |
| `kit validate [name]` | Validate kit format and references |

## Sharing Kits

Share kits via Git repositories. The recommended structure:

```
my-kits/
  kits/
    kit-a/KIT.yaml
    kit-b/KIT.yaml
  README.md
```

Others install with: `altimate-code kit install owner/my-kits`

## Available Kits

See [data-engineering-skills](https://github.com/AltimateAI/data-engineering-skills) for the official kit registry.

## Roadmap

The kit system is actively evolving based on community feedback. Here's what's planned:

### Coming Soon

| Feature | Description | Status |
|---------|-------------|--------|
| **`kit switch`** | Switch between kits in one command (deactivate all, activate one) | Planned |
| **Kit inheritance** | `extends: base-kit` to share conventions across kits | Planned |
| **`kit update`** | Pull newer versions of installed kits from source | Planned |
| **Registry expansion** | More built-in kits for BigQuery, Databricks, Airflow, Dagster | In progress |
| **`kit enforce`** | CI command that fails if required kits are not active | Planned |

### Future

| Feature | Description |
|---------|-------------|
| **Auto-activation** | Automatically suggest or activate kits when detection rules match on project open |
| **Kit locking** | Prevent deactivation of compliance-critical kits without admin override |
| **Conflict detection** | Warn when two active kits have contradictory instructions |
| **Kit analytics** | Activation counts and skill usage metrics for kit authors |
| **MCP tool filtering** | Allow kits to expose only specific tools from an MCP server |

### Contributing to the Roadmap

Have a feature request? [Open an issue](https://github.com/AltimateAI/altimate-code/issues) with the `kit` label, or contribute directly to the [data-engineering-skills](https://github.com/AltimateAI/data-engineering-skills) repo.
