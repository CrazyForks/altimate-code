// altimate_change - new file
//
// Verify-and-escalate SHADOW capture (altimate-router verifier platform integration, phase 1).
//
// The verifier proves a cheap model's edit is behaviour-equivalent (sound oracle) and escalates
// the rest — but to measure its real false-ship φ + savings on LIVE traffic we first need the
// real before/after edits WITH full file context (the seam's advantage over mining transcript
// snippets). This records each edit to a local JSONL; an offline pass (altimate-router
// eval/phi) reconstructs runnable units and runs the verifier. SHADOW only: it never changes
// edit behaviour, is OFF unless ALTIMATE_VERIFY_SHADOW is set, and can never throw.
//
// Phase 2 (later): call the verifier live (verify-daemon / napi addon) and act on the Decision.
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { homedir } from "node:os"
import { Log } from "@/util/log"

const log = Log.create({ service: "verify-shadow" })

const EXT_LANG: Record<string, string> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sql: "sql",
}

function logPath(): string {
  return process.env["ALTIMATE_VERIFY_SHADOW_LOG"] || `${homedir()}/.altimate-router/edit-capture.jsonl`
}

export namespace VerifyShadow {
  export interface EditCapture {
    file: string
    before: string
    after: string
    oldString?: string
    newString?: string
  }

  /** Record an edit for offline verifier measurement. No-op unless ALTIMATE_VERIFY_SHADOW is
   *  set; fail-safe (never throws — observability must never break an edit). */
  export function captureEdit(input: EditCapture): void {
    if (!process.env["ALTIMATE_VERIFY_SHADOW"]) return
    try {
      const ext = input.file.split(".").pop()?.toLowerCase() ?? ""
      const record = {
        ts: Date.now(),
        file: input.file,
        language: EXT_LANG[ext] ?? ext,
        before: input.before,
        after: input.after,
        old_string: input.oldString,
        new_string: input.newString,
      }
      const path = logPath()
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, JSON.stringify(record) + "\n")
    } catch (e) {
      log.error("edit capture failed", { error: e instanceof Error ? e.message : String(e) })
    }
  }
}
