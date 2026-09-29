# R-015 deployed-code admission audit

Read-only source review at `2f5c5173b442199d26f528d2ec7793b3967144a0`. This note contains code facts and diagnostic implications, not a claim that any branch caused the current mobile incident. No tests or production calls were performed by this reviewer. Repository root/backend AGENTS.md were read; checkout was not changed. The exact object was fetched into the existing repository for `git show` reads.

## Scope of the fix actually deployed

- Parent baseline is `e601de54`; functional fix is `2518550c`; `2f5c5173` adds only documentation on top.
- `backend/migrations/2026_09_29_mem00_recorded_source_anchor.sql:83` selects all source rows already referenced by a same-owner intake receipt. The session lock is shared with source intake, making that protected set stable during replacement.
- At lines 103–120 snapshot copies of recorded row IDs or recorded message IDs are ignored; other rows are resequenced around reserved recorded sequences. At lines 150 and 167 recorded rows are excluded from UPDATE and DELETE.
- This protects a current source version from later browser transcript flushes; it does **not** repair any row already mismatched with an old receipt. The migration explicitly says no existing row, receipt, trigger or version is modified (line 30).
- Lines 219–239 add the service-role-only by-message receipt lookup used by interrupted-entry recovery. Python implementation is `backend/packages/harness/deerflow/sophia/memory_governance/store.py:570`.
- PR #165 keeps all owner, source, epoch, retained-context and child-handoff gates. Frontend changes improve classification of a refused run; they do not make an otherwise forbidden run succeed.

## Failure boundary map

1. Browser captures speech and invokes its Builder tool bridge. The screenshot alone does not establish that this occurred.
2. Browser records a governed source action through gateway; gateway returns an immutable receipt.
3. Web chat route requests a companion run; LangGraph auth `create_run` (langgraph_auth.py:450) validates source and mints the input proof.
4. Companion `before_agent` calls `MemoryContextGuard.enter` (memory_context.py:177), rechecks source and retained context before model/tool use.
5. Admitted companion calls `start_builder_task`; governed tool path routes to `_start_independent_builder_task` (start_builder_task.py:2486,2556).
6. Source-only handoff and fresh child allocation go through `dispatch_independent_builder` (builder_provenance.py:63); child auth binds the run; child entry independently verifies it.
7. Builder runs and produces artifact/progress. A failure earlier in this chain cannot be explained as merely a missing progress panel.

All paths below are under `backend/packages/harness/deerflow/` unless otherwise stated.

## `memory_admission_denied`: what its fields mean

`sophia/langgraph_auth.py:62–86` emits one warning with event_name `memory.admission.denied`, a fixed `stage`, and keyed context/run references. When supplied an exception, it also emits `error_type` and safe `denial_reason`. It always returns HTTP 403 `sophia_access_denied`; the HTTP body alone cannot identify the gate.

| Stage | Source line | Meaning |
|---|---:|---|
| voice_lab_permission | 453 | Voice Lab thread-only credential tried to start a run |
| maintenance_permission | 458 | Retention maintenance credential tried to start a run |
| synthetic_assistant | 467 | Synthetic owner tried another assistant |
| kwargs_shape | 471 | Runtime kwargs is not an object |
| config_shape | 474 | Config is not an object |
| configurable_shape | 477 | Configurable is not an object |
| configurable_owner | 479 | Config user_id differs from authenticated owner |
| auth_user | 483 | Server-injected langgraph_auth_user_id differs from authenticated owner |
| context_owner | 489 | Invalid context or its owner differs |
| thread_id_invalid | 495 | Invalid UUID thread id |
| thread_id_mismatch | 498 | Thread differs between request and config/context |
| handoff_in_context | 511 | Builder handoff placed on disallowed context surface |
| disabled_carrier | 523 | Deferred completion/resume/source-attachment carrier was supplied |
| command_present | 544 | Governed run contains a command payload |
| builder_scope | 549 | Handoff has wrong assistant, source action/session simultaneously, or active parent-owner mismatch |
| companion_scope | 568 | No handoff, but graph is not companion or an active governed-tool context exists |
| handoff_not_governed | 575 | Handoff supplied for an owner not resolved as governed |
| admission | 580 | Exception inside owner lookup, source proof, child binding, independent runtime seed, or run UUID normalization |

Direct stage branches intentionally have **no** denial_reason. Record it as absent rather than inventing a value. Only stage=admission wraps an exception and adds a reason.

Important observation limits: `_reject_owner_metadata` and `_owner` can still call plain `_deny`; bearer/service authentication happens before create_run; deck-quality has separate checks. Absence of this warning does not prove admission succeeded. The whole logging body catches failures: an invalid/missing reference HMAC secret can itself prevent keyed refs from being built and suppress the log (lines 69–85).

## Source-proof reasons and the next discriminating check

`sophia/memory_governance/input_provenance.py:104–121` accepts only a source action that validates, a valid run/thread UUID, a plain final user input, and exact equality between submitted text and recorded action text.

| Safe reason | Code location | Meaning / read-only evidence |
|---|---|---|
| authenticated_input_fields_invalid | input_provenance.py:48 | Input keys are not exactly messages |
| authenticated_input_messages_invalid | :50 | Messages is empty/non-list |
| authenticated_input_role_invalid | :54 | Final message is not user/human |
| authenticated_input_message_fields_invalid | :56 | Final message has unsupported fields |
| recorded_input_transform_unproven | :115 | Submitted current text differs from source action after permitted normalization |
| ValidationError | :109 or source models | Malformed/missing source action or returned receipt/snapshot; safe logging hides raw invalid values |
| thread | source_input_provenance.py:123 | Source action thread differs from requested thread |
| source_not_recorded | :126 | Command lookup returned no receipt |
| action_changed | :129 | Receipt owner/session/thread/message/epoch/content-ref tuple differs from current action |
| scope | :89 | Witness owner/thread differs |
| original_receipt | :92 | Lookup receipt is absent or differs from the witness |
| source_scope_or_epoch | :95 | Snapshot owner/session/thread/clear epoch differs |
| source_missing | :98 | No unique source occurrence matches message id |
| source_before_clear / source_accepted_version_changed / source_acceptance_unproven | :101 | Current source is ineligible |
| source_sequence_changed | :103 | Receipt sequence differs from current row |
| source_version_changed | :105 | Receipt version differs from current row |
| source_epoch_changed | :107 | Current row acceptance epoch differs |
| source_acceptance_changed | :113 | Acceptance stamp no longer proves receipt version (with explicit epoch-zero exception) |

Q1 version_equal/sequence_equal proves two joins only. It does not establish content-HMAC parity, correct action session/thread/epoch, current source eligibility, exact wire-input mapping, complete snapshot validity, retained checkpoint proof, child handoff, or final model permission.

For `action_changed` with Q1 equal: gateway intake computes content_ref in `source_intake.py:162`; LangGraph recomputes it in `source_input_provenance.py:130`. Check gateway/LangGraph `SOPHIA_MEMORY_REFERENCE_HMAC_SECRET` equality without exposing values, then privately compare the other tuple fields as booleans. `refs.py:15–17` requires at least 32 bytes. A changed secret does not rewrite existing receipts.

Store `_request` (`store.py:114–138`) deliberately collapses HTTP failures to `governance_http_4xx` or `governance_http_5xx`; 409/412 become `governance_revision_conflict`, connection failure becomes `governance_transport_error`. A generic governance_http_4xx is insufficient to say “wrong API key”: it can also be missing RPC/grants, database precondition, malformed call or partition failure. Use read-only RPC/error metadata, not owner content, to discriminate.

Source snapshot SQL (`backend/migrations/2026_09_09_mem00_c1_epoch_source_target.sql:16–40`) rejects a missing/different session thread, wrong session status, synthetic/fenced session, duplicate message IDs or sequences, nonpositive sequences, future acceptance epochs, or visible transcript rows attached to another thread. The new snapshot replacement fixes recorded-row mutation; it is not a bypass for these whole-session checks.

## Companion entry can fail after HTTP run creation succeeds

`agents/sophia_agent/middlewares/memory_context.py:321–357` emits `memory.context.entry_denied` with `error_type`, `denial_reason`, and `denied_at_line`. Its constant safe_reason_code remains `memory_context_rotation_required`; that alone is a policy label, not the underlying cause.

- Line 207: governed_runtime_read disabled for owner; 209: missing/mismatched authenticated identity or thread; 211: deferred resume requested.
- Lines 214–229: child handoff wrong scope/input-proof state, unverifiable binding, failed source recheck, nonempty old sandbox, or failed zero-memory retained admission.
- Lines 237–250: companion input proof fails, wrong proof schema, invalid source witness, or current source recheck fails.
- Lines 252–266: previous checkpoint/history must be proved. `checkpoint_source_history` is called at 256; record the safe nested reason.
- Lines 275–305: fresh/continued context must have a safe native surface and current retained admission; recovery is narrowly bounded.
- `_empty_native_surface` line 174 rejects any symlink, unexpected file, or nonempty sandbox work/uploads/outputs directory when the context is supposed to be fresh. This can fail despite equal source receipts.
- `_readmit` line 157 checks the governed-read flag; lines 159–165 require transition=continue and no personal-memory inclusions for builder scope.

`pending_input_recovery.py:31–98` can recover only exact appended plain user inputs whose immutable receipts still prove them. Its named reasons include unsealed_nonmessage_state, no_exact_appended_suffix, old_whole_state_changed, pending_bound, not_plain_user_input, pending_source_order_or_scope, pending_source_text_changed, pending_message_metadata, and memory_source_receipt_not_found. A repeated test on an older broken thread can therefore remain blocked after successful migration.

## Builder launch evidence and remaining observability gap

- In `start_builder_task.py:2489`, a governed independent launch refuses edit_existing_artifact, wrong tool name, owner mismatch, or wrong parent thread. At 2494 an already-tracked active task prevents a new launch.
- At 2497–2500 every exception from independent dispatch is converted to a fixed “unconfirmed” tool result; there is **no exception log at this catch**. A visible start_builder_task tool call does not prove child allocation.
- `builder_provenance.py:80` deterministically derives child identity from parent run + tool_call_id. Handoff registration precedes child-thread creation (81–82); source and zero-memory admission must be proved first.
- At 103 child-thread creation may fail; at 111 child-run creation may fail. Both paths fall back to read-only observation; they do not automatically create a second run.
- `observe` at 87–99 verifies durable binding, native run id/thread/status, and parent guard. It swallows all exceptions into status=unconfirmed. Native successful creation can therefore exist even if response confirmation fails.
- Child create_run can emit memory_admission_denied at the child keyed context/run; child before_agent can emit memory.context.entry_denied. Correlate parent and child separately.
- `builder_source_binding.py:130–198` derives actual task machinery from the original current human source, not model-authored enrichment. The Markdown source maps to document with .md extension. This is intentional source-only policy; a spoken correction lacking a complete standalone brief needs careful functional validation.

## Coverage and limits

`backend/tests/test_mem00_recorded_source_anchor.py` covers existence of reachable store methods, exact RPC wiring/missing-receipt handling (74–96), pending intact/rewritten/missing sources (110–162), safe logging including nested causes (126–154), create_run refusal and successful-no-denial (186–227), and migration shape/grants (230–243). The real PostgreSQL contract at 246 is skipped unless a disposable local DB URL is configured; these test definitions do not establish that CI executed it.

`backend/tests/mem00_recorded_source_anchor_contract.sql` covers stale snapshot conflicts, recorded-row rewrite/omission/ID collision protection, sequence uniqueness, snapshot eligibility, second intake, by-message scope, plain-session semantics, and session deletion. It does not replace a deployed-browser + real gateway + real LangGraph + provider integration test.

## Ranked diagnostic branches, pending live evidence

1. Identify the earliest observed request/event: no bridge/source action suggests the frontend transcript/tool path; source recorded plus create_run 403 suggests auth/source admission; companion trace plus entry_denied suggests retained-context/source gate; start_builder_task without child success suggests handoff/allocation/observation; child running then error suggests Builder execution.
2. If new mobile session is not proved, historical receipt/checkpoint damage remains plausible because migration never repairs it. Do not retest old forbidden threads or rewrite their data.
3. If Q1 equal and source gate refuses action_changed, parity/action binding is more likely than snapshot rewrite; if governance_http_4xx, inspect precise read-only DB diagnostics and grants.
4. If source and entry gates passed, investigate unconfirmed handoff/child state rather than blaming Mem0 search visibility or WebSocket setup without evidence.

No specific production cause is confirmed by this source-only review. The mobile screenshot's active Gemini WebSocket/relay is compatible with a separate Builder admission failure and does not prove successful normalized-transcript or tool-bridge delivery.

## Follow-up: health route and safe evidence queries

At this commit `render.yaml:20` sets LangGraph healthCheckPath to `/ok`; `/ready` is the gateway/voice route. `backend/langgraph.json` mounts `deerflow.sophia.deck_design_lift.http_app:app`; that custom app has `/version` and its internal invocation route (`http_app.py:181–194`), no `/ready`. Public `/ready` returning 401 must not be reported as healthy 200. Use public `/ok` for actual configured LangGraph health, and record the mismatch with the runbook. Signed readiness is read-only `POST /assistants/search` (`langgraph_service_auth.py:88–90`); it is not necessary to seek credentials merely to obtain a public health check.

The investigation coordinator reports a newly created mobile session with final voice rows, zero accepted source receipts, no source-action requests, and no LangGraph thread POST/admission-denial events. If corroborated in the final report, that places this attempt before the source-admission path repaired by PR #165. It makes an unchanged source-version admission failure an unsupported explanation for this particular attempt.

Safe SQL count patterns for the relevant thread (substitute only its allowed thread id):

```sql
SELECT count(*) AS artifact_records,
       count(*) FILTER (WHERE source='builder') AS builder_artifacts
FROM public.artifact_registry_records
WHERE thread_id = '<thread-id>' OR parent_thread_id = '<thread-id>';

SELECT count(*) AS build_records
FROM public.sophia_build_registry
WHERE owner_thread_id = '<thread-id>';

SELECT count(*) FILTER (
         WHERE builder_source_receipt->>'schema'='mem00.builder-source-handoff-receipt.v1'
       ) AS handoff_receipts,
       count(*) FILTER (
         WHERE builder_source_receipt->>'schema'='mem00.builder-source-run.v1'
       ) AS child_run_bindings
FROM public.sophia_memory_governance_events
WHERE builder_source_receipt->>'parent_thread_id' = '<thread-id>'
   OR builder_source_receipt->'request'->>'parent_thread_id' = '<thread-id>';
```

`async_tasks` lives in LangGraph checkpoint state, not a Supabase task table (`backend/app/gateway/routers/builder_canvas.py:136–150`). Do not call a zero registry count “async_tasks=0”. A read-only schema check may identify `checkpoints`, and a count of rows by thread can prove absence of checkpoints in that database, but does not by itself prove absence from LangGraph runtime thread metadata. Do not read checkpoint payloads/blobs: they can contain message content.
