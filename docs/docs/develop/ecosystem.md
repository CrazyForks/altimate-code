# Ecosystem

altimate has a growing ecosystem of plugins, tools, and integrations.

## Official Packages

| Package | Description |
|---------|------------|
| `@altimateai/altimate-code` | CLI and TUI |
| `@altimateai/altimate-code-sdk` | TypeScript SDK |
| `@altimateai/altimate-code-plugin` | Plugin development pack |

## Integrations

- **GitHub Actions**: Automated PR review and issue triage
- **GitLab CI**: Merge request analysis
- **VS Code / Cursor / Windsurf**: [IDE integration](../usage/ide.md) via the Datamates extension
- **[Datamates](https://datamates-docs.myaltimate.com/)**: AI teammates platform with MCP integrations, Knowledge Hub, Memory, and Guardrails
- **MCP**: Model Context Protocol servers
- **ACP**: Agent Communication Protocol for editors

## Packs

Packs bundle skills, MCP servers, and instructions into shareable development setups. Anyone can create and distribute packs.

| Pack | Description |
|-----|-------------|
| [dbt-snowflake](https://github.com/AltimateAI/data-engineering-skills/tree/main/packs/dbt-snowflake) | Complete dbt + Snowflake setup |

Browse the [pack registry](https://github.com/AltimateAI/data-engineering-skills/blob/main/registry.json) for more.

### Creating Packs

See the [Pack documentation](../configure/packs.md) for the full guide, or run:

```bash
altimate-code pack create my-pack
```

## Community

- [GitHub Repository](https://github.com/AltimateAI/altimate-code): Source code, issues, discussions
- Share your plugins and tools with the community

## Contributing

Contributions are welcome. See the repository for guidelines on:

- Bug reports and feature requests
- Plugin development
- Documentation improvements
- Tool contributions
