/**
 * Validates the upgrade_available telemetry contract.
 *
 * Bug context: before this was added, `upgrade_attempted` (status=success|error)
 * was the only upgrade signal in telemetry. That gave us "upgrade finished"
 * but not "user was told an upgrade exists". We couldn't distinguish
 *   (a) users don't see the notification  from
 *   (b) users see it and ignore
 * The new `upgrade_available` event, emitted from `cli/upgrade.ts`'s notify(),
 * closes that gap. Pair it with `upgrade_attempted` success to compute the
 * proactive notification → action funnel.
 *
 * Semantic rules encoded in the tests below:
 *   1. Event fires only on PROACTIVE notification paths
 *      (autoupdate=disabled, autoupdate=notify, unknown/yarn method),
 *      NOT from the auto-upgrade error-recovery path.
 *   2. Event is deduped per (correlation_id, latest_version) within a process
 *      so repeated upgrade() calls don't inflate the notified-denominator.
 *   3. Correlation uses session_id when available, falling back to machine_id,
 *      then "cli" as a last resort — never empty.
 *   4. Telemetry failure must never block the user-facing Bus.publish.
 */
import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const TELEMETRY_SRC = fs.readFileSync(
  path.resolve(import.meta.dir, "../../src/altimate/telemetry/index.ts"),
  "utf-8",
)
const CLI_UPGRADE_SRC = fs.readFileSync(
  path.resolve(import.meta.dir, "../../src/cli/upgrade.ts"),
  "utf-8",
)

describe("upgrade_available telemetry event type", () => {
  test("event type is defined in the Telemetry.Event union", () => {
    expect(TELEMETRY_SRC).toContain('type: "upgrade_available"')
    expect(TELEMETRY_SRC).toContain("current_version: string")
    expect(TELEMETRY_SRC).toContain("latest_version: string")
  })

  test("event carries session_id and timestamp like other events", () => {
    const match = TELEMETRY_SRC.match(/type:\s*"upgrade_available"[\s\S]*?\}/)
    expect(match).not.toBeNull()
    const block = match![0]
    expect(block).toContain("timestamp: number")
    expect(block).toContain("session_id: string")
  })

  test("upgrade_attempted method union keeps choco/scoop for Windows granularity", () => {
    // Earlier the union was only "npm" | "bun" | "brew" | "other". Windows
    // users hitting choco/scoop would be indistinguishable from truly generic
    // "other" failures. The expanded union preserves that signal.
    const upgradeAttemptedBlock = TELEMETRY_SRC.match(/type:\s*"upgrade_attempted"[\s\S]*?\}/)
    expect(upgradeAttemptedBlock).not.toBeNull()
    expect(upgradeAttemptedBlock![0]).toContain('"choco"')
    expect(upgradeAttemptedBlock![0]).toContain('"scoop"')
  })
})

describe("upgrade_available emission site (cli/upgrade.ts)", () => {
  test("notify() emits upgrade_available AND publishes UpdateAvailable", () => {
    expect(CLI_UPGRADE_SRC).toContain('type: "upgrade_available"')
    expect(CLI_UPGRADE_SRC).toContain("Bus.publish(Installation.Event.UpdateAvailable")
  })

  test("telemetry failure does not block the user-facing notification", () => {
    // The whole notify() body must include a try/catch around Telemetry.track
    // AND a publishUpdate() call OUTSIDE the try/catch (so Bus.publish still
    // runs if telemetry throws).
    const notifyFn = CLI_UPGRADE_SRC.match(
      /const notify\s*=\s*async[\s\S]*?return publishUpdate\(\)\s*\n\s*\}/,
    )
    expect(notifyFn).not.toBeNull()
    expect(notifyFn![0]).toContain("try {")
    expect(notifyFn![0]).toContain("} catch")
    // Track call comes before catch; publishUpdate comes after the catch block
    const telemetryIdx = notifyFn![0].indexOf('type: "upgrade_available"')
    const catchIdx = notifyFn![0].indexOf("} catch")
    const publishIdx = notifyFn![0].lastIndexOf("return publishUpdate()")
    expect(telemetryIdx).toBeGreaterThanOrEqual(0)
    expect(telemetryIdx).toBeLessThan(catchIdx)
    expect(catchIdx).toBeLessThan(publishIdx)
  })

  test("uses lazy import to avoid telemetry → installation circular dep", () => {
    expect(CLI_UPGRADE_SRC).toContain('await import("@/altimate/telemetry")')
  })

  test("current_version reads from Installation.VERSION (normalized, no v-prefix)", () => {
    expect(CLI_UPGRADE_SRC).toContain("current_version: Installation.VERSION")
  })

  test("latest_version reads from the resolved `latest` local", () => {
    expect(CLI_UPGRADE_SRC).toContain("latest_version: latest")
  })
})

describe("upgrade_available correlation ID fallback (n1 fix)", () => {
  test("prefers sessionId, falls back to machineId, then 'cli'", () => {
    // The notify() body should read Telemetry.getContext() and pick the
    // first non-empty value among sessionId, machineId, "cli". This keeps
    // funnel correlation stable even before session_start fires (the
    // upgrade check runs early in CLI startup).
    expect(CLI_UPGRADE_SRC).toMatch(/ctx\.sessionId\s*\|\|\s*ctx\.machineId\s*\|\|\s*"cli"/)
  })

  test("Telemetry.getContext() exposes machineId", () => {
    // getContext must return machineId so the correlation fallback works.
    const getContextFn = TELEMETRY_SRC.match(/export function getContext\(\)[\s\S]*?\n\s*\}/)
    expect(getContextFn).not.toBeNull()
    expect(getContextFn![0]).toContain("machineId")
  })
})

describe("upgrade_available dedup (m9 fix)", () => {
  test("emits at most once per (correlation, version) in the same process", () => {
    // Module-level Set tracks already-notified versions; repeated upgrade()
    // calls for the same target will NOT re-emit the event.
    expect(CLI_UPGRADE_SRC).toMatch(/_notifiedVersions\s*=\s*new Set<string>\(\)/)
    // dedup key combines correlation and version
    expect(CLI_UPGRADE_SRC).toContain("`${correlationId}:${latest}`")
    expect(CLI_UPGRADE_SRC).toContain("_notifiedVersions.has(dedupKey)")
    expect(CLI_UPGRADE_SRC).toContain("_notifiedVersions.add(dedupKey)")
  })

  test("dedup guard skips telemetry but still publishes the Bus event", () => {
    // If we already notified this version, a subsequent notify() call must
    // still show the toast (publishUpdate) — the user hasn't changed state,
    // but we shouldn't swallow the UI event. We just skip the telemetry.
    const notifyBody = CLI_UPGRADE_SRC.match(
      /const notify\s*=\s*async[\s\S]*?return publishUpdate\(\)\s*\n\s*\}/,
    )
    expect(notifyBody).not.toBeNull()
    expect(notifyBody![0]).toMatch(/if\s*\(_notifiedVersions\.has\(dedupKey\)\)\s*return publishUpdate\(\)/)
  })
})

describe("upgrade_available suppression in error-recovery path (m8 fix)", () => {
  test("auto-upgrade catch handler calls publishUpdate() directly, NOT notify()", () => {
    // When auto-upgrade fails (e.g., choco/scoop synthesized failure), we
    // must still show the toast but MUST NOT emit upgrade_available — the
    // existing upgrade_attempted(status=error) already carries that signal,
    // and emitting both inverts the natural funnel order (attempt before
    // notification). Locate the catch handler by the distinctive log.warn
    // call and verify the body contains publishUpdate, not notify.
    const catchStart = CLI_UPGRADE_SRC.indexOf(".catch(async (err)")
    expect(catchStart).toBeGreaterThanOrEqual(0)
    // Take a generous slice that's guaranteed to include the full catch body.
    const slice = CLI_UPGRADE_SRC.slice(catchStart, catchStart + 1500)
    expect(slice).toContain("auto-upgrade failed, notifying instead")
    expect(slice).toContain("await publishUpdate()")
    // The catch handler must NOT call notify() — which would emit telemetry.
    // Bound the check to the catch handler's body so we don't false-positive
    // against notify() calls earlier in the file.
    const catchBodyEnd = slice.indexOf("})", slice.indexOf("await publishUpdate()"))
    expect(catchBodyEnd).toBeGreaterThan(0)
    const catchBody = slice.slice(0, catchBodyEnd)
    expect(catchBody).not.toMatch(/await notify\(\)/)
  })

  test("publishUpdate is factored out as a named helper", () => {
    // Having publishUpdate as a separate function lets the catch handler
    // show the toast without triggering telemetry.
    expect(CLI_UPGRADE_SRC).toMatch(
      /const publishUpdate\s*=\s*\(\)\s*=>\s*Bus\.publish\(Installation\.Event\.UpdateAvailable/,
    )
  })
})
