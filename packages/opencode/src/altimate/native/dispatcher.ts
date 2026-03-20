/**
 * Dispatcher — routes tool calls to native TypeScript handlers.
 *
 * All 73 bridge methods now have native handlers registered.
 * The Python bridge is no longer used.
 */

import { BridgeMethods, type BridgeMethod } from "./types"
import { Telemetry } from "../telemetry"

type NativeHandler = (params: any) => Promise<any>

const nativeHandlers = new Map<string, NativeHandler>()

/** Register a native TypeScript handler for a bridge method. */
export function register(method: BridgeMethod, handler: NativeHandler): void {
  nativeHandlers.set(method, handler)
}

/** Clear all registered handlers (for test isolation). */
export function reset(): void {
  nativeHandlers.clear()
}

/** Lazy registration hook — set by native/index.ts */
let _ensureRegistered: (() => Promise<void>) | null = null

/** Called by native/index.ts to set the lazy registration function. */
export function setRegistrationHook(fn: () => Promise<void>): void {
  _ensureRegistered = fn
}

/** Dispatch a method call to the registered native handler. */
export async function call<M extends BridgeMethod>(
  method: M,
  params: (typeof BridgeMethods)[M] extends { params: infer P } ? P : never,
): Promise<(typeof BridgeMethods)[M] extends { result: infer R } ? R : never> {
  // altimate_change start — graceful degradation when native binding unavailable
  // Lazy registration: load all handler modules on first call.
  // If the native binding fails to load (e.g. GLIBC mismatch on older Linux),
  // log a warning and continue — tools that don't need native will still work.
  if (_ensureRegistered) {
    const fn = _ensureRegistered
    _ensureRegistered = null
    try {
      await fn()
    } catch (e: any) {
      const msg = String(e?.message || e)
      if (msg.includes("native binding") || msg.includes("GLIBC") || msg.includes("ERR_DLOPEN_FAILED")) {
        console.error(
          `\n⚠ Native module (@altimateai/altimate-core) failed to load.\n` +
          `  SQL analysis tools (validate, lint, transpile, lineage, etc.) will be unavailable.\n` +
          `  Other features (warehouse connections, schema indexing, dbt) still work.\n` +
          `  Cause: ${msg.slice(0, 200)}\n` +
          `\n` +
          `  To fix this, upgrade to a system with GLIBC >= 2.35:\n` +
          `    • Ubuntu 22.04+ / Debian 12+ / Fedora 36+ / RHEL 9+\n` +
          `    • Or run inside a Docker container with a newer base image\n` +
          `    • Check your version: ldd --version\n`,
        )
      } else {
        throw e
      }
    }
  }
  // altimate_change end

  const native = nativeHandlers.get(method as string)

  if (!native) {
    throw new Error(`No native handler for ${String(method)}`)
  }

  const startTime = Date.now()
  try {
    const result = await native(params)

    try {
      Telemetry.track({
        type: "native_call",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        method: method as string,
        status: "success",
        duration_ms: Date.now() - startTime,
      })
    } catch {
      // Telemetry must never turn a successful operation into an error
    }

    return result as any
  } catch (e) {
    try {
      Telemetry.track({
        type: "native_call",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        method: method as string,
        status: "error",
        duration_ms: Date.now() - startTime,
        error: Telemetry.maskString(String(e)).slice(0, 500),
      })
    } catch {
      // Telemetry must never prevent error propagation
    }
    throw e
  }
}

/** Check if a native handler is registered for a method. */
export function hasNativeHandler(method: BridgeMethod): boolean {
  return nativeHandlers.has(method)
}

/** List all methods that have native handlers registered. */
export function listNativeMethods(): string[] {
  return Array.from(nativeHandlers.keys())
}
