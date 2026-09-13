# Voice Lab control cancellation

Historical status: `CLOSED DEPLOYMENT GREEN — d8ad61b303b5df8df262dad46d51782353741761`

## C4 reconciliation (2026-09-13; local, not deployed)

The historical per-mount abort contract below is not the current implementation.
Later revisions share an in-flight authorization across same-document remounts
and claim each server control epoch once. Unmounted consumers do not invoke;
the current mounted consumer may accept a still-valid response. Therefore the
historical abort-signal proof cannot certify the current request-ownership model.

C4 preserves that shared-request behavior while fixing expired resolved receipts:
expiry evicts the cache entry, requires a new server decision, and is checked
again before capture publication and control invocation. The owning hook tests
exercise both denial and renewed authorization after expiry, while retaining
valid readiness-flap/remount and exact-once cases. This is not a proof of all
cross-principal/navigation ownership or provider-resource cleanup boundaries.

Delayed callback results now use a mounted action-owner fence. After invocation,
an unmount or action replacement prevents completion/failure capture from the
obsolete callback. A readiness pause alone does not revoke a started action's
result authority. Focused tests cover delayed success and failure for each of
those three boundaries and require exactly one invocation. They are hook-level
causal proofs, not the twenty complete fresh-process built-Sophia journeys.

## Historical per-mount cancellation contract

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
