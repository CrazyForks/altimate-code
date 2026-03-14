# Upstream Merge Automation

Tools for merging upstream [OpenCode](https://github.com/anomalyco/opencode) releases into the Altimate Code fork with automatic conflict resolution, branding transforms, and version management.

## Quick Start

```bash
# 1. See what upstream versions are available
bun run script/upstream/list-versions.ts

# 2. Analyze what would change (dry-run, no modifications)
bun run script/upstream/merge.ts --version v1.2.21 --dry-run

# 3. Run the full merge
bun run script/upstream/merge.ts --version v1.2.21

# 4. If conflicts need manual resolution, fix them, then:
git add <resolved-files>
bun run script/upstream/merge.ts --continue

# 5. Verify no upstream branding leaked through
bun run script/upstream/analyze.ts --branding
```

## Full Merge Process

The merge script automates an 11-step process:

```
 Step  Description                    Details
 ────  ─────────────────────────────  ────────────────────────────────────────
  1    Validate environment           Clean tree, upstream remote, fetch tags
  2    Snapshot package versions       Save our name/version before merge
  3    Create branches                Backup branch + merge branch
  4    Merge upstream                 git merge <tag> --no-edit
  5    Auto-resolve conflicts         keepOurs, skipFiles, lock files, binaries
  6    Report remaining conflicts     List files needing manual resolution
  7    Apply branding transforms      URL, GitHub, product name replacements
  8    Restore package versions       Revert upstream version bumps
  9    Commit branding changes        Separate commit for traceability
 10    Verify branding integrity      Scan for upstream branding leaks
 11    Push & finalize                Push merge branch, print PR command
```

If step 6 finds unresolvable conflicts, the script exits with instructions.
After manual resolution, run `--continue` to resume from step 7.

## Available Scripts

### `merge.ts` — Main Merge Orchestration

The primary entry point for merging upstream releases.

```bash
# Standard merge
bun run script/upstream/merge.ts --version v1.2.21

# Dry-run analysis (no changes to repo)
bun run script/upstream/merge.ts --version v1.2.21 --dry-run

# Merge without pushing to origin
bun run script/upstream/merge.ts --version v1.2.21 --no-push

# Merge a specific commit instead of a tag
bun run script/upstream/merge.ts --commit abc123def

# Resume after resolving conflicts
bun run script/upstream/merge.ts --continue
```

**Options:**

| Flag | Description |
|------|-------------|
| `--version, -v <tag>` | Upstream version tag to merge |
| `--commit, -c <sha>` | Merge a specific commit instead |
| `--base-branch <name>` | Branch to merge into (default: `main`) |
| `--dry-run` | Preview changes without modifying the repo |
| `--no-push` | Skip pushing the merge branch to origin |
| `--continue` | Resume after manual conflict resolution |
| `--author <name>` | Override merge commit author |
| `--help, -h` | Show help |

**Branches created:**
- `backup/<current-branch>-<timestamp>` — safety snapshot
- `upstream/merge-<version>` — the merge working branch

### `analyze.ts` — Analysis & Verification

Two modes: version preview and branding audit.

```bash
# Analyze what would change for a version
bun run script/upstream/analyze.ts --version v1.2.21

# Audit codebase for upstream branding leaks
bun run script/upstream/analyze.ts --branding

# Detailed audit showing all matches
bun run script/upstream/analyze.ts --branding --verbose

# JSON output (for CI pipelines)
bun run script/upstream/analyze.ts --branding --json

# Default: marker integrity analysis
bun run script/upstream/analyze.ts
```

**Exit codes (branding mode):**
- `0` — No leaks found
- `1` — Branding leaks detected (useful for CI gates)
- `2` — Script error

### `list-versions.ts` — List Upstream Versions

Shows available upstream tags with merge status.

```bash
# Show latest 30 versions
bun run script/upstream/list-versions.ts

# Show more
bun run script/upstream/list-versions.ts --limit 50

# Show all versions
bun run script/upstream/list-versions.ts --all

# JSON output
bun run script/upstream/list-versions.ts --json
```

### `verify-restructure.ts` — Branch Verification

Compares custom code between branches to ensure nothing was lost during restructuring.

```bash
bun run script/upstream/verify-restructure.ts
bun run script/upstream/verify-restructure.ts --json
```

## File Organization

```
script/upstream/
├── merge.ts                 # Main merge orchestration (entry point)
├── analyze.ts               # Version analysis & branding audit
├── list-versions.ts         # List upstream tags with merge status
├── verify-restructure.ts    # Branch comparison verification
├── merge-config.json        # Declarative config (legacy, see config.ts)
├── package.json             # Dependencies (minimatch)
├── tsconfig.json            # TypeScript configuration
├── README.md                # This file
├── utils/
│   ├── config.ts            # Branding rules, merge config, repoRoot()
│   ├── git.ts               # Async git command helpers (Bun $)
│   ├── logger.ts            # Colored terminal logging with step counters
│   └── report.ts            # Transform report types, printing, JSON export
└── transforms/
    ├── keep-ours.ts          # Resolve conflicts by keeping our version
    ├── skip-files.ts         # Resolve conflicts by accepting upstream
    └── lock-files.ts         # Lock file resolution & regeneration
```

## Configuration

All configuration lives in `utils/config.ts` as TypeScript for type safety and inline documentation.

### keepOurs — Files We Own

These files are always kept as-is during merges. Conflicts are auto-resolved by checking out our version.

| Pattern | Description |
|---------|-------------|
| `README.md`, `CONTRIBUTING.md`, etc. | Repository documentation |
| `.github/workflows/**` | CI/CD pipelines |
| `packages/altimate-engine/**` | Python engine (our code) |
| `packages/opencode/src/altimate/**` | TypeScript custom code |
| `packages/opencode/src/bridge/**` | Python-TS bridge |
| `script/upstream/**` | This merge tooling |
| `experiments/**`, `docs/**` | Research & documentation |

### Branding Rules

Ordered from most specific to least specific to prevent partial matches:

| Category | Example Transform |
|----------|-------------------|
| URL subdomains | `auth.dev.opencode.ai` -> `auth.dev.altimate.ai` |
| Root domain | `opencode.ai` -> `altimate.ai` |
| Short domain | `opncd.ai` -> `altimate.ai` |
| GitHub repos | `anomalyco/opencode` -> `AltimateAI/altimate-code` |
| Container registry | `ghcr.io/anomalyco` -> `ghcr.io/AltimateAI` |
| Email addresses | `bot@opencode.ai` -> `bot@altimate.ai` |
| App IDs | `ai.opencode.desktop` -> `ai.altimate.code.desktop` |
| Product names | `OpenCode` -> `Altimate Code` |
| Install commands | `npm i -g opencode-ai` -> `npm i -g @altimateai/altimate-code` |
| Homebrew | `anomalyco/tap/opencode` -> `AltimateAI/tap/altimate-code` |

### Preserve Patterns

Lines containing these strings are excluded from branding transforms to prevent breaking internal references:

- `@opencode-ai/` — npm package scope (kept for upstream compatibility)
- `OPENCODE_` — environment variables and feature flags
- `.opencode/` — config directory path
- `packages/opencode` — internal package path
- `opencode.json` / `opencode.jsonc` — config file names
- `window.__OPENCODE__` — runtime globals
- `import { ` — import statements (would break code)

### Change Markers

Files in `packages/opencode/src/` that we've modified (but are not fully custom) use `altimate_change` markers to track our modifications:

```typescript
// altimate_change start — description of what we changed
... our modifications ...
// altimate_change end
```

These markers:
- Help identify our changes during conflict resolution
- Are audited by `analyze.ts` for integrity (unclosed blocks)
- Guide reviewers to focus on our custom logic vs upstream code

## How to Add New Branding Rules

1. Open `utils/config.ts`
2. Add your rule to the appropriate category array (e.g., `urlRules`, `githubRules`)
3. Place more specific patterns BEFORE less specific ones
4. Include a descriptive `description` field
5. Test with: `bun run script/upstream/analyze.ts --branding`

Example:

```typescript
// In the urlRules array:
{
  pattern: /newservice\.opencode\.ai/g,
  replacement: "newservice.altimate.ai",
  description: "New service subdomain",
},
```

## Troubleshooting

### Merge fails with "working tree has uncommitted changes"

```bash
# Option 1: Commit your changes
git add -A && git commit -m "wip: save work before merge"

# Option 2: Stash your changes
git stash
bun run script/upstream/merge.ts --version v1.2.21
git stash pop
```

### Conflicts remain after auto-resolution

The script lists remaining conflicts and exits. Resolve them manually:

```bash
# See what's still conflicted
git diff --name-only --diff-filter=U

# Open a conflicted file, resolve the markers (<<<, ===, >>>)
# Stage the resolved file
git add <file>

# Resume the merge
bun run script/upstream/merge.ts --continue
```

### Branding leaks detected after merge

```bash
# See all leaks with full detail
bun run script/upstream/analyze.ts --branding --verbose

# Some leaks are false positives (preserved patterns in new contexts)
# To fix real leaks: add a new branding rule or preserve pattern in config.ts
```

### Upstream remote not found

```bash
git remote add upstream https://github.com/anomalyco/opencode.git
git fetch upstream --tags
```

The merge script will auto-add the remote if missing.

### Aborting a merge in progress

```bash
# Abort the git merge
git merge --abort

# Switch back to your original branch
git checkout main

# Delete the merge branch
git branch -D upstream/merge-v1.2.21
```

### Recovering from a failed merge

The script creates a backup branch before starting:

```bash
# Find your backup branch
git branch | grep backup/

# Restore from backup
git checkout main
git reset --hard backup/main-2026-03-14T10-30-00
```

### State file left behind

If a merge was interrupted, a `.upstream-merge-state.json` file may remain in the repo root. It is safe to delete:

```bash
rm .upstream-merge-state.json
```

## CI Integration

The branding audit can be used as a CI gate:

```yaml
# .github/workflows/branding-check.yml
- name: Check for branding leaks
  run: bun run script/upstream/analyze.ts --branding --json
```

Exit code 1 means leaks were found, which can block the PR.

## Setup

```bash
# 1. Ensure upstream remote exists (auto-added by merge.ts if missing)
git remote add upstream https://github.com/anomalyco/opencode.git

# 2. Install dependencies for the merge tooling
cd script/upstream && bun install
```

## Inspiration

This tooling was inspired by [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode)'s upstream merge automation, adapted for Altimate Code's specific branding patterns and fork structure.
