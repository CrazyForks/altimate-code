import { setRegistrationHook } from "./dispatcher"

export * as Dispatcher from "./dispatcher"

// Lazy handler registration — modules are loaded on first Dispatcher.call(),
// not at import time. This prevents @altimateai/altimate-core napi binary
// from loading in test environments where it's not needed.
// altimate_change start — graceful degradation when native binding unavailable
setRegistrationHook(async () => {
  // altimate-core napi-rs binding may fail on systems with older GLIBC.
  // Load it separately so other handlers (connections, schema, finops, dbt) still register.
  try {
    await import("./altimate-core")
  } catch (e: any) {
    const msg = String(e?.message || e)
    if (msg.includes("native binding") || msg.includes("GLIBC") || msg.includes("ERR_DLOPEN_FAILED")) {
      // Swallowed here — dispatcher.ts logs the user-facing warning
    } else {
      throw e
    }
  }

  await import("./sql/register")
  await import("./connections/register")
  await import("./schema/register")
  await import("./finops/register")
  await import("./dbt/register")
  await import("./local/register")
})
// altimate_change end
