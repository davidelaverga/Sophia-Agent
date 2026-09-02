---
name: autonomous-voice-dogfood
description: Run governed autonomous Sophia production voice dogfood through the installed Sophia Voice Lab MCP tools, adapt utterances from observations, classify harness and product outcomes separately, and export evidence. Use for Sophia voice smoke, regression, barge-in, reconnect, Builder lifecycle, finalization, or evidence requests.
---

# Autonomous Sophia voice dogfood

Use only the Sophia Voice Lab MCP tools for live test control. Do not use raw browser JavaScript, repository-local runner commands, direct Gemini/backend calls, a human microphone, or text-message substitution.

Before acting, read `references/tool-contracts.md` and the relevant scenario in `references/scenario-catalog.md`. Read `references/evidence-interpretation.md` before assigning a verdict. Use `references/recovery.md` when any operation is not successful.

## Default bounded flow

1. Call `get_capabilities`. Confirm the requested environment, scenario version, deployment policy, capture policy, and fault scopes are supported.
2. Resolve the exact deployed frontend, Gateway, and Voice identities from the capability result or a prior trusted deployment record. Never guess a SHA.
3. Call `start_voice_run` with the exact expected identities and a fresh stable idempotency key. Stop this run if the observed target differs. Use one bounded `wait_for_turn` call to require the product-ready receipt before speaking.
4. Call `speak` with one bounded utterance. Its success proves only page-side audio scheduling; it does not prove PCM emission, provider transcription, product acceptance, or playback.
5. Call `wait_for_turn` from the returned event cursor for the declared observation. Inspect the structured channels rather than relying on prose.
6. Select each follow-up only after reading the preceding Sophia observation. For V-P01, call six must pass the one `sophia_voice_lab_observation_receipt_v1` returned by call five unchanged under `adaptive_observation.receipt`, add only a separate `followup_intent`, and cite the returned current cursor, provider epoch, and turn as strict preconditions. Never construct, edit, or reuse the receipt. Perform one receipt-bound follow-up and one bounded wait for its result (two speech turns total). Run the separate V-A01 recipe when the full six-turn adaptive scenario is requested.
7. For V-P01, preserve the exact ten-call semantic spine. If a `speak` or `end_voice_run` receipt is durable but its operation is not yet `succeeded`, insert only an explicit `wait_for_turn` with `condition: operation_terminal` for that exact operation, `timeout_ms` no greater than 10000, at most ten polls for one operation and twenty total. Keep each poll between its mutation and the next semantic call, stop at the first terminal receipt, and never poll an already-succeeded operation.
8. Call `inspect_voice_run` before any conclusion. Join input scheduling/PCM/transcription, provider output, playback realization, product state, exact deployment, and trace status. Treat LangSmith as supplemental and fail-open.
9. If requested and authorized, use `barge_in` only relative to an observed playback receipt, and `force_socket_rotation` only with the current provider epoch returned by the run.
10. Always call `end_voice_run`, even after a product failure. Wait for bounded finalization and cleanup evidence.
11. Call `export_voice_evidence`. Report its durable artifact reference, `harness_verdict`, `product_verdict`, cleanup audit, and every typed unavailable join. For the fresh-plugin scenario, this response may be `pending_external_evidence` until an independent platform controller binds the registered app, install, task, and exact response hash in a later immutable manifest revision; do not spend an eleventh semantic plugin call or claim the pending bundle is already P01-certified. Never turn a product failure into a harness pass or vice versa.

Use stable idempotency keys for retries. A timed-out observing call may be retried from its returned cursor. A mutating retry must reuse the original key; never invent a new key merely because a response was lost.

## Hard aborts

End and preserve the run when the service reports deployment mismatch, wrong principal, unsupported origin, physical-microphone fallback, silent/disconnected synthetic input, unrecoverable capture gap, cross-principal/task correlation, unauthorized raw audio, exhausted limits, compromised authentication, or browser-worker loss. Do not bypass an abort locally.

Only repair VT00 harness, authorization, observability, evidence, plugin, or cleanup defects within this workflow. Preserve out-of-scope Sophia behavior as a reproducible product-failure bundle for its owning mission.
