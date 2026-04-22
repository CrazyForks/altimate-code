import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Installation } from "@/installation"
// altimate_change start — robust upgrade notification with zero external dependencies
import { Log } from "@/util/log"

const log = Log.create({ service: "upgrade" })

/**
 * Compare two semver-like version strings. Returns:
 *   1  if a > b
 *   0  if a === b
 *  -1  if a < b
 *
 * Handles standard "major.minor.patch" and ignores prerelease suffixes
 * for the numeric comparison (prerelease is always < release).
 *
 * Zero external dependencies — this function MUST NOT import any package.
 * If it throws, the entire upgrade path breaks and users get locked on
 * old versions with no way to self-heal.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  // Strip leading "v" if present
  const cleanA = a.replace(/^v/, "")
  const cleanB = b.replace(/^v/, "")

  // Split off prerelease suffix
  const [coreA, preA] = cleanA.split("-", 2)
  const [coreB, preB] = cleanB.split("-", 2)

  const partsA = coreA.split(".").map(Number)
  const partsB = coreB.split(".").map(Number)

  // Compare major.minor.patch numerically
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0
    const numB = partsB[i] ?? 0
    if (isNaN(numA) || isNaN(numB)) return 0 // unparseable → treat as equal (safe default)
    if (numA > numB) return 1
    if (numA < numB) return -1
  }

  // Same core version: release > prerelease (e.g., 1.0.0 > 1.0.0-beta.1)
  if (!preA && preB) return 1
  if (preA && !preB) return -1

  return 0
}

/**
 * Returns true if `version` looks like a valid semver string (x.y.z with optional pre).
 * Intentionally lenient — just checks for at least "N.N.N" pattern.
 */
export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version.replace(/^v/, ""))
}

/**
 * Tracks the (version, machineId|cli) pairs for which we have already emitted
 * an `upgrade_available` telemetry event in this process, so repeated upgrade()
 * calls for the same target don't inflate the notified-denominator in the
 * notification → upgrade funnel.
 */
const _notifiedVersions = new Set<string>()

export async function upgrade() {
  const config = await Config.global()
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch((err) => {
    log.warn("failed to fetch latest version", { error: String(err), method })
    return undefined
  })
  if (!latest) return
  if (Installation.VERSION === latest) return

  // Prevent downgrade: if current version is already >= latest, skip
  if (
    Installation.VERSION !== "local" &&
    isValidVersion(Installation.VERSION) &&
    isValidVersion(latest) &&
    compareVersions(Installation.VERSION, latest) >= 0
  ) {
    return
  }

  const publishUpdate = () => Bus.publish(Installation.Event.UpdateAvailable, { version: latest })

  /**
   * Proactively notify the user that an upgrade is available AND emit the
   * `upgrade_available` telemetry so we can measure the notification → upgrade
   * funnel. Called from the autoupdate=disabled, autoupdate=notify, and
   * unknown/yarn paths — NOT from the auto-upgrade error-recovery path
   * (that path already emits `upgrade_attempted(status=error)`, and mixing
   * the two signals conflates "proactive notification" with "error recovery
   * notification"). Deduped per (machineId|session, version) within the
   * process so repeated upgrade() calls don't double-count.
   */
  const notify = async () => {
    try {
      const { Telemetry } = await import("@/altimate/telemetry")
      const ctx = Telemetry.getContext()
      // Prefer machineId for dedup when a session has not started yet (the
      // upgrade check runs early in CLI startup). Falling back to sessionId
      // keeps the key stable within an established session; "cli" is a last
      // resort so the key is never empty.
      const correlationId = ctx.sessionId || ctx.machineId || "cli"
      const dedupKey = `${correlationId}:${latest}`
      if (_notifiedVersions.has(dedupKey)) return publishUpdate()
      _notifiedVersions.add(dedupKey)
      Telemetry.track({
        type: "upgrade_available",
        timestamp: Date.now(),
        session_id: correlationId,
        current_version: Installation.VERSION,
        latest_version: latest,
      })
    } catch (err) {
      // Telemetry is observability; it must never block the user-facing toast.
      log.warn("upgrade_available telemetry failed", { error: String(err) })
    }
    return publishUpdate()
  }

  // Always notify when update is available, regardless of autoupdate setting
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) {
    await notify()
    return
  }
  if (config.autoupdate === "notify") {
    await notify()
    return
  }

  // Can't auto-upgrade for unknown or unsupported methods — notify instead
  if (method === "unknown" || method === "yarn") {
    await notify()
    return
  }

  await Installation.upgrade(method, latest)
    .then(() => Bus.publish(Installation.Event.Updated, { version: latest }))
    .catch(async (err) => {
      // Auto-upgrade failed (e.g., choco/scoop hard-fail, npm exit code). Show
      // the toast so the user knows a new version exists, but DO NOT emit
      // `upgrade_available` — `upgrade_attempted(status=error)` already carries
      // this signal, and emitting both would invert the natural funnel order
      // (attempt before notification).
      log.warn("auto-upgrade failed, notifying instead", { error: String(err), method, target: latest })
      await publishUpdate()
    })
}
// altimate_change end
