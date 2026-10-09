# Voice Lab tool contract

All tools return a versioned common envelope containing `contract_version`, `request_id`, `test_run_id`, `operation_id`, `status`, `event_cursor`, `deployment_identity`, currently known session/thread/provider identifiers, evidence references, warnings, retryability/error class, and `observed_at`. Missing joins are typed; secrets and provider continuation handles are never returned.

## Tools

- `get_capabilities`: read-only server/plugin/scenario/fixture/fault/evidence versions and caller scope.
- `start_voice_run`: validate exact target identities and reserve an isolated authenticated production browser. Required inputs include environment, target, expected frontend/Gateway/Voice identities, capture policy, and idempotency key.
- `speak`: schedule either text-generated speech or an allowlisted fixture. It succeeds only after a page receipt. Retry the same request with the same idempotency key.
- `wait_for_turn`: wait from an event cursor for a declared input transcript, assistant first audio, turn completion, tool/task state, UI projection, or lifecycle condition. A timeout is a typed observation. A satisfied V-P01 assistant-turn wait returns one service-authenticated `sophia_voice_lab_observation_receipt_v1`; pass that object unchanged to the adaptive follow-up.
- `inspect_voice_run`: safe bounded snapshot without mutation.
- `barge_in`: schedule speech relative to an observed output realization. It returns utterance plus interruption/flush handles.
- `force_socket_rotation`: restricted fault operation tied to an expected epoch. It never exposes or accepts a provider resumption handle.
- `end_voice_run`: idempotently request ending through the product path. Durable acceptance or operation success alone does not prove cleanup/evidence completion. For V-P01 use the exact-end `finalization_complete` observation in `p01-asynchronous-flow.md` before export when any finalization prerequisite is missing.
- `export_voice_evidence`: return the durable machine-readable verdict and governed artifact references after browser shutdown or MCP API restart.
- `run_regression_suite`: start a durable asynchronous suite whose child runs remain separately inspectable.
- `get_suite_run`: inspect suite and child states without hiding individual failures.

### Studio LiveKit G7 deployments only

These three tools are registered only when the service runs with `SOPHIA_VOICE_LAB_TARGET_KIND=studio-livekit-g7-v1`; the legacy surface above is unchanged elsewhere.

- `start_studio_g7_run`: reserve a `V-G07` run (`scenario_version` `studio-g7-v1`) against the configured, pinned Studio/API/bridge commits. Returns the non-secret `run_binding.run_binding_sha256` the operator puts in the product grant. Inputs: environment, scenario id/version, optional capture policy (raw audio, video and screenshots stay off), idempotency key.
- `studio_g7_voice_step`: one voice step (`create`, `steer`, `hold`, `resume`, `stop`) as one `speak` operation labelled with its step, through the Studio room's own microphone path. Exactly one of `text` or `fixture_id`. A step runs at most once per run: under a new key an in-flight step answers `STUDIO_G7_STEP_IN_FLIGHT` and a performed one `STUDIO_G7_STEP_ALREADY_PERFORMED` (enforced atomically by the ledger and re-checked by the worker). The legacy `speak`, `barge_in` and `force_socket_rotation` answer `unsupported_for_target` on this kind.
- `studio_g7_action`: one non-voice step as one `studio_action` operation: `leave_and_return`; `section_revision` (`instruction` required, `sections` optional); `stale_edit` (refused by the product as stale is the expected outcome); `withdrawal` (`entry_id` optional; only a note bound to this run's ownership-proven exchange, and only when the preview's whole cascade is the run's own: every version of the note by the principal in this run's exchange, and only decisions the principal proposed by voice, nobody else decided, resting only on those notes; otherwise nothing is sent, `withdrawal_cascade_not_own`); or `observe` (`for_step`, optional `wait_ms`), a read-only outcome read that is not a step and may repeat. Answers `performed`, a typed `status`, and only ids, HTTP statuses, enumerated product codes and hashes.

Mutating calls require an idempotency key. Do not parallelize two speech/fault mutations for one run unless the selected scenario explicitly declares intentional overlap.
