import { describe, test, expect, beforeAll, afterAll } from "bun:test"

// Disable telemetry to avoid side-effects
beforeAll(() => { process.env.ALTIMATE_TELEMETRY_DISABLED = "true" })
afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

import { extractSshConfig, closeTunnel, getActiveTunnel } from "../../src/altimate/native/connections/ssh-tunnel"
import { detectAuthMethod } from "../../src/altimate/native/connections/registry"

// ---------------------------------------------------------------------------
// extractSshConfig — pure function that extracts SSH tunnel config
// ---------------------------------------------------------------------------

describe("extractSshConfig", () => {
  test("returns null when no ssh_host is present", () => {
    const result = extractSshConfig({ type: "postgres", host: "db.example.com", port: 5432 })
    expect(result).toBeNull()
  })

  test("extracts full SSH config with all fields", () => {
    const result = extractSshConfig({
      type: "postgres",
      host: "db.internal",
      port: 5433,
      ssh_host: "bastion.example.com",
      ssh_port: 2222,
      ssh_user: "deployer",
      ssh_password: "secret",
    })
    expect(result).toEqual({
      ssh_host: "bastion.example.com",
      ssh_port: 2222,
      ssh_user: "deployer",
      ssh_password: "secret",
      ssh_private_key: undefined,
      host: "db.internal",
      port: 5433,
    })
  })

  test("applies defaults for ssh_port, ssh_user, host, port", () => {
    const result = extractSshConfig({
      type: "postgres",
      ssh_host: "bastion.example.com",
    })
    expect(result).not.toBeNull()
    expect(result!.ssh_port).toBe(22)
    expect(result!.ssh_user).toBe("root")
    expect(result!.host).toBe("127.0.0.1")
    expect(result!.port).toBe(5432)
  })

  test("throws when connection_string is used with SSH tunnel", () => {
    expect(() => extractSshConfig({
      type: "postgres",
      ssh_host: "bastion.example.com",
      connection_string: "postgresql://user:pass@host:5432/db",
    })).toThrow("Cannot use SSH tunnel with connection_string")
  })

  test("supports private key authentication", () => {
    const result = extractSshConfig({
      type: "snowflake",
      host: "db.internal",
      port: 443,
      ssh_host: "bastion.example.com",
      ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAA...",
    })
    expect(result).not.toBeNull()
    expect(result!.ssh_private_key).toBe("-----BEGIN OPENSSH PRIVATE KEY-----\nAAA...")
    expect(result!.ssh_password).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// closeTunnel / getActiveTunnel — idempotent operations on empty state
// ---------------------------------------------------------------------------

describe("SSH tunnel state management", () => {
  test("closeTunnel is a no-op for non-existent tunnel and does not corrupt state", () => {
    closeTunnel("nonexistent-tunnel-name")
    expect(getActiveTunnel("nonexistent-tunnel-name")).toBeUndefined()
  })

  test("getActiveTunnel returns undefined for non-existent tunnel", () => {
    expect(getActiveTunnel("nonexistent")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// detectAuthMethod — MongoDB-specific fallback paths (added in commit abcaa1d)
//
// Note: config.password triggers the generic "password" branch (line 226)
// BEFORE the type-specific MongoDB branch (line 229). These tests document
// the actual precedence behavior, not the MongoDB branch in isolation.
// ---------------------------------------------------------------------------

describe("detectAuthMethod: MongoDB", () => {
  test("mongodb without password falls through to MongoDB-specific branch returning 'connection_string'", () => {
    expect(detectAuthMethod({ type: "mongodb" })).toBe("connection_string")
  })

  test("mongo alias without password falls through to MongoDB-specific branch returning 'connection_string'", () => {
    expect(detectAuthMethod({ type: "mongo" })).toBe("connection_string")
  })

  test("mongodb with password is caught by the generic password check (precedence test)", () => {
    // The generic `if (config.password)` fires before the MongoDB branch
    expect(detectAuthMethod({ type: "mongodb", password: "secret" })).toBe("password")
  })

  test("mongodb with connection_string is caught by the generic connection_string check (precedence test)", () => {
    expect(detectAuthMethod({ type: "mongodb", connection_string: "mongodb://localhost:27017" })).toBe("connection_string")
  })
})
