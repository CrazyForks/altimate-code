/**
 * Pure utility functions for schema preview display.
 * Separated from TSX for testability.
 */

/** Map data types to short type labels */
export function shortType(dataType: string): string {
  const normalized = dataType.toUpperCase()
  const typeMap: Record<string, string> = {
    VARCHAR: "VARCHAR",
    "CHARACTER VARYING": "VARCHAR",
    TEXT: "TEXT",
    INTEGER: "INT",
    INT: "INT",
    INT4: "INT",
    INT8: "BIGINT",
    BIGINT: "BIGINT",
    SMALLINT: "SMALLINT",
    INT2: "SMALLINT",
    BOOLEAN: "BOOL",
    BOOL: "BOOL",
    FLOAT: "FLOAT",
    FLOAT4: "FLOAT",
    FLOAT8: "DOUBLE",
    DOUBLE: "DOUBLE",
    "DOUBLE PRECISION": "DOUBLE",
    DECIMAL: "DECIMAL",
    NUMERIC: "DECIMAL",
    NUMBER: "NUMBER",
    DATE: "DATE",
    TIMESTAMP: "TIMESTAMP",
    "TIMESTAMP WITHOUT TIME ZONE": "TIMESTAMP",
    "TIMESTAMP WITH TIME ZONE": "TIMESTAMPTZ",
    TIMESTAMPTZ: "TIMESTAMPTZ",
    TIMESTAMP_NTZ: "TIMESTAMP",
    TIMESTAMP_LTZ: "TIMESTAMPTZ",
    TIMESTAMP_TZ: "TIMESTAMPTZ",
    JSON: "JSON",
    JSONB: "JSONB",
    VARIANT: "VARIANT",
    ARRAY: "ARRAY",
    OBJECT: "OBJECT",
    UUID: "UUID",
    BINARY: "BINARY",
    VARBINARY: "BINARY",
    BYTEA: "BINARY",
  }
  // Check for parameterized types like VARCHAR(255) or DECIMAL(10,2)
  const baseType = normalized.replace(/\(.*\)/, "").trim()
  return typeMap[baseType] ?? dataType
}

/** Detect if column name suggests a foreign key */
export function detectFK(name: string): boolean {
  return /(_id|_fk|_key)$/i.test(name) && !/^(id|pk)$/i.test(name)
}

/** Format row count for display */
export function formatRowCount(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return count.toLocaleString()
}
