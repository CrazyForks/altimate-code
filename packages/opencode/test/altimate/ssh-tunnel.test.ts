import { describe, test, expect } from "bun:test"
import {
  extractSshConfig,
  closeTunnel,
  closeAllTunnels,
  getActiveTunnel,
} from "../../src/altimate/native/connections/ssh-tunnel"

describe("SSH tunnel: extractSshConfig", () => {
  test("returns null when no ssh_host present", () => {
    const result = extractSshConfig({ type: "postgres", host: "db.example.com", port: 5432 })
    expect(result).toBeNull()
  })

  test("extracts SSH config with all fields", () => {
    const config = {
      type: "postgres",
      host: "db.internal",
      port: 5432,
      ssh_host: "bastion.example.com",
      ssh_port: 2222,
      ssh_user: "deploy",
      ssh_password: "secret",
    }
    const result = extractSshConfig(config)
    expect(result).toEqual({
      ssh_host: "bastion.example.com",
      ssh_port: 2222,
      ssh_user: "deploy",
      ssh_password: "secret",
      ssh_private_key: undefined,
      host: "db.internal",
      port: 5432,
    })
  })

  test("uses defaults for optional ssh_port and ssh_user", () => {
    const result = extractSshConfig({
      type: "postgres",
      host: "db.internal",
      port: 5432,
      ssh_host: "bastion.example.com",
    })
    expect(result!.ssh_port).toBe(22)
    expect(result!.ssh_user).toBe("root")
  })

  test("uses default host and port when not specified", () => {
    const result = extractSshConfig({
      type: "postgres",
      ssh_host: "bastion.example.com",
    })
    expect(result!.host).toBe("127.0.0.1")
    expect(result!.port).toBe(5432)
  })

  test("throws when ssh_host used with connection_string", () => {
    expect(() =>
      extractSshConfig({
        type: "postgres",
        ssh_host: "bastion.example.com",
        connection_string: "postgresql://user:pass@host/db",
      }),
    ).toThrow("Cannot use SSH tunnel with connection_string")
  })

  test("passes through both ssh_private_key and ssh_password", () => {
    const result = extractSshConfig({
      type: "postgres",
      host: "db.internal",
      port: 5432,
      ssh_host: "bastion.example.com",
      ssh_private_key: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
      ssh_password: "also-provided",
    })
    expect(result!.ssh_private_key).toContain("BEGIN RSA PRIVATE KEY")
    expect(result!.ssh_password).toBe("also-provided")
  })
})

describe("SSH tunnel: lifecycle helpers (no real SSH)", () => {
  test("closeTunnel is a no-op for unknown name", () => {
    closeTunnel("nonexistent-tunnel-name")
    expect(getActiveTunnel("nonexistent-tunnel-name")).toBeUndefined()
  })

  test("closeAllTunnels is safe when no tunnels exist", () => {
    closeAllTunnels()
    expect(getActiveTunnel("any")).toBeUndefined()
  })
})
