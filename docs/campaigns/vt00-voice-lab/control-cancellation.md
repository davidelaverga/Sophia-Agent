# Voice Lab control cancellation

Status: `CLOSED DEPLOYMENT GREEN — d8ad61b303b5df8df262dad46d51782353741761`

Falsifiable hypothesis: a Voice Lab control authorization belongs only to the
mounted page instance that requested it. Unmounting that page aborts the
bodyless authorization request. A response that settles after unmount, including
one whose JSON receipt was already being parsed, must produce neither an
`authorized-action` capture event nor an invocation of the visible Sophia
control callback.

The cancellation boundary does not add a second product action, synthetic-only
callback, browser locator, DOM activation path, provider call, text shortcut, or
retry. A later independently mounted page may make its own request and remains
subject to the same exact server authorization and once-per-document rule.

Focused hook tests hold the fetch and receipt promises open across unmount, prove
the request signal is aborted, release valid stale receipts, and require zero
capture publication and zero callback invocation. The full frontend and Voice
Lab suites must remain green before publication, followed by a closed exact-
candidate deployment assertion with one settled worker and zero active runs. The
exact candidate was deployed on all six components and that assertion passed
with every mutation gate closed.
