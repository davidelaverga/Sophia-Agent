# Recovery and classification

For each failed gate, preserve the exact run and deployment, classify the failure, state one falsifiable hypothesis, change the smallest relevant layer, verify the new exact deployment, and rerun the same scenario/version. Retain both before and after evidence.

Use these classes:

- `invalid_test`: deployment/authentication/capture/correlation hard abort.
- `failed_harness`: injection, driver, MCP, evidence, cleanup, or plugin defect.
- `product_failure`: validly observed Sophia mismatch.
- `inconclusive_provider`: bounded external provider outage.
- `authorization_failed`: caller or run capability rejected.
- `deployment_mismatch`: observed target differs from expected identity.
- `aborted_driver_restart`: browser worker was lost; do not claim browser reattachment.

An MCP API restart may reattach through the durable ledger. A browser-worker crash is not resumable and must be reported honestly. Always attempt idempotent `end_voice_run` and `export_voice_evidence` after a safe failure. Never repeat a mutating call with a new idempotency key because its first response was lost.
