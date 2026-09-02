# Voice Lab browser storage isolation

Status: `CLOSED DEPLOYMENT GREEN — 81e3da1641f1e3ae2edc56a7dc693915184ebe62`

Falsifiable hypothesis: a production Voice Lab run can establish the dedicated
synthetic principal and the ordinary Sophia voice session without importing any
cookie, Local Storage, Session Storage, or prior product state from another
browser context. Every run must begin with a new empty-origin Chromium context;
the exact server-issued grant response is the only source of its Better Auth
session authority.

The worker no longer accepts the legacy encrypted storage-state environment
variables, decrypts browser state, filters inherited session keys, reads session
keys from a renderer, or creates a replacement context carrying captured state.
It creates the run context with only service workers blocked, exchanges the
run-bound grant through that same context, and then loads the ordinary deployed
Sophia application. A configured legacy storage ciphertext or key is ignored
because neither value exists in the runtime configuration contract.

The focused contract test proves the obsolete environment names do not enter the
parsed configuration. Type checking and the affected browser, real-media,
disposable-process, and execution-epoch suites must pass before publication.
Production gates remain closed until the exact candidate is deployed and aggregate
readiness again reports all exact component identities, one settled worker, zero
active runs, and every mutation and execution gate closed.

The exact candidate was deployed on every component and aggregate readiness
returned HTTP 200 with all six identities exact, one settled worker, zero active
runs, OAuth and test auth verified, and every product mutation and execution gate
closed before the DOM-activation removal began.
