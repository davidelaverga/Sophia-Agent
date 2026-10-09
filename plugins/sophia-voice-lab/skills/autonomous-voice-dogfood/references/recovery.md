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

Studio G7 runs: the Lab never requests End for an exchange it cannot prove is the run's own (and ends a proven one only through its id-bound API End); recovery re-verifies it read-only with backoff until it is not live (the product guard ends it at its deadline). A snapshot without a well-formed room presence is typed unknown, not "no exchange". A dead worker's Studio lease (owner heartbeat stale beyond a 60 s clock-skew margin) is released at once when that worker's own cleanup for the lease epoch is durable (browser closed, global sign-out, exchange ended after its join); otherwise only after an API-only recovery, a global sign-out confirmed after the lease expired, the access-token lifetime (raised to any longer lifetime the product issued) and a fresh not-live verification. Until then the run's cleanup, and admission of the next run, stay pending. Evidence completion revokes only its own fresh session, never the principal globally. Report these as typed pending states, not failures to work around.
