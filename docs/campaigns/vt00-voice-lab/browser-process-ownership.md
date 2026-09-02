# Voice Lab disposable browser ownership

Status: `CLOSED DEPLOYMENT GREEN — 0b505c40928fedf6a6ca7bdd5fe874ab64208c26`

Falsifiable hypothesis: every production Voice Lab run owns one newly launched
Chromium server process, one connection to that process, and one execution epoch
bound to the exact run and cleanup obligation. A second run must receive a
different operating-system process and epoch. A concurrent duplicate start,
disconnected browser, or exited child process must fail closed rather than
reconstructing a browser session or continuing a mutation.

The worker launches Chromium with `launchServer`, records the actual child process,
and derives redacted process, boot, and execution-epoch hashes from the process ID,
a per-launch nonce, start time, run ID, and cleanup obligation. Raw process IDs and
the nonce never enter evidence. Readiness probing remains a separate allocation
and cannot become a run browser.

Every run operation revalidates that the connected browser and its exact child are
still active before using the session. Scheduling, socket rotation, continuation,
startup, and cleanup receipts carry the execution-epoch hash. Cancellation,
startup failure, normal finalization, and worker shutdown close the context,
disconnect the browser, wait for the owned child to exit, and may terminate only
that recorded child if graceful close does not settle. Cleanup is successful only
when both the context registry and the run-owned process are proven absent.

Contract tests prove deterministic redacted binding, run/process separation,
active-versus-fenced classification, and rejection of malformed ownership input.
A real Chromium test proves two runs obtain distinct processes and epochs and that
both children exit. The exact candidate was deployed on every component and the
aggregate readiness attestation reported zero active runs, one settled worker,
and every mutation gate closed before the terminal-cleanup repair began.
