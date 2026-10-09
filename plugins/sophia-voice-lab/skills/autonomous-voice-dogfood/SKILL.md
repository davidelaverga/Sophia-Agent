---
name: autonomous-voice-dogfood
description: Run governed autonomous Sophia production voice dogfood through the installed Sophia Voice Lab MCP tools, adapt utterances from observations, classify harness and product outcomes separately, and export evidence. Use for Sophia voice smoke, regression, barge-in, reconnect, Builder lifecycle, finalization, or evidence requests.
---

# Autonomous Sophia voice dogfood

Use only the Sophia Voice Lab MCP tools for live test control. Do not use raw browser JavaScript, repository-local runner commands, direct Gemini/backend calls, a human microphone, or text-message substitution.

Before acting, read `references/tool-contracts.md` and the relevant scenario in `references/scenario-catalog.md`. Read `references/evidence-interpretation.md` before assigning a verdict. Use `references/recovery.md` when any operation is not successful.
For V-P01, also read `references/p01-asynchronous-flow.md` before the first call; it defines the bounded asynchronous observation contract.
For a Studio LiveKit G7 deployment (`get_capabilities` returns a `studio_g7` block), follow the Studio G7 flow below and `V-G07` in the scenario catalog instead of the default flow.

## Default bounded flow

1. Call `get_capabilities`. Confirm the requested environment, scenario version, deployment policy, capture policy, and fault scopes are supported.
2. Resolve the exact deployed frontend, Gateway, and Voice identities from the capability result or a prior trusted deployment record. Never guess a SHA.
3. Call `start_voice_run` with the exact expected identities and a fresh stable idempotency key. Stop this run if the observed target differs. Require the exact start operation's successful product-ready receipt before speaking; V-P01 uses the bounded observation rules in its reference.
4. Call `speak` with one bounded utterance. Its success proves only page-side audio scheduling; it does not prove PCM emission, provider transcription, product acceptance, or playback.
5. Call `wait_for_turn` from the returned event cursor for the declared observation. Inspect the structured channels rather than relying on prose.
6. Select each follow-up only after reading the preceding Sophia observation. For V-P01, call six must pass the one `sophia_voice_lab_observation_receipt_v1` returned by call five unchanged under `adaptive_observation.receipt`, add only a separate `followup_intent`, and cite the returned current cursor, provider epoch, and turn as strict preconditions. Never construct, edit, or reuse the receipt. Perform one receipt-bound follow-up and one bounded wait for its result (two speech turns total). Run the separate V-A01 recipe when the full six-turn adaptive scenario is requested.
7. For V-P01, preserve the ten-call semantic spine and use only the bounded startup, speech, assistant-observation and finalization waits defined in `references/p01-asynchronous-flow.md`. A timeout or durable acceptance is not completion.
8. Call `inspect_voice_run` before any conclusion. Join input scheduling/PCM/transcription, provider output, playback realization, product state, exact deployment, and trace status. Treat LangSmith as supplemental and fail-open.
9. If requested and authorized, use `barge_in` only relative to an observed playback receipt, and `force_socket_rotation` only with the current provider epoch returned by the run.
10. Always call `end_voice_run`, even after a product failure. Wait for bounded finalization and cleanup evidence.
11. Call `export_voice_evidence`. Report its durable artifact reference, `harness_verdict`, `product_verdict`, cleanup audit, and every typed unavailable join. For the fresh-plugin scenario, this response may be `pending_external_evidence` until an independent platform controller binds the registered app, install, task, and exact response hash in a later immutable manifest revision; do not spend an eleventh semantic plugin call or claim the pending bundle is already P01-certified. Never turn a product failure into a harness pass or vice versa.

Use stable idempotency keys for retries. A timed-out observing call may be retried from its returned cursor. A mutating retry must reuse the original key; never invent a new key merely because a response was lost.

## Studio G7 flow (`studio-livekit-g7-v1` deployments only)

1. Call `get_capabilities`; require the `studio_g7` block, its pinned Studio/API/bridge commits, `lab_schema.version` 7 and the three Studio tools. Legacy tools (`start_voice_run`, `speak`, `barge_in`, `force_socket_rotation`) answer `unsupported_for_target` here.
2. Call `start_studio_g7_run` with a fresh idempotency key. Hand `data.run_binding.run_binding_sha256` to the operator, who alone makes the product grant; never create, approve or revoke a grant yourself. The start waits (bounded) for a grant-bound microphone receipt before it opens an exchange.
3. Perform the episode in order, one operation per step: `studio_g7_voice_step` `create` (ask for the HTML page by voice) and `steer`; `studio_g7_action` `leave_and_return`, `section_revision` (with an `instruction`, optional `sections`), `stale_edit`; `studio_g7_voice_step` `hold`, `resume`, `stop`, each followed by `studio_g7_action` `observe` with `for_step` (and a bounded `wait_ms`); then `studio_g7_action` `withdrawal` (it forgets only a note bound to this run's own exchange; pass `entry_id` when there is more than one).
4. A step runs at most once per run: retry a lost response only with the same idempotency key. A new key for a step that is in flight or already performed is refused (`STUDIO_G7_STEP_IN_FLIGHT`, `STUDIO_G7_STEP_ALREADY_PERFORMED`). An action that answers `performed: false` with a typed reason (for example `no_superseded_version`) may be retried with a new key after its precondition holds.
5. Call `end_voice_run`, then `export_voice_evidence`. Report `studio_g7.steps`, the separate harness and product verdicts, `cleanup` (including `ownership`), and every `uncertain` or `unavailable` item as such. A voice-step outcome is certified only from the exchange's calls: in the step's own `?after=<baseline readAt>` window, every call answered at the step's input epoch and exactly one command of the step's kind and expected outcome on the created task's goal (never by actor, time or a task seen elsewhere). Report anything else as the evaluation types it (`uncertain`, `fail` or `unavailable`), never as a pass. A run may show `pending_external_evidence` while late bridge receipts are re-read; do not start another run to force it.

The Lab never requests End for an exchange it cannot prove is its own, and requests it only as the id-bound API End of that exchange (never the room's End button). Leaving the room and closing its own browser are not ownership-gated. It retains no transcript and no audio, and its fake-Studio tests prove no LiveKit packet flow; say so when it matters to a verdict.

## Hard aborts

End and preserve the run when the service reports deployment mismatch, wrong principal, unsupported origin, physical-microphone fallback, silent/disconnected synthetic input, unrecoverable capture gap, cross-principal/task correlation, unauthorized raw audio, exhausted limits, compromised authentication, or browser-worker loss. Do not bypass an abort locally.

Only repair VT00 harness, authorization, observability, evidence, plugin, or cleanup defects within this workflow. Preserve out-of-scope Sophia behavior as a reproducible product-failure bundle for its owning mission.
