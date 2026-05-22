import { sqlExecute } from "./sql_execute.js"
import { sqlAnalyze } from "./sql_analyze.js"
import { sqlExplain } from "./sql_explain.js"
import { schemaIntrospect } from "./schema_introspect.js"
import { dbtCompile } from "./dbt_compile.js"
import { dbtRun } from "./dbt_run.js"
import { dbtTest } from "./dbt_test.js"
import { dbtLineage } from "./dbt_lineage.js"
import { dbtImpactAnalyze } from "./dbt_impact_analyze.js"
import { dbtDiff } from "./dbt_diff.js"
import { finopsCreditsSummary } from "./finops_credits_summary.js"
import { finopsExpensiveQueries } from "./finops_expensive_queries.js"
import { finopsWarehouseAdvice } from "./finops_warehouse_advice.js"
import { finopsUnusedResources } from "./finops_unused_resources.js"
import { finopsAnomalyScan } from "./finops_anomaly_scan.js"
import { finopsClusteringRoi } from "./finops_clustering_roi.js"
import { queryHistorySearch } from "./query_history_search.js"
import { piiScan } from "./pii_scan.js"
import { dataParityCheck } from "./data_parity_check.js"
import { accountUsageQuery } from "./account_usage_query.js"

/**
 * The 20 curated tools exposed over MCP. Order is preserved for `tools/list`
 * — keeps category-grouped output for clients that surface the list to humans.
 */
export const tools = [
  sqlExecute,
  sqlAnalyze,
  sqlExplain,
  schemaIntrospect,
  dbtCompile,
  dbtRun,
  dbtTest,
  dbtLineage,
  dbtImpactAnalyze,
  dbtDiff,
  finopsCreditsSummary,
  finopsExpensiveQueries,
  finopsWarehouseAdvice,
  finopsUnusedResources,
  finopsAnomalyScan,
  finopsClusteringRoi,
  queryHistorySearch,
  piiScan,
  dataParityCheck,
  accountUsageQuery,
] as const
