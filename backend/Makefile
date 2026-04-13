install:
LANGGRAPH_JOBS_PER_WORKER ?= 4
LANGGRAPH_BG_JOB_ISOLATED_LOOPS ?= true

install:
	uv sync

dev:
	BG_JOB_ISOLATED_LOOPS=$(LANGGRAPH_BG_JOB_ISOLATED_LOOPS) uv run langgraph dev --no-browser --allow-blocking --no-reload --n-jobs-per-worker $(LANGGRAPH_JOBS_PER_WORKER)

gateway:
	PYTHONPATH=. uv run uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001

test:
	PYTHONPATH=. uv run pytest tests/ -v

lint:
	uvx ruff check .

format:
	uvx ruff check . --fix && uvx ruff format .
