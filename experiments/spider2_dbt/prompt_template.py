"""Prompt template for Spider 2.0-DBT benchmark tasks.

Passes the benchmark instruction through to the agent as-is.
All agent behavior is defined in builder.txt (the system prompt).
"""

from __future__ import annotations


def build_task_prompt(
    instance_id: str,
    instruction: str,
    project_dir: str,
) -> str:
    """Build the prompt for a Spider2-DBT task.

    Args:
        instance_id: Unique task identifier (e.g., "ga4_001").
        instruction: The natural language task instruction from the benchmark.
        project_dir: Absolute path to the dbt project working directory.

    Returns:
        The instruction string for the agent.
    """
    return instruction
