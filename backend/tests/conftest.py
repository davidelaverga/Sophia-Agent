"""Test configuration for the backend test suite.

Sets up sys.path and pre-mocks modules that would cause circular import
issues when unit-testing lightweight config/registry code in isolation.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

# Make 'app' and 'deerflow' importable from any working directory
sys.path.insert(0, str(Path(__file__).parent.parent))


def _backend_runtime_deps_available() -> bool:
    try:
        import langchain  # noqa: F401
        import langgraph  # noqa: F401
    except ModuleNotFoundError:
        return False
    return True


def _maybe_reexec_pytest_in_uv() -> None:
    """Recover from review bots invoking bare pytest instead of uv-run pytest.

    The backend workspace depends on the uv project environment. A plain
    ``PYTHONPATH=. pytest ...`` command can import this conftest while still
    missing runtime packages such as langchain/langgraph, causing collection to
    fail before assertions run. Re-exec once through uv so the same test command
    uses the declared project dependencies.
    """
    if _backend_runtime_deps_available():
        return
    if os.environ.get("SOPHIA_BACKEND_PYTEST_UV_REEXEC") == "1":
        message = (
            "Backend pytest dependencies are missing after uv re-exec. "
            "Run from backend/: uv sync --group dev && PYTHONPATH=. uv run pytest ..."
        )
        raise RuntimeError(message)
    uv_path = shutil.which("uv")
    if uv_path is None:
        message = (
            "Backend pytest dependencies are missing and uv is not available. "
            "Run from backend/: uv sync --group dev && PYTHONPATH=. uv run pytest ..."
        )
        raise RuntimeError(message)
    env = dict(os.environ)
    env["SOPHIA_BACKEND_PYTEST_UV_REEXEC"] = "1"
    env["PYTHONPATH"] = env.get("PYTHONPATH") or "."
    command = [uv_path, "run", "--group", "dev", "python", "-m", "pytest", *sys.argv[1:]]
    raise SystemExit(subprocess.call(command, env=env))


_maybe_reexec_pytest_in_uv()

# Break the circular import chain that exists in production code:
#   deerflow.subagents.__init__
#     -> .executor (SubagentExecutor, SubagentResult)
#       -> deerflow.agents.thread_state
#         -> deerflow.agents.__init__
#           -> lead_agent.agent
#             -> subagent_limit_middleware
#               -> deerflow.subagents.executor  <-- circular!
#
# By injecting a mock for deerflow.subagents.executor *before* any test module
# triggers the import, __init__.py's "from .executor import ..." succeeds
# immediately without running the real executor module.
_executor_mock = MagicMock()
_executor_mock.SubagentExecutor = MagicMock
_executor_mock.SubagentResult = MagicMock
_executor_mock.SubagentStatus = MagicMock
_executor_mock.MAX_CONCURRENT_SUBAGENTS = 3
_executor_mock.get_background_task_result = MagicMock()

sys.modules["deerflow.subagents.executor"] = _executor_mock
