# Trace bugs — what this branch fixes and why #867 didn't catch them

Companion document to the `fix/trace-clearing-on-workspace-set` branch.
Lists the actual bugs found and fixed; excludes the diagnostic dead-ends
that didn't pan out.

## Bugs fixed in this branch

### 1. Per-turn `session.status === "idle"` finalized the trace every turn

**Location**: `packages/opencode/src/cli/cmd/tui/worker.ts:232-243` (removed in this branch)

**Mechanism**: the handler called `trace.endTrace()` + `sessionTraces.delete(sid)`
whenever `event.type === "session.status"` and `status.type === "idle"`.
`idle` is a **busy→idle transition** — it fires after every agent turn
finishes, not at session end. Every fire destroyed the Trace instance
and removed it from the cache. The next event for the same session in
the next turn hit a cache miss in `getOrCreateTrace`, called
`Trace.create()` + `startTrace(sessionID, {})`, which pushed a single
root span into a freshly-empty `this.spans` and the immediate `snapshot()`
clobbered the rich on-disk `ses_<id>.json` with a 1-span file.

**Symptom**:
- Waterfall view collapsed to the system-prompt span after every turn
- `metadata.prompt` reset to undefined ("What was asked / No prompt
  recorded")
- Token / generation / tool-call counters in `summary` reset to 0/null

**Severity**: hot path on every multi-turn session. Fired ~once per
agent turn for every session in the cache.

**Why the comment in the code was misleading**: the original handler
carried the comment "Finalize trace when session reaches idle
(completed)" — the developer who wrote it conflated `idle` (per-turn
event) with session-end. Sessions in altimate-code are long-lived
across many turns; finalization belongs on `shutdown` or eviction, not
per-turn idle.

**Fix**: handler removed. Trace lives as long as the worker has the
session in its `sessionTraces` map. Finalization happens only on
`worker.shutdown` and on MAX_TRACES eviction — both already correct.

### 2. `getOrCreateTrace` cache-miss never rehydrated from disk

**Location**: `packages/opencode/src/cli/cmd/tui/worker.ts:83-106`,
`packages/opencode/src/altimate/observability/tracing.ts`
(`rehydrateFromFile`, new method)

**Mechanism**: when `sessionTraces.has(sessionID)` returned false, the
worker called `Trace.create()` + `startTrace(sessionID, {})` — which
unconditionally pushed a fresh root span into empty `this.spans` and
wrote a snapshot. The on-disk path is derived purely from `sessionID`,
so the snapshot clobbered any pre-existing rich trace at that path.

**Triggered when**:
- Worker process restart (sessionTraces empty on boot, user resumes
  a session whose trace file already has content)
- MAX_TRACES=100 eviction (the evicted session may be revisited later)
- Any future code path that drops in-memory state for an active session

After fix #1, these are uncommon — but still real edge cases.

**Fix**: new `Trace.rehydrateFromFile(sessionId)` reads
`~/.local/share/altimate-code/traces/ses_<id>.json` if it exists,
parses it, restores `this.spans`, `this.metadata`, `this.rootSpanId`,
`this.startTime`, and the running counters (`totalTokens`,
`toolCallCount`, `generationCount`, token breakdown). Clears the root
span's `endTime` so the trace renders as still-in-progress and accepts
new events. `getOrCreateTrace` now prefers rehydration over
`startTrace`; falls back to `startTrace` only when no usable on-disk
file is found.

### 3. `worker.setWorkspace` was not idempotent

**Location**: `packages/opencode/src/cli/cmd/tui/worker.ts:308-313`

**Mechanism**: each call unconditionally invoked `startEventStream`,
which called `endTrace()` on every entry in `sessionTraces` (fire-and-
forget) and then `sessionTraces.clear()`. Combined with the SolidJS
effect upstream (see #4), this meant every spurious effect re-run
destroyed the entire trace cache.

**Fix**: track `currentWorkspaceID` at module scope; early-return when
`input.workspaceID === currentWorkspaceID`. Defense in depth against the
upstream UI sending spurious calls.

### 4. SolidJS effect on workspaceID re-ran on every session signal change

**Location**: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:186-190`

**Mechanism**: `createEffect(() => session()?.workspaceID && sdk.setWorkspace(...))`
reads `session()` inside the effect — SolidJS dirty-tracks the entire
session signal, not the projected `workspaceID`. So the effect re-ran
on every `session()` update (message count, status, parts updated,
title regenerated, …). Each fire propagated into the worker's
`setWorkspace`.

**Fix**: switched to `createEffect(on(() => session()?.workspaceID, ...))`.
The `on()` projector restricts dirty-tracking to that one field, so
the effect only fires when `workspaceID` actually changes.

### 5. User prompt was never captured

**Location**: `packages/opencode/src/cli/cmd/tui/worker.ts` (Path B in
the `message.part.updated` handler)

**Mechanism**: three different code paths fed `metadata.prompt`:

- **Path A** (`message.updated` for user role): only fired if
  `info.summary?.title || info.summary?.body` was populated — i.e.
  only after the title-agent had run. For a first turn, summary is
  empty when the event arrives. Doesn't fire.
- **Path B** (`message.part.updated` text part): gated on
  `part.type === "text" && part.time?.end`. **User-input parts never
  have `time.end` set** — it's a meaningful concept only for
  processing-end of assistant chunks. Gate never opens for user text.
- **Path C** (`session.updated` with auto-generated title): called
  `trace.setTitle(String(info.title))` with **one argument only** —
  set the title but not the prompt.

Result: title got captured (via Path C, with the auto-generated
"Greeting"-style title), prompt stayed `undefined`. Viewer shows
"What was asked / No prompt recorded".

**Codex review feedback (2026-06-05)**: even if we drop the `time.end`
gate in Path B, calling `trace.setTitle(text, text)` mutates **both**
title and prompt. If Path B fires after Path C, the nice auto-
generated title regresses to raw user input ("Greeting" → "hi"). The
right fix decouples title mutation from prompt capture.

**Fix**:
- New `Trace.setPrompt(prompt)` method on the Trace class. Only
  mutates `metadata.prompt`. Never touches title.
- Path B in `worker.ts`: dropped `part.time?.end` for the user-
  identified branch; calls `setPrompt(text)` instead of
  `setTitle(text, text)`. Assistant-text branch still requires
  `time.end` for `logText`.

### 6. User messages were not first-class events in the trace data model

**Location**: trace data model (no `kind: "user-message"` span before
this branch), `viewer.ts` chat-view renderer

**Mechanism**: the trace recorded user input only as a single
`metadata.prompt` string. Each new `setPrompt` overwrote the previous
value. The viewer's chat tab rendered `metadata.prompt` as one
"▶ You" bubble at the top, then iterated `kind: "generation"` spans
for assistant replies. There was no place for any user message
beyond the first.

**Symptom on a 3-turn session**: chat tab showed the **last** user
prompt followed by **all** earlier assistant responses, with the older
user messages dropped.

**Fix**:
- New `Trace.logUserMessage(text)` pushes a `kind: "user-message"`
  span. `TraceSpan.kind` union extended.
- Worker Path B calls `logUserMessage(text)` alongside `setPrompt(text)`
  for each user-identified part.
- Viewer chat-view rebuilt: filters both user-message and generation
  spans, sorts by `startTime`, walks them in turn order. Renders each
  user-message span as its own "▶ You" bubble. Older traces without
  user-message spans fall back to `metadata.prompt`-at-top —
  backward compatible.

---

## What PR #867 fixed (for comparison)

PR #867 (merged 2026-06-01, "fix(tracing): close trace corruption in
long-running sessions") closed two concurrency bugs and explicitly
left a third as a documented design hazard:

### M2 — debounce dropped events with no follow-up snapshot

`Trace.snapshot()` returned early when `snapshotPending=true` and was
never re-scheduled. In bursty turns (an LLM step firing several tool
calls back-to-back), the disk file lagged memory until a fresh event
arrived in a future turn. If the process exited in the gap, the burst's
tail was lost.

**Fix**: `snapshotRequestedDuringPending` flag whenever `snapshot()`
short-circuits. In `.finally()`, if the flag is set and the trace is
neither crashed nor ending, schedule exactly one follow-up snapshot
via `queueMicrotask`. Bounded — at most one extra write per
"burst → quiet" cycle regardless of burst size.

### M3 — `FileExporter.export()` raced `flushSync` with no `crashed` guard

`endTrace()` calls `exporter.export()`, which does `writeFile(tmp)`
→ `rename(tmp, final)`. On multi-MB traces the writeFile takes 100+ms,
a wide window for `flushSync` to interleave. The `crashed` flag added
in commit `38463876b` only guarded `Trace.snapshot()`, not
`FileExporter.export()`, so `flushSync`'s synchronous crashed write
was overwritten by the export's rename.

**Fix**: per-session `_crashed` flag on `FileExporter` with
`markCrashed()`. Checked at entry, before writeFile, and before rename
(drop tmp + bail). `flushSync` iterates exporters and calls
`markCrashed()` on each before its own synchronous write.

### M2 companion — `endTraceStarted` gate

Once `endTrace()` claims the canonical write, no concurrent snapshot
may run — they would race endTrace's mutation of the root span
(endTime, status) and could clobber endTrace's content with stale
pre-end state.

### M1 — NOT closed in #867

The TOCTOU between the synchronous `if (this.crashed)` check and the
asynchronous kernel `fs.rename` syscall. Documented as a known design
hazard; existing `crashed` flag from `38463876b` protects against it
on local SSD (microsecond rename window). Theoretical exposure remains
on slow/network filesystems.

---

## Why #867 didn't catch the bugs in this branch

### Different layer of abstraction

PR #867's bugs all live at the **intra-Trace-instance concurrency
layer** — within one Trace object's state machine:

- Snapshot debounce/follow-up timing within one instance
- FileExporter ↔ flushSync interleave for one instance's write
- endTrace ↔ snapshot races for one instance

This branch's bugs (#1, #2, #3, #4) all live at the **cross-instance
lifecycle layer** — when one Trace instance gets destroyed and another
is constructed for the same `sessionID`:

- When destruction happens (idle handler / setWorkspace / cache eviction)
- What happens on the next `Trace.create()` (no disk rehydration)
- What the upstream UI triggers cause it (SolidJS effect)

The two layers are orthogonal. #867's reproducers (`tracing-rename-race.test.ts`,
`tracing-display-crash.test.ts`) all hold one Trace instance for their
entire test lifecycle and exercise crash/burst conditions against
that instance. They cannot detect a bug whose mechanism is "destroy
the instance, build a new one, watch the new one's first write
clobber the old one's file."

### The destructive handler was intentional code, not a concurrency bug

The per-turn idle handler (#1) was **the developer's intent** — they
explicitly named it "Finalize trace when session reaches idle
(completed)". The bug is a semantic misunderstanding of what `idle`
means at the event level (per-turn vs per-session), not a race or
data corruption. #867's reproducer matrix wouldn't have surfaced it
because none of the M-class bugs involved destroying the Trace and
the reproducers all assumed a single instance.

### Data-feed and rendering layers were out of scope

#867 worked on the **persistence layer** (FileExporter, snapshot,
flushSync). The prompt-capture and chat-rendering bugs (#5, #6) live
at:

- **Worker event-handler layer** (`worker.ts`) — what gets fed into
  the Trace from the bus event stream
- **Trace data-model layer** (`tracing.ts`) — what fields and span
  kinds the Trace exposes
- **Viewer layer** (`viewer.ts`) — how rendered HTML iterates spans

All three are independent of crash/race safety. A 100%-correct
persistence layer can still ship a 1-span trace file if upstream
feeds only 1 span, or render a single "You" bubble if the data model
only carries `metadata.prompt`.

### No cross-turn integration tests

Existing tracing tests are concurrency reproducers and unit tests of
isolated methods. None exercise the full event-stream-to-trace-file
path for a multi-turn session. The cross-turn nature of the idle
clobber requires a test that drives at least two `busy → idle` cycles
through the worker's event handler against a real `Trace` instance.

This branch adds:

- `test/cli/tui/worker-trace-clearing.test.ts` — source-grep contract
  tests that lock the no-idle-clobber, rehydrate-before-startTrace,
  and `setPrompt`-not-`setTitle` invariants in worker.ts.
- `test/altimate/tracing-rehydrate.test.ts` — behavioral tests for
  `Trace.rehydrateFromFile` (preserve spans/metadata/counters,
  reject missing/mismatched/malformed files, clear endTime on
  rehydrate) and for `logUserMessage` (chronological ordering).

A higher-fidelity follow-up would be a real-worker integration test
that emits a synthetic `session.status` idle event between two turns
and asserts the trace file does not collapse — that needs the worker
event loop running against a stub bus. Worth adding as a separate
PR; the source-grep + behavioral tests are sufficient to lock the
contracts in this PR.
