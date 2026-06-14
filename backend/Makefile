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

# Renders a themed fixture PDF inside the langgraph container — validates the
# pandoc template against the EXACT container pandoc/xelatex/texlive set
# (prod 2026-06-11: a template parse error only reproducible at the container
# pandoc version shipped silently). Slow (~10 min first build); run before
# deploys that touch sophia.latex or the Dockerfile.
pdf-template-smoke:
	cd .. && docker build -f backend/Dockerfile.langgraph -t sophia-langgraph-smoke .
	docker run --rm --entrypoint bash sophia-langgraph-smoke -lc '\
		set -e; cd /tmp; printf "# Smoke\n\nbody\n" > t.md; \
		for theme_vars in "-V accentcolor=1F6FB2 -V headingcolor=10243E -V titlepagecolor=10243E -V titlepagetextcolor=F8FAFC -V titlepage=true" "-V accentcolor=334155" ""; do \
			pandoc --standalone t.md -o t.pdf --pdf-engine=xelatex \
				--template=/app/backend/packages/harness/deerflow/sophia/assets/sophia.latex $$theme_vars; \
			echo "OK: $$theme_vars"; \
		done'

# G-VIS provider matrix (Spec VQ-9): live fixture builds (deck/pdf/html)
# against a running langgraph (boot `make dev` first, or point
# SOPHIA_EVAL_LANGGRAPH_URL at a deployed service). Real API spend —
# on-demand + nightly only, never per-PR.
eval-visuals:
	PYTHONPATH=. uv run python tests/evals/visuals/run_matrix.py --provider anthropic
	SOPHIA_BUILDER_FORCE_PROVIDER=openai PYTHONPATH=. uv run python tests/evals/visuals/run_matrix.py --provider openai

# G-DEL live lane (Spec D): the 40-turn delegation fixture against a
# running langgraph that SHARES this working directory (local `make dev`
# or the nightly CI job) — the runner materializes the parent-session
# ledger straight onto the shared disk. Real API spend — on-demand +
# nightly only, never per-PR.
eval-delegation:
	PYTHONPATH=.:tests uv run python tests/evals/delegation/run_matrix.py --provider anthropic
	SOPHIA_BUILDER_FORCE_PROVIDER=openai PYTHONPATH=.:tests uv run python tests/evals/delegation/run_matrix.py --provider openai
