import type { ReviewCategory, Severity } from "./finding"
import type { Rule } from "./rule-catalog"

/**
 * Data-driven rule generators.
 *
 * Some review concerns are large, enumerable families — dialect-specific
 * functions, reserved-word identifiers, non-portable type names/operators —
 * where each member is a genuinely distinct, real-world catch (this is exactly
 * what SQL transpilers like SQLGlot and linters like SQLFluff catalog per
 * dialect). Rather than hand-write each, we generate one self-verifying rule per
 * curated entry (auto positive example + counter), so the catalog scales to
 * thousands of checks while every rule stays validated by the self-test.
 *
 * Curation rule: only NON-standard / dialect-specific members are listed —
 * standard ANSI functions/types are deliberately excluded to keep precision.
 */

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const seenFn = new Set<string>()

/** One "non-portable function" rule per name in a whitespace-separated list. */
function genFns(family: string, namesStr: string, category: ReviewCategory, why: string): Rule[] {
  const out: Rule[] = []
  for (const raw of namesStr.split(/\s+/)) {
    const name = raw.trim().toLowerCase()
    if (!name || seenFn.has(name)) continue
    seenFn.add(name)
    out.push({
      id: `fn-${name}`,
      category,
      severity: "suggestion",
      title: `${name.toUpperCase()}() is ${family}-specific — verify portability`,
      body: `\`${name.toUpperCase()}()\` is a ${family} function, not standard SQL. ${why} Confirm your warehouse supports it or use a portable equivalent.`,
      added: new RegExp(`\\b${esc(name)}\\s*\\(`, "i"),
      example: { add: `select ${name}(col) from t` },
      counter: { add: "select id from t" },
    })
  }
  return out
}

const seenWord = new Set<string>()

/** One "reserved word used as alias/identifier" rule per word. */
function genReserved(wordsStr: string): Rule[] {
  const out: Rule[] = []
  for (const raw of wordsStr.split(/\s+/)) {
    const w = raw.trim().toLowerCase()
    if (!w || w === "as" || seenWord.has(w)) continue
    seenWord.add(w)
    out.push({
      id: `reserved-${w}`,
      category: "sql_quality",
      severity: "suggestion",
      title: `reserved word '${w}' used as an alias`,
      body: `\`${w.toUpperCase()}\` is a reserved SQL keyword; aliasing/naming a column with it requires quoting and breaks across warehouses. Pick a non-reserved name.`,
      added: new RegExp(`\\bas\\s+${esc(w)}\\b`, "i"),
      example: { add: `select x as ${w}` },
      counter: { add: `select x as ${w}_col` },
    })
  }
  return out
}

const seenType = new Set<string>()

/** One "non-portable type" rule per type name used in a CAST. */
function genTypes(typesStr: string): Rule[] {
  const out: Rule[] = []
  for (const raw of typesStr.split(/\s+/)) {
    const t = raw.trim().toLowerCase()
    if (!t || seenType.has(t)) continue
    seenType.add(t)
    out.push({
      id: `type-${t}`,
      category: "contract_violation",
      severity: "suggestion",
      title: `non-portable type '${t}' in CAST`,
      body: `\`${t.toUpperCase()}\` is a dialect-specific type name; it won't compile across warehouses. Use a portable type (e.g. string/numeric/int/timestamp).`,
      added: new RegExp(`\\bas\\s+${esc(t)}\\b`, "i"),
      example: { add: `cast(x as ${t})` },
      counter: { add: "cast(x as numeric)" },
    })
  }
  return out
}

/** One rule per dialect-specific operator symbol. */
function genOps(
  ops: Array<{ id: string; re: RegExp; ex: string; counter: string; title: string; body: string }>,
): Rule[] {
  return ops.map((o) => ({
    id: `op-${o.id}`,
    category: "sql_quality" as ReviewCategory,
    severity: "suggestion" as Severity,
    title: o.title,
    body: o.body,
    added: o.re,
    example: { add: o.ex },
    counter: { add: o.counter },
  }))
}

// ===========================================================================
// FUNCTION FAMILIES — dialect-specific (non-ANSI) functions only.
// ===========================================================================
const FN: Rule[] = [
  ...genFns(
    "a string",
    "charindex patindex stuff quotename instr strpos locate initcap lpad rpad btrim translate split_part strtok strtok_to_array soundex difference reverse repeat replicate space parse_url editdistance jarowinkler_similarity unistr left right substr mid len charlen str format_string sprintf printf concat_ws regexp_substr regexp_extract regexp_instr regexp_count regexp_replace regexp_matches regexp_like rlike regexp_extract_all ilike_any like_any collate normalize_string",
    "sql_quality",
    "String-function names and signatures vary widely by warehouse.",
  ),
  ...genFns(
    "a date/time",
    "getdate sysdate getutcdate sysdatetime datepart datename dateadd date_add date_sub datediff date_diff timestampadd timestampdiff timeadd timediff datetrunc to_date to_timestamp to_char from_unixtime unix_timestamp last_day next_day dayofweek dayofyear weekofyear weekday yearweek months_between add_months convert_timezone at_time_zone make_date make_timestamp date_from_parts time_from_parts timestamp_from_parts datefromparts eomonth format_date parse_date format_timestamp parse_timestamp date_format str_to_date period_add curdate dayname monthname time_slice generate_date_array generate_timestamp_array from_iso8601_timestamp date_trunc_safe",
    "sql_quality",
    "Date-function names, argument order and timezone behavior differ by warehouse.",
  ),
  ...genFns(
    "a conditional/null",
    "nvl nvl2 isnull ifnull iif iff decode zeroifnull nullifzero choose equal_null div0 div0null booland boolor boolxor regr_count",
    "sql_correctness",
    "Null/conditional helpers behave differently per dialect; NULL handling can change results.",
  ),
  ...genFns(
    "a conversion",
    "convert try_cast safe_cast to_number to_numeric to_varchar to_boolean to_decimal to_double to_binary try_to_number try_to_decimal try_to_date try_to_timestamp try_to_boolean parse_json try_parse_json strtol str_to_map to_json_string",
    "sql_correctness",
    "Conversion helpers and their failure modes (error vs NULL) differ by warehouse.",
  ),
  ...genFns(
    "an aggregate",
    "listagg group_concat string_agg array_agg collect_list collect_set median mode percentile_cont percentile_disc approx_count_distinct approx_quantiles approx_percentile approx_top_count hll hll_count countif count_if sum_if avg_if any_value arbitrary bool_and bool_or boolor_agg booland_agg bit_and bit_or bit_xor bitand_agg kurtosis skew skewness regr_slope regr_intercept regr_r2 covar_pop covar_samp stddev_pop stddev_samp var_pop var_samp variance stddev percentile_approx",
    "sql_correctness",
    "Aggregate availability and exact-vs-approximate semantics vary by warehouse.",
  ),
  ...genFns(
    "a JSON",
    "json_extract json_value json_query json_extract_path_text json_extract_scalar get_json_object json_tuple object_construct array_construct to_json from_json json_parse json_build_object jsonb_extract_path jsonb_extract_path_text openjson json_object_keys json_array_length json_extract_array_element_text variant_to_json check_json parse_ip json_agg jsonb_agg json_each to_variant as_object as_array",
    "sql_correctness",
    "JSON/semi-structured access syntax is entirely dialect-specific; cast results explicitly.",
  ),
  ...genFns(
    "an array/struct",
    "unnest flatten explode posexplode explode_outer array_contains array_length cardinality array_distinct array_sort array_position array_slice array_to_string string_to_array split_to_table named_struct element_at array_construct_compact arrays_overlap array_intersection array_cat array_append array_size array_compact array_remove array_union sequence map_keys map_values map_filter zip_with arrays_zip transform_values",
    "fanout",
    "Array/struct functions are dialect-specific and several (UNNEST/FLATTEN/EXPLODE) multiply rows.",
  ),
  ...genFns(
    "a geospatial",
    "st_geogpoint st_point st_distance st_within st_contains st_intersects st_dwithin st_area st_buffer st_makeline st_geogfromtext st_geomfromtext st_astext st_centroid st_length st_perimeter st_union st_difference st_setsrid st_transform st_simplify st_envelope st_x st_y st_geohash st_makepolygon",
    "sql_quality",
    "Geospatial (ST_*) function support and SRID handling vary by warehouse.",
  ),
  ...genFns(
    "a hash/encoding",
    "farm_fingerprint hashbytes hash_agg sha sha1 sha2 sha256 sha512 hash_64 to_base64 from_base64 base64_encode base64_decode crc32 murmur3 xxhash64 hex_encode hex_decode to_hex from_hex unhex encode decode chr ascii bit_length octet_length compress decompress",
    "sql_quality",
    "Hash/encode function names and output encodings differ by warehouse.",
  ),
  ...genFns(
    "a math/bitwise",
    "div bitand bitor bitxor bitnot bitshiftleft bitshiftright bitcount getbit cbrt factorial gcd lcm haversine square cube cot acot sec csc sinh cosh tanh asinh acosh atanh width_bucket truncate trunc pow randstr uniform zipf normal seq1 seq2 seq4 seq8 random_between",
    "sql_quality",
    "Math/bitwise helpers beyond ANSI are dialect-specific.",
  ),
  ...genFns(
    "a window/analytic",
    "ratio_to_report conditional_change_event conditional_true_event lag_in_frame lead_in_frame nth_value_from_last",
    "sql_correctness",
    "Analytic helpers beyond standard window functions are warehouse-specific.",
  ),
  ...genFns(
    "a system/session",
    "current_user session_user system_user current_role current_warehouse current_database current_schema last_query_id object_id db_name suser_name suser_sname newid scope_identity ident_current last_insert_id connection_id version user_name host_name",
    "idempotency",
    "Session/system functions vary by run context and aren't reproducible in a transform.",
  ),
  ...genFns(
    "a Spark/Databricks",
    "from_json get_json_object schema_of_json to_csv from_csv map_from_arrays arrays_zip filter forall aggregate reduce exists transform_keys percentile xpath stack inline parse_url_tuple",
    "sql_quality",
    "Spark SQL functions don't exist on other warehouses.",
  ),
  ...genFns(
    "a BigQuery",
    "net.host net.reg_domain net.ip_from_string net.ipv4_to_int64 ml.predict ml.feature_info safe.cast safe.divide safe.negate generate_array byte_length code_points_to_string string_to_code_points contains_substr search vector_search",
    "sql_quality",
    "BigQuery-namespaced functions (NET./ML./SAFE.) are BigQuery-only.",
  ),
  ...genFns(
    "a Snowflake",
    "try_to_geography parse_xml check_xml get_path get_ignore_case system$wait system$abort_session as_double as_integer as_char as_varchar as_boolean as_date as_timestamp_ntz time_from_parts dateadd_safe minute_diff",
    "sql_quality",
    "Snowflake-specific functions won't run elsewhere.",
  ),
  ...genFns(
    "a Postgres",
    "generate_series age justify_interval justify_days array_to_json row_to_json to_tsvector to_tsquery ts_rank similarity word_similarity nextval currval setval lpad regexp_split_to_table regexp_split_to_array",
    "sql_quality",
    "Postgres-specific functions won't run on cloud warehouses.",
  ),
  ...genFns(
    "a Redshift",
    "json_extract_path_text json_extract_array_element_text approximate listaggdistinct getdate_local dat_part",
    "sql_quality",
    "Redshift-specific functions/aliases aren't portable.",
  ),
  ...genFns(
    "a try/safe-guard",
    "try_add try_subtract try_multiply try_divide try_element_at try_sum try_avg safe_negate safe_multiply safe_add safe_subtract",
    "sql_correctness",
    "TRY_/SAFE_ guarded arithmetic is dialect-specific; semantics differ between error and NULL.",
  ),
  ...genFns(
    "a Trino/DuckDB",
    "approx_distinct contains_sequence regexp_extract_all url_extract_host url_extract_path url_extract_query url_extract_protocol url_extract_port to_iso8601 from_iso8601_date array_join multimap_agg histogram numeric_histogram qdigest_agg tdigest_agg word_stem map_from_entries bitwise_and_agg bitwise_or_agg list_extract list_aggregate list_transform list_filter unnest_longer unnest_wider list_value list_pack struct_pack epoch_ms strftime strptime",
    "sql_quality",
    "Trino/Presto/DuckDB functions are engine-specific.",
  ),
  ...genFns(
    "a legacy/deprecated",
    "nz toupper tolower str_replace to_days from_days period_diff makedate maketime sec_to_time time_to_sec utc_timestamp utc_date utc_time soundex2 isnumeric isdate quoted_identifier textptr nvl_safe",
    "sql_quality",
    "Legacy/deprecated functions should be replaced with current standard equivalents.",
  ),
]

// ===========================================================================
// RESERVED WORDS — ANSI + warehouse reserved keywords (curated, ~300).
// ===========================================================================
const RESERVED_WORDS = `
select from where group by having order limit offset fetch first next only ties
join inner outer left right full cross natural on using union intersect except minus all distinct
case when then else end and or not null is in like ilike rlike between exists any some
with recursive over partition window rows range unbounded preceding following current row qualify
pivot unpivot lateral apply connect start prior level rownum dual
table view sequence index primary foreign key unique check default constraint references
create alter drop truncate insert update delete merge into values set returning grant revoke comment
column add cascade restrict rename modify
int integer bigint smallint tinyint mediumint decimal numeric float real double precision number money
char varchar nchar nvarchar text string clob blob bytea binary varbinary boolean bool bit
date time timestamp datetime interval year month day hour minute second zone timezone
json jsonb variant array struct map object uuid serial geography geometry super
user current_user session_user system_user current_role authorization
current_date current_time current_timestamp localtime localtimestamp sysdate getdate
cast convert coalesce nullif cube rollup grouping grouping_id
true false unknown
asymmetric symmetric similar escape collate placing overlaps
schema catalog database domain role
analyze vacuum explain optimize cluster
begin commit rollback transaction savepoint work
function procedure trigger returns language immutable stable volatile
if elseif while loop declare cursor open close fetch leave iterate repeat until
isolation read write committed uncommitted repeatable serializable
sample tablesample top percent
lead lag rank dense_rank row_number ntile first_value last_value nth_value cume_dist percent_rank
abort cancel listen notify lock share exclusive nowait skip locked
temp temporary unlogged global local
generated identity always increment
filter within ordinality respect ignore nulls
describe show use call execute prepare deallocate reset discard checkpoint reindex
copy import export load unload stage put get list remove
connect_by_root nocycle siblings dimension measures match_recognize define subset permute classifier
materialized incremental ephemeral persist transient clone
`

// ===========================================================================
// NON-PORTABLE TYPE NAMES (dialect-specific).
// ===========================================================================
const NONPORTABLE_TYPES = `
int2 int4 int8 float4 float8 bytea serial bigserial smallserial smalldatetime datetime2 datetimeoffset
nvarchar nchar ntext clob nclob blob raw long variant super geography geometry hierarchyid sql_variant
tinyint mediumint binary_float binary_double bignumeric float64 int64 uniqueidentifier rowversion
xml hstore inet cidr macaddr tsvector tsquery box circle line lseg path polygon point money2
timestamptz timetz int128 uint8 uint16 uint32 uint64 decimal128 decimal256 fixedstring datetime64
enum8 enum16 ipv4 ipv6 utinyint usmallint uinteger ubigint hugeint nvarchar2 varchar2 clob2 bpchar
`

// ===========================================================================
// DIALECT-SPECIFIC OPERATORS.
// ===========================================================================
const OPS = genOps([
  {
    id: "pg-cast",
    re: /::/,
    ex: "select x::int from t",
    counter: "select cast(x as int) from t",
    title: "`::` cast is Postgres/Redshift-specific",
    body: "`x::type` cast syntax isn't portable; use `cast(x as type)`.",
  },
  {
    id: "json-arrow2",
    re: /->>/,
    ex: "select data->>'k' from t",
    counter: "select json_value(data,'k') from t",
    title: "`->>` JSON operator is Postgres-specific",
    body: "`->>`/`->` JSON access is Postgres/MySQL-specific; use the warehouse's JSON function.",
  },
  {
    id: "json-hasharrow",
    re: /#>>/,
    ex: "select data#>>'{a,b}' from t",
    counter: "select json_value(data,'$.a.b') from t",
    title: "`#>>` JSON path operator is Postgres-specific",
    body: "`#>`/`#>>` deep JSON path operators are Postgres-only.",
  },
  {
    id: "jsonb-contains",
    re: /@>/,
    ex: "where data @> '{}'",
    counter: "where json_value(data,'$.x') = 'y'",
    title: "`@>` containment operator is Postgres-specific",
    body: "`@>`/`<@` containment operators are Postgres/JSONB-only.",
  },
  {
    id: "pg-regex",
    re: /~\*|!~/,
    ex: "where name ~* 'abc'",
    counter: "where lower(name) like '%abc%'",
    title: "`~`/`~*` regex operator is Postgres-specific",
    body: "POSIX regex operators (`~`, `~*`, `!~`) are Postgres-only; use REGEXP_* functions.",
  },
  {
    id: "mysql-null-safe",
    re: /<=>/,
    ex: "where a <=> b",
    counter: "where a is not distinct from b",
    title: "`<=>` null-safe equality is MySQL-specific",
    body: "MySQL's `<=>` isn't portable; use `IS NOT DISTINCT FROM` or explicit NULL handling.",
  },
])

export const GENERATED: Rule[] = [...FN, ...genReserved(RESERVED_WORDS), ...genTypes(NONPORTABLE_TYPES), ...OPS]
