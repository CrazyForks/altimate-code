"""Tests for sql/data_diff.py — deterministic data diff engine using ReladiffSession."""

import json
import os
import sys
from datetime import datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

# Ensure the local src/ is on sys.path so the datadiff branch module is importable
# even when an older editable install points to a different worktree.
_SRC_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "src")
if os.path.isdir(_SRC_DIR) and os.path.abspath(_SRC_DIR) not in [os.path.abspath(p) for p in sys.path]:
    sys.path.insert(0, os.path.abspath(_SRC_DIR))

from altimate_engine.models import SqlExecuteResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_execute_result(columns, rows, row_count=None, truncated=False):
    """Build a SqlExecuteResult with sensible defaults."""
    return SqlExecuteResult(
        columns=columns,
        rows=rows,
        row_count=row_count if row_count is not None else len(rows),
        truncated=truncated,
    )


def _empty_result():
    """Executor's synthetic row for 0-row results."""
    return _make_execute_result(
        columns=["status"],
        rows=[["Query executed successfully"]],
        row_count=0,
    )


def _error_result(msg="SQL compilation error"):
    """Executor's error row."""
    return _make_execute_result(
        columns=["error"],
        rows=[[msg]],
        row_count=1,
    )


# ===================================================================
# 1. _execute_task
# ===================================================================

class TestExecuteTask:
    """Unit tests for the _execute_task helper."""

    @patch("altimate_engine.sql.data_diff.execute_sql")
    def test_normal_rows_string_conversion(self, mock_exec):
        """All cell values are stringified."""
        from altimate_engine.sql.data_diff import _execute_task

        mock_exec.return_value = _make_execute_result(
            columns=["id", "name"],
            rows=[[1, "Alice"], [2, "Bob"]],
        )
        task = {"id": "task-1", "sql": "SELECT 1"}
        result = _execute_task(task, "wh")

        assert result["id"] == "task-1"
        assert result["rows"] == [["1", "Alice"], ["2", "Bob"]]

    @patch("altimate_engine.sql.data_diff.execute_sql")
    def test_none_values_preserved(self, mock_exec):
        """None stays None rather than becoming the string 'None'."""
        from altimate_engine.sql.data_diff import _execute_task

        mock_exec.return_value = _make_execute_result(
            columns=["a", "b"],
            rows=[[1, None], [None, "x"]],
        )
        result = _execute_task({"id": "t1", "sql": "SELECT 1"}, "wh")

        assert result["rows"] == [["1", None], [None, "x"]]

    @patch("altimate_engine.sql.data_diff.execute_sql")
    def test_empty_result_returns_empty_rows(self, mock_exec):
        """When row_count is 0 the synthetic status row must NOT leak through."""
        from altimate_engine.sql.data_diff import _execute_task

        mock_exec.return_value = _empty_result()
        result = _execute_task({"id": "t2", "sql": "SELECT 1"}, "wh")

        assert result["rows"] == []

    @patch("altimate_engine.sql.data_diff.execute_sql")
    def test_error_result_passes_through(self, mock_exec):
        """Error rows (row_count=1) are forwarded as-is after stringification."""
        from altimate_engine.sql.data_diff import _execute_task

        mock_exec.return_value = _error_result("Syntax error near 'SELCT'")
        result = _execute_task({"id": "t3", "sql": "SELCT 1"}, "wh")

        assert result["rows"] == [["Syntax error near 'SELCT'"]]

    @patch("altimate_engine.sql.data_diff.execute_sql")
    def test_large_row_count(self, mock_exec):
        """Thousands of rows are passed through without truncation in the helper."""
        from altimate_engine.sql.data_diff import _execute_task

        rows = [[i, f"val_{i}"] for i in range(5000)]
        mock_exec.return_value = _make_execute_result(
            columns=["id", "val"], rows=rows, row_count=5000,
        )
        result = _execute_task({"id": "big", "sql": "SELECT 1"}, "wh")

        assert len(result["rows"]) == 5000
        assert result["rows"][0] == ["0", "val_0"]

    @patch("altimate_engine.sql.data_diff.execute_sql")
    def test_mixed_types(self, mock_exec):
        """int, float, Decimal, datetime, and None are all stringified correctly."""
        from altimate_engine.sql.data_diff import _execute_task

        ts = datetime(2025, 1, 15, 10, 30, 0)
        mock_exec.return_value = _make_execute_result(
            columns=["a", "b", "c", "d", "e"],
            rows=[[42, 3.14, Decimal("99.99"), ts, None]],
        )
        result = _execute_task({"id": "mix", "sql": "SELECT 1"}, "wh")

        row = result["rows"][0]
        assert row[0] == "42"
        assert row[1] == "3.14"
        assert row[2] == "99.99"
        assert row[3] == str(ts)
        assert row[4] is None

    @patch("altimate_engine.sql.data_diff.execute_sql")
    def test_task_id_preserved(self, mock_exec):
        """The response carries the same id as the incoming task."""
        from altimate_engine.sql.data_diff import _execute_task

        mock_exec.return_value = _make_execute_result(columns=["x"], rows=[[1]])
        for tid in ["abc-123", "0", "task_99"]:
            result = _execute_task({"id": tid, "sql": "SELECT 1"}, "wh")
            assert result["id"] == tid

    @patch("altimate_engine.sql.data_diff.execute_sql")
    def test_sql_forwarded_to_executor(self, mock_exec):
        """The SQL string and warehouse are passed through to execute_sql."""
        from altimate_engine.sql.data_diff import _execute_task

        mock_exec.return_value = _make_execute_result(columns=["x"], rows=[[1]])
        _execute_task({"id": "t", "sql": "SELECT count(*) FROM t"}, "my_wh")

        call_args = mock_exec.call_args
        params = call_args[0][0]
        assert params.sql == "SELECT count(*) FROM t"
        assert params.warehouse == "my_wh"
        assert params.limit == 100_000


# ===================================================================
# 2. _resolve_dialect
# ===================================================================

class TestResolveDialect:
    """Unit tests for dialect resolution from ConnectionRegistry."""

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_snowflake_dialect(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "snowflake"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("sf_wh") == "snowflake"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_duckdb_dialect(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "duckdb"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("duck") == "duckdb"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_postgres_dialect(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "postgres"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("pg") == "postgres"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_postgresql_maps_to_postgres(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "postgresql"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("pg2") == "postgres"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_bigquery_dialect(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "bigquery"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("bq") == "bigquery"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_mysql_dialect(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "mysql"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("my") == "mysql"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_clickhouse_dialect(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "clickhouse"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("ch") == "clickhouse"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_databricks_dialect(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "databricks"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("db") == "databricks"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_redshift_dialect(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "redshift"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("rs") == "redshift"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_unknown_type_returns_generic(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "oracle"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("ora") == "generic"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_connection_not_found_returns_generic(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        mock_reg.get.side_effect = ValueError("Connection not found")
        assert _resolve_dialect("missing") == "generic"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_exception_during_get_returns_generic(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        mock_reg.get.side_effect = RuntimeError("Registry broken")
        assert _resolve_dialect("broken") == "generic"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_missing_type_attr_returns_generic(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock(spec=[])  # no 'type' attribute
        mock_reg.get.return_value = conn
        assert _resolve_dialect("no_type") == "generic"

    @patch("altimate_engine.sql.data_diff.ConnectionRegistry")
    def test_case_insensitive_type(self, mock_reg):
        from altimate_engine.sql.data_diff import _resolve_dialect

        conn = MagicMock()
        conn.type = "Snowflake"
        mock_reg.get.return_value = conn
        assert _resolve_dialect("sf") == "snowflake"


# ===================================================================
# 3. run_data_diff — altimate_core not installed
# ===================================================================

class TestRunDataDiffNoAltimateCore:
    """When RELADIFF_AVAILABLE is False."""

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", False)
    def test_returns_error_when_core_missing(self):
        from altimate_engine.sql.data_diff import run_data_diff

        result = run_data_diff(
            source_table="t1",
            target_table="t2",
            source_warehouse="wh",
            key_columns=["id"],
        )
        assert result["success"] is False
        assert "altimate-core" in result["error"]
        assert "ReladiffSession" in result["error"]


# ===================================================================
# 4. run_data_diff — session creation
# ===================================================================

class TestRunDataDiffSessionCreation:
    """Tests for ReladiffSession instantiation edge cases."""

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_session_creation_failure(self, mock_core, _dial):
        from altimate_engine.sql.data_diff import run_data_diff

        mock_core.ReladiffSession.side_effect = ValueError("bad spec")
        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )
        assert result["success"] is False
        assert "Failed to create session" in result["error"]
        assert "bad spec" in result["error"]

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_session_done_immediately(self, mock_core, _dial):
        """Session.start() returns Done right away."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {"equal": True}}
        mock_core.ReladiffSession.return_value = session

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )
        assert result["success"] is True
        assert result["status"] == "completed"
        assert result["outcome"] == {"equal": True}
        assert result["steps"] == 1

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_session_error_immediately(self, mock_core, _dial):
        """Session.start() returns Error."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Error", "message": "Schema mismatch"}
        mock_core.ReladiffSession.return_value = session

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )
        assert result["success"] is False
        assert result["error"] == "Schema mismatch"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_unexpected_action_type(self, mock_core, _dial):
        """Session returns an unrecognized action type."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "WaitForInput"}
        mock_core.ReladiffSession.return_value = session

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )
        assert result["success"] is False
        assert "Unexpected action type" in result["error"]
        assert "WaitForInput" in result["error"]

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_error_with_no_message(self, mock_core, _dial):
        """Error action without a message field uses fallback."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Error"}
        mock_core.ReladiffSession.return_value = session

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )
        assert result["success"] is False
        assert result["error"] == "Unknown engine error"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_done_with_no_outcome(self, mock_core, _dial):
        """Done action without an outcome field uses empty dict."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done"}
        mock_core.ReladiffSession.return_value = session

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )
        assert result["success"] is True
        assert result["outcome"] == {}


# ===================================================================
# 5. run_data_diff — cooperative loop
# ===================================================================

class TestRunDataDiffCooperativeLoop:
    """Full cooperative loop: session emits ExecuteSql, we run it, feed back."""

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_single_execute_then_done(self, mock_core, mock_exec_task, _dial):
        """One ExecuteSql round followed by Done."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {
            "type": "ExecuteSql",
            "tasks": [{"id": "q1", "sql": "SELECT count(*) FROM t1", "table_side": "Table1"}],
        }
        session.step.return_value = {"type": "Done", "outcome": {"row_count": 100}}
        mock_core.ReladiffSession.return_value = session
        mock_exec_task.return_value = {"id": "q1", "rows": [["100"]]}

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )

        assert result["success"] is True
        assert result["steps"] == 2
        assert result["outcome"] == {"row_count": 100}
        mock_exec_task.assert_called_once()
        # Verify step received the JSON-encoded responses
        step_arg = session.step.call_args[0][0]
        parsed = json.loads(step_arg)
        assert parsed == [{"id": "q1", "rows": [["100"]]}]

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_multiple_rounds_then_done(self, mock_core, mock_exec_task, _dial):
        """Three ExecuteSql rounds before Done."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        execute_action = {
            "type": "ExecuteSql",
            "tasks": [{"id": "q", "sql": "SELECT 1", "table_side": "Table1"}],
        }
        session.start.return_value = execute_action
        session.step.side_effect = [
            execute_action,
            execute_action,
            {"type": "Done", "outcome": {"diff_rows": 5}},
        ]
        mock_core.ReladiffSession.return_value = session
        mock_exec_task.return_value = {"id": "q", "rows": [["1"]]}

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )

        assert result["success"] is True
        assert result["steps"] == 4  # start + 3 step calls
        assert mock_exec_task.call_count == 3  # 3 ExecuteSql rounds, 1 task each

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_sql_execution_failure(self, mock_core, mock_exec_task, _dial):
        """When _execute_task raises, run_data_diff returns failure with failed_sql."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {
            "type": "ExecuteSql",
            "tasks": [{"id": "q1", "sql": "BAD SQL", "table_side": "Table1"}],
        }
        mock_core.ReladiffSession.return_value = session
        mock_exec_task.side_effect = RuntimeError("Connection timeout")

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )

        assert result["success"] is False
        assert "SQL execution failed" in result["error"]
        assert "Connection timeout" in result["error"]
        assert result["failed_sql"] == "BAD SQL"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_table_side_routing(self, mock_core, mock_exec_task, _dial):
        """Table1 routes to source_warehouse, Table2 routes to target_warehouse."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {
            "type": "ExecuteSql",
            "tasks": [
                {"id": "q1", "sql": "SELECT 1", "table_side": "Table1"},
                {"id": "q2", "sql": "SELECT 2", "table_side": "Table2"},
            ],
        }
        session.step.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session
        mock_exec_task.return_value = {"id": "q", "rows": []}

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="src_wh", target_warehouse="tgt_wh",
            key_columns=["id"],
        )

        calls = mock_exec_task.call_args_list
        assert len(calls) == 2
        # First call: Table1 -> src_wh
        assert calls[0][0][1] == "src_wh"
        # Second call: Table2 -> tgt_wh
        assert calls[1][0][1] == "tgt_wh"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_unknown_table_side_defaults_to_source(self, mock_core, mock_exec_task, _dial):
        """Unknown table_side falls back to source_warehouse."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {
            "type": "ExecuteSql",
            "tasks": [{"id": "q1", "sql": "SELECT 1", "table_side": "UnknownSide"}],
        }
        session.step.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session
        mock_exec_task.return_value = {"id": "q1", "rows": []}

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="src_wh", target_warehouse="tgt_wh",
            key_columns=["id"],
        )

        assert mock_exec_task.call_args[0][1] == "src_wh"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_max_steps_safety_limit(self, mock_core, mock_exec_task, _dial):
        """State machine that never converges is stopped at 100 steps."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        infinite_action = {
            "type": "ExecuteSql",
            "tasks": [{"id": "q", "sql": "SELECT 1", "table_side": "Table1"}],
        }
        session.start.return_value = infinite_action
        session.step.return_value = infinite_action
        mock_core.ReladiffSession.return_value = session
        mock_exec_task.return_value = {"id": "q", "rows": []}

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )

        assert result["success"] is False
        assert "did not converge" in result["error"]
        assert result["steps"] == 100

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_multiple_tasks_in_single_step(self, mock_core, mock_exec_task, _dial):
        """A single ExecuteSql action can carry multiple tasks."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {
            "type": "ExecuteSql",
            "tasks": [
                {"id": "a", "sql": "SELECT 1", "table_side": "Table1"},
                {"id": "b", "sql": "SELECT 2", "table_side": "Table1"},
                {"id": "c", "sql": "SELECT 3", "table_side": "Table2"},
            ],
        }
        session.step.return_value = {"type": "Done", "outcome": {"ok": True}}
        mock_core.ReladiffSession.return_value = session
        mock_exec_task.side_effect = [
            {"id": "a", "rows": [["1"]]},
            {"id": "b", "rows": [["2"]]},
            {"id": "c", "rows": [["3"]]},
        ]

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="src", target_warehouse="tgt",
            key_columns=["id"],
        )

        assert result["success"] is True
        assert mock_exec_task.call_count == 3
        # Verify all three responses sent to step
        step_arg = json.loads(session.step.call_args[0][0])
        assert len(step_arg) == 3
        ids = {r["id"] for r in step_arg}
        assert ids == {"a", "b", "c"}

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_failure_on_second_task_aborts(self, mock_core, mock_exec_task, _dial):
        """If the second task in a batch fails, we abort immediately."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {
            "type": "ExecuteSql",
            "tasks": [
                {"id": "a", "sql": "OK SQL", "table_side": "Table1"},
                {"id": "b", "sql": "BAD SQL", "table_side": "Table1"},
            ],
        }
        mock_core.ReladiffSession.return_value = session
        mock_exec_task.side_effect = [
            {"id": "a", "rows": [["1"]]},
            RuntimeError("Permission denied"),
        ]

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )

        assert result["success"] is False
        assert "Permission denied" in result["error"]
        assert result["failed_sql"] == "BAD SQL"


# ===================================================================
# 6. run_data_diff — parameter handling
# ===================================================================

class TestRunDataDiffParams:
    """Verify parameter defaults and spec construction."""

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="generic")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_target_warehouse_defaults_to_source(self, mock_core, _dial):
        """When target_warehouse is None, source_warehouse is used for both."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="only_wh", target_warehouse=None,
            key_columns=["id"],
        )

        spec_json = mock_core.ReladiffSession.call_args[0][0]
        spec = json.loads(spec_json)
        # Both dialects resolved with the same warehouse
        assert spec["dialect1"] == "generic"
        assert spec["dialect2"] == "generic"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_database_schema_flow_through(self, mock_core, _dial):
        """database and schema are included in the spec when provided."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
            source_database="src_db", source_schema="src_sch",
            target_database="tgt_db", target_schema="tgt_sch",
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert spec["table1"]["database"] == "src_db"
        assert spec["table1"]["schema"] == "src_sch"
        assert spec["table2"]["database"] == "tgt_db"
        assert spec["table2"]["schema"] == "tgt_sch"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_database_schema_omitted_when_none(self, mock_core, _dial):
        """database and schema keys are absent from spec when not provided."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert "database" not in spec["table1"]
        assert "schema" not in spec["table1"]
        assert "database" not in spec["table2"]
        assert "schema" not in spec["table2"]

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_where_clause_included(self, mock_core, _dial):
        """where_clause is added to config when provided."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
            where_clause="created_at > '2025-01-01'",
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert spec["config"]["where_clause"] == "created_at > '2025-01-01'"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_where_clause_omitted_when_none(self, mock_core, _dial):
        """where_clause key is absent from config when not provided."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert "where_clause" not in spec["config"]

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_extra_columns_defaults_to_empty_list(self, mock_core, _dial):
        """When extra_columns is None, spec config gets an empty list."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
            extra_columns=None,
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert spec["config"]["extra_columns"] == []

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_extra_columns_passed_through(self, mock_core, _dial):
        """Explicit extra_columns are forwarded to the spec."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
            extra_columns=["name", "email"],
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert spec["config"]["extra_columns"] == ["name", "email"]

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_key_columns_forwarded(self, mock_core, _dial):
        """key_columns are present in the spec config."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id", "tenant_id"],
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert spec["config"]["key_columns"] == ["id", "tenant_id"]

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_algorithm_forwarded(self, mock_core, _dial):
        """algorithm parameter is forwarded to spec config."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
            algorithm="joindiff",
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert spec["config"]["algorithm"] == "joindiff"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_algorithm_defaults_to_auto(self, mock_core, _dial):
        """Default algorithm is 'auto'."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert spec["config"]["algorithm"] == "auto"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_different_dialects_for_source_and_target(self, mock_core, mock_dial):
        """Source and target can have different dialects."""
        from altimate_engine.sql.data_diff import run_data_diff

        mock_dial.side_effect = lambda wh: {"src": "snowflake", "tgt": "bigquery"}[wh]
        session = MagicMock()
        session.start.return_value = {"type": "Done", "outcome": {}}
        mock_core.ReladiffSession.return_value = session

        run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="src", target_warehouse="tgt",
            key_columns=["id"],
        )

        spec = json.loads(mock_core.ReladiffSession.call_args[0][0])
        assert spec["dialect1"] == "snowflake"
        assert spec["dialect2"] == "bigquery"


# ===================================================================
# 7. Integration-level tests with realistic session flows
# ===================================================================

class TestRunDataDiffIntegration:
    """Mock realistic multi-step flows that mimic actual ReladiffSession behavior."""

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_joindiff_flow(self, mock_core, mock_exec_task, _dial):
        """Simulate a JoinDiff: dup check -> count -> full join -> Done."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()

        # Step 1: dup check (empty result = no dups)
        step1 = {
            "type": "ExecuteSql",
            "tasks": [
                {"id": "dup1", "sql": "SELECT id, count(*) FROM t1 GROUP BY id HAVING count(*) > 1", "table_side": "Table1"},
                {"id": "dup2", "sql": "SELECT id, count(*) FROM t2 GROUP BY id HAVING count(*) > 1", "table_side": "Table2"},
            ],
        }
        # Step 2: row counts
        step2 = {
            "type": "ExecuteSql",
            "tasks": [
                {"id": "cnt1", "sql": "SELECT count(*) FROM t1", "table_side": "Table1"},
                {"id": "cnt2", "sql": "SELECT count(*) FROM t2", "table_side": "Table2"},
            ],
        }
        # Step 3: full join diff
        step3 = {
            "type": "ExecuteSql",
            "tasks": [
                {"id": "join1", "sql": "SELECT * FROM t1 FULL OUTER JOIN t2 ON t1.id = t2.id WHERE ...", "table_side": "Table1"},
            ],
        }
        done = {
            "type": "Done",
            "outcome": {
                "total_rows_source": 1000,
                "total_rows_target": 998,
                "rows_only_in_source": 3,
                "rows_only_in_target": 1,
                "rows_with_differences": 5,
            },
        }

        session.start.return_value = step1
        session.step.side_effect = [step2, step3, done]
        mock_core.ReladiffSession.return_value = session

        mock_exec_task.side_effect = [
            {"id": "dup1", "rows": []},          # no dups in source
            {"id": "dup2", "rows": []},          # no dups in target
            {"id": "cnt1", "rows": [["1000"]]},  # source count
            {"id": "cnt2", "rows": [["998"]]},   # target count
            {"id": "join1", "rows": [["diff_row_1"], ["diff_row_2"]]},
        ]

        result = run_data_diff(
            source_table="orders", target_table="orders_v2",
            source_warehouse="prod_wh", target_warehouse="staging_wh",
            key_columns=["order_id"],
            extra_columns=["amount", "status"],
        )

        assert result["success"] is True
        assert result["steps"] == 4
        assert result["outcome"]["rows_only_in_source"] == 3
        assert result["outcome"]["rows_with_differences"] == 5

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_profile_flow(self, mock_core, mock_exec_task, _dial):
        """Simulate a profile comparison: column stats queries -> Done with verdicts."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()

        profile_step = {
            "type": "ExecuteSql",
            "tasks": [
                {"id": "p1", "sql": "SELECT min(id), max(id), count(distinct id) FROM t1", "table_side": "Table1"},
                {"id": "p2", "sql": "SELECT min(id), max(id), count(distinct id) FROM t2", "table_side": "Table2"},
            ],
        }
        done = {
            "type": "Done",
            "outcome": {
                "columns": {
                    "id": {"verdict": "match", "source_min": "1", "target_min": "1"},
                    "name": {"verdict": "mismatch", "source_distinct": "50", "target_distinct": "48"},
                },
            },
        }

        session.start.return_value = profile_step
        session.step.return_value = done
        mock_core.ReladiffSession.return_value = session

        mock_exec_task.side_effect = [
            {"id": "p1", "rows": [["1", "1000", "1000"]]},
            {"id": "p2", "rows": [["1", "998", "998"]]},
        ]

        result = run_data_diff(
            source_table="users", target_table="users_snapshot",
            source_warehouse="analytics",
            key_columns=["id"],
        )

        assert result["success"] is True
        assert result["outcome"]["columns"]["id"]["verdict"] == "match"
        assert result["outcome"]["columns"]["name"]["verdict"] == "mismatch"

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="snowflake")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_cascade_count_then_stop(self, mock_core, mock_exec_task, _dial):
        """Simulate a cascade flow that stops after count queries (tables match)."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()

        count_step = {
            "type": "ExecuteSql",
            "tasks": [
                {"id": "c1", "sql": "SELECT count(*) FROM t1", "table_side": "Table1"},
                {"id": "c2", "sql": "SELECT count(*) FROM t2", "table_side": "Table2"},
            ],
        }
        done = {
            "type": "Done",
            "outcome": {
                "equal": True,
                "method": "count",
                "source_count": 5000,
                "target_count": 5000,
            },
        }

        session.start.return_value = count_step
        session.step.return_value = done
        mock_core.ReladiffSession.return_value = session

        mock_exec_task.side_effect = [
            {"id": "c1", "rows": [["5000"]]},
            {"id": "c2", "rows": [["5000"]]},
        ]

        result = run_data_diff(
            source_table="events", target_table="events_replica",
            source_warehouse="primary",
            key_columns=["event_id"],
        )

        assert result["success"] is True
        assert result["outcome"]["equal"] is True
        assert result["outcome"]["method"] == "count"
        assert result["steps"] == 2

    @patch("altimate_engine.sql.data_diff.RELADIFF_AVAILABLE", True)
    @patch("altimate_engine.sql.data_diff._resolve_dialect", return_value="duckdb")
    @patch("altimate_engine.sql.data_diff._execute_task")
    @patch("altimate_engine.sql.data_diff.altimate_core")
    def test_error_mid_flow(self, mock_core, mock_exec_task, _dial):
        """Engine returns Error mid-flow after successful first step."""
        from altimate_engine.sql.data_diff import run_data_diff

        session = MagicMock()

        session.start.return_value = {
            "type": "ExecuteSql",
            "tasks": [{"id": "q1", "sql": "SELECT 1", "table_side": "Table1"}],
        }
        session.step.return_value = {
            "type": "Error",
            "message": "Key column 'id' not found in table",
        }
        mock_core.ReladiffSession.return_value = session
        mock_exec_task.return_value = {"id": "q1", "rows": [["1"]]}

        result = run_data_diff(
            source_table="t1", target_table="t2",
            source_warehouse="wh", key_columns=["id"],
        )

        assert result["success"] is False
        assert "Key column" in result["error"]
        assert result["steps"] == 2
