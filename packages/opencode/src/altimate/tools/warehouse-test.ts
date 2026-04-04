import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const WarehouseTestTool = Tool.define("warehouse_test", {
  description:
    "Test connectivity to a named warehouse connection. Verifies the connection is reachable and credentials are valid.",
  parameters: z.object({
    name: z.string().describe("Name of the warehouse connection to test"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("warehouse.test", { name: args.name })

      if (result.connected) {
        return {
          title: `Connection '${args.name}': OK`,
          metadata: { connected: true },
          output: `Successfully connected to warehouse '${args.name}'.`,
        }
      }

      // altimate_change start — actionable error guidance for common auth failures
      const errorDetail = result.error ?? "Unknown error"
      const guidance = getConnectionGuidance(errorDetail)
      // altimate_change end
      return {
        title: `Connection '${args.name}': FAILED`,
        metadata: { connected: false },
        output: `Failed to connect to warehouse '${args.name}'.\nError: ${errorDetail}${guidance}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `Connection '${args.name}': ERROR`,
        metadata: { connected: false, error: msg },
        output: `Failed to test connection: ${msg}\n\nCheck your connection configuration and try again.`,
      }
    }
  },
})

// altimate_change start — actionable error guidance for common auth failures
function getConnectionGuidance(error: string): string {
  const lower = error.toLowerCase()

  if (lower.includes("password") && (lower.includes("incorrect") || lower.includes("authentication failed"))) {
    return "\n\nHow to fix: Check the password in your connection config. Verify the username has access from your current IP address. Use `warehouse_remove` then `warehouse_add` to re-enter credentials."
  }
  if (lower.includes("password must be a string") || lower.includes("scram")) {
    return "\n\nHow to fix: The password field is missing or not a string. Check your connection config — the password may be empty or set to a non-string value. Use `warehouse_remove` then `warehouse_add` to re-configure."
  }
  if (lower.includes("private key") || lower.includes("decrypt")) {
    return "\n\nHow to fix: Key pair authentication failed. Verify: (1) the key file is PEM/PKCS#8 format, (2) the passphrase is correct, (3) the key has not expired, (4) the public key is registered in your warehouse."
  }
  if (lower.includes("missing") && lower.includes("password")) {
    return "\n\nHow to fix: No password was provided. Use `warehouse_remove` then `warehouse_add` to configure credentials. For Snowflake, you can also use key pair or SSO authentication."
  }
  if (lower.includes("browser") && lower.includes("timed out")) {
    return "\n\nHow to fix: SSO browser authentication timed out. Ensure your default browser opened the auth page. If running in a headless environment, switch to password or key pair authentication instead."
  }
  if (lower.includes("not installed") || lower.includes("cannot find module")) {
    return "\n\nHow to fix: The database driver is not installed. Run `npm install` with the appropriate driver package for your database type."
  }
  if (lower.includes("econnrefused") || lower.includes("enotfound")) {
    return "\n\nHow to fix: Cannot reach the database server. Check: (1) the hostname and port are correct, (2) the server is running, (3) any firewalls or VPNs are configured to allow the connection."
  }
  if (lower.includes("schema") && (lower.includes("does not exist") || lower.includes("not authorized"))) {
    return "\n\nHow to fix: The specified schema does not exist or your user lacks access. Check: (1) the schema name is spelled correctly, (2) your user/role has USAGE privilege on the schema."
  }

  return ""
}
// altimate_change end
