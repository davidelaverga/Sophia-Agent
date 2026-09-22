# Current qualification — 2026-09-22

Historical E1/E2 and automatic recall evidence is retained below. Do not interpret this as full E3: explicit-tool recall remains unproved. Tin Otter is now forgotten with a historical verified purge receipt; the test preference remains active. E4/E5 actual next-request admission, E6 complete settlement and E7 practical handover are still open. See c3-current-state.md for the reconciled inventory. No new hosted acceptance run during Codex takeover; spend question pending.

---

# MEM00-C3 — first-use proof matrix

Date: 2026-09-20
Owner under test: `CUyZxRFmDNONbR0eKqkJjTrJ2z8nkDKd` (Davide Laverga, verified via better-auth session)
Frontend under test: `dpl_99vszUEXAXnZ5LP68EPKWJ3w843t` (source `a5982c6`, `frontend/` ≡ r8 `3aebc59a`)
Gateway: `3aebc59a` (`srv-d7be5s9r0fns7397l4g0`) · LangGraph: `local_dev` API variant, `langgraph_api_version=0.8.1`
Memory contract: `mem00.v1`, epoch `1`

**Terminal status: NOT `MEMORY_TEXT_PILOT_READY`.** E4 is half-proven; E5–E7 are unattempted. A release-blocking defect is open (D1 below).

## Stage results

| Stage | Result | Evidence |
|---|---|---|
| **E1** source/extraction | ✅ **PASS** | New authenticated text session; 3 candidates extracted with provenance: `extraction_run_id=48d741f5-…` (earlier run) and a second run for the Tin Otter session; `source_manifest_ref = hmac-sha256:transcript-manifest:7cc5b42b…` (a genuine `keyed_ref()` HMAC). Recap surfaced a 3-card review UI. |
| **E2** decisions | ✅ **PASS** | Approved 2, rejected 1 through the browser. Inventory moved `canonical_records` 1→3, `candidate_records` 8→11, `withheld_candidates` 6→9, `reviewable_pending` unchanged at 2. `snapshot_id` advanced `495790…`→`b9b00d61…`. Rejected candidate never became canonical. |
| **E3** positive recall | ✅ **PASS (automatic)** / ⚠️ **explicit retrieval unproven** | In a cold session, without the words "Tin Otter" or "Rust" in the prompt, the model answered *"Tin Otter — a toy scheduling app focused on recurring reminders. You're building it in Rust to learn the language properly."* Provider side: both memories present in Mem0, namespace `sophia-memory-v2-2df20d06afbe4c27ab4b2413bcdeafd9`, lifecycle `Active`. Explicit `retrieve_memories` was invoked (*"I'll pull up your memory on that"*) but its continuation was lost to D1, so the explicit-tool path is **not** evidenced. |
| **E4** edit | ⚠️ **HALF** — edit proven, recall-of-updated-revision **not** proven | Canonical edit confirmed: `14c6a3f8-…` content now "…learn **Go** properly", `content_revision` 1→2, `memory_governance_revision` 1→2; sibling `a9352106-…` untouched at revision 1. **Three subsequent recall attempts produced no model response** (D1), so it is unknown whether admission serves revision 2 and excludes revision 1. |
| **E5** warm revocation | ❌ **NOT ATTEMPTED** | Blocked: a recall test cannot distinguish "memory correctly fenced" from "session bricked by D1". |
| **E6** reload/cleanup | ❌ **NOT ATTEMPTED** | — |
| **E7** real-account handover | ❌ **NOT ATTEMPTED** | Owner is activated and governed, but no bounded practical confirmation has been completed. |

## Supporting evidence proven outside the E-stages

- **Frontend release**: `www.sophia-ei.com` serves `dpl_99vszUEXAXnZ5LP68EPKWJ3w843t`; old `dpl_4TxUxd6Ee…` absent from served assets. Verified by inspecting the served domain, not a dashboard banner.
- **Owner declaration**: `/api/memory/recent` moved from `{"detail":"memory_owner_undeclared"}` to a governed inventory with `owner_id`, `memory_contract_epoch: 1`, `status: available`, `source: sophia_candidate_ledger`, `fallbackApplied: false`.
- **Legacy containment**: 6 pre-existing candidates stayed `withheld` and 2 real pending candidates stayed `reviewable_pending` throughout. No legacy record was approved, imported or deleted. C2 §3 honoured.
- **Truthful indexing status**: Pool reports `projection_status: "unavailable"` with `provider_state_queried: false` — i.e. "not queried", not "not projected". Verified against Mem0, where projection had in fact succeeded. C2 §3's canonical-vs-provider distinction holds.

## Test-record registry

Everything below is synthetic test data created by this mission. The marker word is **"Tin Otter"**.

| ID | Content | State |
|---|---|---|
| `14c6a3f8-dab6-4d50-9e58-3956d90642f4` | Tin Otter side project (edited Rust→Go) | canonical, active, revision 2 |
| `a9352106-8ee7-43aa-8a7b-881f3b613219` | Tin Otter bullet-summary preference | canonical, active, revision 1 |
| (rejected) | "…only on Tuesday evenings…" | rejected at review, never canonical |

Mem0 projections of the two canonical records exist in namespace `sophia-memory-v2-2df20d06afbe4c27ab4b2413bcdeafd9`. **Both remain to be cleaned up** — E6 was not reached.

**NOT mine, not to be touched:** candidates `249e1253-…` and `a0001760-…` from session `f7199e38-…` are Davide's real pending candidates, created when his paused session was ended. Plus 6 pre-existing withheld candidates and 1 pre-existing canonical record.

## Sessions created

| Session | Purpose | Outcome |
|---|---|---|
| `d608616d-21ce-4148-bdaa-318506010104` | E1 attempt 1 | 0 candidates — facts were over-labelled as synthetic and correctly discarded by the extractor |
| `834f5fc6-8b1f-4fb1-8c6e-50b9367962c1` | E1 attempt 2 | 0 candidates — content was trivia not matching the 9 categories |
| (Tin Otter session) | E1 attempt 3 | ✅ 3 candidates |
| (E3 session) | E3 cold recall | ✅ recall proven |
| `f1a7f011-b57e-4b86-841d-ef2cacc95663` | E4 recall-after-edit | ❌ **bricked by D1** — 3 user messages, 0 responses |

## Honest limitations

1. The explicit retrieval tool path is unproven.
2. Recall-after-edit is unproven; the edit itself is proven.
3. No warm-context revocation, cleanup or handover evidence exists.
4. Session `f1a7f011-…` is left in a stuck state and should be closed.
5. Owner-declaration and cohort/flag values were read from operator-reported values and live behaviour, not from direct inspection of Render env (blocked by host permission).
