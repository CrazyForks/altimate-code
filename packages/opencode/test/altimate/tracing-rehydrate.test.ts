/**
 * Behavioral test for `Trace.rehydrateFromFile` and the worker's
 * cache-miss-rehydrates contract.
 *
 * The bug being guarded against: when the in-memory `Trace` instance for a
 * session is destroyed (worker restart, MAX_TRACES eviction, the now-removed
 * per-turn idle finalize) and a new `Trace` is constructed for the same
 * `sessionID`, the fresh `this.spans = []` plus immediate `snapshot()` in
 * `startTrace` would clobber the rich on-disk `ses_<id>.json` with a 1-span
 * file. Symptom: waterfall view collapses to system-prompt; metadata.prompt
 * disappears.
 *
 * `rehydrateFromFile` is the defense-in-depth fix: on cache miss, load the
 * existing trace state instead of starting fresh.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Trace, FileExporter, type TraceFile } from "../../src/altimate/observability/tracing"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tracing-rehydrate-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function makeTrace() {
  return Trace.withExporters([new FileExporter(tmpDir)])
}

async function readTraceFile(sessionId: string): Promise<TraceFile> {
  const safeId = sessionId.replace(/[/\\.:]/g, "_")
  const filePath = path.join(tmpDir, `${safeId}.json`)
  return JSON.parse(await fs.readFile(filePath, "utf-8"))
}

describe("Trace.rehydrateFromFile + cache-miss rehydration", () => {
  test("rehydrate preserves spans, metadata, and counters when reconstructing on cache miss", async () => {
    const sessionId = "ses_rehydrate_basic"

    // Phase 1: original Trace builds up rich state, then is discarded (simulating
    // a worker restart or MAX_TRACES eviction).
    const original = makeTrace()
    original.startTrace(sessionId, {
      title: "test session",
      prompt: "do the thing",
      model: "openai/gpt-5.5",
      providerId: "altimate-backend",
      agent: "builder",
    })
    // Simulate turn-1 activity: a few tool calls + some text.
    original.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any)
    original.logToolCall({ tool: "grep", state: { status: "completed", input: { p: "x" } } } as any)
    original.logText({ text: "first response", time: { end: Date.now() } } as any)
    // Flush to disk so the file represents the cumulative state.
    await original.flush()

    const onDiskAfterPhase1 = await readTraceFile(sessionId)
    expect(onDiskAfterPhase1.spans.length).toBeGreaterThan(1)
    expect(onDiskAfterPhase1.metadata.prompt).toBe("do the thing")
    expect(onDiskAfterPhase1.metadata.title).toBe("test session")

    // Phase 2: drop the original (worker restart / eviction). Construct a fresh
    // Trace instance for the SAME sessionID. This is the path that, pre-fix,
    // would have called startTrace and clobbered the file.
    const reconstructed = makeTrace()
    const didRehydrate = reconstructed.rehydrateFromFile(sessionId)

    expect(didRehydrate).toBe(true)

    // Without writing anything yet, the in-memory state must reflect what was
    // on disk: same spans, same metadata, same root id.
    const fileImmediatelyAfterRehydrate = await readTraceFile(sessionId)
    expect(fileImmediatelyAfterRehydrate.spans).toEqual(onDiskAfterPhase1.spans)
    expect(fileImmediatelyAfterRehydrate.metadata.prompt).toBe("do the thing")

    // Phase 3: log new activity on the reconstructed Trace and flush. The next
    // snapshot must preserve the old spans AND add the new ones — not overwrite.
    reconstructed.logToolCall({ tool: "edit", state: { status: "completed", input: { f: "b" } } } as any)
    await reconstructed.flush()

    const onDiskAfterPhase3 = await readTraceFile(sessionId)
    expect(onDiskAfterPhase3.spans.length).toBeGreaterThan(onDiskAfterPhase1.spans.length)
    // Old spans still there.
    for (const oldSpan of onDiskAfterPhase1.spans) {
      expect(onDiskAfterPhase3.spans.some((s) => s.spanId === oldSpan.spanId)).toBe(true)
    }
    // Metadata was preserved across the reconstruction.
    expect(onDiskAfterPhase3.metadata.prompt).toBe("do the thing")
    expect(onDiskAfterPhase3.metadata.title).toBe("test session")
    expect(onDiskAfterPhase3.metadata.model).toBe("openai/gpt-5.5")
  })

  test("rehydrate returns false when no on-disk trace exists (fresh session)", async () => {
    const trace = makeTrace()
    const result = trace.rehydrateFromFile("ses_does_not_exist")
    expect(result).toBe(false)
  })

  test("rehydrate returns false when on-disk trace is for a different session", async () => {
    // Stage a mismatched file at the expected path for "session-A".
    await fs.writeFile(
      path.join(tmpDir, "ses_target.json"),
      JSON.stringify({
        version: 2,
        traceId: "x",
        sessionId: "ses_other",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        metadata: {},
        spans: [{ spanId: "r", parentSpanId: null, name: "ses_other", kind: "session", startTime: 0, status: "ok" }],
        summary: {
          totalTokens: 0,
          totalCost: 0,
          totalToolCalls: 0,
          totalGenerations: 0,
          duration: 0,
          status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    )
    const trace = makeTrace()
    const result = trace.rehydrateFromFile("ses_target")
    expect(result).toBe(false)
  })

  test("rehydrate clears endTime on the root span so the trace renders as still in-progress", async () => {
    const sessionId = "ses_endtime_clear"

    const original = makeTrace()
    original.startTrace(sessionId, {})
    original.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any)
    await original.endTrace() // sets root endTime
    const ended = await readTraceFile(sessionId)
    const endedRoot = ended.spans.find((s) => s.parentSpanId === null)
    expect(endedRoot?.endTime).toBeDefined()

    const reconstructed = makeTrace()
    const ok = reconstructed.rehydrateFromFile(sessionId)
    expect(ok).toBe(true)

    // Trigger a snapshot via a real span push so the disk file gets re-written.
    reconstructed.logToolCall({ tool: "grep", state: { status: "completed", input: { p: "x" } } } as any)
    await reconstructed.flush()

    const afterRehydrate = await readTraceFile(sessionId)
    const root = afterRehydrate.spans.find((s) => s.parentSpanId === null)
    // The trace must be re-openable: the root endTime is cleared so subsequent
    // turns don't render the trace as "completed" in the viewer.
    expect(root?.endTime).toBeUndefined()
  })
})
