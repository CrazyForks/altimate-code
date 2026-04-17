# Packs

Packs bundle skills, MCP servers, and instructions into a single activatable unit. Instead of configuring each piece separately, activate a pack to get a complete development setup.

## Quick Start

```bash
# List available packs
altimate-code pack list

# Auto-detect packs for your project
altimate-code pack detect

# Activate a pack
altimate-code pack activate dbt-snowflake

# Check active packs
altimate-code pack status

# Deactivate
altimate-code pack deactivate dbt-snowflake
```

## Installing Packs

Install packs from GitHub repositories or local paths:

```bash
# From GitHub
altimate-code pack install AltimateAI/data-engineering-skills

# From local path
altimate-code pack install ./my-packs

# Install globally (available in all projects)
altimate-code pack install AltimateAI/data-engineering-skills --global
```

## PACK.yaml Format

Packs are defined in `PACK.yaml` files:

```yaml
name: my-pack
description: What this pack configures
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
    message: "Detected my-tool — activate pack?"
```

## What `pack activate` Does

When you activate a pack, it:

1. **Installs skills** from referenced repositories into `.opencode/skills/`
2. **Configures MCP servers** by merging entries into your project's config file
3. **Creates instruction files** at `.opencode/instructions/pack-<name>.md`
4. **Registers the pack** as active in `.opencode/active-packs`

All changes are reversible with `pack deactivate`.

## Creating Your Own Pack

```bash
altimate-code pack create my-team-standards
```

This scaffolds `.opencode/packs/my-team-standards/PACK.yaml` with a template. Edit it, then activate:

```bash
altimate-code pack activate my-team-standards
```

### Validating

Check your pack for issues before sharing:

```bash
altimate-code pack validate my-team-standards
```

## Multiple Active Packs

You can activate multiple packs simultaneously. Their MCP servers are merged and instruction files coexist:

```bash
altimate-code pack activate dbt-snowflake
altimate-code pack activate my-team-standards
altimate-code pack status  # shows both
```

## Trust Tiers

| Tier | Description |
|------|-------------|
| `built-in` | Ships with Altimate Code, maintained by the team |
| `verified` | Published by official vendors, reviewed |
| `community` | Created by anyone, use at your discretion |

## Pack Locations

Packs are discovered from:

1. **Project**: `.opencode/packs/` and `.altimate-code/packs/`
2. **Global**: `~/.config/altimate-code/packs/`
3. **Config paths**: `packs.paths` in your config file
4. **Installed**: `~/.local/share/altimate-code/packs/`

## CLI Reference

| Command | Description |
|---------|-------------|
| `pack list` | List all available packs |
| `pack list --json` | JSON output for scripting |
| `pack list --detect` | Show only project-matching packs |
| `pack create <name>` | Scaffold a new pack |
| `pack show <name>` | Display full pack details |
| `pack install <source>` | Install from GitHub or local path |
| `pack activate <name>` | Install skills, configure MCP, enable |
| `pack activate <name> --yes` | Skip confirmation prompt |
| `pack deactivate <name>` | Remove from active packs, clean up |
| `pack remove <name>` | Delete an installed pack |
| `pack detect` | Find packs matching current project |
| `pack search [query]` | Search the pack registry |
| `pack status` | Show active packs |
| `pack validate [name]` | Validate pack format and references |

## Sharing Packs

Share packs via Git repositories. The recommended structure:

```
my-packs/
  packs/
    pack-a/PACK.yaml
    pack-b/PACK.yaml
  README.md
```

Others install with: `altimate-code pack install owner/my-packs`

## Available Packs

See [data-engineering-skills](https://github.com/AltimateAI/data-engineering-skills) for the official pack registry.

## Roadmap

The pack system is actively evolving based on community feedback. Here's what's planned:

### Coming Soon

| Feature | Description | Status |
|---------|-------------|--------|
| **`pack switch`** | Switch between packs in one command (deactivate all, activate one) | Planned |
| **Pack inheritance** | `extends: base-pack` to share conventions across packs | Planned |
| **`pack update`** | Pull newer versions of installed packs from source | Planned |
| **Registry expansion** | More built-in packs for BigQuery, Databricks, Airflow, Dagster | In progress |
| **`pack enforce`** | CI command that fails if required packs are not active | Planned |

### Future

| Feature | Description |
|---------|-------------|
| **Auto-activation** | Automatically suggest or activate packs when detection rules match on project open |
| **Pack locking** | Prevent deactivation of compliance-critical packs without admin override |
| **Conflict detection** | Warn when two active packs have contradictory instructions |
| **Pack analytics** | Activation counts and skill usage metrics for pack authors |
| **MCP tool filtering** | Allow packs to expose only specific tools from an MCP server |

### Contributing to the Roadmap

Have a feature request? [Open an issue](https://github.com/AltimateAI/altimate-code/issues) with the `pack` label, or contribute directly to the [data-engineering-skills](https://github.com/AltimateAI/data-engineering-skills) repo.
