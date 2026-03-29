import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
// altimate_change start — post-connect feature suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
// altimate_change end

export const WarehouseAddTool = Tool.define("warehouse_add", {
  description:
    "Add a new warehouse connection. Stores credentials securely in OS keyring when available, metadata in connections.json.",
  parameters: z.object({
    name: z.string().describe("Name for the warehouse connection"),
    config: z
      .record(z.string(), z.unknown())
      .describe(
        `Connection configuration. Must include "type". Field aliases (camelCase, dbt names) are auto-normalized. Canonical fields per type:
- postgres: host, port, database, user, password, ssl, connection_string, statement_timeout
- snowflake: account, user, password, database, schema, warehouse, role, private_key_path, private_key_passphrase, private_key (inline PEM), authenticator (oauth/externalbrowser/okta URL), token
- bigquery: project, credentials_path (service account JSON file), credentials_json (inline JSON), location, dataset
- databricks: server_hostname, http_path, access_token, catalog, schema
- redshift: host, port, database, user, password, ssl, connection_string
- mysql: host, port, database, user, password, ssl (or ssl_ca, ssl_cert, ssl_key)
- sqlserver: host, port, database, user, password, encrypt, trust_server_certificate
- oracle: connection_string (or host, port, service_name), user, password
- duckdb: path (file path or ":memory:")
- sqlite: path (file path)
Snowflake auth examples: (1) Password: {"type":"snowflake","account":"xy12345","user":"admin","password":"secret","warehouse":"WH","database":"db"}. (2) Key-pair: {"type":"snowflake","account":"xy12345","user":"admin","private_key_path":"/path/rsa_key.p8","warehouse":"WH","database":"db"}. (3) OAuth: {"type":"snowflake","account":"xy12345","authenticator":"oauth","token":"<token>","warehouse":"WH","database":"db"}. (4) SSO: {"type":"snowflake","account":"xy12345","user":"admin","authenticator":"externalbrowser","warehouse":"WH","database":"db"}.
IMPORTANT: For private key file paths, always use "private_key_path" (not "private_key").`,
      ),
  }),
  async execute(args, ctx) {
    if (!args.config.type) {
      return {
        title: `Add '${args.name}': FAILED`,
        metadata: { success: false, name: args.name, type: "" },
        output: `Missing required field "type" in config. Specify the database type (postgres, snowflake, duckdb, mysql, sqlserver, bigquery, databricks, redshift).`,
      }
    }

    try {
      const result = await Dispatcher.call("warehouse.add", {
        name: args.name,
        config: args.config,
      })

      if (result.success) {
        // altimate_change start — append post-connect feature suggestions
        let output = `Successfully added warehouse '${result.name}' (type: ${result.type}).\n\nUse warehouse_test to verify connectivity.`
        try {
          const schemaCache = await Dispatcher.call("schema.cache_status", {}).catch(() => null)
          const schemaIndexed = (schemaCache?.total_tables ?? 0) > 0
          const warehouseList = await Dispatcher.call("warehouse.list", {}).catch(() => ({ warehouses: [] }))

          let dbtDetected = false
          try {
            const { detectDbtProject } = await import("./project-scan")
            const dbtInfo = await detectDbtProject(process.cwd())
            dbtDetected = dbtInfo.found
          } catch {
            // project-scan unavailable — skip dbt detection
          }

          const ctx: PostConnectSuggestions.SuggestionContext = {
            warehouseType: result.type,
            schemaIndexed,
            dbtDetected,
            connectionCount: warehouseList.warehouses.length,
            toolsUsedInSession: [],
          }
          output += PostConnectSuggestions.getPostConnectSuggestions(ctx)

          const suggestionsShown = ["sql_execute", "sql_analyze", "lineage_check", "schema_detect_pii"]
          if (!schemaIndexed) suggestionsShown.unshift("schema_index")
          if (dbtDetected) suggestionsShown.push("dbt_develop", "dbt_troubleshoot")
          if (warehouseList.warehouses.length > 1) suggestionsShown.push("data_diff")
          PostConnectSuggestions.trackSuggestions({
            suggestionType: "post_warehouse_connect",
            suggestionsShown,
            warehouseType: result.type,
          })
        } catch {
          // Suggestions must never break the add flow
        }
        // altimate_change end

        return {
          title: `Add '${args.name}': OK`,
          metadata: { success: true, name: result.name, type: result.type },
          output,
        }
      }

      return {
        title: `Add '${args.name}': FAILED`,
        metadata: { success: false, name: args.name, type: "" },
        output: `Failed to add warehouse '${args.name}'.\nError: ${result.error ?? "Unknown error"}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `Add '${args.name}': ERROR`,
        metadata: { success: false, name: args.name, type: "" },
        output: `Failed to add warehouse: ${msg}`,
      }
    }
  },
})
