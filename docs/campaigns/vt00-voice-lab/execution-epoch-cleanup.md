# Voice Lab execution-epoch terminal cleanup

Status: `IMPLEMENTED — CLOSED DEPLOYMENT ASSERTION REQUIRED`

Falsifiable hypothesis: a run that allocated a disposable Chromium process cannot
release its browser lease, enter final evidence settlement, or certify cleanup
until durable evidence joins one process acquisition, one worker/lease acquisition,
provider and auth-session cleanup, and exact process death to the same run,
cleanup obligation, and execution epoch.

The ordinary end path records a canonical provider-cleanup receipt only after a
product-authored, run-bound `closed` or `ended` event is observed. It records the
auth cleanup with the same redacted process, browser-boot, and execution-epoch
hashes. Only after those receipts does it close the browser context and owned
Chromium child and record exact context absence, browser disconnection, and child
death. The worker derives a content-free proof over the durable event ordinals and
requires its worker hash and lease epoch to match the lease being CAS-released.

Failure recovery may satisfy provider and auth cleanup after process death only
through the product-owned authoritative recovery receipt. That receipt must follow
the exact process-death event and report live-resource zero plus complete provider,
auth-session, and Builder cleanup. A missing, duplicated, reordered, cross-run,
cross-obligation, cross-process, or cross-epoch receipt leaves the lease held and
emits a typed `cleanup.execution_epoch_unconfirmed` event.

Pre-allocation rejections remain outside this proof because no run Chromium process
exists. Their existing authoritative browser-lease-absent and live-resource-zero
receipts remain mandatory.

Contract tests cover direct cleanup, recovery after process death, reversed recovery,
missing provider cleanup, reversed provider/auth order, duplicated process death,
cross-epoch drift, and the pre-allocation case. Production gates stay closed until
the exact candidate is deployed and aggregate readiness again reports zero active
runs, one settled worker, exact build identity on all components, and every mutation
gate closed.
