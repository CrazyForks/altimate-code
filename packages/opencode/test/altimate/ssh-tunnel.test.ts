/**
 * Tests for SSH tunnel config extraction and tunnel lifecycle.
 *
 * extractSshConfig is the gateway to all SSH tunnel connections — wrong
 * defaults mean connection failures, missing connection_string validation
 * means confusing errors. Tunnel lifecycle functions manage resources;
 * bugs mean dangling SSH connections.
 *
 * Zero direct tests existed before this file.
 */
import { describe, test, expect, beforeEach } from "bun:test"
import {
  extractSshConfig,
  closeTunnel,
  closeAllTunnels,
  getActiveTunnel,
} from "../../src/altimate/native/connections/ssh-tunnel"

// ---------------------------------------------------------------------------
// extractSshConfig — pure config extraction
// ---------------------------------------------------------------------------

describe("extractSshConfig", () => {
  test("returns null when no ssh_host in config", () => {
    const result = extractSshConfig({ type: "postgres", host: "db.example.com", port: 5432 })
    expect(result).toBeNull()
  })

  test("extracts SSH config with all fields provided", () => {
    const result = extractSshConfig({
      type: "postgres",
      host: "db.internal",
      port: 5432,
      ssh_host: "bastion.example.com",
      ssh_port: 2222,
      ssh_user: "deploy",
      ssh_password: "secret123",
    })
    expect(result).not.toBeNull()
    expect(result!.ssh_host).toBe("bastion.example.com")
    expect(result!.ssh_port).toBe(2222)
    expect(result!.ssh_user).toBe("deploy")
    expect(result!.ssh_password).toBe("secret123")
    expect(result!.ssh_private_key).toBeUndefined()
    expect(result!.host).toBe("db.internal")
    expect(result!.port).toBe(5432)
  })

  test("applies default port 22 and user 'root' when not specified", () => {
    const result = extractSshConfig({
      type: "snowflake",
      host: "db.internal",
      port: 443,
      ssh_host: "bastion.example.com",
    })
    expect(result!.ssh_port).toBe(22)
    expect(result!.ssh_user).toBe("root")
  })

  test("defaults to host 127.0.0.1 and port 5432 when host/port absent (type-agnostic)", () => {
    // Note: the 5432 fallback is hardcoded regardless of database type.
    // A postgres config and a mysql config both get 5432 when port is omitted.
    const pgResult = extractSshConfig({
      type: "postgres",
      ssh_host: "bastion.example.com",
    })
    expect(pgResult!.host).toBe("127.0.0.1")
    expect(pgResult!.port).toBe(5432)

    // Same fallback for non-postgres types — documents that default is NOT type-aware
    const mysqlResult = extractSshConfig({
      type: "mysql",
      ssh_host: "bastion.example.com",
    })
    expect(mysqlResult!.port).toBe(5432)
  })

  test("throws when connection_string is used with SSH", () => {
    expect(() =>
      extractSshConfig({
        type: "postgres",
        connection_string: "postgresql://user:pass@host:5432/db",
        ssh_host: "bastion.example.com",
      }),
    ).toThrow("Cannot use SSH tunnel with connection_string")
  })
})

// ---------------------------------------------------------------------------
// Tunnel lifecycle — no SSH connection needed
// ---------------------------------------------------------------------------

describe("tunnel lifecycle (no SSH connection needed)", () => {
  beforeEach(() => {
    // Ensure clean module-level state between tests
    closeAllTunnels()
  })

  test("getActiveTunnel returns undefined for non-existent tunnel", () => {
    expect(getActiveTunnel("nonexistent-tunnel-name")).toBeUndefined()
  })

  test("closeTunnel on non-existent tunnel is a no-op", () => {
    // Should not throw
    closeTunnel("nonexistent-tunnel-name")
  })

  test("closeAllTunnels on empty state is a no-op", () => {
    // Should not throw
    closeAllTunnels()
  })
})
