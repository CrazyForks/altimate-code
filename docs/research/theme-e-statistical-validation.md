# Theme E: Statistical Validation Approaches

_Iteration 3 — 2026-03-13_

## Key Insight: KS Test Is Overly Sensitive at Scale

Evidently AI's benchmarking found KS "would fire alarms for many real-world use cases all the time" on large datasets. **Recommendation: KS for <= 1,000 rows; Wasserstein distance for larger datasets.**

## Distribution Comparison Tests

### By Dataset Size (Evidently's Smart Defaults)

| Dataset Size | Numerical (n_unique > 5) | Categorical (n_unique > 2) | Binary |
|---|---|---|---|
| <= 1,000 rows | KS test | Chi-squared | Z-test |
| > 1,000 rows | Wasserstein distance | Jensen-Shannon | Z-test |

### Population Stability Index (PSI)
- `PSI = sum((actual% - expected%) * ln(actual% / expected%))`
- **< 0.1**: Stable, **0.1-0.25**: Investigate, **>= 0.25**: Action required
- Originated in credit risk scorecards; most widely adopted threshold in industry
- Sensitive to binning choices; add epsilon (0.0001) to avoid division by zero

### Jensen-Shannon Divergence
- Symmetric, bounded (0 to 1)
- Evidently found it "slightly more sensitive than KL divergence and PSI"
- Default for categorical features on large datasets

## Data Profiling as Validation

### Canonical Profile Metrics
Row count, null count/%, distinct count (HLL), min/max, mean/stddev, percentiles (KLL sketch), histograms, top-K frequent items, data type distribution.

### Practical Thresholds (Production Experience)

| Check | Conservative | Standard | Aggressive |
|---|---|---|---|
| Row count vs historical | +/- 10% | +/- 20% | +/- 50% |
| Null rate (critical cols) | 0% | < 1% | < 5% |
| Distinct count | +/- 2% | +/- 5% | +/- 10% |
| PSI (drift) | < 0.1 | < 0.2 | < 0.25 |
| Mean shift | < 1 sigma | < 2 sigma | < 3 sigma |

**No formal industry standards exist.** Numbers come from: statistical convention (3-sigma), financial services (PSI), iterative refinement, and tool defaults.

## Anomaly Detection Models

| Approach | Used By | Pros | Cons |
|---|---|---|---|
| Z-score | Elementary | Simple, interpretable | Assumes normality |
| IQR | Custom | Robust to outliers | Less sensitive |
| Prophet | Custom | Handles seasonality | Heavy, slow |
| Unsupervised ML | Anomalo | Adapts, no rules | Black box, expensive |
| Dynamic thresholds | Bigeye, Monte Carlo | Auto-calibrates | Vendor lock-in |

### Elementary's Approach (Open Source, dbt-native)
- Z-score anomaly detection over time buckets
- Default: 3 standard deviations, 14-day training window
- Runs as dbt tests — zero extra infrastructure

## Sketch-Based Comparison

### Apache DataSketches Ecosystem (Cross-Database Key)

| Database | HLL | KLL (Quantiles) | Theta (Distinct) |
|---|---|---|---|
| Snowflake | Native (`DATASKETCHES_HLL`) | No | No |
| ClickHouse | Native (`uniqHLL12`) | Via UDF | Native (`uniqTheta`) |
| DuckDB | Extension | Extension | Extension |

Sketches serialize as BLOBs — can be stored, shared, merged across systems without data movement.

### whylogs: Mergeable Statistical Profiles
- Single-pass, constant-memory profiling
- Metrics: counters, summary stats, HLL cardinality, KLL distribution, top-K
- **All metrics are mergeable** — combine profiles from distributed systems
- Profiles are database-agnostic: profile source in Snowflake, target in ClickHouse, compare in Python
- Serialized as Protobuf (~KB, not MB)

## Tool Comparison

| Capability | Evidently | whylogs | Great Expectations | Elementary | TFDV |
|---|---|---|---|---|---|
| KS test | Yes | No | Yes (bootstrapped) | No | No |
| PSI | Yes | No | No | No | No |
| Profile merging | No | **Yes** | No | No | No |
| Sketch-based | No | Yes (HLL, KLL) | No | No | Yes |
| dbt-native | No | No | No | **Yes** | No |
| Cross-database | Yes | Yes | Yes | Limited | No |

## Recommended Tiered Approach

**Tier 1 (Day 1)**: Row count > 0, row count within 20% of 7-day avg, no null PKs, schema matches
**Tier 2 (Week 2)**: Null rates, distinct counts within 5%, value ranges, freshness SLA
**Tier 3 (Month 2)**: PSI < 0.2, Jensen-Shannon < 0.1, Z-score on daily aggregates (3-sigma)
**Tier 4 (Mature)**: Unsupervised anomaly detection, seasonality-aware, dynamic thresholds

## Implications for Reladiff

### Already Implemented
- Profile algorithm (count, null%, distinct, min/max per column) ✓
- Cascade (count → profile → content diff) ✓

### Potential Additions
1. **PSI calculation** in Profile mode — compare distributions, not just aggregates
2. **Percentile comparison** (p50/p90/p99) using SQL `PERCENTILE_CONT` or sketches
3. **Statistical test selection** based on dataset size (KS for small, Wasserstein for large)
4. **whylogs profile export** — generate whylogs-compatible profiles from our profile results
5. **Threshold-based pass/fail** — configurable thresholds for profile metrics (e.g., "null rate < 5%")
6. **Historical baseline comparison** — store profiles over time, detect drift against baseline

### Sources
Evidently AI docs/benchmarks, whylogs docs, Elementary docs, Monte Carlo, Bigeye, Anomalo blogs, TFDV guide, Great Expectations distributional expectations, Pandera hypothesis testing, Apache DataSketches, Citus T-Digest, Datadog DDSketch

---

## Iteration 2

_Deep research — 2026-03-13_

### 1. Distribution Comparison in Practice

#### Wasserstein (Earth Mover's) Distance — Why It Wins at Scale

Unlike KL divergence or KS, Wasserstein yields a finite, interpretable value even when distributions have non-overlapping support. It respects distance in the input space — moving probability mass from value 10 to value 11 costs less than moving it to value 1000. This aligns with human intuition about similarity far better than pointwise divergence measures.

**Practical properties for data validation:**
- Quantifies differences as spatial displacement, not just magnitude
- Works on non-overlapping distributions (KL divergence returns infinity)
- SciPy implementation: `scipy.stats.wasserstein_distance(u_values, v_values)` — O(n log n)
- No binning required (unlike PSI/Jensen-Shannon), eliminating a source of instability

**When to use:** Large datasets (>1K rows) with continuous numerical columns where you care about the magnitude of shift, not just whether a shift exists.

#### Cramer-von Mises vs Anderson-Darling vs KS

These three EDF (Empirical Distribution Function) tests serve different detection goals:

| Test | Weighting | Best At Detecting | Power vs KS |
|---|---|---|---|
| Kolmogorov-Smirnov | Maximum pointwise difference | Location shifts | Baseline |
| Cramer-von Mises | Integral of squared differences | Spread/shape changes | Higher for most alternatives |
| Anderson-Darling | Extra weight on tails | Tail departures | Higher, especially with small samples |

**Key findings from power studies:**
- For ordinal data, CvM and AD are more powerful than chi-squared against trend alternatives
- For nominal data, chi-squared is more powerful against bimodal/flat alternatives
- AD requires less data than KS to reach sufficient statistical power
- No single test dominates across all alternative hypotheses — the best test depends on what departures you expect

#### Parametric vs Non-Parametric: Decision Framework

| Condition | Use Parametric | Use Non-Parametric |
|---|---|---|
| Data is normally distributed | Yes | Either |
| Large sample (n > 30) | Yes (CLT applies) | Either |
| Small sample, non-normal | No | Yes |
| Outliers present | No | Yes |
| Median better represents center | No | Yes |
| Need confidence intervals | Yes | Limited |

**For data validation:** Default to non-parametric tests (KS, Wasserstein, CvM). Data pipelines produce distributions that are rarely normal — skewed counts, heavy-tailed latencies, multimodal categoricals. Parametric tests add assumptions that pipeline data routinely violates.

### 2. Data Profiling Frameworks — Deep Dive

#### ydata-profiling: What It Actually Computes

The profiling report generates five categories of analysis from a single `ProfileReport(df)` call:

1. **Type inference** — automatic detection of Categorical, Numerical, Date, Boolean, URL, Path, etc.
2. **Univariate analysis** — per-column: mean, median, mode, std, variance, skewness, kurtosis, IQR, range, coefficient of variation, histogram, value counts
3. **Multivariate analysis** — Pearson, Spearman, Kendall, Phik correlations; pairwise scatter plots
4. **Missing data analysis** — missing count/%, matrix visualization, dendrogram of missing patterns
5. **Alerts** — automatic flagging of: high correlation (>0.9), skewness, uniformity, high zeros%, constant values, high cardinality, duplicates, infinite values, imbalanced classes

**Limitations for cross-database validation:** ydata-profiling requires all data in a Pandas/Spark DataFrame. It cannot profile data in-place in Snowflake or ClickHouse — data must be extracted first. This makes it unsuitable for large-scale cross-database comparison but useful for profiling sampled extracts.

#### DataComPy: Column-Level Statistical Comparison

Capital One's open-source library for DataFrame comparison. Key capabilities:

- **Join-based comparison** — matches rows by key columns, then compares value columns
- **Tolerance handling** — absolute and relative tolerance for floating-point comparisons
- **Column-level report** — unequal columns, equal columns, columns only in one DataFrame
- **Row-level detail** — which rows match, which differ, which are unique to each side
- **Multi-engine support** — Pandas, Polars, Spark, and Snowpark backends

**What DataComPy does NOT do:** No statistical tests, no distribution comparison, no profiling. It is a deterministic row-by-row comparator with tolerance, not a statistical validator. Complementary to, not a replacement for, distribution tests.

#### Apache DataSketches — Technical Depth

**KLL Sketch (Quantiles):**
- Default K=200 yields ~1.65% normalized rank error
- K does not need to be a power of 2
- 16 implementation variants across input types (double/float/long/items), memory modes (heap/off-heap), and storage modes (compact/updatable)
- Merge operation works across heap, off-heap, and compact byte arrays
- Outperforms t-digest on update speed, serialization, and deserialization at equivalent accuracy

**HLL Sketch (Cardinality):**
- Three flavors: HLL_4, HLL_6, HLL_8 for speed/size tuning
- Memory range: ~50 bytes to ~2MB depending on accuracy requirements
- Error bounds use lookup tables and empirical measurements (no closed-form solution)

**KLL vs T-Digest (Apache DataSketches benchmark):**

| Property | KLL (K=200) | T-Digest (compression=100) |
|---|---|---|
| Rank error | ~1.65% with formal guarantees | Similar accuracy, no formal guarantees |
| Worst-case error | Bounded | Unbounded (known worst cases exist) |
| Speed (update) | Faster | Slower |
| Speed (serialize) | Faster | Slower |
| Merge behavior | Well-defined | Ambiguous rank rule |
| Serialized size | ~same | ~same |

**T-Digest strengths:** Extreme tail accuracy (parts per million at p99.9 and p0.1). Median is the least accurate point. Merging preserves accuracy with no loss. Best for monitoring tail latencies (p99, p99.9).

**DDSketch (Datadog):** Provides relative error guarantees in value space (not rank space). Fully mergeable. Best for SLA monitoring where you need "p99 latency is within 1% of true value" rather than "rank error is within 1.65%."

### 3. Anomaly Detection for Data Quality — Production Systems

#### Uber's Architecture (D3 + UDQ + Holt-Winters)

Uber operates three interconnected systems:

**UDQ (Unified Data Quality):** Centralized API for defining, executing, and maintaining data quality tests. Supports 2,000+ critical datasets, detects ~90% of data quality incidents. Generic API contract allows any system to integrate.

**Data Stats Service (DSS):** Queries date-partitioned Hive/Vertica tables, generates time-series quality metrics per column. Tracked metrics:
- Numeric: average, median, max, min
- String: unique count, missing count
- All: null%, zero%, false%, percentiles (P1, P25, P50, P75, P99), stddev, count distinct

**D3 (Dataset Drift Detector):** Anomaly detection layer built on top of DSS.
- Uses **Prophet** as default anomaly detection model (nonlinear regression with seasonal adjustment)
- 90-day historical profiling for initial baseline
- Daily scheduled jobs for ongoing monitoring
- **PCA decomposition** to reduce many metric time series into representative bundles — top components explain >90% of variation
- Double-projection technique: project without latest data point, then with it, to amplify detection of drastic changes
- Conservative alerting limits on top of base limits to reduce false positives
- User feedback loop: users tag true/false alerts, which are excluded from future predictions

**Uber's earlier system** used **Holt-Winters additive model** (exponential smoothing with level, trend, seasonal components). One-step-ahead forecasting with severity scores 0-4. Selected because it is "simple to interpret and works very well for forecasting problems."

#### Monte Carlo's ML Approach

Four monitor categories:
1. **Pipeline observability** — learns normal update patterns, alerts on breakage
2. **Metrics monitors** — learns statistical profile of fields, alerts on pattern violations (the "unknown unknowns" detector)
3. **Validations** — custom SQL row-level checks
4. **Performance** — query runtime tracking

2025 additions: Two AI agents (Monitoring Agent, Troubleshooting Agent) built on Claude 3.5. The Monitoring Agent creates data observability monitors with thresholds suited to specific environments. The Troubleshooting Agent diagnoses root causes.

#### Anomalo's Unsupervised ML

- Samples 10,000 records from the most recent data + comparison samples from previous days
- ML models search for ways current data differs from historical data
- Built on four principles: sensitivity (detect subtle anomalies), specificity (avoid false positives), transparency (explain why), scalability
- Handles real-world noise: autoincrementing IDs, seasonality, chaotic tables
- Models retrain automatically as new data arrives
- No rules required — pure pattern learning

#### Soda's Proprietary Algorithm (2025)

- Built in-house, no third-party libraries (replaced Prophet dependency)
- 70% improvement in anomaly detection accuracy vs Prophet in benchmark testing
- 70% fewer false positives
- Scales to 1B rows in 64 seconds
- Uses Jensen-Shannon distance and KS tests for distribution comparison
- Multivariate anomaly detection: monitors joint distribution of multiple columns simultaneously, capturing inter-column relationships

#### Bigeye's Autothresholds

Multi-step process:
1. Analyze metric history with preliminary statistical tests (structural analysis)
2. Blind prediction test across multiple techniques — select most accurate
3. Model uncertainty of future values from historical data
4. Integrate forecasts + structural info + uncertainty into boundary limits

Key design details:
- Default training window: **21 days** (3 weeks = 3 cycles of weekly seasonality, the minimum for classical seasonal inference)
- Detects multiple seasonal patterns: weekly sinusoids, 3-hourly stair-stepping
- Learning rate controls pace of training to prevent slow degradation from being masked
- Trains thousands of models per customer, each consuming 100+ features
- Uses both forecast and non-forecast models
- Reinforcement learning from user feedback adjusts sensitivity over time

### 4. Percentile & Quantile Comparison — Practical Guide

#### Quantile Sketch Selection Matrix

| Algorithm | Error Type | Error Bound | Tail Accuracy | Merge | Best For |
|---|---|---|---|---|---|
| KLL | Rank error | ~1.65% (K=200) | Uniform across quantiles | Clean | General-purpose quantile comparison |
| T-Digest | Rank error | ~PPM at tails, worst at median | Excellent at extremes | Preserves accuracy | Tail monitoring (p99, p99.9) |
| DDSketch | Relative value error | Configurable (e.g., 1%) | Excellent | Fully mergeable | SLA monitoring, latency percentiles |
| REQ (Relative Error Quantiles) | Relative rank error | Configurable | Adjustable | Yes | When you need relative rather than absolute rank accuracy |

#### Comparing p50/p90/p99 Across Source and Target

Practical SQL approach using `PERCENTILE_CONT`:

```sql
-- Source percentiles
SELECT
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY amount) AS p50,
  PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY amount) AS p90,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY amount) AS p99
FROM source_table;

-- Compare: flag if any percentile differs by more than threshold
-- Relative difference: ABS(source_pNN - target_pNN) / NULLIF(source_pNN, 0)
```

**Threshold guidance for percentile comparison:**
- p50 (median): alert if relative difference > 5%
- p90: alert if relative difference > 10%
- p99: alert if relative difference > 20% (tails are naturally more volatile)

#### T-Digest Internal Mechanics

The algorithm uses a variant of 1D k-means clustering controlled by a scale function:
1. Points are sorted and grouped into clusters
2. Scale function determines cluster size — clusters near tails are smaller (more precise)
3. Each cluster stores a centroid (mean) and weight (count)
4. Percentile estimation: linear interpolation between adjacent centroids
5. CDF formula: `CDF[i] = (-w[i]/2 + sum(w[1..i])) / sum(w[1..N])`

The `delta` parameter controls accuracy vs memory: higher delta = more clusters = more memory = better accuracy. Default delta=100 provides parts-per-million accuracy at extreme percentiles.

### 5. Multi-Dimensional Data Quality Scores

#### The Six Core Dimensions (Industry Consensus)

1. **Accuracy** — data correctly represents real-world entities
2. **Completeness** — all required records and fields are populated
3. **Consistency** — no conflicts within or across systems
4. **Timeliness** — data is current and available when needed
5. **Validity** — data conforms to defined formats, types, ranges
6. **Uniqueness** — no unintended duplicates

ISO 8000 adds a three-layer model on top: **syntactic quality** (schema conformance, fully automatable), **semantic quality** (rule-based validation), **pragmatic quality** (fitness for use, measured via user feedback).

#### Composite Score Formulas in Production

**Weighted average approach (most common):**
```
Quality Score = (w_accuracy * S_accuracy + w_completeness * S_completeness + ... ) / sum(weights)
```

Example from Qualytics:
```
Score = baseline(70) * f(coverage) * f(accuracy) * f(conformity) * f(precision)
        * f(consistency) * f(completeness) * f(timeliness) * f(volumetrics)
```
Each factor is bounded to prevent single-dimension domination. Result clamped 0-100.

**DQOps pass/fail percentage:**
```
KPI = (passed_checks + warning_checks) / total_checks * 100%
```
Warnings count as passes (cosmetic issues), errors and fatals count as failures.

**Qualytics dimension formulas:**

| Dimension | Formula |
|---|---|
| Completeness | avg(non_null / total_records) * 100 |
| Conformity | (1 - anomalous_rows / min(scanned, total)) * 100 |
| Coverage | Exponential growth: 1 check ~60, 2 ~84, 3+ approaches 100 |
| Consistency | 100 for stable types, 0 for type changes |
| Timeliness | 100 - exponential decay based on anomaly count |
| Volumetrics | 100 - exponential decay based on anomaly count |

**Aggregation to datastore level:**
```
Datastore Score = sum(container_score * container_weight) / sum(container_weight)
```

#### Weighting Strategies

- **Equal weights** — simplest, often the starting point
- **Business-impact weighting** — accuracy weighted higher for financial data, timeliness weighted higher for real-time dashboards
- **Risk-based weighting** — dimensions that have caused past incidents get higher weight
- **Standardize before aggregating** — different dimensions may have different scales; normalize to 0-100 before combining

### 6. Practical Threshold Setting

#### MAD (Median Absolute Deviation) — The Robust Alternative to Z-Score

Formula: `MAD = 1.4826 * median(|Xi - median(X)|)`

The constant 1.4826 makes MAD a consistent estimator of standard deviation for normal distributions.

**Anomaly detection with MAD:**
1. Compute `median(X)` and `MAD`
2. Threshold = `median ± (sensitivity * MAD)`
3. Sensitivity typically 3-5 (analogous to sigma in Z-score)
4. Any point beyond threshold is flagged

**Why MAD beats Z-score for data quality:**
- Non-parametric — no normality assumption
- Robust to outliers — a single extreme value does not distort the baseline
- A corrupted batch cannot mask its own corruption (unlike mean + stddev)
- Simple to compute in SQL: `1.4826 * MEDIAN(ABS(value - (SELECT MEDIAN(value) FROM t)))`

#### Auto-Threshold Approaches Used in Production

| Method | Used By | Training Window | Key Property |
|---|---|---|---|
| Z-score (mean ± k*sigma) | Elementary | 14 days | Simple but assumes normality |
| MAD (median ± k*MAD) | InfluxDB, custom | Configurable | Robust to outliers |
| Holt-Winters | Uber | 90 days initial | Handles trend + seasonality |
| Prophet | Uber D3 | 90 days | Nonlinear regression, seasonal |
| Multi-model selection | Bigeye | 21 days | Selects best from model library |
| Proprietary (Prophet replacement) | Soda | Not disclosed | 70% fewer false positives |
| Unsupervised ML ensemble | Anomalo | Adapts continuously | No rules, learns patterns |
| PCA + forecasting | Uber (earlier) | 90 days | Reduces dimensionality first |

#### Combating Alert Fatigue — Production Strategies

**Quantitative targets:**
- False positive rate: < 10% on critical alerts
- Alert engagement: 70%+ of critical alerts should drive action
- Response SLAs: 15 minutes for critical, 2 hours for high-priority

**Tactical approaches:**
1. **Monitor only what matters** — 50-100 business-critical tables, not everything
2. **Severity tiering** — critical (pages), warning (Slack), info (dashboard only)
3. **Feedback loops** — let engineers flag false positives; use flags to retrain thresholds
4. **Disable ignored alerts** — if no one acts on an alert for 30 days, disable or downgrade it
5. **Adaptive ML thresholds** require 40% fewer manual updates than static rules
6. **Context in alerts** — include downstream impact ("3 dashboards affected") to enable triage
7. **Quarterly threshold reviews** — even with dynamic systems, human review prevents drift in alert quality

**Anti-patterns:**
- Alerting on every table in the warehouse (noise drowns signal)
- Static thresholds on volatile metrics (constant false positives on weekends)
- No ownership for alerts (nobody's problem = everybody's problem)
- Missing runbooks (alert fires but nobody knows what to do)

### Sources (Iteration 2)

- [Wasserstein metric — Wikipedia](https://en.wikipedia.org/wiki/Wasserstein_metric)
- [SciPy wasserstein_distance](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.wasserstein_distance.html)
- [Chi-Square vs KS vs CvM power comparison — ResearchGate](https://www.researchgate.net/publication/29462535)
- [Cramer-von Mises criterion — Wikipedia](https://en.wikipedia.org/wiki/Cram%C3%A9r%E2%80%93von_Mises_criterion)
- [Anderson-Darling test — Wikipedia](https://en.wikipedia.org/wiki/Anderson%E2%80%93Darling_test)
- [ydata-profiling — GitHub](https://github.com/ydataai/ydata-profiling)
- [ydata-profiling concepts](https://docs.profiling.ydata.ai/latest/getting-started/concepts/)
- [DataComPy — Capital One](https://capitalone.github.io/datacompy/)
- [DataComPy — GitHub](https://github.com/capitalone/datacompy)
- [Apache DataSketches KLL](https://datasketches.apache.org/docs/KLL/KLLSketch.html)
- [Apache DataSketches HLL](https://datasketches.apache.org/docs/HLL/HllSketches.html)
- [KLL vs T-Digest — Apache DataSketches](https://datasketches.apache.org/docs/QuantilesStudies/KllSketchVsTDigest.html)
- [DDSketch paper — VLDB](https://www.vldb.org/pvldb/vol12/p2195-masson.pdf)
- [T-Digest — G-Research](https://www.gresearch.com/news/approximate-percentiles-with-t-digests/)
- [T-Digest paper — ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2665963820300403)
- [Uber D3 drift detection](https://www.uber.com/en-DE/blog/d3-an-automated-system-to-detect-data-drifts/)
- [Uber data quality monitoring at scale](https://www.uber.com/blog/monitoring-data-quality-at-scale/)
- [Uber operational excellence in data quality](https://www.uber.com/blog/operational-excellence-data-quality/)
- [Monte Carlo anomaly detection](https://www.montecarlodata.com/blog-data-quality-anomaly-detection-everything-you-need-to-know/)
- [Monte Carlo AI agents — BigDATAwire](https://www.hpcwire.com/bigdatawire/2025/04/17/monte-carlo-brings-ai-agents-into-the-data-observability-fold/)
- [Anomalo unsupervised ML — Snowflake blog](https://medium.com/snowflake/how-anomalos-snowflake-native-app-automates-data-anomaly-detection-3e1c047441d2)
- [Anomalo ML approaches to time-series anomaly detection](https://www.anomalo.com/blog/machine-learning-approaches-to-time-series-anomaly-detection/)
- [Soda anomaly detection docs](https://docs.soda.io/data-observability)
- [Bigeye autothresholds](https://docs.bigeye.com/docs/autothresholds)
- [Bigeye anomaly detection approach](https://www.bigeye.com/blog/anomaly-detection-part-2-the-bigeye-approach)
- [MAD anomaly detection](https://crispinagar.github.io/blogs/mad-anomaly-detection.html)
- [MAD for anomaly detection — Medium](https://medium.com/swlh/anomaly-detection-with-median-absolute-deviation-c609e1c09262)
- [InfluxDB MAD anomaly detection](https://www.influxdata.com/blog/anomaly-detection-with-median-absolute-deviation/)
- [Data quality dimensions — IBM](https://www.ibm.com/think/topics/data-quality-dimensions)
- [6 data quality dimensions — Monte Carlo](https://www.montecarlodata.com/blog-6-data-quality-dimensions-examples/)
- [ISO 8000 — Wikipedia](https://en.wikipedia.org/wiki/ISO_8000)
- [ISO 8000 — arc42](https://quality.arc42.org/standards/iso-8000)
- [Qualytics quality scores](https://userguide.qualytics.io/quality-scores/what-are-quality-scores/)
- [DQOps KPI metrics](https://dqops.com/docs/dqo-concepts/definition-of-data-quality-kpis/)
- [Data quality alerts — Atlan](https://atlan.com/know/data-quality-alerts/)
- [Alert fatigue — Monte Carlo](https://www.montecarlodata.com/blog-alert-fatigue)
- [Alert fatigue solutions 2025 — incident.io](https://incident.io/blog/alert-fatigue-solutions-for-dev-ops-teams-in-2025-what-works)
