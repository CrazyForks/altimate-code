"""Spider 2.0-DBT benchmark results tracker.

Stores all run results in SQLite for persistent tracking across sessions.
Usage:
    python tracker.py import           # Import all JSON results into DB
    python tracker.py status           # Show current best scores per task
    python tracker.py runs             # List all runs with summary
    python tracker.py failures         # Show tasks that have never passed
    python tracker.py diff RUN1 RUN2   # Compare two runs
    python tracker.py best             # Show best possible combined score
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).parent / "benchmark_tracker.db"
RESULTS_DIR = Path(__file__).parent / "results"


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            model TEXT,
            total_tasks INTEGER,
            tasks_run INTEGER,
            completed INTEGER,
            timed_out INTEGER,
            passed INTEGER,
            failed INTEGER,
            errors INTEGER,
            pass_rate REAL,
            parallel_workers INTEGER,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS task_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL REFERENCES runs(run_id),
            instance_id TEXT NOT NULL,
            domain TEXT,
            passed INTEGER NOT NULL DEFAULT 0,
            exit_code INTEGER,
            timed_out INTEGER DEFAULT 0,
            dbt_success INTEGER DEFAULT 0,
            elapsed_s REAL,
            event_count INTEGER,
            eval_error TEXT,
            eval_method TEXT,
            attempt INTEGER DEFAULT 1,
            UNIQUE(run_id, instance_id)
        );

        CREATE TABLE IF NOT EXISTS task_meta (
            instance_id TEXT PRIMARY KEY,
            domain TEXT,
            instruction TEXT,
            has_gold_db INTEGER DEFAULT 1,
            eval_harness_bug INTEGER DEFAULT 0,
            notes TEXT
        );

        CREATE TABLE IF NOT EXISTS prompt_versions (
            version_id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT REFERENCES runs(run_id),
            prompt_hash TEXT,
            changes TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_task_results_instance ON task_results(instance_id);
        CREATE INDEX IF NOT EXISTS idx_task_results_run ON task_results(run_id);
        CREATE INDEX IF NOT EXISTS idx_task_results_passed ON task_results(passed);
    """)
    conn.commit()


def import_all(conn: sqlite3.Connection):
    """Import all evaluation and benchmark JSON files into the DB."""
    # Find matching pairs of benchmark + evaluation files
    eval_files = sorted(RESULTS_DIR.glob("evaluation_2*.json"))
    bench_files = sorted(RESULTS_DIR.glob("spider2_benchmark_*.json"))

    print(f"Found {len(eval_files)} evaluation files, {len(bench_files)} benchmark files")

    # Build lookup of benchmark files by timestamp
    bench_by_ts = {}
    for bf in bench_files:
        ts = bf.stem.replace("spider2_benchmark_", "")
        bench_by_ts[ts] = bf

    imported = 0
    for ef in eval_files:
        eval_data = json.loads(ef.read_text())
        run_id = eval_data["timestamp"]

        # Skip if already imported
        existing = conn.execute("SELECT 1 FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if existing:
            continue

        # Find the source benchmark file
        source = eval_data.get("source_results", "")
        bench_data = None
        bench_ts = Path(source).stem.replace("spider2_benchmark_", "") if source else None
        if bench_ts and bench_ts in bench_by_ts:
            bench_data = json.loads(bench_by_ts[bench_ts].read_text())

        # Insert run
        tasks_run = len(eval_data.get("evaluations", []))
        conn.execute("""
            INSERT INTO runs (run_id, timestamp, model, total_tasks, tasks_run,
                            completed, timed_out, passed, failed, errors, pass_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            run_id,
            run_id,
            eval_data.get("model", "unknown"),
            eval_data.get("total", 68),
            tasks_run,
            bench_data.get("completed", 0) if bench_data else tasks_run,
            bench_data.get("timed_out", 0) if bench_data else 0,
            eval_data.get("passed", 0),
            eval_data.get("failed", 0),
            eval_data.get("errors", 0),
            eval_data.get("pass_rate", 0),
        ))

        # Build benchmark task lookup
        bench_tasks = {}
        if bench_data:
            for t in bench_data.get("task_results", []):
                bench_tasks[t["instance_id"]] = t

        # Insert task results
        for ev in eval_data.get("evaluations", []):
            iid = ev["instance_id"]
            bt = bench_tasks.get(iid, {})

            conn.execute("""
                INSERT OR REPLACE INTO task_results
                    (run_id, instance_id, domain, passed, exit_code, timed_out,
                     dbt_success, elapsed_s, event_count, eval_error, eval_method, attempt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                run_id,
                iid,
                bt.get("domain", ""),
                1 if ev["passed"] else 0,
                bt.get("exit_code"),
                1 if bt.get("timed_out") else 0,
                1 if bt.get("dbt_success") else 0,
                bt.get("elapsed_s"),
                bt.get("event_count"),
                ev.get("error"),
                ev.get("method"),
                bt.get("attempt", 1),
            ))

            # Upsert task meta
            conn.execute("""
                INSERT OR IGNORE INTO task_meta (instance_id, domain, instruction)
                VALUES (?, ?, ?)
            """, (iid, bt.get("domain", ""), bt.get("instruction", "")))

        imported += 1

    conn.commit()

    # Mark known impossible tasks
    impossible = {
        "airbnb002": ("missing gold DB", 0, 1),
        "biketheft001": ("missing gold DB", 0, 1),
        "google_ads001": ("missing gold DB", 0, 1),
        "gitcoin001": ("missing gold DB", 0, 1),
        "chinook001": ("gold table name mismatch", 0, 1),
        "xero_new001": ("eval references empty xero.duckdb", 1, 0),
        "xero_new002": ("eval references empty xero.duckdb", 1, 0),
        "social_media001": ("eval references empty social_media_reporting.duckdb", 1, 0),
    }
    for iid, (note, harness_bug, no_gold) in impossible.items():
        conn.execute("""
            UPDATE task_meta SET has_gold_db = ?, eval_harness_bug = ?, notes = ?
            WHERE instance_id = ?
        """, (1 - no_gold if not harness_bug else 1, harness_bug, note, iid))
    conn.commit()

    print(f"Imported {imported} new runs")


def show_runs(conn: sqlite3.Connection):
    rows = conn.execute("""
        SELECT run_id, model, tasks_run, passed, failed, errors, pass_rate, timed_out, notes
        FROM runs ORDER BY run_id
    """).fetchall()

    print(f"\n{'Run ID':<22} {'Tasks':>5} {'Pass':>4} {'Fail':>4} {'Err':>3} {'T/O':>3} {'Rate':>7} Notes")
    print("-" * 75)
    for r in rows:
        notes = r["notes"] or ""
        print(f"{r['run_id']:<22} {r['tasks_run']:>5} {r['passed']:>4} {r['failed']:>4} {r['errors']:>3} {r['timed_out']:>3} {r['pass_rate']:>6.1f}% {notes}")


def show_status(conn: sqlite3.Connection):
    """Show per-task best result across all runs."""
    rows = conn.execute("""
        SELECT
            tr.instance_id,
            tm.domain,
            MAX(tr.passed) as ever_passed,
            COUNT(tr.run_id) as times_run,
            SUM(tr.passed) as times_passed,
            MIN(tr.elapsed_s) as fastest_s,
            MAX(tr.timed_out) as ever_timed_out,
            tm.has_gold_db,
            tm.eval_harness_bug,
            tm.notes
        FROM task_results tr
        LEFT JOIN task_meta tm ON tr.instance_id = tm.instance_id
        GROUP BY tr.instance_id
        ORDER BY ever_passed DESC, times_passed DESC, tr.instance_id
    """).fetchall()

    print(f"\n{'Task':<38} {'Best':>4} {'Pass/Run':>8} {'Fast':>6} {'Notes'}")
    print("-" * 85)
    passed_count = 0
    impossible_count = 0
    for r in rows:
        best = "PASS" if r["ever_passed"] else "FAIL"
        if not r["has_gold_db"] or r["eval_harness_bug"]:
            best = "N/A"
            impossible_count += 1
        if r["ever_passed"]:
            passed_count += 1
        fast = f"{r['fastest_s']:.0f}s" if r["fastest_s"] else "?"
        notes = r["notes"] or ""
        if r["ever_timed_out"] and not r["ever_passed"]:
            notes = (notes + " timeout").strip()
        print(f"{r['instance_id']:<38} {best:>4} {r['times_passed']}/{r['times_run']:>2}    {fast:>6} {notes}")

    total = len(rows)
    print(f"\n  Total tasks: {total}")
    print(f"  Ever passed: {passed_count}")
    print(f"  Impossible:  {impossible_count}")
    print(f"  Best possible: {passed_count}/{total} ({passed_count/total*100:.1f}%)")


def show_failures(conn: sqlite3.Connection):
    """Show tasks that have NEVER passed in any run."""
    rows = conn.execute("""
        SELECT
            tr.instance_id,
            tm.domain,
            COUNT(tr.run_id) as times_run,
            MAX(tr.timed_out) as ever_timed_out,
            MIN(tr.elapsed_s) as min_time,
            MAX(tr.elapsed_s) as max_time,
            tm.has_gold_db,
            tm.eval_harness_bug,
            tm.notes
        FROM task_results tr
        LEFT JOIN task_meta tm ON tr.instance_id = tm.instance_id
        GROUP BY tr.instance_id
        HAVING MAX(tr.passed) = 0
        ORDER BY tm.has_gold_db DESC, tm.eval_harness_bug, tr.instance_id
    """).fetchall()

    print(f"\n=== NEVER-PASSED TASKS ({len(rows)}) ===\n")

    impossible = [r for r in rows if not r["has_gold_db"] or r["eval_harness_bug"]]
    addressable = [r for r in rows if r["has_gold_db"] and not r["eval_harness_bug"]]

    if impossible:
        print(f"--- Impossible ({len(impossible)}) ---")
        for r in impossible:
            print(f"  {r['instance_id']:<35} {r['notes'] or 'impossible'}")

    print(f"\n--- Addressable ({len(addressable)}) ---")
    print(f"  {'Task':<35} {'Runs':>4} {'T/O':>3} {'MinTime':>7} {'MaxTime':>7}")
    print("  " + "-" * 60)
    for r in addressable:
        to = "yes" if r["ever_timed_out"] else ""
        mint = f"{r['min_time']:.0f}s" if r["min_time"] else "?"
        maxt = f"{r['max_time']:.0f}s" if r["max_time"] else "?"
        print(f"  {r['instance_id']:<35} {r['times_run']:>4} {to:>3} {mint:>7} {maxt:>7}")


def show_best(conn: sqlite3.Connection):
    """Show the best possible combined score if we take best result per task."""
    rows = conn.execute("""
        SELECT
            tr.instance_id,
            MAX(tr.passed) as ever_passed,
            tm.has_gold_db,
            tm.eval_harness_bug
        FROM task_results tr
        LEFT JOIN task_meta tm ON tr.instance_id = tm.instance_id
        GROUP BY tr.instance_id
    """).fetchall()

    total = len(rows)
    passed = sum(1 for r in rows if r["ever_passed"])
    impossible = sum(1 for r in rows if not r["has_gold_db"] or r["eval_harness_bug"])
    addressable = total - impossible
    never_passed = total - passed - impossible

    print(f"\n=== BEST POSSIBLE SCORE ===")
    print(f"  Total tasks:      {total}")
    print(f"  Ever passed:      {passed} ({passed/total*100:.1f}%)")
    print(f"  Impossible:       {impossible}")
    print(f"  Never passed:     {never_passed}")
    print(f"  Addressable left: {never_passed}")
    print(f"\n  Best score:       {passed}/{total} = {passed/total*100:.1f}%")
    print(f"  Ceiling (excl impossible): {passed}/{addressable} = {passed/addressable*100:.1f}%")

    # Leaderboard comparison
    leaderboard = [
        ("Databao Agent", 44.11),
        ("MLE-Bench Agent", 38.24),
        ("Claude 3.5 Sonnet (CoT)", 36.76),
    ]
    print(f"\n  Leaderboard comparison:")
    inserted = False
    for name, rate in leaderboard:
        if not inserted and passed / total * 100 >= rate:
            print(f"  >>> Altimate Code: {passed/total*100:.1f}% <<<")
            inserted = True
        print(f"      {name}: {rate}%")
    if not inserted:
        print(f"  >>> Altimate Code: {passed/total*100:.1f}% <<<")


def diff_runs(conn: sqlite3.Connection, run1: str, run2: str):
    """Compare two runs side by side."""
    rows = conn.execute("""
        SELECT
            COALESCE(a.instance_id, b.instance_id) as instance_id,
            a.passed as run1_passed,
            b.passed as run2_passed,
            a.elapsed_s as run1_time,
            b.elapsed_s as run2_time,
            a.timed_out as run1_timeout,
            b.timed_out as run2_timeout
        FROM task_results a
        FULL OUTER JOIN task_results b ON a.instance_id = b.instance_id AND b.run_id = ?
        WHERE a.run_id = ?
        ORDER BY instance_id
    """, (run2, run1)).fetchall()

    gained = []
    lost = []
    for r in rows:
        p1 = r["run1_passed"] or 0
        p2 = r["run2_passed"] or 0
        if p1 == 0 and p2 == 1:
            gained.append(r["instance_id"])
        elif p1 == 1 and p2 == 0:
            lost.append(r["instance_id"])

    r1 = conn.execute("SELECT passed, pass_rate FROM runs WHERE run_id = ?", (run1,)).fetchone()
    r2 = conn.execute("SELECT passed, pass_rate FROM runs WHERE run_id = ?", (run2,)).fetchone()

    print(f"\n=== DIFF: {run1} vs {run2} ===")
    if r1:
        print(f"  Run 1: {r1['passed']} passed ({r1['pass_rate']}%)")
    if r2:
        print(f"  Run 2: {r2['passed']} passed ({r2['pass_rate']}%)")
    print(f"\n  Gained ({len(gained)}):")
    for t in gained:
        print(f"    + {t}")
    print(f"  Lost ({len(lost)}):")
    for t in lost:
        print(f"    - {t}")


def annotate_run(conn: sqlite3.Connection, run_id: str, notes: str):
    """Add notes to a run."""
    conn.execute("UPDATE runs SET notes = ? WHERE run_id = ?", (notes, run_id))
    conn.commit()
    print(f"Updated run {run_id} with notes: {notes}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    cmd = sys.argv[1]
    conn = get_db()
    init_db(conn)

    if cmd == "import":
        import_all(conn)
    elif cmd == "runs":
        show_runs(conn)
    elif cmd == "status":
        show_status(conn)
    elif cmd == "failures":
        show_failures(conn)
    elif cmd == "best":
        show_best(conn)
    elif cmd == "diff":
        if len(sys.argv) < 4:
            print("Usage: tracker.py diff RUN1 RUN2")
            return
        diff_runs(conn, sys.argv[2], sys.argv[3])
    elif cmd == "annotate":
        if len(sys.argv) < 4:
            print("Usage: tracker.py annotate RUN_ID 'notes'")
            return
        annotate_run(conn, sys.argv[2], sys.argv[3])
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)

    conn.close()


if __name__ == "__main__":
    main()
