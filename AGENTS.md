# Codex Repository Instructions

## Backend Tests

The backend requires Python 3.12 and the `uv` environment from `backend/pyproject.toml`.
Do not run backend tests with system Python or bare `pytest`; that skips the workspace
package dependency graph and fails during collection on imports such as `langchain`,
`langgraph`, and `dotenv`.

For backend review or verification, bootstrap and run tests through `uv`:

```bash
cd backend
uv sync --group dev
PYTHONPATH=. uv run pytest tests/ -v
```

For the focused builder/gateway PR sweep, use:

```bash
cd backend
uv sync --group dev
PYTHONPATH=. uv run pytest \
  tests/test_builder_progress_middleware.py \
  tests/test_builder_progress_endpoint.py \
  tests/test_builder_events_worker.py \
  tests/test_builder_canvas_worker.py \
  tests/test_builder_canvas_routes.py \
  tests/test_gateway_app_mounts.py \
  tests/test_companion_wakeup.py \
  tests/test_gateway_sophia.py \
  tests/test_start_builder_task.py \
  -q
```

The frontend uses `pnpm`; run frontend checks from `frontend/`.
