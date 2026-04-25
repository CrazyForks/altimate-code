/**
 * Audit unwrapped altimate edits.
 *
 * For every file in main that is upstream-shared (not in keepOurs / skipFiles),
 * diff against a synthetic upstream base (default: v1.3.17) and report every
 * added/changed line that is NOT inside an `altimate_change` block.
 *
 * Output: per-file list of unwrapped edit hunks. Used to prep main for a
 * bridge merge to a future upstream version — wrap these in markers first
 * so the overlay doesn't silently lose them.
 */

import { $ } from "bun"
import path from "path"
import { writeFileSync, existsSync, readFileSync } from "fs"
import { parseArgs } from "util"
import { loadConfig, repoRoot, type MergeConfig } from "./utils/config.ts"
import * as logger from "./utils/logger.ts"
import { bold, cyan, dim, green, yellow, red } from "./utils/logger.ts"

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    base: { type: "string", default: "v1.3.17" },
    out: { type: "string", default: ".unwrapped-audit.md" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: false,
})

if (args.help) {
  console.log(`
  ${bold("Audit Unwrapped Altimate Edits")}

  ${bold("USAGE")}
    bun run script/upstream/audit-unwrapped.ts [--base v1.3.17] [--out .unwrapped-audit.md]
`)
  process.exit(0)
}

const BASE = args.base as string
const OUT = args.out as string
const ROOT = repoRoot()
const CHANGE_MARKER = "altimate_change"
const START_RE = new RegExp(`${CHANGE_MARKER} start`)
const END_RE = new RegExp(`${CHANGE_MARKER} end`)

interface Hunk {
  startLine: number // line in main
  endLine: number
  added: string[]
}

/** Parse a unified diff and return added-line hunks. */
function parseAddedHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  const lines = diff.split("\n")
  let curLine = 0
  let inHunk = false
  let curHunk: Hunk | null = null

  for (const raw of lines) {
    const headerMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (headerMatch) {
      if (curHunk && curHunk.added.length > 0) hunks.push(curHunk)
      curLine = parseInt(headerMatch[1]!, 10) - 1
      inHunk = true
      curHunk = null
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith("+++") || raw.startsWith("---")) continue
    if (raw.startsWith("+")) {
      curLine++
      if (!curHunk) curHunk = { startLine: curLine, endLine: curLine, added: [] }
      else curHunk.endLine = curLine
      curHunk.added.push(raw.slice(1))
    } else if (raw.startsWith("-")) {
      // removed lines from base — don't increment curLine
    } else if (raw.startsWith(" ")) {
      curLine++
      if (curHunk && curHunk.added.length > 0) {
        hunks.push(curHunk)
        curHunk = null
      }
    }
  }
  if (curHunk && curHunk.added.length > 0) hunks.push(curHunk)
  return hunks
}

/** Build a per-line "is inside altimate_change block" map for a file. */
function blockMembership(content: string): boolean[] {
  const lines = content.split("\n")
  const inside: boolean[] = new Array(lines.length).fill(false)
  let inB = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (!inB && START_RE.test(line)) {
      inB = true
      inside[i] = true
      continue
    }
    if (inB) {
      inside[i] = true
      if (END_RE.test(line)) inB = false
    }
  }
  return inside
}

async function main() {
  const config = loadConfig()
  const { minimatch } = await import("minimatch")

  // Resolve list of files in main that we'd try to overlay (i.e., not keepOurs, not skipFiles)
  const ourFiles = (await $`git ls-tree -r --name-only HEAD`.cwd(ROOT).text()).trim().split("\n")
  const baseFiles = new Set(
    (await $`git ls-tree -r --name-only ${BASE}`.cwd(ROOT).text()).trim().split("\n"),
  )

  const candidates = ourFiles.filter((f) => {
    if (!baseFiles.has(f)) return false
    if (config.keepOurs.some((p) => minimatch(f, p, { dot: true }))) return false
    if (config.skipFiles.some((p) => minimatch(f, p, { dot: true }))) return false
    return true
  })

  logger.banner(`Audit unwrapped altimate edits — base ${BASE}`)
  logger.info(`Candidate files (overlay-bound, exist in ${BASE}): ${candidates.length}`)

  interface FileReport {
    file: string
    unwrappedHunks: Hunk[]
  }
  const reports: FileReport[] = []
  let totalUnwrapped = 0
  let processed = 0

  for (const file of candidates) {
    processed++
    if (processed % 100 === 0) logger.info(`  ${processed}/${candidates.length}...`)

    const ourContent = readFileSync(path.join(ROOT, file), "utf8")
    const inside = blockMembership(ourContent)

    const diff = await $`git diff --no-color -U0 ${BASE}:${file} HEAD:${file}`
      .cwd(ROOT)
      .text()
      .catch(() => "")
    if (!diff) continue
    const hunks = parseAddedHunks(diff)
    if (hunks.length === 0) continue

    // Filter out hunks where every added line is inside a marker block
    const unwrapped: Hunk[] = []
    for (const hunk of hunks) {
      const lines = ourContent.split("\n")
      // Confirm hunk's added lines actually correspond to our file content.
      // For hunks that introduce new code, every added line in the hunk should
      // map to inside[startLine..endLine]. If any line in that range is OUTSIDE
      // a marker block, it's an unwrapped change.
      let hasUnwrapped = false
      for (let l = hunk.startLine - 1; l < hunk.endLine && l < inside.length; l++) {
        if (!inside[l]) {
          hasUnwrapped = true
          break
        }
      }
      if (hasUnwrapped) unwrapped.push(hunk)
    }
    if (unwrapped.length > 0) {
      reports.push({ file, unwrappedHunks: unwrapped })
      totalUnwrapped += unwrapped.length
    }
  }

  // Write report
  const lines: string[] = []
  lines.push(`# Unwrapped altimate edits — diffed against ${BASE}\n`)
  lines.push(`Generated: ${new Date().toISOString()}\n`)
  lines.push(`Files audited (overlay-bound + present in ${BASE}): ${candidates.length}`)
  lines.push(`Files with unwrapped edits: **${reports.length}**`)
  lines.push(`Total unwrapped hunks: **${totalUnwrapped}**\n`)
  lines.push(`\nWrap each hunk in \`// altimate_change start — description\` / \`// altimate_change end\` `)
  lines.push(`markers in main BEFORE running the bridge merge, so the overlay preserves them.\n`)

  // Sort by hunk count desc
  reports.sort((a, b) => b.unwrappedHunks.length - a.unwrappedHunks.length)

  for (const r of reports) {
    lines.push(`\n## \`${r.file}\` — ${r.unwrappedHunks.length} hunks\n`)
    for (const h of r.unwrappedHunks.slice(0, 20)) {
      lines.push(`- L${h.startLine}-${h.endLine}:`)
      lines.push("  ```")
      for (const a of h.added.slice(0, 25)) lines.push(`  ${a}`)
      if (h.added.length > 25) lines.push(`  ... ${h.added.length - 25} more lines`)
      lines.push("  ```")
    }
    if (r.unwrappedHunks.length > 20) {
      lines.push(`- ...and ${r.unwrappedHunks.length - 20} more hunks`)
    }
  }

  writeFileSync(path.join(ROOT, OUT), lines.join("\n"))

  logger.banner("Audit complete")
  console.log(`  Candidates audited:           ${candidates.length}`)
  console.log(`  Files with unwrapped edits:   ${yellow(String(reports.length))}`)
  console.log(`  Total unwrapped hunks:        ${yellow(String(totalUnwrapped))}`)
  console.log(`  Report:                       ${OUT}`)
  console.log()
  if (reports.length > 0) {
    console.log(`  ${bold("Top 10 offenders:")}`)
    for (const r of reports.slice(0, 10)) {
      console.log(`    ${r.unwrappedHunks.length.toString().padStart(4)}  ${r.file}`)
    }
  }
}

main().catch((e) => {
  logger.error(e?.message ?? String(e))
  console.error(e?.stack)
  process.exit(1)
})
