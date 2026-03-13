# Theme K: Data Validation for ML/AI Pipelines

> Deep research on how ML teams validate training data, feature stores, and model inputs.
> Covers tools, statistical methods, emerging LLM patterns, and practical production thresholds.

---

## Table of Contents

1. [Training Data Validation](#1-training-data-validation)
2. [Feature Store Validation](#2-feature-store-validation)
3. [whylogs & Data Profiling](#3-whylogs--data-profiling)
4. [Evidently AI](#4-evidently-ai)
5. [Great Expectations for ML](#5-great-expectations-for-ml)
6. [Emerging Patterns](#6-emerging-patterns)
7. [Statistical Tests Deep Dive](#7-statistical-tests-deep-dive)
8. [Tool Comparison Matrix](#8-tool-comparison-matrix)

---

## 1. Training Data Validation

### 1.1 TensorFlow Data Validation (TFDV)

TFDV is the most mature, production-hardened training data validation library in the ML ecosystem. It operates at three levels: **statistics generation**, **schema inference**, and **anomaly detection**.

**Architecture**: TFDV runs on Apache Beam, enabling distributed processing on Dataflow, Spark, or Flink. It produces protocol buffer-based statistics and schemas that integrate with the full TFX pipeline.

#### Schema Inference

TFDV uses conservative heuristics to infer stable data properties from statistics, avoiding overfitting the schema to a specific dataset. The inferred schema captures:

- Feature presence (required vs optional)
- Value types and domains (string, int, float)
- Allowed value ranges and sets
- Feature shape (fixed vs variable length)

```python
import tensorflow_data_validation as tfdv

# Generate statistics from data
stats = tfdv.generate_statistics_from_tfrecord(data_location=path)

# Or from a DataFrame
stats = tfdv.generate_statistics_from_dataframe(dataframe)

# Infer schema from statistics
schema = tfdv.infer_schema(stats)

# Customize schema constraints
tfdv.get_feature(schema, 'payment_type').presence.min_fraction = 0.5
tfdv.get_domain(schema, 'payment_type').value.append('Prcard')
```

#### Anomaly Detection

```python
# Validate new data against established schema
serving_stats = tfdv.generate_statistics_from_tfrecord(data_location=serving_path)
anomalies = tfdv.validate_statistics(statistics=serving_stats, schema=schema)
tfdv.visualize_anomalies(anomalies)
```

TFDV detects anomalies including: unexpected feature types, missing features, out-of-range values, unexpected string values, and schema mismatches.

#### Training-Serving Skew Detection

TFDV provides two comparators for skew detection:

```python
# L-infinity norm comparator (categorical features)
tfdv.get_feature(schema, 'payment_type').skew_comparator.infinity_norm.threshold = 0.01

# Jensen-Shannon divergence (numeric and categorical features)
tfdv.get_feature(schema, 'payment_type').skew_comparator.jensen_shannon_divergence.threshold = 0.01

# Run skew detection
skew_anomalies = tfdv.validate_statistics(
    statistics=train_stats,
    schema=schema,
    serving_statistics=serving_stats
)
```

#### Data Drift Detection (temporal)

```python
# Compare day-over-day data
tfdv.get_feature(schema, 'payment_type').drift_comparator.infinity_norm.threshold = 0.01

drift_anomalies = tfdv.validate_statistics(
    statistics=train_day2_stats,
    schema=schema,
    previous_statistics=train_day1_stats
)
```

#### Data Slicing

TFDV supports sliced validation to detect issues in data subpopulations:

```python
from tensorflow_data_validation.utils import slicing_util

# Slice by feature values
slice_fn = slicing_util.get_feature_value_slicer(
    features={'country': None}  # All values of 'country'
)

# Slice by specific values
slice_fn = slicing_util.get_feature_value_slicer(
    features={'age': [10, 50, 70]}
)

stats_options = tfdv.StatsOptions(slice_functions=[slice_fn])
```

**Sources:**
- [TFDV Guide](https://www.tensorflow.org/tfx/guide/tfdv)
- [TFDV Get Started](https://www.tensorflow.org/tfx/data_validation/get_started)
- [TFDV Anomalies Reference](https://www.tensorflow.org/tfx/data_validation/anomalies)

### 1.2 Training-Serving Skew

Training-serving skew is one of the most insidious production ML failures. It occurs when the data a model sees during serving differs systematically from what it saw during training.

#### Three Root Causes

| Cause | Description | Detection Method |
|-------|-------------|-----------------|
| **Data skew** | Training and serving data come from different sources or distributions | Statistical comparison of feature distributions |
| **Feature skew** | Feature engineering logic differs between training and serving | Shadow-mode deployment; log and compare feature vectors |
| **Label skew** | The relationship between features and labels changes over time | Monitor prediction distribution vs actual outcomes |

#### Detection Strategies

1. **Feature vector logging**: Log serving-time feature vectors and compare distributions against training data. Even sampling 1-5% of traffic is sufficient for statistical tests.

2. **Shadow-mode deployment**: Deploy the model without serving predictions. Monitor feature distributions in production before going live.

3. **Feature store as prevention**: Using a centralized feature store (Feast, Tecton, Hopsworks) ensures the same feature engineering code runs at both training and serving time.

4. **Replay testing**: For a sample of production requests, re-compute features using training pipeline code and compare against serving pipeline output.

**Key insight from Nubank**: "The best solution is to explicitly monitor it so that system and data changes don't introduce skew unnoticed. Even if you can't do this for every example, do it for a small fraction."

**Sources:**
- [Nubank: Dealing with Train-Serve Skew](https://building.nubank.com/dealing-with-train-serve-skew-in-real-time-ml-models-a-short-guide/)
- [Google: Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml)
- [Vertex AI: Monitor for Training-Serving Skew](https://cloud.google.com/blog/topics/developers-practitioners/monitor-models-training-serving-skew-vertex-ai)

### 1.3 Feature Drift Detection in Production

Feature drift monitoring requires both **univariate** (per-feature) and **multivariate** (cross-feature) approaches.

#### Univariate Methods

Monitor each feature independently using statistical tests. See [Section 7](#7-statistical-tests-deep-dive) for detailed test comparison.

#### Multivariate Methods

Univariate monitoring misses drift in feature *relationships* (e.g., age-income correlation changing).

| Method | How It Works | Strengths | Weaknesses |
|--------|-------------|-----------|------------|
| **PCA-based** | Reduce dimensionality, then apply univariate tests in PC space | Captures variance shifts | Loses interpretability |
| **Domain Classifier** | Train binary classifier to distinguish reference vs current data | Intuitive (ROC AUC), consistent | Requires training a model |
| **MMD** | Kernel-based test comparing mean embeddings in RKHS | No distribution assumptions | Slow, hard to interpret |
| **Mahalanobis Distance** | Distance scaled by covariance matrix | Accounts for correlations | Assumes multivariate normal |

**Production recommendation**: Use a domain classifier as the default multivariate method. It provides a single interpretable metric (ROC AUC from 0.5 = no drift to 1.0 = complete drift) and works consistently across data types.

**Sources:**
- [Arthur AI: Multivariate Drift Detection](https://www.arthur.ai/blog/data-drift-detection-in-high-dimensional-and-unstructured-data-part-i-multivariate-data-drift-with-tabular-data)
- [NannyML: Multivariate Drift Comparison](https://www.nannyml.com/blog/tutorial-multivariate-drift-comparison)
- [Deepchecks: Multivariate Drift](https://docs.deepchecks.com/0.11/checks_gallery/tabular/train_test_validation/plot_multivariate_drift.html)

---

## 2. Feature Store Validation

### 2.1 Feast (Open Source)

Feast's Data Quality Monitoring (DQM) module is in **alpha** status. It uses Great Expectations as its profiler backend.

#### Architecture

```
Raw Data --> Feature Engineering --> Feast Feature Store
                                         |
                                    On historical retrieval:
                                         |
                              Reference Dataset + Profiler
                                         |
                              Validation (GX ExpectationSuite)
                                         |
                              Pass: return DataFrame
                              Fail: raise ValidationFailed
```

#### Code Example

```python
from feast import FeatureStore
from feast.dqm.profilers.ge_profiler import ge_profiler

# Define a profiler using Great Expectations
@ge_profiler
def my_profiler(dataset):
    dataset.expect_column_max_to_be_between("feature_a", 0, 100)
    dataset.expect_column_values_to_not_be_null("feature_b")
    return dataset.get_expectation_suite()

# Validate during historical retrieval
fs = FeatureStore(repo_path=".")
job = fs.get_historical_features(entity_df=entity_df, features=feature_refs)

# This will raise ValidationFailed if checks fail
validated_df = job.to_df(
    validation_reference=fs
        .get_saved_dataset("reference_dataset")
        .as_reference(profiler=my_profiler)
)
```

**Limitations**:
- Alpha status, API may change
- Only validates during historical retrieval (not online serving)
- Requires manual profiler definition (automatic profiling is limited)
- Only supports Great Expectations as profiler backend

**Source:** [Feast DQM Reference](https://docs.feast.dev/reference/dqm)

### 2.2 Tecton

Tecton provides **native** data quality metrics without requiring external tools.

**Tracked metrics per Feature View:**
- Null values percentage per materialization interval
- Zero values / empty strings / zero-length arrays percentage
- Row counts (before aggregation)
- Estimated unique join keys (approximate count distinct)

**Key architectural difference from Feast**: Tecton monitors at the Feature View (pipeline) level rather than at retrieval time, catching issues *before* they enter the feature store.

For deeper drift analysis, Tecton integrates with **Fiddler AI** for proactive drift and data quality monitoring across Feature Views.

**Source:** [Tecton Data Quality Metrics](https://docs.tecton.ai/docs/monitoring/data-quality-metrics)

### 2.3 Hopsworks

Hopsworks has the deepest Great Expectations integration of any feature store, with validation built directly into the `insert()` path.

#### Validation on Insert

```python
import great_expectations as ge

# Define expectations
expectation_suite = ge.core.ExpectationSuite(
    expectation_suite_name="validate_on_insert"
)
expectation_suite.add_expectation(
    ge.core.ExpectationConfiguration(
        expectation_type="expect_column_min_to_be_between",
        kwargs={"column": "feature_a", "min_value": 0, "max_value": 100}
    )
)

# Attach to feature group
fg = fs.create_feature_group(
    "my_features",
    version=1,
    primary_key=['entity_id'],
    expectation_suite=expectation_suite
)

# Validation happens automatically on insert
job, validation_report = fg.insert(df)
```

#### Two Ingestion Policies

| Policy | Behavior | Use Case |
|--------|----------|----------|
| `ALWAYS` (default) | Insert data regardless of validation result | Development, monitoring |
| `STRICT` | Block insertion if validation fails | Production, preventing garbage-in |

Validation reports are stored alongside the data, enabling historical quality tracking in the Hopsworks UI.

**Source:** [Hopsworks Data Validation](https://docs.hopsworks.ai/latest/user_guides/fs/feature_group/data_validation/)

### 2.4 Point-in-Time Correctness

Point-in-time correctness prevents **temporal data leakage** -- using feature values that were not available at prediction time.

#### The Problem

```
Event timeline:
  t=1: Feature "account_balance" = $500
  t=2: Prediction event (should use balance=$500)
  t=3: Feature "account_balance" = $1000

Wrong: Using $1000 for training at t=2 (future leakage)
Right: Using $500 for training at t=2 (point-in-time correct)
```

A naive `LEFT JOIN` or `merge_asof` gives each label the latest feature row, including data from *after* the event.

#### Feature Store Solutions

All major feature stores support **AS OF joins** (also called temporal joins or point-in-time joins):

- **Databricks Feature Store**: `FeatureFunction` with `TimestampLookupKey` for point-in-time feature joins
- **SageMaker Feature Store**: Apache Spark-based point-in-time queries
- **Feast**: `get_historical_features()` with entity DataFrame containing event timestamps
- **Hopsworks**: Built-in time-travel queries on feature groups

#### Timefence: Dedicated Leakage Detection

Timefence is a specialized Python tool built on DuckDB for detecting and fixing temporal data leakage:

```python
import timefence

# Define data sources with timestamps
users = timefence.Source(
    path="data/users.parquet",
    keys=["user_id"],
    timestamp="updated_at"
)

# Define features with embargo periods
spend = timefence.Feature(
    source=txns,
    embargo="1d",       # 1-day safety buffer after label time
    name="spend_30d",
    sql="SELECT ... FROM {source}"
)

# Audit existing training set for leakage
report = timefence.audit(
    "train.parquet",
    features=[country, spend],
    keys=["user_id"],
    label_time="label_time"
)
report.assert_clean()  # Raises if leakage detected
```

**Performance benchmarks** (Intel i7, 16GB):

| Scenario | Labels | Features | Build Time | Audit Time |
|----------|--------|----------|-----------|-----------|
| Typical | 100K | 10 | 1.9s | 1.7s |
| Large | 1M | 10 | 12s | 8.5s |

CI/CD integration: `timefence audit data/train.parquet --strict` (exits code 1 on leakage).

**Sources:**
- [Timefence](https://timefence.dev/)
- [Databricks Point-in-Time Joins](https://docs.databricks.com/aws/en/machine-learning/feature-store/time-series)
- [SageMaker Point-in-Time Queries](https://aws.amazon.com/blogs/machine-learning/build-accurate-ml-training-datasets-using-point-in-time-queries-with-amazon-sagemaker-feature-store-and-apache-spark/)

---

## 3. whylogs & Data Profiling

### 3.1 Architecture

whylogs creates **mergeable statistical profiles** -- lightweight summaries that can be combined across distributed systems and time windows without accessing raw data.

**Key insight**: Profiles are fixed-size regardless of data volume, enabling privacy-preserving monitoring at scale.

#### Collected Metrics Per Column

| Metric Type | Details |
|-------------|---------|
| **Counters** | Boolean count, null count, data type counts |
| **Summary statistics** | Sum, min, max, mean, variance |
| **Cardinality** | Approximate unique values via HyperLogLog |
| **Distribution** | Histograms (KLL sketch), top-128 frequent items |
| **Type inference** | Automatic detection of string, int, float, boolean |

#### Profile Creation and Merging

```python
import whylogs as why

# Profile individual data batches
profile_view1 = why.log(df_batch1).profile().view()
profile_view2 = why.log(df_batch2).profile().view()
profile_view3 = why.log(df_batch3).profile().view()

# Merge profiles (order doesn't matter, associative + commutative)
merged = profile_view1.merge(profile_view2).merge(profile_view3)

# Inspect merged statistics
merged.to_pandas().head()
```

The `track()` method offers in-place accumulation on a single profile:

```python
profile = why.log(df_batch1).profile()
profile.track(df_batch2)  # Accumulates into same profile
profile.track(df_batch3)
```

### 3.2 Production Status (2025)

**Critical update**: WhyLabs, Inc. discontinued commercial operations in early 2025 after the founding team was acquired by Apple. The whylogs library and WhyLabs platform are now **community-driven open-source projects** under Apache 2.0.

**Implications for production users:**
- The core `whylogs` library remains fully functional and maintained
- No commercial support or SLA available
- The WhyLabs SaaS platform (dashboards, alerts) is no longer actively developed
- Teams should plan for self-hosted monitoring infrastructure or alternative platforms

### 3.3 Integration Patterns

whylogs integrates with orchestrators (Airflow, Flyte, ZenML) and monitoring tools:

```python
# Flyte integration example
@task
def profile_data(df: pd.DataFrame) -> DatasetProfileView:
    return why.log(df).profile().view()

@task
def check_drift(current: DatasetProfileView, reference: DatasetProfileView):
    # Compare profiles for drift detection
    ...
```

For alerting, profiles can be sent to Grafana, PagerDuty, or custom webhook endpoints. With WhyLabs SaaS no longer active, teams typically export profiles to their own time-series databases.

**Sources:**
- [whylogs GitHub](https://github.com/whylabs/whylogs)
- [whylogs Documentation](https://docs.whylabs.ai/docs/whylogs-overview/)
- [Merging Profiles](https://whylogs.readthedocs.io/en/latest/examples/basic/Merging_Profiles.html)
- [WhyLabs Deep Dive](https://skywork.ai/skypage/en/WhyLabs-A-Deep-Dive-into-the-Open-Source-AI-Observability-Powerhouse/1976566359372001280)

---

## 4. Evidently AI

### 4.1 Overview

Evidently is the leading open-source ML observability framework with 100+ built-in evaluations. It covers tabular data, NLP, and LLM systems. Unlike whylogs (profile-first), Evidently is **report-first** -- it generates rich HTML dashboards, JSON metrics, and test results.

### 4.2 Drift Detection Methods

Evidently implements 20+ statistical tests with intelligent defaults:

#### Default Test Selection Logic

| Column Type | Dataset Size | n_unique | Default Test | Threshold |
|-------------|-------------|----------|-------------|-----------|
| Numerical | <= 1000 | > 5 | KS test | p-value <= 0.05 |
| Numerical | > 1000 | > 5 | Wasserstein Distance | >= 0.1 |
| Categorical | <= 1000 | > 2 | Chi-squared test | p-value <= 0.05 |
| Categorical | > 1000 | > 2 | Jensen-Shannon divergence | >= 0.1 |
| Binary | any | <= 2 | Z-score proportion test | p-value <= 0.05 |
| Text | <= 1000 | - | Domain classifier (ROC AUC) | > 95th percentile |
| Text | > 1000 | - | Domain classifier (ROC AUC) | > 0.55 |

**Design rationale**: For large datasets, p-value-based tests (KS, chi-squared) become oversensitive -- they flag statistically significant but practically irrelevant differences. Distance-based methods (Wasserstein, JS) with fixed thresholds are more appropriate.

#### Available Statistical Methods

```python
from evidently.metrics import DataDriftTable

# Use default test selection
drift_report = Report(metrics=[DataDriftTable()])

# Override with specific method
drift_report = Report(metrics=[
    DataDriftTable(
        stattest="wasserstein",
        stattest_threshold=0.1
    )
])

# Per-column overrides
drift_report = Report(metrics=[
    DataDriftTable(
        per_column_stattest={
            "numerical_col": "ks",
            "categorical_col": "psi"
        }
    )
])
```

Full list of available tests: KS, chi-squared, Z-score, Wasserstein, Jensen-Shannon, PSI, K-L divergence, Anderson-Darling, Cramer-von Mises, Fisher exact test, G-test, Hellinger distance, Mann-Whitney U, energy distance, Epps-Singleton, and domain classifier.

### 4.3 Data Quality Monitoring

Beyond drift, Evidently provides data quality presets:

- Missing values (count, share, by column)
- Duplicate rows
- Column type mismatches
- Constant and near-constant features
- Highly correlated features
- Target distribution changes

### 4.4 LLM Evaluation

Evidently has expanded into LLM observability (see [Section 6.1](#61-llm-data-validation)):

- RAG evaluation: context precision, context recall, faithfulness
- Text descriptors: length, sentiment, out-of-vocabulary rate
- Embedding drift detection via domain classifiers

**Sources:**
- [Evidently GitHub](https://github.com/evidentlyai/evidently)
- [Evidently Drift Documentation](https://docs.evidentlyai.com/metrics/explainer_drift)
- [Evidently: 5 Drift Detection Methods Compared](https://www.evidentlyai.com/blog/data-drift-detection-large-datasets)
- [RAG Evaluation Guide](https://www.evidentlyai.com/llm-guide/rag-evaluation)

---

## 5. Great Expectations for ML

### 5.1 ML-Specific Use Cases

Great Expectations (GX) is primarily a data quality framework, not ML-specific. But it excels at validating the data flowing *into* ML pipelines.

#### Where GX Fits in ML Workflows

```
Raw Data --> [GX: validate raw data]
  --> Feature Engineering
    --> [GX: validate feature ranges, types, nulls]
      --> Model Training
        --> [GX: validate predictions, check class balance]
          --> Model Serving
            --> [GX: validate serving inputs match training schema]
```

#### ML-Specific Custom Expectations

```python
# Class balance check
gx_suite.add_expectation(
    ExpectationConfiguration(
        expectation_type="expect_column_proportion_of_unique_values_to_be_between",
        kwargs={"column": "target", "min_value": 0.3, "max_value": 0.7}
    )
)

# Feature range validation
gx_suite.add_expectation(
    ExpectationConfiguration(
        expectation_type="expect_column_values_to_be_between",
        kwargs={"column": "age", "min_value": 0, "max_value": 120}
    )
)

# No null features for model input
gx_suite.add_expectation(
    ExpectationConfiguration(
        expectation_type="expect_column_values_to_not_be_null",
        kwargs={"column": "critical_feature"}
    )
)

# Distribution check (training data should have diverse values)
gx_suite.add_expectation(
    ExpectationConfiguration(
        expectation_type="expect_column_unique_value_count_to_be_between",
        kwargs={"column": "category_feature", "min_value": 5, "max_value": 1000}
    )
)
```

### 5.2 ZenML Integration

ZenML provides first-class GX integration for continuous validation in ML pipelines:

```python
from zenml.integrations.great_expectations.steps import (
    great_expectations_profiler_step,
    great_expectations_validator_step,
)

@pipeline
def training_pipeline():
    data = load_data()
    profile = great_expectations_profiler_step(dataset=data)
    validation_result = great_expectations_validator_step(
        dataset=data,
        expectation_suite=profile
    )
    if validation_result.success:
        train_model(data)
```

### 5.3 Vertex AI Integration

Google Cloud's Vertex AI Pipelines can embed GX validation nodes:

```python
from kfp.v2 import dsl

@dsl.component
def validate_data(dataset_path: str) -> bool:
    import great_expectations as gx
    context = gx.get_context()
    result = context.run_checkpoint(checkpoint_name="training_data_check")
    return result.success
```

**Sources:**
- [Great Expectations for MLOps](https://greatexpectations.io/blog/ml-ops-great-expectations/)
- [ZenML + Great Expectations](https://www.zenml.io/blog/zenml-sets-up-great-expectations-for-continuous-data-validation-in-your-ml-pipelines)
- [Vertex AI + Great Expectations](https://datatonic.com/insights/vertex-ai-data-validation-pipelines-great-expectations/)
- [KDnuggets: GX in Data Science Pipelines](https://www.kdnuggets.com/implementing-data-quality-assurance-data-science-pipelines-great-expectations)

---

## 6. Emerging Patterns

### 6.1 LLM Data Validation

#### Embedding Drift Detection

Embedding drift is the "silent killer of RAG accuracy." It occurs when the same text produces different vectors over time due to model updates, preprocessing changes, or partial re-embedding.

**Detection checklist (run quarterly):**

| Check | Method | Healthy | Warning | Critical |
|-------|--------|---------|---------|----------|
| **Cosine distance** on 100 re-embedded documents | Compare stored vs fresh vectors | < 0.001 | 0.001-0.02 | > 0.05 |
| **Top-k overlap** on 20 benchmark queries | Compare nearest neighbors | > 85% | 70-85% | < 70% |
| **Vector count** | Compare DB count vs source of truth | 0 delta | < 1% delta | > 1% delta |
| **L2 norm distribution** | Track norm statistics over time | Stable | Shifting | Bimodal |

**Root causes ranked by frequency:**
1. Partial re-embedding (mixing old and new vectors)
2. Preprocessing pipeline changes (chunk sizes, normalization)
3. Model version bumps (incompatible vector spaces)
4. Infrastructure changes (quantization, index parameters)

**Prevention**: Pin everything (model version, preprocessing deps, chunking config). Store provenance metadata with every vector. Never mix embedding generations -- re-embed the entire corpus when pipeline changes.

#### Embedding Drift Detection Methods

Evidently AI's research compared 5 methods for detecting drift in embeddings:

| Method | How It Works | Best For |
|--------|-------------|----------|
| **Euclidean Distance** | Average all embeddings, measure L2 distance | Quick signal, but hard to threshold |
| **Cosine Distance** | Angle between averaged embedding vectors | Familiar metric, breaks with PCA |
| **Domain Classifier** | Binary classifier distinguishing ref vs current | **Best default** -- interpretable ROC AUC |
| **Share of Drifted Components** | Per-dimension Wasserstein, then aggregate | Extends tabular methods to embeddings |
| **MMD** | Kernel-based distribution comparison in RKHS | Theoretical rigor, slow |

**Recommendation**: Use the **domain classifier** approach as default. ROC AUC provides a single interpretable number (0.5 = no drift, 1.0 = complete separation).

#### RAG Evaluation (RAGAS Framework)

The RAGAS framework provides reference-free metrics for evaluating RAG systems:

| Metric | What It Measures | Range |
|--------|-----------------|-------|
| **Context Precision** | Are relevant chunks ranked higher than irrelevant ones? | 0-1 |
| **Context Recall** | Do retrieved docs cover all relevant aspects? | 0-1 |
| **Faithfulness** | Are response claims supported by retrieved context? | 0-1 |
| **Answer Relevancy** | Does the answer address the original question? | 0-1 |
| **Hallucination Rate** | Percentage of unsupported claims | 0-1 |

These metrics enable continuous monitoring of RAG retrieval quality without requiring human annotations.

**Sources:**
- [Embedding Drift: The Silent Killer](https://decompressed.io/learn/embedding-drift)
- [Evidently: 5 Embedding Drift Methods](https://www.evidentlyai.com/blog/embedding-drift-detection)
- [RAGAS Paper (arXiv)](https://arxiv.org/abs/2309.15217)
- [Evidently RAG Evaluation Guide](https://www.evidentlyai.com/llm-guide/rag-evaluation)
- [AWS: Monitor Embedding Drift for LLMs](https://aws.amazon.com/blogs/machine-learning/monitor-embedding-drift-for-llms-deployed-from-amazon-sagemaker-jumpstart/)

### 6.2 Synthetic Data Validation

Validating synthetic data requires proving it is statistically similar to real data while being useful for downstream ML tasks.

#### Validation Dimensions

| Dimension | Method | Good Threshold |
|-----------|--------|---------------|
| **Univariate** | KS test per column | KS statistic > 0.9 (higher = more similar) |
| **Bivariate** | Correlation matrix comparison | < 0.05 mean absolute difference |
| **Multivariate** | Discriminative test (binary classifier) | Accuracy near 50% (can't distinguish) |
| **ML Utility** | Train-Synthetic-Test-Real (TSTR) | Performance within 5-15% of real data |
| **Privacy** | Nearest-neighbor distance ratio | No synthetic point too close to real |

#### Discriminative Testing

```python
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import cross_val_score
import numpy as np

# Label real=0, synthetic=1
X = np.vstack([real_data, synthetic_data])
y = np.array([0] * len(real_data) + [1] * len(synthetic_data))

# If classifier can't distinguish: accuracy ~0.5 = good synthetic data
clf = RandomForestClassifier(n_estimators=100)
scores = cross_val_score(clf, X, y, cv=5, scoring='accuracy')
print(f"Discriminability: {scores.mean():.3f}")  # Target: 0.50 +/- 0.02
```

**Quality benchmarks**: High-quality synthetic datasets achieve 90%+ statistical accuracy, with ML models trained on synthetic data performing within 5-15% of real data benchmarks.

**Sources:**
- [Qualtrics: Synthetic Data Validation](https://www.qualtrics.com/articles/strategy-research/synthetic-data-validation/)
- [Galileo: Validating Synthetic Data](https://galileo.ai/blog/validating-synthetic-data-ai)
- [YData: Measuring Column Similarity](https://ydata.ai/resources/how-to-validate-if-synthetic-data-is-statistically-similar-to-real-data.html)

### 6.3 Data Versioning for Reproducible ML

#### lakeFS Acquires DVC (November 2025)

The two leading data versioning tools unified under lakeFS. DVC continues as an independent open-source project for data scientists working with smaller datasets, while lakeFS focuses on enterprise-grade infrastructure for petabyte-scale data lakes.

#### Comparison

| Feature | DVC | lakeFS |
|---------|-----|--------|
| **Scale** | Small-medium datasets | Petabyte-scale |
| **Architecture** | Git-like CLI, metafiles | Git-like branching on object storage |
| **Storage** | S3, GCS, Azure, local | S3-compatible (any object store) |
| **Quality gates** | CI/CD hooks, dvc diff | Pre-merge hooks, branch protection |
| **Lineage** | Pipeline DAG (dvc.yaml) | Commit history on data lake |
| **Best for** | Individual data scientists | Platform teams, enterprise ML |

#### Quality Validation in Data Versioning

```bash
# DVC: Track data changes and validate before merging
dvc diff                    # Show what changed in data
dvc metrics diff            # Compare model metrics across versions
dvc plots diff              # Visual comparison of results

# lakeFS: Branch-based validation
lakectl diff lakefs://repo/feature-branch lakefs://repo/main
# Run validation hooks before merge
lakectl merge lakefs://repo/feature-branch lakefs://repo/main
```

**Hybrid pattern**: Teams use DVC for local dev (version training data, track experiments) and lakeFS for cloud data management (A/B test with branches, merge only after validation).

**Sources:**
- [lakeFS Acquires DVC](https://lakefs.io/media-mentions/lakefs-acquires-dvc-uniting-data-version-control-pioneers/)
- [Data Versioning Best Practices](https://lakefs.io/data-version-control/dvc-best-practices/)
- [ML Data Version Control at Scale](https://lakefs.io/blog/scalable-ml-data-version-control-and-reproducibility/)

---

## 7. Statistical Tests Deep Dive

### 7.1 Test Comparison

Based on Evidently AI's systematic comparison of 5 drift detection methods on large datasets:

| Test | Type | Sensitivity | Scale Behavior | Threshold Standard | Best For |
|------|------|-------------|----------------|-------------------|---------|
| **KS Test** | p-value | Very high | Oversensitive at >100K samples | p < 0.05 | Small datasets, critical drift |
| **PSI** | Distance | Low | Stable across sizes | < 0.1 none, 0.1-0.2 moderate, > 0.2 significant | Finance, stable distributions |
| **Jensen-Shannon** | Distance | Medium | Stable, slightly more sensitive than PSI | >= 0.1 indicates drift | General purpose, categorical |
| **Wasserstein** | Distance | Medium-High | Stable above 100K | Context-dependent | Balanced sensitivity, numeric |
| **KL Divergence** | Distance | Low | Stable | >= 0.1 indicates drift | Information-theoretic applications |

### 7.2 Sensitivity Characteristics

The tests respond differently to *types* of distribution change:

| Change Type | KS | PSI | Jensen-Shannon | Wasserstein |
|------------|----|----|----------------|-------------|
| **Mean shift** | High | Medium | Medium | **Very High** |
| **Variance change** | High | **Very High** | **Very High** | Medium |
| **Shape change** | **Very High** | Medium | Medium | Medium |
| **Tail behavior** | High | Low | Low | Medium |

**Key finding**: PSI and Jensen-Shannon are more impacted by variance differences than mean shifts, while Wasserstein is more affected by mean shifts. KS captures both equally.

### 7.3 Practical Threshold Guidelines

#### PSI (Population Stability Index)

```
PSI < 0.1   --> No significant change (green)
PSI 0.1-0.2 --> Moderate change, investigate (yellow)
PSI >= 0.2  --> Significant change, action required (red)
```

These thresholds originate from the financial services industry and are well-established. PSI is computed by binning the distributions and summing `(actual% - expected%) * ln(actual% / expected%)`.

#### Wasserstein Distance

No universal threshold exists. Best practice: **normalize by standard deviation** of the reference distribution. A Wasserstein distance of 0.1 standard deviations is a reasonable starting point.

```python
from scipy.stats import wasserstein_distance
import numpy as np

ref_std = np.std(reference_data)
raw_distance = wasserstein_distance(reference_data, current_data)
normalized_distance = raw_distance / ref_std

# Thresholds (adapt to your use case)
if normalized_distance < 0.1:
    status = "no_drift"
elif normalized_distance < 0.3:
    status = "warning"
else:
    status = "drift_detected"
```

#### Jensen-Shannon Divergence

Bounded [0, 1] when using the square root form (Jensen-Shannon distance). The 0.2 standard for PSI does **not** apply to JS divergence.

**Production approach** (from Arize AI): Look at a moving window of values over a multi-day period to set a per-feature threshold, rather than using a fixed global threshold.

#### KS Test

p-value based, so threshold depends on sample size. For large datasets (>100K), use a corrected significance level or switch to distance-based methods.

```python
from scipy.stats import ks_2samp

stat, p_value = ks_2samp(reference_data, current_data)

# For large datasets, even tiny differences are "significant"
# Better: check if the KS statistic exceeds a practical threshold
if stat > 0.05:  # Practical significance threshold
    print("Meaningful drift detected")
```

### 7.4 Decision Framework

```
START
  |
  v
Is even 1% drift critical? ----YES----> KS Test (control sample size)
  |NO
  v
Need interpretable magnitude? --YES----> Wasserstein (normalize by stddev)
  |NO
  v
Historical PSI thresholds exist? -YES--> PSI (use established thresholds)
  |NO
  v
General purpose? ----YES----> Jensen-Shannon (bounded, symmetric)
  |NO
  v
High-dimensional / embeddings? --YES--> Domain Classifier (ROC AUC)
```

### 7.5 Multi-Dimensional Drift

For multivariate drift (feature interaction changes), univariate tests miss correlated shifts:

```python
# Approach 1: Domain Classifier
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import cross_val_score

X = np.vstack([ref_features, current_features])
y = np.array([0]*len(ref_features) + [1]*len(current_features))
scores = cross_val_score(GradientBoostingClassifier(), X, y, cv=5, scoring='roc_auc')
drift_score = scores.mean()  # 0.5 = no drift, 1.0 = complete drift

# Approach 2: PCA + Univariate
from sklearn.decomposition import PCA
pca = PCA(n_components=5).fit(ref_features)
ref_pcs = pca.transform(ref_features)
current_pcs = pca.transform(current_features)
# Apply KS or Wasserstein to each principal component

# Approach 3: Maximum Mean Discrepancy (MMD)
# Available in alibi-detect
from alibi_detect.cd import MMDDrift
drift_detector = MMDDrift(ref_features, backend='pytorch')
result = drift_detector.predict(current_features)
print(f"Drift detected: {result['data']['is_drift']}")
```

**Sources:**
- [Evidently: 5 Drift Methods Compared](https://www.evidentlyai.com/blog/data-drift-detection-large-datasets)
- [Evidently: Drift Explainer](https://docs.evidentlyai.com/metrics/explainer_drift)
- [Arize: Jensen-Shannon Divergence](https://arize.com/blog-course/jensen-shannon-divergence/)
- [Superwise: Drift Metrics Introduction](https://superwise.ai/blog/a-hands-on-introduction-to-drift-metrics/)
- [Deepchecks: Automating Drift Thresholds](https://www.deepchecks.com/how-to-automate-data-drift-thresholding-in-machine-learning/)

---

## 8. Tool Comparison Matrix

### 8.1 ML Data Validation Tools

| Tool | Focus | Drift Detection | Data Quality | LLM Support | License | Status (2025) |
|------|-------|----------------|--------------|-------------|---------|--------------|
| **TFDV** | Training data | Yes (L-inf, JS) | Schema-based | No | Apache 2.0 | Active (TFX) |
| **Evidently** | ML observability | 20+ methods | Presets | Yes (RAG, text) | Apache 2.0 | Active, leading |
| **Great Expectations** | Data quality | No (pair with others) | 300+ expectations | No | Apache 2.0 | Active (GX Cloud) |
| **whylogs** | Data profiling | Via profiles | Mergeable profiles | Yes (langkit) | Apache 2.0 | Community-only |
| **Deepchecks** | ML validation | Yes (multivariate) | Suites | Yes (LLM eval) | AGPL 3.0 | Active |
| **Alibi Detect** | Drift & outliers | 15+ methods | No | No | Business Source | Active (Seldon) |
| **NannyML** | Performance estimation | CBPE, DLE | Limited | No | Apache 2.0 | Active |

### 8.2 Feature Store Validation

| Feature Store | Validation Method | When Validated | Production Policy | External Tools |
|---------------|-------------------|----------------|-------------------|---------------|
| **Feast** | GX ExpectationSuites | Historical retrieval | Alpha, no blocking | Great Expectations |
| **Tecton** | Native metrics | Materialization | Contact support | Fiddler AI |
| **Hopsworks** | GX integration | On insert | ALWAYS / STRICT | Great Expectations |
| **Databricks** | Expectations | On write | Quarantine tables | Built-in |
| **SageMaker** | Monitor baselines | Scheduled | CloudWatch alerts | Built-in |

### 8.3 Drift Detection Method Selection Guide

| Scenario | Recommended Method | Threshold | Tool |
|----------|-------------------|-----------|------|
| Numerical features, small dataset (<1K) | KS test | p < 0.05 | Evidently, scipy |
| Numerical features, large dataset (>1K) | Wasserstein distance | 0.1 (normalized) | Evidently |
| Categorical features, small dataset | Chi-squared test | p < 0.05 | Evidently, scipy |
| Categorical features, large dataset | Jensen-Shannon divergence | >= 0.1 | Evidently |
| Embeddings / high-dimensional | Domain classifier | ROC AUC > 0.55 | Evidently, Alibi Detect |
| Performance without labels | CBPE | Model-specific | NannyML |
| Training vs serving comparison | L-infinity / JS divergence | Feature-specific | TFDV |
| Finance / regulatory | PSI | > 0.2 | Custom, Evidently |

### 8.4 Additional Notable Tools

| Tool | Description | Key Differentiator |
|------|-------------|-------------------|
| **Timefence** | Temporal leakage detection | DuckDB-based, CI/CD friendly |
| **RAGAS** | RAG evaluation framework | Reference-free LLM metrics |
| **Arize AI** | ML observability platform | Production-scale, embedding monitoring |
| **Fiddler AI** | Model monitoring | Explainable AI + drift |
| **Openlayer** | AI testing platform | Pre-deployment testing |
| **Giskard** | ML testing | Vulnerability scanning |

---

## Key Takeaways

1. **No single tool covers everything**. The practical stack is: Great Expectations (data quality gates) + Evidently (drift monitoring) + feature store validation (Feast/Hopsworks/Tecton) + TFDV or Deepchecks (training data).

2. **Statistical test selection matters enormously**. KS tests at scale generate false positives. Use Wasserstein for numerical and Jensen-Shannon for categorical features on large datasets. PSI only if you have established thresholds from historical data.

3. **Multivariate drift detection is underused**. Most teams monitor features independently and miss correlated shifts. Domain classifiers provide the best balance of interpretability and detection power.

4. **Point-in-time correctness is non-negotiable**. Temporal data leakage is the most common and most damaging form of data quality issue in ML. Feature stores solve it architecturally; Timefence audits it post-hoc.

5. **Embedding drift is the new frontier**. As RAG systems proliferate, monitoring vector space stability is becoming as important as monitoring tabular feature distributions. Pin model versions, never mix embedding generations, and run quarterly drift audits.

6. **WhyLabs acquisition by Apple** (2025) leaves a gap in the open-source ML monitoring ecosystem. Evidently AI is the strongest remaining open-source contender. Teams should evaluate self-hosted alternatives or commercial platforms (Arize, Fiddler, Datadog ML Monitoring).

7. **The convergence of data quality and ML validation** is accelerating. Tools like Evidently now handle both tabular data quality and LLM evaluation. Great Expectations is adding AI-enhanced expectations. The boundary between "data engineering" and "ML engineering" validation is dissolving.
