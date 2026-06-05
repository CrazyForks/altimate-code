import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"

const ROOT = path.resolve(__dirname, "../../../")

// Regression guards for the trace-clearing-on-workspace-set bug.
//
// Bug shape (full chain):
//
//   1. SolidJS createEffect in `routes/session/index.tsx` watches
//      `session()?.workspaceID` but re-runs on every `session()` signal change
//      (message count, status, parts updated, …) — including the cascade at
//      agent-finish.
//   2. Each fire calls `sdk.setWorkspace(workspaceID)` via RPC.
//   3. `worker.setWorkspace` unconditionally calls `startEventStream`.
//   4. `startEventStream` calls `endTrace()` on every entry in `sessionTraces`
//      (fire-and-forget) and then `sessionTraces.clear()`.
//   5. On the next event for the same session, `getOrCreateTrace(sessionID)`
//      hits a cache miss, calls `Trace.create()` + `startTrace(sessionID, {})`,
//      which pushes a single root span into a freshly-empty `this.spans`.
//      `startTrace` then writes a snapshot — overwriting the rich on-disk trace
//      with a near-empty one.
//
// Observable: `/traces` waterfall view collapses to just the system-prompt
// span after every agent-finish.
//
// Two fixes lock the contract here:
//   - `worker.setWorkspace` is now idempotent on unchanged workspaceID.
//   - `createEffect` in `routes/session/index.tsx` uses `on(...)` so it only
//     fires when the projected `workspaceID` actually changes.

describe("trace-clearing-on-workspace-set regression", () => {
  test("worker.setWorkspace short-circuits when workspaceID is unchanged", async () => {
    const workerSrc = await fs.readFile(path.join(ROOT, "src/cli/cmd/tui/worker.ts"), "utf-8")

    // A `currentWorkspaceID` tracker is declared at module scope.
    expect(workerSrc).toMatch(/let currentWorkspaceID:\s*string\s*\|\s*undefined/)

    // The setWorkspace handler must guard on equality with the tracker before
    // calling startEventStream. Match either a strict-equality early return or
    // the same pattern wrapped in a block.
    expect(workerSrc).toMatch(
      /async setWorkspace\(input: \{ workspaceID\?: string \}\)\s*\{[\s\S]{0,400}if \(input\.workspaceID === currentWorkspaceID\) return/,
    )

    // After the guard, the tracker must be updated to the new value, otherwise
    // a subsequent same-value call wouldn't short-circuit.
    expect(workerSrc).toMatch(
      /if \(input\.workspaceID === currentWorkspaceID\) return\s*\n\s*currentWorkspaceID = input\.workspaceID/,
    )
  })

  test("session route's workspaceID effect uses `on()` so it only fires when workspaceID actually changes", async () => {
    const routeSrc = await fs.readFile(
      path.join(ROOT, "src/cli/cmd/tui/routes/session/index.tsx"),
      "utf-8",
    )

    // The previous shape (`createEffect(() => { if (session()?.workspaceID) ... })`)
    // re-runs on every session() signal change. The fixed shape uses `on()` with
    // an explicit projector returning workspaceID, so SolidJS dirty-tracks only
    // that value.
    expect(routeSrc).toMatch(/createEffect\(\s*on\(\s*\(\)\s*=>\s*session\(\)\?\.workspaceID/)

    // The unguarded inline form must not reappear — that would re-introduce the bug.
    expect(routeSrc).not.toMatch(/createEffect\(\(\)\s*=>\s*\{\s*\n\s*if\s*\(session\(\)\?\.workspaceID\)/)
  })

  // The real root cause: a session.status=idle handler that called endTrace +
  // sessionTraces.delete after every turn. `idle` fires on busy→idle transition
  // (i.e. after every agent turn finishes), not at session-end. Each fire
  // destroyed the Trace instance; the next event in a later turn forced a fresh
  // Trace.create() whose 1-span initial snapshot clobbered the rich on-disk
  // trace. Also explains the "What was asked / No prompt recorded" symptom —
  // metadata.prompt was captured on the destroyed instance, never on the
  // replacement. The handler is now a no-op; finalization happens on worker
  // shutdown and MAX_TRACES eviction only.
  test("worker does NOT call endTrace+delete on session.status=idle", async () => {
    const workerSrc = await fs.readFile(path.join(ROOT, "src/cli/cmd/tui/worker.ts"), "utf-8")

    // The destructive shape must not exist anywhere in the file.
    expect(workerSrc).not.toMatch(/status === "idle"[\s\S]{0,200}sessionTraces\.delete/)
    expect(workerSrc).not.toMatch(/status === "idle"[\s\S]{0,200}trace\.endTrace\(\)/)
  })

  // Defense-in-depth: `getOrCreateTrace` on cache miss must try to load an
  // existing on-disk trace before falling back to startTrace. Otherwise a
  // worker restart or MAX_TRACES eviction recreates the trace empty and
  // the next snapshot clobbers the rich file.
  test("getOrCreateTrace prefers rehydrateFromFile over startTrace on cache miss", async () => {
    const workerSrc = await fs.readFile(path.join(ROOT, "src/cli/cmd/tui/worker.ts"), "utf-8")
    expect(workerSrc).toMatch(
      /if \(!trace\.rehydrateFromFile\(sessionID\)\)\s*\{\s*\n\s*trace\.startTrace\(sessionID, \{\}\)\s*\n\s*\}/,
    )
  })
})
