# VT00 Voice Lab threat model

Status: `DRAFT — CONTROL VERIFICATION PENDING`

## Scope and assets

The scope is the private Codex plugin, public authenticated MCP web service, background browser worker, isolated Postgres ledger, short-lived product capability, dedicated synthetic principal, ordinary Sophia web application, and governed evidence artifacts.

Protected assets include production credentials, browser session cookies, capability-signing secrets, provider sessions and spend, canonical Sophia state, user transcripts, raw audio, trace identifiers, evidence integrity, and exact deployment identity.

## Trust boundaries

1. Registered private app to public MCP: OAuth 2.1 authorization code with S256 PKCE, RFC 9728 protected-resource metadata, pinned client metadata/redirect, short-lived scoped access tokens, rotating refresh families, revocation, and HTTPS. A distinct static bearer is diagnostic-only.
2. MCP to Postgres: private Render connection string and caller-scoped durable state.
3. Worker to frontend grant/refresh routes: short-lived signed capability bound to principal, test run, environment, operations, and deployment identity.
4. Browser page to ordinary Sophia/Gemini paths: the product route remains authoritative; the harness only replaces audio-only `getUserMedia` before application startup.
5. Evidence reader to stored artifacts: caller ownership, hash verification, redaction, and retention enforcement.

## Threats, required controls, and current verification

| Threat | Required control | Verification |
|---|---|---|
| Public MCP use by an unauthorized caller | OAuth resource/audience/client/subject/scope validation on every request; durable code/token/replay state; distinct diagnostic and fault bearers; scoped tools/resources | `PENDING` |
| OAuth redirect, code, refresh, or client-assertion abuse | Exact issuer/resource/redirect/client metadata; S256; POST consent with CSRF; atomic consume/rotation/replay revocation; bounded JWT times/JTI; content-free errors | `PENDING` |
| Credential or cookie returned in MCP text/evidence/logs | Key and value redaction; bounded public projections; secret-scanning tests | `PENDING` |
| Confused-deputy use of an ordinary user | Exact dedicated principal binding in every grant and run | `PENDING` |
| Dedicated test principal reaches an ordinary API, provider, memory, project, upload, sharing, or analytics surface | Default-deny frontend `/api` policy from HttpOnly lab context and configured principal; Gateway authenticates before body/route allocation and permits only an immutable method/template Voice-Lab allowlist; unauthenticated mutable/global routes are forbidden | `PENDING` |
| Replay or duplicate provider spend | Run-scoped idempotency keys, canonical request hashes, durable leases | `PENDING` |
| SSRF to an attacker-controlled frontend/backend/voice target | Exact HTTPS origin allowlist; redirect refusal; exact build check before browser creation | `PENDING` |
| General microphone or camera access | Page-init audio-only `getUserMedia` bridge; reject video/non-audio requests | `PENDING` |
| Direct Gemini/text bypass masquerading as product speech | Page-owned WebAudio destination; fixture hash; input scheduled/started/PCM/transcribed chain | `PENDING` |
| Arbitrary socket disruption | Provider-origin allowlist; latest product epoch precondition; separate fault authorization | `PENDING` |
| False playback or continuity claims | Distinct received/scheduled/started/completed/flushed/dropped receipts and restoration proof | `PENDING` |
| Capture overflow or restart evidence loss | Cursor/generation/gap metadata; monotonic durable drains; restart-safe ledger | `PENDING` |
| Cross-run evidence disclosure | Caller ownership checks and non-guessable resource IDs | `PENDING` |
| Raw audio or transcript over-retention | Raw audio off by default; provisional session-created hard ceiling with no overdue finalization extension; finalization-anchored signed per-run retention only before that ceiling; independent local hard-deadline purge; product-owned expiry reaper; one random signed opaque cleanup obligation indexed across every synthetic store; identity-free `prepared` authority retained and alarmed while cleanup is unverified; no completed tombstone before an immediate authoritative cross-store delete/read-zero; final handle deletion/read-zero audit | `PENDING` |
| Synthetic traces enter ordinary analytics or outlive test retention | Exit before LangSmith client/trace allocation for synthetic Voice and Builder paths; emit a bound typed `synthetic_isolation_policy` status; preserve canonical evidence locally | `PENDING` |
| Synthetic browser telemetry enters ordinary product analytics or error reporting | Same-origin server enforcement from the HttpOnly Voice Lab context before every analytics sink, plus a lifecycle-complete client fence for direct Sentry calls; drop or isolate every synthetic event and breadcrumb before, during, and after connection; ordinary telemetry remains unchanged | `PENDING` |
| Provider/session/task orphan after end, process restart, or deployment change | Product-owned expiry reaper with a durable lease; cancellation-safe lease acquisition; progress-guaranteed cursor/quarantine handling for malformed rows; cleanup-only cross-restart/cross-deploy authority; browser lease reaper; exact-run provider/Builder/auth/evidence deletion and authoritative zero audit | `PENDING` |
| Public OAuth or MCP input amplifies durable storage or spend | Bounded transport parsers; authenticated content-free rejection audit; durable per-endpoint quotas; rolling run/provider/audio/suite budgets; periodic expired-row purge independent of new traffic | `PENDING` |
| A stale or hostile database shape is accepted at startup | Immutable migration checksum; empty-or-exact preflight; exact catalog, privilege, and transactional DML postflight; web and worker refuse readiness on drift | `PENDING` |
| The harness self-certifies a restart, response-loss, or plugin-install scenario | A non-MCP attestation lane with an independent key accepts only source-specific, expiring, replay-fenced evidence: deployment/process receipts for restart, immutable client/operation/effect joins for response loss, and platform-authored registered-app/install/fresh-task/call provenance for plugin certification | `PENDING` |
| Deployment drift during a run | Exact preflight identity and final identity recheck | `PENDING` |
| Kill-switch bypass | Fail-closed startup/mutation checks and operator negative test | `PENDING` |

## Misuse cases that must remain impossible

- Supplying an arbitrary production principal, URL, WebSocket origin, fixture path, or browser script.
- Calling Gemini directly, injecting `sendText`, or replacing the ordinary Sophia tool/session/finalization paths.
- Returning cookies, authorization headers, provider resumption handles, hidden reasoning, unrestricted browser logs, or unredacted user content.
- Treating LangSmith as runtime state, a required dependency, or the only evidence of behavior.
- Granting fault scope to an ordinary OAuth or base diagnostic credential, or leaving fault injection enabled outside the bounded campaign window.
- Allowing a normal MCP/OAuth caller, the browser worker, or a generic operator assertion to mint D02, A03, or P01 certification evidence.
- Issuing the dedicated principal a raw backend ticket, or relying on CORS/front-end proxy policy while direct Gateway routes remain reachable.

## Failure posture

Authorization, deployment, capture-integrity, evidence-integrity, and cleanup failures fail closed. Optional LangSmith evidence remains fail-open with a typed unavailable reason. Product defects may be reported with a passing harness verdict only when the harness chain and durable evidence are complete; otherwise the harness verdict is failed or invalid.

## Incident response

1. Engage the Voice Lab and protected product-plane kill switches.
2. Revoke the OAuth token family and diagnostic bearers, then rotate affected OAuth, grant, capability, recovery, or internal-auth secrets if exposure is possible.
3. Stop the worker and enumerate owned browser, product session, provider, task, and lease resources.
4. Preserve redacted durable evidence and hashes; quarantine any raw material.
5. Delete or expire unauthorized artifacts and record the deletion audit.
6. Reopen only after the failed control has a focused negative test and the deployment identities are reverified.
