/**
 * Pre-execution critic gate.
 *
 * Before a SIDE-EFFECTING tool runs (bash, write, edit, sql_execute, dbt_*), a
 * verifier checks the proposed args; on hard failure the call is denied and the
 * reason is fed back so the model can retry — instead of executing a bad action.
 *
 * The judgment plugs in via the `Verifier` interface. Two impls ship here:
 *   - `ALLOW_ALL`            — ungated (open); for tests / opt-out.
 *   - `basicSafetyVerifier`  — the wired default: a conservative, dependency-free
 *                              heuristic that blocks catastrophic, unambiguous
 *                              host-destructive bash (e.g. `rm -rf /`, fork bombs,
 *                              `mkfs`/`dd` on a raw device).
 *
 * This is a best-effort safety NET, NOT a security boundary or sandbox: a
 * determined caller can obfuscate around literal patterns (command substitution,
 * base64-decode-pipe-sh, etc.). Defense in depth lives elsewhere (OS sandbox, the
 * permission system, and a richer pluggable verifier the caller may inject).
 *
 * Pure + testable. Wired into session/prompt.ts, just before `item.execute(args, ctx)`.
 */

export namespace Critic {
  /**
   * Side-effecting tools worth gating, by their REAL registered tool ids (see
   * tool/registry.ts). Reads (glob/grep/read) are never gated. dbt builds/runs
   * are not a distinct tool — they execute via `bash`, which is gated.
   * NOTE: the gate is wired into the native ToolRegistry execute wrapper only;
   * MCP-provided tools run through a separate wrapper and are NOT gated. The
   * shipped `basicSafetyVerifier` is bash-only (a native tool), so this is a
   * no-op gap today — but a product injecting a verifier for `sql_execute`
   * must confirm it's a native, not MCP, tool.
   */
  export const DEFAULT_GATED = ["bash", "write", "edit", "sql_execute", "apply_patch"]

  export interface Verdict {
    ok: boolean
    reason?: string
  }

  /** The judgment interface. Default impl allows all (open). Product plugs a richer verifier. */
  export interface Verifier {
    verify(toolName: string, args: Record<string, unknown>): Verdict | Promise<Verdict>
  }

  export const ALLOW_ALL: Verifier = { verify: () => ({ ok: true }) }

  export function enabled(): boolean {
    return process.env["ALTIMATE_CRITIC_GATE"] === "1"
  }

  export function isGated(toolName: string, gated: string[] = DEFAULT_GATED): boolean {
    return gated.includes(toolName)
  }

  // ── Heuristic bash safety ──────────────────────────────────────────────────
  //
  // Targets that, combined with a recursive+force `rm`, mean catastrophic loss.
  // Deliberately ABSOLUTE only — `.`, `./` and bare `*` are NOT here: clearing
  // the working/build directory (`rm -rf *`, `rm -rf .`) is routine and safe in a
  // sandboxed workspace, and we have no `workdir` context to judge them.
  const RM_FATAL_TARGETS = new Set(["/", "/*", "/.", "/..", "~", "~/", "~/*", "$home", "$home/", "$home/*"])
  // Top-level system paths whose recursive deletion bricks the machine.
  const RM_FATAL_TOPLEVEL = [
    "/etc",
    "/usr",
    "/var",
    "/bin",
    "/sbin",
    "/boot",
    "/lib",
    "/lib64",
    "/sys",
    "/dev",
    "/proc",
    "/root",
    "/home",
    "/opt",
  ]

  // Transparent command prefixes: words that may precede the real command without
  // changing which command runs. Lets `sudo rm -rf /` and `bash -c "rm -rf /"`
  // still be seen as an `rm` in command position, while `git commit -m "rm -rf /"`
  // (rm buried in an argument) is not.
  const TRANSPARENT_PREFIX = new Set([
    "sudo",
    "doas",
    "nohup",
    "time",
    "env",
    "exec",
    "command",
    "builtin",
    "ionice",
    "nice",
    "setsid",
    "stdbuf",
    "then",
    "do",
    "else",
    "bash",
    "sh",
    "zsh",
    "dash",
    "ksh",
  ])

  function isFatalRmTarget(tok: string): boolean {
    // Normalize bash brace expansion: ${home} -> $home, ${home}/ -> $home/
    const norm = tok.replace(/^\$\{([a-z_]+)\}(\/.*)?$/, (_m, v, rest) => "$" + v + (rest ?? ""))
    if (RM_FATAL_TARGETS.has(tok) || RM_FATAL_TARGETS.has(norm)) return true
    // Catch a system path itself, its trailing-slash form, OR a glob wipe of its
    // contents (`/var/*`) — but NOT a scoped subpath like `/home/user/project`.
    return RM_FATAL_TOPLEVEL.some((p) => tok === p || tok === p + "/" || tok === p + "/*")
  }

  /**
   * Is the token at index `i` in COMMAND position (the start of a pipeline
   * segment), versus an argument to some other command? Walks left skipping
   * flags and transparent prefixes; a separator or the start means command
   * position, any other bareword means it's an argument.
   */
  function isCommandPosition(tokens: string[], i: number, sep: Set<string>): boolean {
    for (let j = i - 1; j >= 0; j--) {
      const t = tokens[j]
      if (sep.has(t)) return true
      if (t.startsWith("-")) continue // a flag (e.g. `sudo -E`, `bash -c`)
      if (TRANSPARENT_PREFIX.has(t)) continue
      // Inline env-var assignment preceding the command (e.g. `FOO=1 rm -rf /`,
      // `IFS=x rm ...`) — these don't change which command runs, so keep walking.
      if (/^[a-z_][a-z0-9_]*=/i.test(t)) continue
      return false // a real preceding word -> rm is an argument, not the command
    }
    return true // reached the start through only flags/prefixes
  }

  /**
   * Detect a catastrophic, unambiguous host-destructive bash command. Returns a
   * human reason when dangerous, else null. Conservative on purpose — it only
   * fires on the few patterns that are almost never legitimate. Quotes are
   * stripped so `bash -c "rm -rf /"` is still seen; this can over-match a command
   * that merely mentions such a string (acceptable: the gate is opt-in/off by default).
   */
  export function detectDangerousBash(raw: string): string | null {
    if (!raw || typeof raw !== "string") return null
    if (raw.length > 1_000_000) return null // cap — don't scan pathologically huge input
    // Normalize: drop quotes, collapse whitespace, lowercase for keyword/path matching.
    const norm = raw.replace(/['"`]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
    if (!norm) return null

    // Fork bomb: :(){ :|:& };:
    if (norm.replace(/\s+/g, "").includes(":|:&") || /:\s*\(\s*\)\s*\{/.test(norm)) {
      return "fork bomb"
    }
    // Explicit intent to remove the root filesystem.
    if (norm.includes("--no-preserve-root")) {
      return "rm with --no-preserve-root targets the root filesystem"
    }
    // mkfs on a block device.
    if (/\bmkfs(\.\w+)?\b/.test(norm) && /\/dev\//.test(norm)) {
      return "mkfs on a block device"
    }
    // dd writing to a raw disk.
    if (/\bdd\b/.test(norm) && /\bof=\/dev\/(sd|nvme|disk|hd|vd|mmcblk)/.test(norm)) {
      return "dd writing to a raw block device"
    }
    // Redirect over a raw disk.
    if (/>\s*\/dev\/(sd|nvme|disk|hd|vd|mmcblk)/.test(norm)) {
      return "redirect over a raw block device"
    }
    // Recursive chmod/chown of the root filesystem (short `-R`/`-rf` or long
    // `--recursive`, against bare `/` or a `/*` glob wipe).
    if (/\bch(mod|own)\b/.test(norm) && /(^|\s)(-[a-z]*r|--recursive)\b/.test(norm) && /\s\/\*?(\s|$)/.test(norm)) {
      return "recursive permission/ownership change on /"
    }
    // Recursive + force rm of a fatal target. Split shell separators into their
    // own tokens so they don't glue to a target (`/;`) and so EVERY `rm` in a
    // compound command is inspected — not just the last one.
    const SEP = new Set([";", "|", "&", ">", "<"])
    const tokens = norm
      .replace(/([;|&><])/g, " $1 ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
    for (let i = 0; i < tokens.length; i++) {
      // Match `rm` or a fully-qualified `/bin/rm`, but only in command position
      // (not when `rm -rf /` merely appears inside another command's argument).
      if (tokens[i] !== "rm" && !tokens[i].endsWith("/rm")) continue
      if (!isCommandPosition(tokens, i, SEP)) continue
      let recursive = false
      let force = false
      const targets: string[] = []
      for (let j = i + 1; j < tokens.length; j++) {
        const t = tokens[j]
        if (SEP.has(t)) break // end of this rm invocation
        if (t.startsWith("-")) {
          if (t === "--recursive" || (/^-[a-z]+$/.test(t) && t.includes("r"))) recursive = true
          if (t === "--force" || (/^-[a-z]+$/.test(t) && t.includes("f"))) force = true
        } else {
          targets.push(t)
        }
      }
      if (recursive && force) {
        for (const t of targets) {
          if (isFatalRmTarget(t)) return `recursive force-delete of "${t}"`
        }
      }
    }
    return null
  }

  /**
   * The wired default verifier. Blocks only catastrophic bash; everything else
   * (other gated tools, non-bash) is allowed. A product may inject a richer one.
   */
  export const basicSafetyVerifier: Verifier = {
    verify(toolName, args) {
      if (toolName !== "bash") return { ok: true }
      const reason = detectDangerousBash(String(args?.["command"] ?? ""))
      return reason ? { ok: false, reason } : { ok: true }
    },
  }

  export interface GateResult {
    allow: boolean
    /** when blocked, the message to feed back to the model in place of execution. */
    feedback?: string
  }

  /**
   * Decide whether a proposed tool call may execute. Non-gated tools always pass.
   * Gated tools are checked by the verifier; a not-ok verdict blocks with feedback.
   * NEVER throws — a critic failure must not break the agent (fail-open on error).
   */
  /** Max time to wait on a verifier before failing open. A hung verifier must
   *  never hang the agent. */
  export const VERIFIER_TIMEOUT_MS = 5000

  export async function gate(
    toolName: string,
    args: Record<string, unknown>,
    verifier: Verifier = ALLOW_ALL,
    gated: string[] = DEFAULT_GATED,
    timeoutMs: number = VERIFIER_TIMEOUT_MS,
  ): Promise<GateResult> {
    if (!enabled() || !isGated(toolName, gated)) return { allow: true }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // async IIFE so a synchronous throw in verify() rejects the promise (and is
      // caught below) rather than escaping the Promise.race.
      const verifyPromise = (async () => verifier.verify(toolName, args))()
      const timeout = new Promise<Verdict>((resolve) => {
        timer = setTimeout(() => resolve({ ok: true, reason: "__timeout__" }), timeoutMs)
        // don't keep the event loop alive for this guard timer
        ;(timer as any)?.unref?.()
      })
      const v = await Promise.race([verifyPromise, timeout])
      if (v.ok) return { allow: true }
      return {
        allow: false,
        feedback: `Blocked by altimate verifier before execution: ${v.reason ?? "failed validation"}. Fix and retry.`,
      }
    } catch {
      // Fail-open: observability/governance must never break core functionality.
      return { allow: true }
    } finally {
      // Clear the guard timer once the race settles (verify resolved first) so it
      // doesn't linger until timeout.
      if (timer) clearTimeout(timer)
    }
  }
}
