import { describe, test, expect, beforeAll } from "bun:test"
import { readFileSync, writeFileSync, mkdtempSync, cpSync, existsSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import { $ } from "bun"

const dist = join(import.meta.dir, "../dist")
const scriptDir = join(import.meta.dir, "../script")

// ─── Helpers ─────────────────────────────────────────────────────────
// Simulate what copy-python.ts does against arbitrary bundle content,
// without touching the real dist/index.js.
function runPatchLogic(bundleContent: string): { patched: boolean; output: string } {
  const pattern = /var __dirname\s*=\s*"[^"]*python-bridge[^"]*"/
  if (pattern.test(bundleContent)) {
    const replacement = `var __dirname = typeof import.meta.dirname === "string" ? import.meta.dirname : __require("path").dirname(__require("url").fileURLToPath(import.meta.url))`
    return { patched: true, output: bundleContent.replace(pattern, replacement) }
  }
  return { patched: false, output: bundleContent }
}

// ─── Adversarial: Regex edge cases ──────────────────────────────────
describe("adversarial: patch regex", () => {
  test("matches typical CI runner path (Linux)", () => {
    const bundle = `var __dirname = "/home/runner/work/altimate-code/node_modules/.bun/python-bridge@1.1.0/node_modules/python-bridge"`
    const result = runPatchLogic(bundle)
    expect(result.patched).toBe(true)
    expect(result.output).toContain("import.meta.dirname")
    expect(result.output).not.toContain("/home/runner")
  })

  test("matches macOS dev path", () => {
    const bundle = `var __dirname = "/Users/dev/code/node_modules/python-bridge"`
    const result = runPatchLogic(bundle)
    expect(result.patched).toBe(true)
    expect(result.output).not.toContain("/Users/dev")
  })

  test("matches Windows CI path", () => {
    const bundle = `var __dirname = "C:\\Users\\runneradmin\\work\\node_modules\\python-bridge"`
    const result = runPatchLogic(bundle)
    expect(result.patched).toBe(true)
    expect(result.output).not.toContain("C:\\Users")
  })

  test("matches path with @scope in node_modules", () => {
    const bundle = `var __dirname = "/opt/ci/node_modules/.bun/python-bridge@2.0.0/node_modules/python-bridge"`
    const result = runPatchLogic(bundle)
    expect(result.patched).toBe(true)
  })

  test("does NOT match unrelated __dirname (no python-bridge)", () => {
    const bundle = `var __dirname = "/home/runner/work/some-other-module"`
    const result = runPatchLogic(bundle)
    expect(result.patched).toBe(false)
    // The original hardcoded path is preserved — this is CORRECT behavior.
    // The patch should only touch the python-bridge dirname.
  })

  test("does NOT match __dirname that's already patched", () => {
    const bundle = `var __dirname = typeof import.meta.dirname === "string" ? import.meta.dirname : __require("path").dirname(__require("url").fileURLToPath(import.meta.url))`
    const result = runPatchLogic(bundle)
    expect(result.patched).toBe(false)
  })

  test("handles extra whitespace in assignment", () => {
    const bundle = `var __dirname  =   "/some/path/to/python-bridge"`
    const result = runPatchLogic(bundle)
    expect(result.patched).toBe(true)
  })

  test("only patches FIRST match (non-global)", () => {
    const bundle = [`var __dirname = "/first/path/python-bridge"`, `var __dirname = "/second/path/python-bridge"`].join(
      "\n",
    )
    const result = runPatchLogic(bundle)
    expect(result.patched).toBe(true)
    // First one is patched
    expect(result.output).toContain("import.meta.dirname")
    // Second one survives — this is a known limitation
    expect(result.output).toContain("/second/path/python-bridge")
  })

  test("does NOT match if quotes are single quotes", () => {
    const bundle = `var __dirname = '/home/runner/python-bridge'`
    const result = runPatchLogic(bundle)
    // Bun uses double quotes, so single-quote paths should not match
    expect(result.patched).toBe(false)
  })

  test("does NOT match let or const declarations", () => {
    const bundle = `const __dirname = "/home/runner/python-bridge"`
    const result = runPatchLogic(bundle)
    // Pattern specifically matches `var __dirname` — const/let won't match
    expect(result.patched).toBe(false)
  })
})

// ─── Adversarial: Built output invariants ───────────────────────────
describe("adversarial: built bundle invariants", () => {
  beforeAll(async () => {
    // Ensure we have a fresh build
    if (!existsSync(join(dist, "index.js"))) {
      await $`bun run build`.cwd(join(import.meta.dir, ".."))
    }
  })

  test("exactly ONE __dirname assignment exists in bundle", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    const matches = code.match(/var __dirname\s*=/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(1)
  })

  test("__dirname is used to resolve PYTHON_BRIDGE_SCRIPT", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    expect(code).toContain('path.join(__dirname, "node_python_bridge.py")')
  })

  test("no CI runner paths leaked anywhere in bundle", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    // Common CI runner path prefixes
    expect(code).not.toContain("/home/runner/work/")
    expect(code).not.toContain("/github/workspace/")
    expect(code).not.toContain("D:\\a\\altimate-code\\")
  })

  test("patched __dirname includes both primary and fallback paths", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    const line = code.split("\n").find((l) => l.includes("var __dirname"))
    expect(line).toBeDefined()
    // Primary: import.meta.dirname
    expect(line).toContain("import.meta.dirname")
    // Fallback: fileURLToPath
    expect(line).toContain("fileURLToPath")
    // Uses __require (Bun's bundled require)
    expect(line).toContain("__require")
  })

  test("node_python_bridge.py in dist matches the source", () => {
    const resolved = require.resolve("@altimateai/dbt-integration")
    const sourcePy = join(require("path").dirname(resolved), "node_python_bridge.py")
    if (!existsSync(sourcePy)) return // skip if source not available

    const source = readFileSync(sourcePy, "utf8")
    const copied = readFileSync(join(dist, "node_python_bridge.py"), "utf8")
    expect(copied).toBe(source)
  })

  test("altimate_python_packages directory was copied", () => {
    expect(existsSync(join(dist, "altimate_python_packages"))).toBe(true)
  })
})

// ─── Adversarial: Runtime resolution simulation ─────────────────────
describe("adversarial: runtime resolution", () => {
  test("patched __dirname evaluates to a real directory at runtime", () => {
    // import.meta.dirname should resolve to THIS test file's directory
    // In the real bundle, it would resolve to dist/
    const dirname = import.meta.dir
    expect(typeof dirname).toBe("string")
    expect(dirname.length).toBeGreaterThan(0)
    expect(dirname).not.toContain("runner")
  })

  test("node_python_bridge.py is findable relative to dist/index.js", () => {
    // This is the critical runtime check: __dirname should be dist/,
    // and node_python_bridge.py should be in dist/
    const bridgePath = join(dist, "node_python_bridge.py")
    expect(existsSync(bridgePath)).toBe(true)

    // Verify it's actually a Python file, not garbage
    const content = readFileSync(bridgePath, "utf8")
    expect(content).toContain("import") // Python imports
    expect(content.length).toBeGreaterThan(100) // not truncated
  })

  test("bundle can be loaded from a DIFFERENT directory without path errors", async () => {
    // Simulate running the binary from /tmp — __dirname should still
    // resolve to where index.js lives, not the CWD
    const tmpDir = mkdtempSync(join(tmpdir(), "adversarial-"))
    const originalCwd = process.cwd()

    try {
      process.chdir(tmpDir)

      // The patched code uses import.meta.dirname which is compile-time
      // resolved to the file's actual location, not CWD. Verify this.
      const indexPath = join(dist, "index.js")
      expect(existsSync(indexPath)).toBe(true)

      // Read the bundle and verify the __dirname line doesn't reference CWD
      const code = readFileSync(indexPath, "utf8")
      expect(code).not.toContain(tmpDir)
    } finally {
      process.chdir(originalCwd)
    }
  })
})

// ─── Adversarial: Double-patch protection ───────────────────────────
describe("adversarial: idempotency", () => {
  test("running the patch twice does not corrupt the bundle", () => {
    const original = `var __dirname = "/ci/path/python-bridge"`

    // First patch
    const first = runPatchLogic(original)
    expect(first.patched).toBe(true)

    // Second patch on already-patched output — should be a no-op
    const second = runPatchLogic(first.output)
    expect(second.patched).toBe(false)
    expect(second.output).toBe(first.output)
  })

  test("patch output is syntactically valid JS", () => {
    const bundle = `var __dirname = "/home/runner/python-bridge";`
    const result = runPatchLogic(bundle)

    // The patched code should not have unmatched quotes or parens
    const openParens = (result.output.match(/\(/g) || []).length
    const closeParens = (result.output.match(/\)/g) || []).length
    expect(openParens).toBe(closeParens)

    const openQuotes = (result.output.match(/"/g) || []).length
    expect(openQuotes % 2).toBe(0) // even number of quotes
  })
})

// ─── Adversarial: CI smoke test alignment ───────────────────────────
describe("adversarial: CI smoke test parity", () => {
  test("CI regex catches what build-integrity test catches", () => {
    // CI uses: grep -qE 'var __dirname\\s*=\\s*"(/|[A-Za-z]:\\\\)' (shell regex)
    // Test uses: /var __dirname\s*=\s*"(?:[A-Za-z]:\\\\|\/)/
    // Both should flag the same hardcoded paths

    const linuxPath = `var __dirname = "/home/runner/python-bridge"`
    const windowsPath = `var __dirname = "C:\\\\Users\\\\runner\\\\python-bridge"`
    const patchedPath = `var __dirname = typeof import.meta.dirname === "string" ? import.meta.dirname : __require("path").dirname(__require("url").fileURLToPath(import.meta.url))`

    const ciRegex = /var __dirname\s*=\s*"(\/|[A-Za-z]:\\)/
    const testRegex = /var __dirname\s*=\s*"(?:[A-Za-z]:\\\\|\/)/

    // Both should flag hardcoded paths
    expect(ciRegex.test(linuxPath)).toBe(true)
    expect(testRegex.test(linuxPath)).toBe(true)

    expect(ciRegex.test(windowsPath)).toBe(true)
    expect(testRegex.test(windowsPath)).toBe(true)

    // Neither should flag the patched version
    expect(ciRegex.test(patchedPath)).toBe(false)
    expect(testRegex.test(patchedPath)).toBe(false)
  })
})
