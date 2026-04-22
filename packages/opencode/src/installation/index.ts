import { BusEvent } from "@/bus/bus-event"
import path from "path"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "../util/log"
import { iife } from "@/util/iife"
import { Flag } from "../flag/flag"
import { Process } from "@/util/process"
import { buffer } from "node:stream/consumers"
// altimate_change start — telemetry (lazy import to avoid circular dep with Telemetry → Installation)
let _telemetryCache: (typeof import("../telemetry"))["Telemetry"] | undefined
async function getTelemetry() {
  if (_telemetryCache) return _telemetryCache
  const { Telemetry } = await import("../telemetry")
  _telemetryCache = Telemetry
  return Telemetry
}
// altimate_change end

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export namespace Installation {
  const log = Log.create({ service: "installation" })

  async function text(cmd: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    return Process.text(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      nothrow: true,
    }).then((x) => x.text)
  }

  // altimate_change start — explicit UpgradeResult type
  // Shape shared by Process.run() and upgradeCurl() results plus the
  // synthesized failure results used for unsupported methods (choco/scoop).
  // Using a named type avoids `as Awaited<ReturnType<typeof upgradeCurl>>`
  // casts that silently accept mismatches if the real return shape drifts.
  type UpgradeResult = { code: number; stdout: Buffer; stderr: Buffer }
  // altimate_change end

  async function upgradeCurl(target: string): Promise<UpgradeResult> {
    const body = await fetch("https://altimate.ai/install").then((res) => {
      if (!res.ok) throw new Error(res.statusText)
      return res.text()
    })
    const proc = Process.spawn(["bash"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        VERSION: target,
      },
    })
    if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")
    proc.stdin.end(body)
    const [code, stdout, stderr] = await Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
    return {
      code,
      stdout,
      stderr,
    }
  }

  export type Method = Awaited<ReturnType<typeof method>>

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export async function method() {
    if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".local", "bin"))) return "curl"
    const exec = process.execPath.toLowerCase()

    const checks = [
      {
        name: "npm" as const,
        command: () => text(["npm", "list", "-g", "--depth=0"]),
      },
      {
        name: "yarn" as const,
        command: () => text(["yarn", "global", "list"]),
      },
      {
        name: "pnpm" as const,
        command: () => text(["pnpm", "list", "-g", "--depth=0"]),
      },
      {
        name: "bun" as const,
        command: () => text(["bun", "pm", "ls", "-g"]),
      },
      // altimate_change start — brew formula name
      {
        name: "brew" as const,
        command: () => text(["brew", "list", "--formula", "altimate-code"]),
      },
      // altimate_change end
      // altimate_change start — choco/scoop are supported as an input (--method=choco)
      // so callers still type-check, but we do NOT auto-detect them. The sentinel
      // commands below return empty strings; combined with the `installedName`
      // check further down, these entries can never match. Auto-detecting would
      // match upstream `opencode` (the wrong product) installed alongside.
      {
        name: "scoop" as const,
        command: () => Promise.resolve(""),
      },
      {
        name: "choco" as const,
        command: () => Promise.resolve(""),
      },
      // altimate_change end
    ]

    checks.sort((a, b) => {
      const aMatches = exec.includes(a.name)
      const bMatches = exec.includes(b.name)
      if (aMatches && !bMatches) return -1
      if (!aMatches && bMatches) return 1
      return 0
    })

    for (const check of checks) {
      const output = await check.command()
      // altimate_change start — package names for detection
      // choco/scoop entries above are sentinels (empty-string commands), so
      // they can never match here; only brew + npm-family can resolve.
      const installedName = check.name === "brew" ? "altimate-code" : "@altimateai/altimate-code"
      // altimate_change end
      if (output.includes(installedName)) {
        return check.name
      }
    }

    return "unknown"
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  // altimate_change start — brew formula detection
  async function getBrewFormula() {
    const tapFormula = await text(["brew", "list", "--formula", "AltimateAI/tap/altimate-code"])
    if (tapFormula.includes("altimate-code")) return "AltimateAI/tap/altimate-code"
    const coreFormula = await text(["brew", "list", "--formula", "altimate-code"])
    if (coreFormula.includes("altimate-code")) return "altimate-code"
    return "AltimateAI/tap/altimate-code"
  }
  // altimate_change end

  export async function upgrade(method: Method, target: string) {
    let result: UpgradeResult | undefined
    switch (method) {
      case "curl":
        result = await upgradeCurl(target)
        break
      case "npm":
        result = await Process.run(["npm", "install", "-g", `@altimateai/altimate-code@${target}`], { nothrow: true })
        break
      case "pnpm":
        result = await Process.run(["pnpm", "install", "-g", `@altimateai/altimate-code@${target}`], { nothrow: true })
        break
      case "bun":
        result = await Process.run(["bun", "install", "-g", `@altimateai/altimate-code@${target}`], { nothrow: true })
        break
      case "brew": {
        const formula = await getBrewFormula()
        const env = {
          HOMEBREW_NO_AUTO_UPDATE: "1",
          ...process.env,
        }
        if (formula.includes("/")) {
          const tap = await Process.run(["brew", "tap", "AltimateAI/tap"], { env, nothrow: true })
          if (tap.code !== 0) {
            result = tap
            break
          }
          const repo = await Process.text(["brew", "--repo", "AltimateAI/tap"], { env, nothrow: true })
          if (repo.code !== 0) {
            result = repo
            break
          }
          const dir = repo.text.trim()
          if (dir) {
            const pull = await Process.run(["git", "pull", "--ff-only"], { cwd: dir, env, nothrow: true })
            if (pull.code !== 0) {
              result = pull
              break
            }
          }
        }
        result = await Process.run(["brew", "upgrade", formula], { env, nothrow: true })
        break
      }

      // altimate_change start — choco/scoop not supported; return a helpful error
      // (in place of upstream's `choco upgrade opencode` / `scoop install opencode`,
      // which install the wrong product).
      case "choco":
      case "scoop": {
        const msg =
          `altimate-code is not distributed via ${method}. ` +
          `Reinstall via npm (\`npm install -g @altimateai/altimate-code\`), ` +
          `Homebrew (\`brew install AltimateAI/tap/altimate-code\`), ` +
          `or the install script at https://altimate.ai/install`
        result = {
          code: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(msg),
        } satisfies UpgradeResult
        break
      }
      // altimate_change end
      default:
        throw new Error(`Unknown method: ${method}`)
    }
    // altimate_change start — telemetry for upgrade result
    // choco/scoop are retained as distinct values so analytics can distinguish
    // Windows users hitting the unsupported-method path from generic "other"
    // failures. See the upgrade_attempted event definition in telemetry/index.ts.
    const telemetryMethod = (["npm", "bun", "brew", "choco", "scoop"].includes(method) ? method : "other") as
      | "npm"
      | "bun"
      | "brew"
      | "choco"
      | "scoop"
      | "other"
    if (!result || result.code !== 0) {
      const stderr = result?.stderr.toString("utf8") || ""
      const T = await getTelemetry()
      T.track({
        type: "upgrade_attempted",
        timestamp: Date.now(),
        session_id: T.getContext().sessionId || "cli",
        from_version: VERSION,
        to_version: target,
        method: telemetryMethod,
        status: "error",
        error: stderr.slice(0, 500),
      })
      throw new UpgradeFailedError({
        stderr: stderr,
      })
    }
    log.info("upgraded", {
      method,
      target,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    const T2 = await getTelemetry()
    T2.track({
      type: "upgrade_attempted",
      timestamp: Date.now(),
      session_id: T2.getContext().sessionId || "cli",
      from_version: VERSION,
      to_version: target,
      method: telemetryMethod,
      status: "success",
    })
    // altimate_change end
    await Process.text([process.execPath, "--version"], { nothrow: true })
  }

  // altimate_change start — normalize VERSION: strip "v" prefix from CI git tag
  export const VERSION = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION.trim().replace(/^v/, "") : "local"
  // altimate_change end
  export const CHANNEL = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
  export const USER_AGENT = `altimate-code/${CHANNEL}/${VERSION}/${Flag.OPENCODE_CLIENT}`

  export async function latest(installMethod?: Method) {
    const detectedMethod = installMethod || (await method())

    if (detectedMethod === "brew") {
      const formula = await getBrewFormula()
      if (formula.includes("/")) {
        const infoJson = await text(["brew", "info", "--json=v2", formula])
        const info = JSON.parse(infoJson)
        const version = info.formulae?.[0]?.versions?.stable
        if (!version) throw new Error(`Could not detect version for tap formula: ${formula}`)
        return version
      }
      // altimate_change start — brew: use GitHub releases API as source of truth
      // altimate-code is NOT in core homebrew, so formulae.brew.sh will 404.
      // `brew info --json=v2` returns the LOCAL cached version which can be stale
      // if the tap hasn't been updated — using it would cause `latest()` to return
      // the already-installed version, making the upgrade command skip silently.
      // GitHub releases API is the authoritative source for the actual latest version.
      return fetch("https://api.github.com/repos/AltimateAI/altimate-code/releases/latest")
        .then((res) => {
          if (!res.ok) throw new Error(`GitHub releases API: ${res.status} ${res.statusText}`)
          return res.json()
        })
        .then((data: any) => {
          if (!data.tag_name) throw new Error("Missing tag_name in GitHub releases response")
          return data.tag_name.replace(/^v/, "")
        })
      // altimate_change end
    }

    if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
      const registry = await iife(async () => {
        const r = (await text(["npm", "config", "get", "registry"])).trim()
        const reg = r || "https://registry.npmjs.org"
        return reg.endsWith("/") ? reg.slice(0, -1) : reg
      })
      const channel = CHANNEL
      // altimate_change start — npm package name for version check
      return fetch(`${registry}/@altimateai/altimate-code/${channel}`)
      // altimate_change end
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    // altimate_change start — choco/scoop not supported; fall through to GitHub releases API
    // Upstream opencode queried chocolatey/scoop for the `opencode` package, which
    // returns the wrong product's version. altimate-code is not published to
    // either manager, so treat these methods like any other: use GitHub releases
    // as the source of truth. This keeps `latest()` returning the right version
    // even if detection somehow surfaced choco/scoop (e.g., via --method=choco).
    // altimate_change end

    return fetch("https://api.github.com/repos/AltimateAI/altimate-code/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}
