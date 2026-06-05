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
})
