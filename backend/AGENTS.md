For the backend architecture and design patterns:
@./CLAUDE.md

Backend tests require Python 3.12 and the `uv` environment declared in
`pyproject.toml`. Do not use system Python or bare `pytest` for backend review
runs; those commands bypass the workspace dependency graph and can fail during
collection on imports such as `langchain`, `langgraph`, and `dotenv`.

Use this bootstrap before backend test commands:

```bash
uv sync --group dev
PYTHONPATH=. uv run pytest tests/ -v
```

For focused test runs, keep the same `uv run pytest` prefix and append the
specific test files.
