# Voice Lab control adapter

Status: `IMPLEMENTED — CLOSED DEPLOYMENT ASSERTION REQUIRED`

Falsifiable hypothesis: when the dedicated synthetic principal holds one valid,
short-lived, exact run-bound capability and every required product gate is open,
the server can authorize Sophia's existing dashboard session-start callback and
existing session voice-start callback without a dashboard locator, DOM click,
MutationObserver activation, direct provider call, or text shortcut. With the
adapter flag absent or false, an ordinary principal, a missing or malformed
capability, a cross-run binding, a changed scenario, cleanup obligation, or
deployment identity, an expired epoch, a request body, or an unknown action must
produce no product action.

`SOPHIA_VOICE_LAB_CONTROL_ADAPTER_ENABLED` is an independent, default-false
frontend gate. The adapter endpoint accepts only bodyless POSTs for the two fixed
actions. It verifies the dedicated Better Auth principal, the HttpOnly Gateway
capability, the independently signed run-binding cookie, the current frontend
build, and the exact run/scenario/deployment/cleanup tuple. Its short-lived
control epoch is derived from the signed grant epoch and the fixed action. The
browser receives no credential or reusable authority.

The client hook treats every non-200 or malformed receipt as absence and invokes
only the existing product callback, once per mounted document. The Voice Lab
worker observes both exact-origin authorization responses and requires both
receipts together with the existing page-owned MediaStream, ordinary
`getUserMedia`, product credentials, provider epoch, and streaming receipts before
startup can become ready. The canonical start path therefore waits for the
server-authorized product actions and contains no DOM fallback.

Focused frontend authorization, negative-path, middleware, dashboard, and session
tests plus Voice Lab browser/media contract tests must pass before publication.
The next independent candidate owns disposable Chromium process identity and
effect fencing; this adapter is not a browser, voice runtime, provider authority,
or product mutation implementation.
