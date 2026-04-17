/**
 * SQL Server driver using the `mssql` (tedious) package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"

// ---------------------------------------------------------------------------
// Azure AD helpers — cache + resource URL resolution
// ---------------------------------------------------------------------------

// Module-scoped token cache, keyed by `${resource}|${clientId ?? ""}`.
// Tokens are reused across `connect()` calls in the same process and refreshed
// a few minutes before expiry. Fixes the issue where every new connection
// fetched a fresh token (wasteful, risks throttling) and long-lived diffs
// failed silently when the embedded token hit its ~1h TTL.
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000 // refresh 5 minutes before expiry
const TOKEN_FALLBACK_TTL_MS = 50 * 60 * 1000 // used when JWT has no exp claim

/**
 * Parse the `exp` claim from a JWT access token (milliseconds since epoch).
 * Returns undefined if the token isn't a JWT or has no exp claim.
 */
function parseTokenExpiry(token: string): number | undefined {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return undefined
    const payload = parts[1]
    // base64url → base64 + padding
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (payload.length % 4)) % 4)
    const decoded = Buffer.from(padded, "base64").toString("utf-8")
    const claims = JSON.parse(decoded)
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the Azure resource URL for token acquisition.
 *
 * Preference order:
 *   1. Explicit `config.azure_resource_url`.
 *   2. Inferred from host suffix (Azure Gov / China).
 *   3. Default Azure commercial cloud.
 */
function resolveAzureResourceUrl(config: ConnectionConfig): string {
  const explicit = config.azure_resource_url as string | undefined
  if (explicit) return explicit
  const host = (config.host as string | undefined) ?? ""
  if (host.includes(".usgovcloudapi.net") || host.includes(".datawarehouse.fabric.microsoft.us")) {
    return "https://database.usgovcloudapi.net/"
  }
  if (host.includes(".chinacloudapi.cn")) {
    return "https://database.chinacloudapi.cn/"
  }
  return "https://database.windows.net/"
}

/** Visible for testing: reset the module-scoped token cache. */
export function _resetTokenCacheForTests(): void {
  tokenCache.clear()
}

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let mssql: any
  let MssqlConnectionPool: any
  try {
    // @ts-expect-error — mssql has no type declarations; installed as optional peerDependency
    const mod = await import("mssql")
    mssql = mod.default || mod
    // ConnectionPool is a named export, not on .default
    MssqlConnectionPool = mod.ConnectionPool ?? mssql.ConnectionPool
  } catch {
    throw new Error(
      "SQL Server driver not installed. Run: npm install mssql",
    )
  }

  let pool: any

  return {
    async connect() {
      const mssqlConfig: Record<string, unknown> = {
        server: config.host ?? "127.0.0.1",
        port: config.port ?? 1433,
        database: config.database,
        options: {
          encrypt: config.encrypt ?? false,
          trustServerCertificate: config.trust_server_certificate ?? true,
          connectTimeout: 10000,
          requestTimeout: 30000,
        },
        pool: {
          max: 5,
          min: 0,
          idleTimeoutMillis: 30000,
        },
      }

      // Normalize shorthand auth values to tedious-compatible types
      const AUTH_SHORTHANDS: Record<string, string> = {
        cli: "azure-active-directory-default",
        default: "azure-active-directory-default",
        password: "azure-active-directory-password",
        "service-principal": "azure-active-directory-service-principal-secret",
        serviceprincipal: "azure-active-directory-service-principal-secret",
        "managed-identity": "azure-active-directory-msi-vm",
        msi: "azure-active-directory-msi-vm",
      }
      const rawAuth = config.authentication as string | undefined
      const authType = rawAuth ? (AUTH_SHORTHANDS[rawAuth.toLowerCase()] ?? rawAuth) : undefined

      if (authType?.startsWith("azure-active-directory")) {
        ;(mssqlConfig.options as any).encrypt = true

        // Resolve a raw Azure AD access token.
        // Used by both `azure-active-directory-default` and by
        // `azure-active-directory-access-token` when no token was provided.
        //
        // We acquire the token ourselves rather than letting tedious do it because:
        //  1. Bun can resolve @azure/identity to the browser bundle (inside
        //     tedious or even our own import), where DefaultAzureCredential
        //     is a non-functional stub that throws.
        //  2. Passing a credential object via type:"token-credential" hits a
        //     CJS/ESM isTokenCredential boundary mismatch in Bun.
        //
        // Strategy: try @azure/identity first (works when module resolution
        // is correct), fall back to shelling out to `az account get-access-token`
        // (works everywhere Azure CLI is installed).
        //
        // Tokens are cached module-scope keyed by (resource, client_id) and
        // refreshed 5 minutes before expiry — reuses tokens across connections
        // and prevents silent failures when embedded tokens hit their TTL.
        const resourceUrl = resolveAzureResourceUrl(config)
        const clientId = (config.azure_client_id as string | undefined) ?? ""
        const cacheKey = `${resourceUrl}|${clientId}`

        const acquireAzureToken = async (): Promise<string> => {
          const cached = tokenCache.get(cacheKey)
          if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
            return cached.token
          }

          let token: string | undefined
          let expiresAt: number | undefined
          let azureIdentityError: unknown = null
          let azCliStderr = ""

          try {
            const azureIdentity = await import("@azure/identity")
            const credential = new azureIdentity.DefaultAzureCredential(
              config.azure_client_id
                ? { managedIdentityClientId: config.azure_client_id as string }
                : undefined,
            )
            const tokenResponse = await credential.getToken(`${resourceUrl}.default`)
            if (tokenResponse?.token) {
              token = tokenResponse.token
              // @azure/identity provides expiresOnTimestamp (ms). Prefer it; fall
              // back to parsing the JWT exp claim so both paths share the cache.
              expiresAt = tokenResponse.expiresOnTimestamp ?? parseTokenExpiry(token)
            }
          } catch (err) {
            azureIdentityError = err
            // @azure/identity unavailable or browser bundle — fall through to CLI
          }

          if (!token) {
            try {
              const { execSync } = await import("node:child_process")
              const out = execSync(
                `az account get-access-token --resource ${resourceUrl} --query accessToken -o tsv`,
                { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
              ).trim()
              if (out) {
                token = out
                expiresAt = parseTokenExpiry(out)
              }
            } catch (err: any) {
              // Capture stderr so the final error message can hint at the root cause
              // (e.g. "Please run 'az login'", "subscription not found").
              azCliStderr = String(err?.stderr ?? err?.message ?? "").slice(0, 200).trim()
            }
          }

          if (!token) {
            const hints: string[] = []
            if (azureIdentityError) hints.push(`@azure/identity: ${String(azureIdentityError).slice(0, 120)}`)
            if (azCliStderr) hints.push(`az CLI: ${azCliStderr}`)
            const detail = hints.length > 0 ? ` (${hints.join("; ")})` : ""
            throw new Error(
              `Azure AD token acquisition failed${detail}. Either install @azure/identity (npm install @azure/identity) ` +
              "or log in with Azure CLI (az login).",
            )
          }

          tokenCache.set(cacheKey, {
            token,
            expiresAt: expiresAt ?? Date.now() + TOKEN_FALLBACK_TTL_MS,
          })
          return token
        }

        if (authType === "azure-active-directory-default") {
          mssqlConfig.authentication = {
            type: "azure-active-directory-access-token",
            options: { token: await acquireAzureToken() },
          }
        } else if (authType === "azure-active-directory-password") {
          mssqlConfig.authentication = {
            type: "azure-active-directory-password",
            options: {
              userName: config.user,
              password: config.password,
              clientId: config.azure_client_id,
              tenantId: config.azure_tenant_id,
            },
          }
        } else if (authType === "azure-active-directory-access-token") {
          // If the caller supplied a token, use it; otherwise acquire one
          // automatically (DefaultAzureCredential → az CLI).
          const suppliedToken = (config.token ?? config.access_token) as string | undefined
          mssqlConfig.authentication = {
            type: "azure-active-directory-access-token",
            options: { token: suppliedToken ?? (await acquireAzureToken()) },
          }
        } else if (
          authType === "azure-active-directory-msi-vm" ||
          authType === "azure-active-directory-msi-app-service"
        ) {
          mssqlConfig.authentication = {
            type: authType,
            options: {
              ...(config.azure_client_id ? { clientId: config.azure_client_id } : {}),
            },
          }
        } else if (authType === "azure-active-directory-service-principal-secret") {
          mssqlConfig.authentication = {
            type: "azure-active-directory-service-principal-secret",
            options: {
              clientId: config.azure_client_id,
              clientSecret: config.azure_client_secret,
              tenantId: config.azure_tenant_id,
            },
          }
        }
      } else {
        // Standard SQL Server user/password
        mssqlConfig.user = config.user
        mssqlConfig.password = config.password
      }

      // Use an explicit ConnectionPool (not the global mssql.connect()) so
      // multiple simultaneous connections to different servers are isolated.
      if (MssqlConnectionPool) {
        pool = new MssqlConnectionPool(mssqlConfig)
        await pool.connect()
      } else {
        pool = await mssql.connect(mssqlConfig)
      }
    },

    async execute(sql: string, limit?: number, _binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)

      let query = sql
      const isSelectLike = /^\s*SELECT\b/i.test(sql)
      // SQL Server uses TOP, not LIMIT
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bTOP\b/i.test(sql) &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        // Insert TOP after SELECT
        query = sql.replace(
          /^(\s*SELECT\s)/i,
          `$1TOP ${effectiveLimit + 1} `,
        )
      }

      const result = await pool.request().query(query)
      const recordset = result.recordset ?? []
      const truncated = effectiveLimit > 0 && recordset.length > effectiveLimit
      const limitedRecordset = truncated ? recordset.slice(0, effectiveLimit) : recordset

      // mssql merges unnamed columns (e.g. SELECT COUNT(*), SUM(...)) into a
      // single array under the empty-string key: row[""] = [val1, val2, ...].
      // Flatten only the empty-string key to restore positional column values;
      // legitimate array values from other keys are preserved as-is.
      const flattenRow = (row: any): any[] => {
        const vals: any[] = []
        for (const [k, v] of Object.entries(row)) {
          if (k === "" && Array.isArray(v)) vals.push(...v)
          else vals.push(v)
        }
        return vals
      }

      const rows = limitedRecordset.map(flattenRow)
      const sampleFlat = rows.length > 0 ? rows[0] : []
      const namedKeys = recordset.length > 0 ? Object.keys(recordset[0]) : []
      const columns =
        namedKeys.length === sampleFlat.length
          ? namedKeys
          : sampleFlat.length > 0
            ? sampleFlat.map((_: any, i: number) => `col_${i}`)
            : (result.recordset?.columns
                ? Object.keys(result.recordset.columns)
                : [])

      return {
        columns,
        rows,
        row_count: rows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      const result = await pool
        .request()
        .query(
          "SELECT name FROM sys.schemas WHERE name NOT IN ('guest','INFORMATION_SCHEMA','sys') ORDER BY name",
        )
      return result.recordset.map((r: any) => r.name as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const result = await pool
        .request()
        .input("schema", schema)
        .query(
          `SELECT t.name, t.type
           FROM sys.tables t
           INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
           WHERE s.name = @schema
           UNION ALL
           SELECT v.name, 'V' as type
           FROM sys.views v
           INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
           WHERE s.name = @schema
           ORDER BY name`,
        )
      return result.recordset.map((r: any) => ({
        name: r.name as string,
        type: r.type?.trim() === "V" ? "view" : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const result = await pool
        .request()
        .input("schema", schema)
        .input("table", table)
        .query(
          `SELECT c.name AS column_name,
                  tp.name AS data_type,
                  c.is_nullable
           FROM sys.columns c
           INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
           INNER JOIN sys.objects o ON c.object_id = o.object_id
           INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
           WHERE s.name = @schema AND o.name = @table
             AND o.type IN ('U', 'V')
           ORDER BY c.column_id`,
        )
      return result.recordset.map((r: any) => ({
        name: r.column_name as string,
        data_type: r.data_type as string,
        nullable: r.is_nullable === 1,
      }))
    },

    async close() {
      if (pool) {
        await pool.close()
        pool = null
      }
    },
  }
}
