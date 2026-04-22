/**
 * Upgrade method detection and brew latest() tests.
 *
 * Validates the installation method detection logic and the
 * brew version resolution paths in installation/index.ts.
 */
import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const INSTALLATION_SRC = fs.readFileSync(
  path.resolve(import.meta.dir, "../../src/installation/index.ts"),
  "utf-8",
)

describe("installation method detection", () => {
  test("checks brew with correct formula name", () => {
    // method() must check for "altimate-code" not "opencode"
    expect(INSTALLATION_SRC).toContain('"altimate-code"')
  })

  test("npm detection uses scoped package name", () => {
    expect(INSTALLATION_SRC).toContain("@altimateai/altimate-code")
  })

  test("brew check command uses brew list --formula", () => {
    expect(INSTALLATION_SRC).toContain('"brew", "list", "--formula"')
  })

  test("method detection prioritizes matching exec path", () => {
    // checks.sort puts the manager matching process.execPath first
    expect(INSTALLATION_SRC).toContain("exec.includes(a.name)")
  })
})

describe("brew formula resolution", () => {
  test("getBrewFormula checks tap formula first", () => {
    expect(INSTALLATION_SRC).toContain("AltimateAI/tap/altimate-code")
  })

  test("getBrewFormula returns tap formula as default", () => {
    expect(INSTALLATION_SRC).toContain('return "AltimateAI/tap/altimate-code"')
  })
})

describe("brew latest() version resolution", () => {
  test("tap formula uses brew info --json=v2", () => {
    expect(INSTALLATION_SRC).toContain('"brew", "info", "--json=v2"')
  })

  test("non-tap formula does NOT use formulae.brew.sh", () => {
    // altimate-code is NOT in core homebrew — formulae.brew.sh would 404
    expect(INSTALLATION_SRC).not.toContain("formulae.brew.sh/api/formula/altimate-code.json")
  })

  test("non-tap brew uses GitHub releases API as source of truth", () => {
    // brew info --json=v2 returns LOCAL cached version which can be stale.
    // GitHub releases API is authoritative for the actual latest version.
    expect(INSTALLATION_SRC).toContain("api.github.com/repos/AltimateAI/altimate-code/releases/latest")
  })

  test("GitHub releases fallback strips v prefix from tag_name", () => {
    expect(INSTALLATION_SRC).toContain('tag_name.replace(/^v/, "")')
  })

  test("GitHub releases fallback validates tag_name exists", () => {
    expect(INSTALLATION_SRC).toContain("Missing tag_name")
  })
})

// altimate_change start — choco/scoop are NOT supported for altimate-code
describe("choco/scoop routing", () => {
  test("method() does not auto-detect choco by querying `choco list`", () => {
    // Auto-detect would match against UPSTREAM `opencode` installed alongside,
    // misrouting altimate-code upgrades to the wrong product. The sentinel
    // command must never exec a shell — it returns an empty promise instead.
    expect(INSTALLATION_SRC).not.toMatch(/"choco",\s*"list"/)
  })

  test("method() does not auto-detect scoop by querying `scoop list`", () => {
    expect(INSTALLATION_SRC).not.toMatch(/"scoop",\s*"list"/)
  })

  test("latest() does not query upstream chocolatey feed", () => {
    expect(INSTALLATION_SRC).not.toContain("community.chocolatey.org")
  })

  test("latest() does not query upstream scoop bucket", () => {
    expect(INSTALLATION_SRC).not.toContain("ScoopInstaller/Main/master/bucket/opencode.json")
  })

  test("upgrade() for choco/scoop returns a helpful error, not the wrong product", () => {
    // No `choco upgrade opencode` or `scoop install opencode@...` anywhere
    expect(INSTALLATION_SRC).not.toMatch(/"choco",\s*"upgrade",\s*"opencode"/)
    expect(INSTALLATION_SRC).not.toMatch(/"scoop",\s*"install",\s*`opencode@/)
    // Error message points the user to a supported install path
    expect(INSTALLATION_SRC).toContain("altimate-code is not distributed via")
    expect(INSTALLATION_SRC).toContain("https://altimate.ai/install")
  })

  test("upgrade() for choco/scoop emits upgrade_attempted status=error telemetry", () => {
    // The error-result object flows through the existing telemetry emission
    // block, so no separate emission is needed. Validate the result shape
    // exists (non-zero code + populated stderr) instead of duplicating track().
    expect(INSTALLATION_SRC).toMatch(/case "choco":\s*case "scoop"/)
    expect(INSTALLATION_SRC).toMatch(/code:\s*1/)
  })

  test("telemetryMethod preserves choco/scoop for analytics granularity", () => {
    // Earlier revision collapsed choco/scoop to "other" in telemetry. Now they
    // are retained so Windows users hitting the unsupported-method path are
    // distinguishable from truly generic "other" failures.
    expect(INSTALLATION_SRC).toMatch(/\["npm",\s*"bun",\s*"brew",\s*"choco",\s*"scoop"\]\.includes\(method\)/)
  })

  test("UpgradeResult named type exists (replaces as Awaited<ReturnType<...>> cast)", () => {
    expect(INSTALLATION_SRC).toMatch(/type UpgradeResult\s*=/)
    // And the synthesized choco/scoop result uses `satisfies UpgradeResult`
    // rather than a loose `as` cast. Check for an actual code occurrence of
    // the cast (trailing line break after the `>`), excluding backtick-wrapped
    // mentions in doc comments.
    expect(INSTALLATION_SRC).toContain("satisfies UpgradeResult")
    expect(INSTALLATION_SRC).not.toMatch(/}\s*as Awaited<ReturnType<typeof upgradeCurl>>/)
  })
})

describe("cmd/upgrade.ts — choco/scoop CLI hygiene", () => {
  const CMD_UPGRADE_SRC = fs.readFileSync(
    path.resolve(import.meta.dir, "../../src/cli/cmd/upgrade.ts"),
    "utf-8",
  )

  test("--method no longer exposes choco or scoop as valid choices", () => {
    // Users reading `altimate upgrade --help` must not see unsupported methods
    // that would lead them into the hard-fail path.
    expect(CMD_UPGRADE_SRC).toMatch(/choices:\s*\["curl",\s*"npm",\s*"pnpm",\s*"bun",\s*"brew"\]/)
    // Stricter: the choices list must not contain choco or scoop anywhere.
    const choicesMatch = CMD_UPGRADE_SRC.match(/choices:\s*\[([^\]]*)\]/)
    expect(choicesMatch).not.toBeNull()
    expect(choicesMatch![1]).not.toMatch(/"choco"/)
    expect(choicesMatch![1]).not.toMatch(/"scoop"/)
  })

  test("dead 'elevated command shell' branch removed from error handler", () => {
    // After the installation.ts fix, choco stderr is the synthesized
    // "altimate-code is not distributed via..." message, which never
    // contains the upstream choco UAC error string. The conditional branch
    // that checked for it is unreachable and must be removed.
    expect(CMD_UPGRADE_SRC).not.toMatch(/method === "choco"\s*&&\s*err\.data\.stderr\.includes\(/)
    expect(CMD_UPGRADE_SRC).not.toContain("not running from an elevated command shell")
    expect(CMD_UPGRADE_SRC).not.toContain("Please run the terminal as Administrator")
  })
})

describe("cmd/uninstall.ts — altimate-code package identifiers", () => {
  const UNINSTALL_SRC = fs.readFileSync(
    path.resolve(import.meta.dir, "../../src/cli/cmd/uninstall.ts"),
    "utf-8",
  )

  test("does not uninstall upstream opencode-ai via npm/pnpm/bun/yarn", () => {
    // Pre-fix: `npm uninstall -g opencode-ai` would fail silently (wrong
    // product) or uninstall upstream opencode if present. Must use altimate.
    expect(UNINSTALL_SRC).not.toMatch(/"(npm|pnpm|bun|yarn)",?\s*(?:"global")?,?\s*"(?:uninstall|remove)",?\s*"-g"?,?\s*"opencode-ai"/)
    expect(UNINSTALL_SRC).not.toMatch(/"opencode-ai"/)
  })

  test("does not uninstall upstream opencode via brew", () => {
    expect(UNINSTALL_SRC).not.toMatch(/"brew",\s*"uninstall",\s*"opencode"/)
    expect(UNINSTALL_SRC).not.toMatch(/brew uninstall opencode\b/)
  })

  test("uses altimate-code package names", () => {
    expect(UNINSTALL_SRC).toContain("@altimateai/altimate-code")
    expect(UNINSTALL_SRC).toContain('"brew", "uninstall", "altimate-code"')
  })

  test("does not attempt choco or scoop uninstall (we don't publish there)", () => {
    expect(UNINSTALL_SRC).not.toMatch(/"choco",\s*"uninstall"/)
    expect(UNINSTALL_SRC).not.toMatch(/"scoop",\s*"uninstall"/)
    // The old choco-specific "-y -r" flag branch and "elevated command shell"
    // check are both unreachable now and must be removed.
    expect(UNINSTALL_SRC).not.toContain('"-y", "-r"')
    expect(UNINSTALL_SRC).not.toContain("not running from an elevated command shell")
  })
})
// altimate_change end

describe("upgrade execution", () => {
  test("npm upgrade uses scoped package name", () => {
    expect(INSTALLATION_SRC).toContain("@altimateai/altimate-code@${target}")
  })

  test("brew upgrade taps AltimateAI/tap", () => {
    expect(INSTALLATION_SRC).toContain('"brew", "tap", "AltimateAI/tap"')
  })

  test("brew upgrade pulls latest formula before upgrading", () => {
    expect(INSTALLATION_SRC).toContain('"git", "pull", "--ff-only"')
  })

  test("brew upgrade disables auto-update", () => {
    expect(INSTALLATION_SRC).toContain("HOMEBREW_NO_AUTO_UPDATE")
  })

  test("curl upgrade uses altimate.ai/install endpoint", () => {
    expect(INSTALLATION_SRC).toContain("https://altimate.ai/install")
  })

  test("VERSION normalization strips v prefix", () => {
    expect(INSTALLATION_SRC).toContain('OPENCODE_VERSION.trim().replace(/^v/, "")')
  })
})

describe("version comparison in upgrade command", () => {
  /**
   * Simulate the version comparison logic from cmd/upgrade.ts.
   * Both sides must be normalized for comparison to work.
   */
  function wouldSkipUpgrade(currentVersion: string, target: string): boolean {
    return currentVersion === target
  }

  test("matching versions skip upgrade", () => {
    expect(wouldSkipUpgrade("0.4.9", "0.4.9")).toBe(true)
  })

  test("different versions proceed with upgrade", () => {
    expect(wouldSkipUpgrade("0.4.8", "0.4.9")).toBe(false)
  })

  test("v-prefixed current would NOT match clean target (documents the fix)", () => {
    // Before the fix, VERSION could be "v0.4.9" and target "0.4.9"
    // This would incorrectly proceed with upgrade even when versions match
    expect(wouldSkipUpgrade("v0.4.9", "0.4.9")).toBe(false)
    // After the fix, both are clean — comparison works correctly
    const normalized = "v0.4.9".replace(/^v/, "")
    expect(wouldSkipUpgrade(normalized, "0.4.9")).toBe(true)
  })
})
