# Evidence interpretation

Canonical Sophia records and app-authored receipts are authoritative. LangSmith is supplemental and may be typed `trace_unavailable` without erasing canonical evidence.

Keep these channels separate:

- input source manifest and audio hash;
- page scheduling/start/completion/interruption receipts;
- downstream PCM frame receipts;
- provider input transcription and turn acceptance;
- provider output transcription fragments;
- unique provider output chunks/fingerprints;
- playback scheduled/started/completed/flushed/dropped receipts;
- captured output-leg artifact reference, when policy permits;
- tool calls/results/settlements and Builder task/run/control IDs;
- durable transcript/session/task/finalization projections;
- UI assertions and deployment identity before interaction and at export.

An output transcript is not audible realization. Received audio bytes are not playback. A source scheduled in Web Audio is not natural completion. Accept playback only from the explicit realization lifecycle and state the strongest receipt reached.

Every scenario has separate `harness_verdict` and `product_verdict`. The harness passes only when injection, observation, correlation, evidence, authorization, and cleanup worked. Sophia product behavior can fail while the harness passes; preserve and assign that failure rather than weakening the assertion.

## Studio LiveKit G7 (`sophia.voice-qualification.v1`)

- Bridge and guard receipts come from the product's qualification evidence (migration 0046 shape) and page receipts from the Studio room; both are bound by grant id and run binding, and a receipt bound to another run or grant fails the harness. An evidence read refused with 422 `not_found` is `not_answered_to_principal` (not the grant's principal, or no grant covers the exchange); a 404 is `endpoint_not_served` (the route is absent: the product runs without voice qualification), typed unavailable and never read as "not yours" or as proof of ownership or of an end.
- Input is reconciled by window ordinal and envelope only (`pcm_reconciliation: envelope_only`); the Lab's and the bridge's PCM chains are never compared.
- No transcript and no audio is retained, by the Lab or by the product contract: transcript content, output transcription and output audio are `not_supported_by_product_privacy_model`.
- Outcomes of the Lab's own member-API requests (section revision, stale edit, withdrawal) and downloaded artifact bytes (SHA-256 against the declared digests) are canonical. A voice step passes only when the exchange's calls (A15 `GET /api/v1/exchanges/{id}/calls`) show exactly one new command after the step's durable baseline, of the step's kind (`native_task` for create; `steer`, `hold`, `resume`, `stop`) on the created task's goal, not denied, superseded or of unknown outcome, never certified before, with a rising authority epoch and, for hold/resume/stop, the created task's status matching in the step's own observation. A refusal (no command, e.g. a Hold on work already held), another kind or goal, two commands, a call at or below the baseline, or anything seen only in another exchange or from the principal's own request is never a pass; calls the product does not serve (404) or refuses (422 `not_found`) leave the step `unavailable`.
- WebRTC sender stats are corroboration only. The fake-Studio tests' loopback peer proves the published track is the Lab's, not packet flow through LiveKit.
- Cleanup `ownership` is `proven` only from the exchange's evidence naming this run's binding and grant; only then did the Lab request End, and only as the id-bound API End of that exchange. Otherwise the Lab never requested End and the exchange's end is `uncertain` or `unavailable` until observed not live. An end counts only for what was observed after Speak by a member-API read: of the joined exchange, or, with no join, nothing live observed after the run's browser close and a confirmed global sign-out (never a time window); a malformed room snapshot is unknown, never "no live exchange". `cleanup.refresh_session_revoked` fails while an evidence-refresh session could not be revoked; the run cannot certify until a later global sign-out (made only once no other run can hold a live principal session; admission answers `STUDIO_GLOBAL_SIGNOUT_PENDING` while a global sign-out is in flight).
