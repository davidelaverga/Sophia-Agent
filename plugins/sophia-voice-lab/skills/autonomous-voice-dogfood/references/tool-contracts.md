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
- `end_voice_run`: idempotently end through the product path, observe bounded finalization, close the browser, and audit cleanup.
- `export_voice_evidence`: return the durable machine-readable verdict and governed artifact references after browser shutdown or MCP API restart.
- `run_regression_suite`: start a durable asynchronous suite whose child runs remain separately inspectable.
- `get_suite_run`: inspect suite and child states without hiding individual failures.

Mutating calls require an idempotency key. Do not parallelize two speech/fault mutations for one run unless the selected scenario explicitly declares intentional overlap.
