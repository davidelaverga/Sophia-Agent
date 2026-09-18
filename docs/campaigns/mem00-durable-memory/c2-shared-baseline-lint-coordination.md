# Shared baseline: Voice Lab lint, and a correction about the encoding tests

**Status:** a small separate change, prepared for the Voice owner. It is **not**
on `codex/mem00-text-pilot` and is not part of the C2 integration candidate,
because the files belong to Voice Lab and the repository's merge requirements
are the Voice owner's to satisfy.

Branch: `codex/voice-lab-lint-hygiene`, from `8c5cf538`.

---

## 1. Correction: the two "baseline test failures" were mine, not the baseline's

Earlier records in this campaign state that `make test` fails on the shared
baseline with two `tests/test_local_sandbox_encoding.py` cases, and that the
pilot merely does not add to them. **That was a measurement error, and this
corrects it.**

Both tests build a command that begins with the literal `python`, and
`local_sandbox._trusted_image_provider_command` resolves it with
`shutil.which`. On this machine there is no bare `python` on `PATH` — only
`python3` — so the helper returned `None` and both assertions failed. I invoked
pytest as `.venv/bin/python -m pytest`, which does **not** put the virtualenv's
`bin` on `PATH`. CI runs `make test`, which is `uv run pytest`, and `uv run`
does put it there.

Re-measured on `8c5cf538` with `PATH` set the way `uv run` sets it:

```
11 passed, 2 skipped        tests/test_local_sandbox_encoding.py
```

So there is **nothing to fix** here, and no coordination needed for it. The
campaign's earlier "2 failed" figures are an artefact of the harness, not a
property of the shared line. Every measurement in this document and in the
release record from this date forward puts the venv on `PATH`.

**Withdrawn from the defect backlog on the sponsor's direction, 2026-09-18:**
these two cases are a measurement error, not a code defect, and nothing about
them is carried forward as work. The corrected invocation is kept: every
measurement puts the virtualenv's `bin` on `PATH`, as `uv run` does.

## 2. The 22 lint errors are real

`ruff check .` is `PATH`-independent, and `make lint` runs before `make test`,
so this is the step that actually fails CI on the shared baseline. All 22 are in
three Voice Lab files:

| file | errors |
| --- | --- |
| `backend/tests/test_voice_lab_process_termination.py` | 11 × `E701`, 3 × `I001`, 2 × `F811` |
| `backend/tests/test_voice_lab_process_termination_postgres.py` | 2 × `I001`, 1 × `E501`, 1 × `E731`, 1 × `F811` |
| `backend/app/gateway/voice_lab_process_termination.py` | 1 × `I001` |

## 3. What the prepared change does

Per rule, and deliberately **not** `ruff check --fix .` or `ruff format`:

- **`E701`** (11): `if cond: stmt` split into two lines. Indentation preserved,
  nothing else on those lines touched.
- **`E731`** (1): the assigned `lambda` becomes a two-line `def` with the same
  body.
- **`E501`** (1): one 290-character SQL `INSERT` split across implicit string
  concatenation. The statement text is byte-identical once concatenated.
- **`F811`** (3): `# noqa: F811 - pytest fixture request` on the parameter
  lines. These are fixtures imported so pytest can resolve them and then named
  again as parameters; ruff cannot see a fixture used by name.
- **`I001`** (6): import sorting only, via `--select I001`.

No check is disabled, no rule is ignored in configuration, and no blanket
autofix was run. `F401` in particular was **not** auto-fixed: on this campaign's
own branch a blanket `--fix` deleted 32 pytest fixture imports and produced 477
collection errors, which is why the rule-by-rule form is used here.

Result: `ruff check .` → **All checks passed**, and the three Voice Lab test
files still pass (42 passed, 3 skipped).

## 4. What the Voice owner is being asked to decide

1. Whether to take this change as prepared, or to fix the same 22 differently —
   the `E701` style in particular is a deliberate compression in those files and
   the owner may prefer a per-file ruff configuration to reformatting.
2. Whether it lands on its own or alongside the C2 integration. It is
   independent either way: the pilot branch is already `ruff check .` clean on
   its own files, so this is the only remaining lint blocker on the merged line.

## 5. The pull request, and what the review needs to cover

**Base** `codex/sophia-observability-v1` (head `8c5cf538`, verified unmoved on
the remote at the time of writing) - **head** `codex/voice-lab-lint-hygiene`
(`9ed8bedf`), one commit, fast-forwardable.

The branch is pushed. The PR itself has to be opened from an account with write
access to the repository: this environment has no `gh` CLI and no GitHub
credential, and none should be supplied to it. A compare link with the title and
body pre-filled is in the session where this was prepared; opening it and
pressing "Create pull request" is the whole action.

What CI will run on that PR, and what the reviewer should expect:

| workflow | why it triggers | expected |
| --- | --- | --- |
| `backend-unit-tests` | always | `make lint` **passes for the first time on this line**, then `make test` runs and passes |
| `sentrux-gate` | always, blocking | architecture score vs `origin/main`; a whitespace/import-order change should not move it |
| `memory-highlights-e2e` | paths under `frontend/**` | **not triggered** - this change touches no frontend file |

Two things worth a reviewer's attention rather than a rubber stamp:

1. **The three `F811` noqas.** They assert "this is a pytest fixture named as a
   parameter". If any of them is actually a genuine redefinition, the noqa hides
   a real bug. They were read individually, but the Voice owner knows these files.
2. **`make lint` uses `uvx ruff`, which is unpinned.** It resolves whatever ruff
   is current when CI runs, not the `ruff 0.14.11` in `backend/uv.lock`. A new
   ruff release can therefore turn this line red again without any commit. If the
   owner wants that closed, pinning `uvx ruff@<version>` in the Makefile is a
   separate one-line change and is deliberately not bundled here.

## 6. Out of scope

Pilot activation, the unapplied serving grants, receiving-authentication
install, provider obligations, and the fault-injection RPC permissions — all
recorded separately and none of them touched here.
