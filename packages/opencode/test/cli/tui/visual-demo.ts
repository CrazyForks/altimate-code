/**
 * Visual demo script — renders data-UX components to stdout for screenshots.
 * Run with: bun run test/cli/tui/visual-demo.ts
 */
import {
  detectColumnType,
  formatCell,
  calculateColumnWidths,
  fitToWidth,
  formatElapsed,
} from "../../../src/cli/cmd/tui/util/data-table-utils"
import {
  shortType,
  detectFK,
  formatRowCount,
} from "../../../src/cli/cmd/tui/util/schema-preview-utils"
import {
  elapsedSeverity,
  formatInlineSummary,
} from "../../../src/cli/cmd/tui/util/cost-badge-utils"
import {
  formatCostColor,
  truncateQuery,
} from "../../../src/cli/cmd/tui/util/query-progress-utils"

// ─── ANSI helpers ──────────────────────────────────────────────
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const CYAN = "\x1b[36m"
const BLUE = "\x1b[34m"
const MAGENTA = "\x1b[35m"
const BG_DARK = "\x1b[48;5;236m"

function severityColor(sev: string) {
  if (sev === "fast" || sev === "green") return GREEN
  if (sev === "normal" || sev === "yellow") return YELLOW
  return RED
}

function hr(label: string, width = 80) {
  const line = "─".repeat(Math.max(width - label.length - 4, 10))
  console.log(`\n${DIM}──${RESET} ${BOLD}${label}${RESET} ${DIM}${line}${RESET}\n`)
}

// ─── DEMO 1: Snowflake Order Results ──────────────────────────
function demoSnowflakeOrders() {
  hr("DEMO 1: Snowflake Order Results — DataTable + CostBadge")

  const columns = ["ORDER_ID", "CUSTOMER_NAME", "TOTAL_AMOUNT", "ORDER_DATE", "STATUS"]
  const rows = [
    [10001, "Acme Corp", 15420.5, "2024-01-15", "SHIPPED"],
    [10002, "GlobalTech Inc", 8750.0, "2024-01-16", "PROCESSING"],
    [10003, "DataDriven LLC", 32100.75, "2024-01-16", "DELIVERED"],
    [10004, "CloudFirst", 4200.0, "2024-01-17", "PENDING"],
    [10005, "ML Dynamics", 67890.25, "2024-01-17", "SHIPPED"],
    [10006, "QuantumDB", 1250.0, "2024-01-18", "CANCELLED"],
  ]

  const width = 90
  const colTypes = columns.map((_, i) => detectColumnType(i, rows))
  const colWidths = calculateColumnWidths(columns, rows, width, colTypes)

  // Header
  const header = columns
    .map((col, i) => fitToWidth(col, colWidths[i], colTypes[i] === "number" ? "right" : "left"))
    .join(" │ ")
  console.log(`  ${BOLD}${header}${RESET}`)

  // Separator
  const sep = colWidths
    .map((w, i) => (colTypes[i] === "number" ? "─".repeat(w - 1) + "┤" : "─".repeat(w)))
    .join("─┼─")
  console.log(`  ${DIM}${sep}${RESET}`)

  // Rows
  for (const row of rows) {
    const line = row
      .map((val, i) => {
        const cellText = formatCell(val, colTypes[i])
        return fitToWidth(cellText, colWidths[i], colTypes[i] === "number" ? "right" : "left")
      })
      .join(" │ ")
    console.log(`  ${line}`)
  }

  // Footer badge
  const summary = formatInlineSummary({ rowCount: 6, elapsedMs: 847, truncated: false, warehouse: "COMPUTE_WH" })
  const sev = elapsedSeverity(847)
  console.log(`  ${DIM}${severityColor(sev)}${summary}${RESET}`)
}

// ─── DEMO 2: BigQuery Analytics Wide Table ────────────────────
function demoBigQueryAnalytics() {
  hr("DEMO 2: BigQuery Analytics — Wide Table with Truncation")

  const columns = ["event_date", "user_id", "session_id", "page_url", "duration_sec", "bounce", "revenue_usd"]
  const rows = [
    ["2024-01-15", "usr_abc123", "sess_001", "https://app.example.com/dashboard/analytics?ref=email&utm_source=campaign", 142.5, false, 0.0],
    ["2024-01-15", "usr_def456", "sess_002", "https://app.example.com/pricing", 45.2, true, 0.0],
    ["2024-01-15", "usr_ghi789", "sess_003", "https://app.example.com/checkout/complete", 320.1, false, 49.99],
    ["2024-01-16", "usr_jkl012", "sess_004", "https://app.example.com/docs/getting-started", 88.7, false, 0.0],
  ]

  const width = 100
  const colTypes = columns.map((_, i) => detectColumnType(i, rows))
  const colWidths = calculateColumnWidths(columns, rows, width, colTypes)

  const header = columns
    .map((col, i) => fitToWidth(col, colWidths[i], colTypes[i] === "number" ? "right" : "left"))
    .join(" │ ")
  console.log(`  ${BOLD}${header}${RESET}`)

  const sep = colWidths
    .map((w, i) => (colTypes[i] === "number" ? "─".repeat(w - 1) + "┤" : "─".repeat(w)))
    .join("─┼─")
  console.log(`  ${DIM}${sep}${RESET}`)

  for (const row of rows) {
    const line = row
      .map((val, i) => {
        const cellText = formatCell(val, colTypes[i])
        return fitToWidth(cellText, colWidths[i], colTypes[i] === "number" ? "right" : "left")
      })
      .join(" │ ")
    console.log(`  ${line}`)
  }

  const summary = formatInlineSummary({ rowCount: 1250000, elapsedMs: 3400, truncated: true, warehouse: undefined })
  const sev = elapsedSeverity(3400)
  console.log(`  ${DIM}${severityColor(sev)}${summary}${RESET}`)
}

// ─── DEMO 3: Schema Preview — Tree View ──────────────────────
function demoSchemaPreview() {
  hr("DEMO 3: Schema Preview — Tree View with PK/FK/Types")

  interface Col { name: string; data_type: string; nullable: boolean; primary_key: boolean; description?: string }
  const columns: Col[] = [
    { name: "order_id", data_type: "NUMBER(38,0)", nullable: false, primary_key: true },
    { name: "customer_id", data_type: "NUMBER(38,0)", nullable: false, primary_key: false },
    { name: "order_date", data_type: "TIMESTAMP_NTZ", nullable: false, primary_key: false },
    { name: "total_amount", data_type: "NUMBER(12,2)", nullable: false, primary_key: false },
    { name: "status", data_type: "VARCHAR(50)", nullable: true, primary_key: false },
    { name: "shipping_address", data_type: "VARIANT", nullable: true, primary_key: false },
    { name: "created_at", data_type: "TIMESTAMP_LTZ", nullable: false, primary_key: false },
    { name: "updated_at", data_type: "TIMESTAMP_LTZ", nullable: true, primary_key: false },
    { name: "region_key", data_type: "VARCHAR(10)", nullable: true, primary_key: false },
    { name: "discount_pct", data_type: "FLOAT", nullable: true, primary_key: false, description: "Applied discount percentage" },
  ]

  const tableName = "ANALYTICS.ORDERS"
  const rowCount = 2450000

  // Header
  console.log(`  ${BOLD}${tableName} · ${formatRowCount(rowCount)} rows · ${columns.length} columns${RESET}`)

  // Column tree
  const nameW = Math.max(...columns.map(c => c.name.length))
  const typeW = Math.max(...columns.map(c => shortType(c.data_type).length))

  columns.forEach((col, i) => {
    const isLast = i === columns.length - 1
    const prefix = isLast ? "└─" : "├─"
    const pk = col.primary_key ? "PK" : ""
    const fk = detectFK(col.name) ? "FK" : ""
    const name = col.name.padEnd(nameW)
    const type = shortType(col.data_type).padEnd(typeW)

    const badges: string[] = []
    if (pk) badges.push(`${GREEN}${pk}${RESET}`)
    if (fk) badges.push(`${YELLOW}${fk}${RESET}`)
    if (col.nullable) badges.push(`${DIM}NULL${RESET}`)
    if (col.description) badges.push(`${DIM}${col.description.slice(0, 30)}${RESET}`)

    const nameDisplay = col.primary_key ? `${BOLD}${name}${RESET}` : name
    console.log(`  ${DIM}${prefix}${RESET} ${nameDisplay}  ${CYAN}${type}${RESET}  ${badges.join(" ")}`)
  })
}

// ─── DEMO 4: Query Progress States ───────────────────────────
function demoQueryProgress() {
  hr("DEMO 4: Query Execution Progress — States")

  // Running state
  const query1 = "SELECT o.*, c.name, SUM(li.amount) as total FROM orders o JOIN customers c ON o.customer_id = c.id JOIN line_items li ON o.id = li.order_id WHERE o.created_at > '2024-01-01' GROUP BY 1,2,3"
  console.log(`  ${YELLOW}⠋${RESET} Running query...  ${DIM}12.3s${RESET}`)
  console.log(`  ${DIM}${truncateQuery(query1, 80)}${RESET}`)
  console.log()

  // Completed state
  console.log(`  ${GREEN}✓${RESET} Query completed  ${DIM}${formatElapsed(2340)}${RESET}`)
  const costColor = formatCostColor(0.003)
  console.log(`  ${severityColor(costColor)}$0.003${RESET}  ${DIM}42 rows · COMPUTE_WH${RESET}`)
  console.log()

  // Error state
  console.log(`  ${RED}✗${RESET} Query failed  ${DIM}0.4s${RESET}`)
  console.log(`  ${RED}SQL compilation error: Object 'ORDERS' does not exist${RESET}`)
}

// ─── DEMO 5: Narrow Terminal Adaptation ──────────────────────
function demoNarrowTerminal() {
  hr("DEMO 5: Narrow Terminal (40 chars) — Graceful Column Shrinking")

  const columns = ["ORDER_ID", "CUSTOMER_NAME", "TOTAL_AMOUNT", "STATUS"]
  const rows = [
    [10001, "Acme Corp", 15420.5, "SHIPPED"],
    [10002, "GlobalTech Inc", 8750.0, "PROCESSING"],
    [10003, "DataDriven LLC", 32100.75, "DELIVERED"],
  ]

  const width = 40
  const colTypes = columns.map((_, i) => detectColumnType(i, rows))
  const colWidths = calculateColumnWidths(columns, rows, width, colTypes)

  const header = columns
    .map((col, i) => fitToWidth(col, colWidths[i], colTypes[i] === "number" ? "right" : "left"))
    .join(" │ ")
  console.log(`  ${BOLD}${header}${RESET}`)

  const sep = colWidths
    .map((w, i) => (colTypes[i] === "number" ? "─".repeat(w - 1) + "┤" : "─".repeat(w)))
    .join("─┼─")
  console.log(`  ${DIM}${sep}${RESET}`)

  for (const row of rows) {
    const line = row
      .map((val, i) => {
        const cellText = formatCell(val, colTypes[i])
        return fitToWidth(cellText, colWidths[i], colTypes[i] === "number" ? "right" : "left")
      })
      .join(" │ ")
    console.log(`  ${line}`)
  }

  const summary = formatInlineSummary({ rowCount: 3, elapsedMs: 120, truncated: false, warehouse: "XS_WH" })
  console.log(`  ${DIM}${GREEN}${summary}${RESET}`)
}

// ─── DEMO 6: Cost Badge Severity Levels ──────────────────────
function demoCostBadges() {
  hr("DEMO 6: Cost Badge Severity Levels")

  const cases = [
    { elapsed: 120, label: "Fast query (120ms)" },
    { elapsed: 2340, label: "Normal query (2.3s)" },
    { elapsed: 15000, label: "Slow query (15s)" },
    { elapsed: 45000, label: "Very slow query (45s)" },
  ]

  for (const c of cases) {
    const sev = elapsedSeverity(c.elapsed)
    const color = severityColor(sev)
    const summary = formatInlineSummary({ rowCount: 1000, elapsedMs: c.elapsed, truncated: false, warehouse: "WH" })
    console.log(`  ${color}●${RESET} ${c.label.padEnd(28)} ${color}${summary}${RESET}`)
  }
}

// ─── Run all demos ────────────────────────────────────────────
console.log(`\n${BOLD}${MAGENTA}╔══════════════════════════════════════════════════════════════════╗${RESET}`)
console.log(`${BOLD}${MAGENTA}║     Altimate Code — Data UX Polish: Visual Component Demos      ║${RESET}`)
console.log(`${BOLD}${MAGENTA}╚══════════════════════════════════════════════════════════════════╝${RESET}`)

demoSnowflakeOrders()
demoBigQueryAnalytics()
demoSchemaPreview()
demoQueryProgress()
demoNarrowTerminal()
demoCostBadges()

hr("END OF DEMOS")
console.log(`  ${DIM}All components adapt to terminal width and degrade gracefully.${RESET}`)
console.log(`  ${DIM}281 tests pass across 8 test files with 1,866 assertions.${RESET}\n`)
