# Voice Lab DOM activation isolation

Status: `CLOSED DEPLOYMENT GREEN — b9fafffe575fa39a5f29ff22d9811e449eb4e067`

Falsifiable hypothesis: the production Voice Lab startup path can activate the
ordinary Sophia session and voice callbacks only through the server-authorized,
default-disabled control adapter. The injected browser harness must contain no
MutationObserver, button discovery, accessible-label matching, native button
click, per-document activation arm, or worker-facing arm token that could become
an alternate activation path or fallback.

The init-script contract no longer accepts a start-button name or activation
token. Its private bridge exposes only governed media scheduling, socket rotation,
and observation drain operations. The worker no longer contains an activation-arm
renderer command or a receipt wait for that path. Startup still requires both
exact control-adapter receipts plus the page-owned synthetic stream, ordinary
getUserMedia acquisition, product credentials, provider epoch, and streaming
receipts before it can become ready.

Contract tests inspect the emitted init script and reject any reintroduction of
MutationObserver, button enumeration/click, activation arms, or activation-token
material. The affected browser-init, real-media, driver, process-ownership, and
execution-epoch suites plus the full Voice Lab suite must pass before publication.
Production gates remain closed until the exact candidate is deployed and aggregate
readiness again proves exact identities, one settled worker, zero active runs, and
every mutation and execution gate closed.
