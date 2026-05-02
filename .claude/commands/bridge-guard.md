---
description: Audit a v1.4.0-style upstream bridge merge for the regression patterns that bit us last time. Catches brand leaks, behavior patches lost to overwrite, split-brain module pairs, and test fixtures locked to old APIs. Run after the bridge merge tool produces a PR, before merging to main.
---

# Bridge Merge Audit

Run this after `script/upstream/bridge-merge.ts` (or any large upstream merge) produces a PR. Catches the regression classes that v1.4.0 shipped before we built the three-layer safety net (commits `3a6b59bdea` + `13ba57f7f1`).

## Input

`$ARGUMENTS` = PR number, or empty to detect from current branch via `gh pr view`. Branch name typically `upstream/merge-vX.Y.Z`.

## Why this skill exists

The v1.4.0 bridge merge shipped 16 user-impacting regressions across 30 files. Root cause: many altimate customizations were never wrapped in `altimate_change` markers, so the bridge merge tool — working as designed — overwrote them with upstream's version. The branding scan was too narrow to catch user-visible bare `opencode` strings; behavior patches (function calls, retry loops, default values) had no marker discipline at all.

This skill walks the auditor through every regression class we've actually seen, with the exact greps + code reads to detect each one. **Treat the patterns as a checklist, not a suggestion** — every item below was a real bug in v1.4.0 that reached the user before we caught it.

## Step 0: Setup

```bash
git fetch origin
gh pr view --json number,title,headRefName,baseRefName,url
git checkout <merge-branch>
git status --short
```

If working tree is dirty, stop. Capture base SHA: `BASE=$(git merge-base HEAD origin/main)`. The audit compares HEAD vs `$BASE`.

## Step 1: Run the three-layer tooling check (mandatory, do this first)

```bash
bun run script/upstream/analyze.ts --branding --strict
bun run script/upstream/analyze.ts --require-markers --strict
bun run script/upstream/analyze.ts --markers --base main --strict
```

All three must pass before continuing. If `--branding` flags leaks: those are user-visible strings the broadened scan caught (yargs describe, console output, User-Agent, MCP client name, OIDC audience, etc.). Fix each before moving on.

If `--require-markers` flags missing markers: behavioral patches in known-vulnerable files were lost. Restore them or remove the file from `config.requireMarkers` if it no longer holds patches.

If `--markers` flags unmarked changes: code modifications to upstream-shared files that need wrapping.

## Step 2: Diff scope reconnaissance

```bash
git diff main --stat -- packages/opencode/src/ | tail -5
git diff main --name-only -- packages/opencode/src/ | wc -l
```

If >100 files changed, this is a major bridge merge — every step below is mandatory. If <50 files, you can be more selective but still hit the high-risk categories.

Spawn parallel audit subagents to cover the diff in chunks. Each agent gets the regression catalog in Step 3 and reports findings. Three concurrent agents work well: one for `cli/` + `tui/`, one for `session/` + `server/` + `permission/`, one for everything else.

## Step 3: The regression catalog

Each pattern below names a class of bug, where it lives, the exact grep to detect it, and the fix shape. Walk every category — they each bit us in v1.4.0.

### 3.1 Split-brain module pairs

**Symptom:** Two modules export the same API + emit the same bus events, but each owns its own state. HTTP route calls one, runtime calls the other. Replies hit empty maps; tools deadlock forever.

**v1.4.0 instance:** `Permission` (Effect-TS, `src/permission/index.ts`) vs `PermissionNext` (vanilla, `src/permission/next.ts`). Tool calls invoked `PermissionNext.ask`; HTTP `POST /permission/{id}/reply` route invoked `Permission.reply`. Result: every permission round-trip silently no-op'd, tool dispatch hung, "Allow once" looped back to the same prompt forever.

**Detect:**
```bash
# Find duplicate BusEvent.define names (the smoking gun)
grep -rA3 'BusEvent\.define(' packages/opencode/src/ | grep -oE '"[a-z][a-z0-9._]*"' | sort | uniq -d

# Find sibling modules with overlapping APIs
find packages/opencode/src -name "next.ts" -o -name "*-next.ts"
# For each, check who imports the original vs the -next variant
```

**Fix:** Verify every HTTP route handler calls the same module the runtime ask side calls. The `requireMarkers` allowlist in `script/upstream/utils/config.ts` already includes `server/routes/permission.ts` and `server/routes/session.ts` — so the bridge tool now refuses to overlay them. But check any newly-introduced sibling modules.

### 3.2 Test fixtures locked to old API

**Symptom:** Tests pass type-check but fail at runtime because they use `adaptor.fetch(...)` while production code now uses `adaptor.target()`. Often labeled with `// @ts-nocheck` or "DRAFT" comments.

**v1.4.0 instance:** `test/control-plane/session-proxy-middleware.test.ts` had a TestAdaptor implementing `fetch` only. Production middleware called `(adaptor as any).fetch(...)` with a misleading marker comment claiming `fetch` was a "v1.4.0-only API not in main" — the comment had the upstream direction reversed.

**Detect:**
```bash
grep -rn '@ts-nocheck' packages/opencode/test 2>&1 | head -10
grep -rn '(adaptor as any)' packages/opencode/src 2>&1
grep -rn 'as any).fetch\|as any).target' packages/opencode 2>&1
```

**Fix:** When a marker comment claims an API "is upstream-only" or "not in main," verify by reading the type definition. If the comment is wrong, rewrite to use the new API and update the test fixture.

### 3.3 Brand strings in user-visible contexts

**Symptom:** `describe:` text, `console.log` strings, `UI.println` arguments, MCP `clientInfo.name`, `User-Agent` headers, OIDC audience, GitHub workflow YAML — all reverted to `opencode`.

**v1.4.0 instances:** 11+ files (`cli/cmd/serve.ts`, `web.ts`, `uninstall.ts`, `pr.ts`, `mcp.ts`, `error.ts`, `dialog-status.tsx`, `error-component.tsx`, `ui.ts` non-TTY wordmark, `github.ts` sweeping revert, `plugin/codex.ts` UA strings, `plugin/copilot.ts` UA strings, `network.ts` mDNS).

**Detect:** This is exactly what the broadened branding scan catches now. If Step 1 passed, you're already covered. But also do a manual spot-check:

```bash
# Anything that says "opencode" in user-visible string contexts
grep -rE 'describe:\s*["`'\''`][^"`'\''`]*opencode' packages/opencode/src/cli/cmd/
grep -rE 'console\.(log|error)\s*\([^)]*opencode' packages/opencode/src/ | grep -v "altimate_change"
grep -rE 'User-Agent.*opencode/\$\{' packages/opencode/src/
```

**Fix:** Replace `opencode` → `altimate-code` (or `altimate` for some contexts — the User-Agent for chat headers uses `altimate/`, the binary name uses `altimate-code/`). Wrap each fix in `altimate_change start — upstream_fix: ... / altimate_change end`.

### 3.4 Logo / color / theme regressions (visible at TUI startup)

**Symptom:** ASCII logo glyphs replaced; brand colors swapped from `theme.primary` / `theme.accent` to monochrome `theme.textMuted` / `theme.text`; theme palette tokens darkened (Subtext1 → Overlay2).

**v1.4.0 instances:** `cli/logo.ts` (ALTIMATE | CODE → OPEN | CODE), `tui/component/logo.tsx` (primary/accent → textMuted/text), three Catppuccin variants (Subtext1 → Overlay2).

**Detect:**
```bash
# Logo glyph diff
git diff main -- packages/opencode/src/cli/logo.ts
# Logo render colors diff
git diff main -- packages/opencode/src/cli/cmd/tui/component/logo.tsx
# Theme palette tokens (Subtext1 vs Overlay2 etc)
git diff main -- packages/opencode/src/cli/cmd/tui/context/theme/
```

**Fix:** Restore main's version. The catppuccin JSON files are now in `keepOurs` so this shouldn't recur. Logo files are in `requireMarkers` — markers are required. Logo TSX uses `theme.primary` (warm orange `#fab283`) on the left half + `theme.accent` (purple `#9d7cd8`) on the right.

### 3.5 Behavior patches lost (invisible to string scans)

**Symptom:** A function call disappears, a `setTimeout(..., 0)` wrapper is removed, a retry loop becomes a single attempt, a defensive `.catch(() => undefined)` is dropped. No string change — only a behavioral diff.

**v1.4.0 instances (all silent until users hit them):**
- `project/bootstrap.ts` — `Truncate.init()` call dropped; tool-output dir grows unboundedly forever.
- `provider/models.ts` — `setTimeout(..., 0)` deferral removed around the initial `ModelsDev.refresh()`; circular-dep risk on cold start (the bug altimate commit `980efaab64` was originally added to fix).
- `plugin/codex.ts` — OAuth refresh retry loop (3 attempts, 4xx-vs-5xx aware) removed; transient network blips now hard-fail user sessions. Also the 30s token-expiry skew buffer was removed.
- `control-plane/workspace.ts` — `.catch(() => undefined)` defensive swallow dropped; transient network blip kills the SSE reconnect loop forever. Local workspaces also `return`ed out of the loop forever.
- `session/message-v2.ts` — opaque-error augmentation (PR #118/#133) replaced with bare `errorMessage(e)`; bare "Error" / matching name strings leak through to TUI.
- TUI components (`clipboard.ts`, `dialog-workspace-list.tsx`, `dialog-mcp.tsx`) — `Log.Default.debug/error/info` replaced with `console.log/error`. `console.*` writes directly to terminal mid-render and corrupts the TUI display.

**Detect:** No automated scan can catch these. Read every changed file in `requireMarkers` line-by-line, compare to `git show main:<path>`. Look for:

```bash
# Functions whose call sites disappeared
git diff main -- packages/opencode/src/ | grep -E "^- *[A-Z][a-zA-Z]*\.[a-zA-Z]+\(\)"
# setTimeout / setInterval wrappers removed
git diff main -- packages/opencode/src/ | grep -B2 -A2 "^-.*setTimeout"
# .catch handlers dropped
git diff main -- packages/opencode/src/ | grep "^-.*\.catch("
# Log.Default replaced with console
git diff main -- packages/opencode/src/cli/cmd/tui/ | grep -B1 "console\."
```

**Fix:** For each behavior diff, look at the surrounding altimate commit history (`git log --follow main -- <file>`) to see if the patch was intentional. Restore + wrap in `altimate_change start — upstream_fix: ... / end` markers. Add the file to `requireMarkers` if not already there.

### 3.6 New altimate-only files dropped to upstream-deleted-review

**Symptom:** Files that exist in main but not in upstream (e.g., `src/memory/**`, `src/altimate/**`) get classified as `upstreamDeletedReview` by `bridge-merge.ts`. The tool keeps them but flags for human review. If reviewer skips → file might be removed by mistake.

**v1.4.0 instance:** `packages/opencode/src/memory/**` (altimate_memory_* tool family) was in `upstreamDeletedReview` until I added it to `keepOurs`.

**Detect:** Open `.bridge-merge-report.md` (the report file the bridge tool writes) and look at the "Files in main but not in v1.4.0 — REVIEW" section. Anything altimate-owned should already be in `keepOurs`.

**Fix:** Add the file's parent directory to `keepOurs` glob in `script/upstream/utils/config.ts`.

### 3.7 Internal scripts that wrap upstream binary names

**Symptom:** `script/beta.ts`, `script/raw-changelog.ts`, `packages/script/src/index.ts` use literal `opencode` references when they should use `altimate-code` (binary name) or filter against upstream's bot identity.

**Detect:**
```bash
grep -n "opencode" script/beta.ts script/raw-changelog.ts packages/script/src/index.ts
```

**Fix:** Two cases:
- Spawning a binary (`$\`opencode run\``) → must be `altimate-code run` (the upstream binary isn't installed).
- Filtering bot identities for changelog generation (`["actions-user", "opencode", "opencode-agent[bot]"]`) → these are the upstream identities we filter AGAINST. Keep them; wrap the array in `altimate_change start — intentional: filters upstream bot ... / end`.

## Step 4: Verify the safety net itself

The three-layer defense is only useful if the lists stay current. After fixing all findings:

```bash
# Every file we just touched should be in requireMarkers (if it holds patches)
# OR keepOurs (if it's pure altimate)
git diff main --name-only -- packages/opencode/src/ | while read f; do
  in_require=$(grep -c "\"$f\"" script/upstream/utils/config.ts)
  in_keep=$(grep -c "\"$f\"\|$(dirname $f)/\*\*" script/upstream/utils/config.ts)
  has_marker=$(grep -l "altimate_change" "$f" 2>/dev/null)
  if [ -z "$has_marker" ] && [ "$in_require" -eq 0 ] && [ "$in_keep" -eq 0 ]; then
    echo "UNPROTECTED: $f"
  fi
done
```

Files printed by `UNPROTECTED:` are vulnerable to the next bridge merge — either add markers, add to `requireMarkers`, or add the parent directory to `keepOurs`.

## Step 5: Functional verification

Tooling checks aren't enough. Each behavior class needs a runtime check:

```bash
# Typecheck the whole tree
bun turbo typecheck

# Focused suites that exercise the regressions
cd packages/opencode
bun test test/upstream test/permission test/server test/util/error.test.ts test/control-plane

# Full suite (some flaky failures under heavy parallel load are expected;
# verify each failure passes in isolation before treating it as a real regression)
bun test --timeout 30000
```

For UI/TUI changes, build a local binary and visually verify:

```bash
bun --cwd packages/opencode run build:local
INSTALL_DIR="$(npm root -g)/@altimateai/altimate-code"
cp packages/opencode/dist/*/bin/altimate-code "$INSTALL_DIR/bin/altimate-code"
altimate-code   # check: logo colors, brand strings, permission flow
```

Critical end-to-end test: trigger a permission prompt and verify "Allow once" / "Allow always" / "Reject" all unblock the tool dispatch (this is the v1.4.0 deadlock scenario — see `test/upstream/v140-permission-deadlock.test.ts` for a runtime regression test).

## Step 6: Sign-off

Before approving the PR, confirm:

- [ ] `bun run script/upstream/analyze.ts --branding --strict` — 0 leaks
- [ ] `bun run script/upstream/analyze.ts --require-markers --strict` — every file in the list has markers
- [ ] `bun run script/upstream/analyze.ts --markers --base main --strict` — every change in upstream-shared files has markers
- [ ] `bun turbo typecheck` — 5/5 packages clean
- [ ] Walked Step 3 categories 3.1–3.7 explicitly. Don't skip categories — every one was a real bug in v1.4.0.
- [ ] Each fix is wrapped in `altimate_change start — upstream_fix: ... / altimate_change end`
- [ ] Any new altimate-only directory is in `keepOurs` glob
- [ ] Any newly-discovered patched file is in `requireMarkers`
- [ ] Local TUI smoke-test passes (logo, permission flow, key strokes)
- [ ] Full test suite passes; any failures are confirmed pre-existing flakes (pass in isolation, present before the merge branch)

## Reference: where everything lives

| Tool / list | Location | Purpose |
|---|---|---|
| Branding leak scan | `script/upstream/analyze.ts` `LEAK_PATTERNS` | Catches user-visible bare `opencode` strings |
| `requireMarkers` allowlist | `script/upstream/utils/config.ts` field | Files that must keep their `altimate_change` markers |
| `keepOurs` globs | `script/upstream/utils/config.ts` field | Files the bridge merge tool never overlays |
| `skipFiles` globs | `script/upstream/utils/config.ts` field | Upstream files to discard entirely |
| Bridge merge tool | `script/upstream/bridge-merge.ts` | Produces the merge plan + applies the overlay |
| Marker check (CI) | `script/upstream/analyze.ts --markers` | Flags new code in upstream-shared files without markers |
| v1.4.0 regression tests | `packages/opencode/test/upstream/v140-*.test.ts` | Lock the regression patterns at the test level |
| Defensive runtime test | `packages/opencode/test/upstream/v140-permission-deadlock.test.ts` | End-to-end ask→reply→resolve regression test for the split-brain class |

## Reference: relevant commits

- `33ffd9c51f` — Permission split-brain fix (route to PermissionNext)
- `7a91221d05` — Runtime e2e regression test for the deadlock scenario
- `e203a9ade1` — Logo glyph restore (ALTIMATE | CODE)
- `72c215d042` — Logo brand color restore (theme.primary + theme.accent)
- `3a6b59bdea` — 16-regression line-by-line audit fix
- `13ba57f7f1` — Three-layer regression backstop (broadened scan + requireMarkers + retroactive sweep)
- `b84264255a`+ — Original v1.4.0 bridge merge (the one that introduced the regressions — read its diff to understand the upstream attack surface)

$ARGUMENTS
