# MEM00-C2 coordinated release sequence

**Status:** prepared, not started. Every step below is gated, and the gates are
named. Nothing in this document is authorization to perform any of it.

This replaces the paragraph-form "still required before the hosted journey" note
with an ordered sequence, because the steps are no longer independent: two of
them must land together, and one is another owner's.

The two subjects this campaign keeps **out** of this sequence remain out:
**provider obligations** (historical, preserved as-is) and the
**fault-injection RPC permissions** (`arm_fault`, `consume_fault`,
`clear_faults` hold `service_role` EXECUTE; a separate least-privilege question,
never bundled into an activation grant).

---

## Where the gates actually stand

| gate | state |
| --- | --- |
| Pilot branch tests | **green** — 7,212 passed / 0 failed, measured with the venv on `PATH` as `uv run` sets it |
| Pilot branch `ruff check .` | **green** — 0 errors |
| Shared baseline tests | **green** — 6,227 passed / 0 failed |
| Shared baseline `ruff check .` | **22 errors**, all Voice Lab's — fix prepared on `codex/voice-lab-lint-hygiene` |
| Serving grants | reviewed, signature-pinned, **unapplied** |
| Receiving authentication | built and tested, **not installed**; `langgraph.json` has no `auth` key |
| Non-cohort cutover | resolved in code; every account is still undeclared and 0 owners are governed |

The earlier note said the integration line "still carries ~121 failing tests
from legacy fixture gaps, which would keep required CI red". That is no longer
true and the sequence below assumes the current numbers.

## Step 0 — Voice owner's decisions (blocks steps 2 and 3)

From [`c2-receiving-auth-cross-owner-coordination.md`](./c2-receiving-auth-cross-owner-coordination.md):

1. A non-owner `maintenance` scope for Voice Lab's cleanup and reaper paths.
   **Built**, and eligibility is now bound to the cleanup fence rather than to
   client metadata.
2. Its exact route list. **Built** as thread search / read / delete and run
   list / read / cancel — no run creation, no `/state`, `/history` or `/copy`.
3. Whether deck-quality shares that scope. **Built as a separate one**, because
   dispatch creates runs and retention must not.
4. Whether the Voice Lab principal refusal stays absolute. **Narrowed, not
   dropped** — see step 0a. This is the one that needs a decision rather than a
   review.
5. ~~Which identity owns the companion run during a Voice Lab test.~~
   **Closed.** Both now work: an ordinary parent owner and the test principal
   itself both create an authorized synthetic Builder thread.

### Step 0a — the one substantive ask

Installing receiving authentication requires the Voice Lab test principal to be
admitted for **authorized synthetic Builder work only**: a thread whose
cleanup-fence reservation exists, its own such threads, and the Builder graph on
one. It stays refused a plain thread, an unreserved synthetic thread, the
companion graph, and every MEM00 surface — it remains undeclared, so no input
provenance is minted for it and no memory can be inherited.

Without this, installing authentication stops Voice Lab's synthetic Builder.
With it, the isolation rule is narrower than it was. That trade is the Voice
owner's to accept, and it is the only thing in this sequence that changes a
rule rather than applying one.

## Step 1 — shared baseline lint (independent, any time)

Merge `codex/voice-lab-lint-hygiene` (from `8c5cf538`), or the Voice owner's
preferred equivalent. See
[`c2-shared-baseline-lint-coordination.md`](./c2-shared-baseline-lint-coordination.md).
Until this lands, `make lint` fails on the merged line and CI never reaches
`make test` — so this gates *any* PR on that line, not only this campaign's.

## Step 2 — receiving authentication install (needs step 0a)

One change, three files, and it must be **one** change:

- `backend/langgraph.json` — add the `auth` entry pointing at
  `deerflow/sophia/langgraph_auth.py:auth`.
- `backend/tests/test_render_config.py:96` — the `assert "auth" not in config`
  that currently pins its absence.
- The four caller sites are **already migrated** and are inert until this lands:
  they enter their lane, the credential is minted, and an uninstalled server
  ignores the header.

Splitting this is the failure mode: installing without the callers returns 401
to Voice Lab retention cleanup and deck-quality dispatch; migrating without
installing does nothing.

## Step 3 — serving grants (needs step 2's decision, not its deploy)

`backend/migrations/2026_09_17_mem00_c2_serving_grants.sql`, unchanged since
`73c69bad`. EXECUTE only, `service_role` only, 21 frozen type-only signatures,
with signature/overload drift checks and a set-equality assertion. Rehearsed
0/21 → 21/21, total 25 → 46, idempotent, all four guards proven non-vacuous.

It is ordered after step 2's decision because granting serving access before the
receiving boundary is authenticated widens the surface for longer than
necessary, not because the SQL depends on it.

## Step 4 — deployment

Three Render services, `autoDeployTrigger: Off` on all of them, exact-commit
manual deploy of the qualified integration SHA. Gateway first; LangGraph only
after step 2, since that is where the auth entry takes effect.

## Step 5 — the single hosted C2 lifecycle

One journey, hosted, on the deployed candidate. Not a certification campaign and
not a re-run of the suite: the one lifecycle C2 has always specified.

## Step 6 — authorized handover to Davide

After step 5 and only after it.

## What is NOT in this sequence

Pilot activation. Declaring any account. Cohort changes. Provider obligations.
The fault-injection RPC permissions. Each is separately recorded and none is
implied by completing the six steps above.
