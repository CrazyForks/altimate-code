/**
 * Environment-variable based auth + the write-gate.
 *
 * Phase 1 keeps the surface trivially auditable: no file-based config, no
 * embedded secrets, no network round-trip to resolve credentials. Every value
 * comes from `process.env`, and mutating tools require an explicit opt-in
 * through `ALTIMATE_MCP_ALLOW_WRITE=true`.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"])

export function isWriteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ALTIMATE_MCP_ALLOW_WRITE
  if (!raw) return false
  return TRUTHY.has(raw.trim().toLowerCase())
}

export class WriteNotAllowedError extends Error {
  constructor(toolName: string) {
    super(
      `${toolName}: write operations are disabled. Set ALTIMATE_MCP_ALLOW_WRITE=true to enable mutating tools.`,
    )
    this.name = "WriteNotAllowedError"
  }
}

export function assertWriteAllowed(toolName: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isWriteAllowed(env)) throw new WriteNotAllowedError(toolName)
}
