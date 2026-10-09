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

Studio G7 runs: the Lab never requests End for an exchange it cannot prove is the run's own (and ends a proven one only through its id-bound API End); recovery re-verifies it read-only with backoff until it is not live (the product guard ends it at its deadline). A snapshot without a well-formed room presence is typed unknown, not "no exchange". A dead worker's Studio lease (owner heartbeat stale beyond a 60 s clock-skew margin) is released at once when that worker's own cleanup for the lease epoch is durable (browser closed, global sign-out, exchange ended after its join); otherwise only after an API-only recovery, a global sign-out confirmed after the lease expired, the access-token lifetime (raised to any longer lifetime the product issued) and a fresh not-live verification. That verification also reads the room's live presence: a fresh report with the principal still in the room keeps the lease (`principal_present_in_room`); a stale or missing report, a 422 `not_found` or a 404 (route absent) is `unobservable`, never "gone". Until then the run's cleanup, and admission of the next run, stay pending. Evidence completion revokes only its own fresh session (three local attempts), never the principal globally; an unrevoked one keeps cleanup incomplete until a global sign-out made only once no other run can hold a live principal session (a terminal run with its browser closed never blocks it). A start refused with `STUDIO_GLOBAL_SIGNOUT_PENDING` is retried later with the same idempotency key. An abandoned global sign-out leaves cleanup incomplete until recovery retries it; a run awaiting external evidence stays `pending_external_evidence` meanwhile (never a failure manifest) and is finalized only by the Studio evidence path. The release gates run on the ledger's clock, and Studio API-only recoveries are spaced at least 30 s apart. A Supabase grant whose access-token lifetime exceeds 24 h fails start closed (`STUDIO_AUTH_TOKEN_LIFETIME_UNBOUNDED`). Report these as typed pending states, not failures to work around.
