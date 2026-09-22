# Fresh hosted D1 evidence — 2026-09-22

Codex submitted exactly one short ordinary text recall request after Davide approved $5 NEW variable spend. Session `19acce9c-c2d3-4e9e-b53b-5f2387d3d42c`; thread `01a0c810-8fa8-7ee3-895e-7cd9b59a64eb`; run `01a0c812-0b05-74a1-9c9d-3056dd839bc1`.

LangGraph logs directly verify deployment 406ff0a6. Run started 07:43:41Z, failed 07:43:59.802Z. Model response was parsed and recorded (tool_call_count=1). Traceback: memory_context.py:786 awrap_model_call AFTER handler returns -> serialized guarded line77 -> check line436. This is the POST-MODEL source/readmission recheck, not before_agent on this run. It had inclusion_count=1, revocation_epoch=5, memory_clear_epoch=0. No new forget or clear occurred during this turn. Correct owner was carried on the model run.

The app streamed a short summary-preference reply, included forgotten synthetic marker Tin Otter, then displayed Connection interrupted. Retry? Both D1 and the forgotten-marker observation are fresh. Actual prompt origin is still unverified; do not declare a canonical leak from output text alone. Need inspect the exact request or retained state by supported authenticated read. Do not weaken completion/source admission.

The Mac locked before this new evidence could be sent through Claude UI. User was asked to unlock. Test session remains open and needs supported End. Do not deploy/restart while its evidence needs capture. One live turn only; actual cost pending.

## Source-path hypothesis (not yet a live row comparison)

After the parsed result, the log shows lookup_source_action and source_snapshot, then check() raises, with no subsequent readmission RPC shown. `recheck_recorded_source` requires the immutable intake witness source_version/sequence to match the current row. `sophia_memory_source_version_trigger` rotates on ANY row-field change. `useSessionStreamPersistence.ts` has no governed/source-intake branch; its legacy snapshot path can change created_at, sequence, final or metadata through `sophia_replace_session_messages`. `useSessionSendActions.ts` already suppresses legacy parent touch for sourceIntent, but this separate stream-persistence path remains. Compare the current accepted receipt to its current source row in the fresh test session before changing anything. Do not weaken the source-version trigger or ignore mismatches.
