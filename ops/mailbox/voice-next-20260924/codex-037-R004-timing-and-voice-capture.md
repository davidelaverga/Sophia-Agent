# codex-037 — R-004 timing test and ordinary voice capture
2026-09-26; Mem0 20:50–20:55 UTC; voice evidence collected by 21:36 UTC. No deploy/config/product-code changes or Lab admission/run; A-014b unchanged.
## V1 — Chrome Incognito, frontend 12ce0f89
Davide opened DevTools and performed the single mic attempt; Console/Network Keep log enabled. An idle setup session was ended before capture; no second mic attempt.
Two recorded POST …/voice/connect requests: HTTP 200. Inspected normal response: preconnect=false, synthetic_test=null; detail/code fields absent.
provider_cleanup_token and provider_cleanup_expires_at are both present as null. No credential values are included here.
Network filter generativelanguage.googleapis.com: 0 / 61 requests; no Google WS created. HTTP handshake status, close code/reason and first server message: N/A.
Main UI remains “Sophia — Ready when you are”; telemetry says “Voice runtime failed”, stage=error, WSS=closed, relay=disconnected, no mic signal.
Exact telemetry error: “Gemini browser Live session bootstrap exposed provider cleanup authority outside the synthetic lane.”
Console distinct warning text: [builder-canvas] snapshot-response; snapshot-hydrated; builderSnapshotEmptyPassive; sse-error; sse-timeout-reconnect; sse-open; hook-start; [app-version] freshness check.
Console error text: “Failed to load resource: the server responded with a status of 404 ()”; POST /api/voice-lab/control/session-start and /voice-start 404 (Not Found).
Also retained from setup/session teardown: “Failed to load resource: the server responded with a status of 409 ()”; PATCH /api/sessions/[id] 409 (Conflict). These are not the bootstrap rejection.
The 404s are automatic denied page-hook probes, not authorized Lab actions. The voice rejection is visible in telemetry, not a separate observed Console exception.
Code path at 12ce0f89: useStreamVoiceSession.ts startTalking L3143 → connect call L3350 → gemini-browser-live-websocket-dogfood.ts wrapper L4412 → connect L1868 → bootstrap parsing L3222/L5483.
First failure: readGeminiProviderCleanupAuthority L5308–5310 tests !== undefined; null satisfies that test and throws on an ordinary session. startTalking catch L4514–4522 records the failure.
getUserMedia L3496, setupComplete L4254, and startMicrophoneAudioPipeline L4257/L8300 are not reached. This failure precedes microphone permission and the resampler.
Captured session ended: POST /api/sophia/end-session HTTP 202; End disabled afterward.
## M1 — one disposable provider record, gateway key, configured org/project
Synthetic owner sophia-r004-disposable-76175a80f6e9491380c75003692905db; memory ID 09cb7f16-fe81-4e11-84a6-bc685a850967.
Exactly one add: HTTP 200, infer=false, async_mode=false, output_format=v1.1; ADD result with memory ID, no event ID or queued indication.
Immediate GET completed +1.229s: HTTP 200; all 8 metadata keys present/equal, none missing/different.
Keys: environment, sophia_managed, memory_contract_epoch, canonical_revision, canonical_memory_id, memory_governance_revision, projection_operation_id, provider_namespace.
| Target / actual search start after add response | Search HTTP / hits | Exact-ID GET metadata |
|---|---|---|
| 0s / 1.230s (after immediate GET) | 200 / 0 | 200; complete |
| 30s / 30.002s | 200 / 0 | 200; complete |
| 60s / 60.003s | 200 / 0 | 200; complete |
| 120s / 120.005s | 200 / 0 | 200; complete |
| 300s / 300.005s | 200 / 0 | 200; complete |
No search hit exists whose metadata can be assessed; “complete” above is exact-ID readback. Identical query/owner/scope throughout.
Cleanup: DELETE 200, subsequent exact-ID GET 404, search 200 / 0. Disposable record gone.
Deployed project_revision (mem0_projection_adapter.py L181–214) adds with infer=false/async_mode=false, then immediately GETs and compares metadata. It waits 0 configured seconds, has no readback polling, and does not verify search visibility.
## Ranked causes, exact proposed changes and rollbacks — NOT APPLIED
Voice #1 confirmed: null-versus-absent bootstrap contract mismatch, not a Google/mic/resampler failure. Proposed frontend change at L5309: reject only token != null || cleanupExpiresAt != null; keep synthetic validation and rejection of every non-null ordinary authority unchanged.
Voice validation required before deployment: ordinary missing/null fields pass; either non-null field rejects; synthetic malformed authority still rejects. Rollback: revert that patch / restore frontend 12ce0f89.
Recall #1: new-write search visibility/provider search behavior, reproduced through 300s despite complete GET metadata; provider-side mechanism unresolved. #2: R-002 restore metadata mismatch remains separate/unreproduced. #3: key-scope mismatch weakened by R-003 parity.
Proposed recall mitigation: retain returned IDs, verify exact metadata plus same-owner search visibility before marking projection ready; schedule existing-ID checks at 0/30/60/120/300s, then reconciliation_hold if absent; never re-add merely to wait. Add field-name-only mismatch receipts; preserve fail-closed checks.
This detects/contains the failure, not a proven repair of Mem0 indexing. Rollback: revert those adapter/worker changes and restore gateway eb849b62 / LangGraph def5c454 for whichever services received them; no config/schema changes. STOP for approval.
