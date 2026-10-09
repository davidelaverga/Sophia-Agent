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

- Bridge and guard receipts come from the product's qualification evidence (migration 0046 shape) and page receipts from the Studio room; both are bound by grant id and run binding, and a receipt bound to another run or grant fails the harness.
- Input is reconciled by window ordinal and envelope only (`pcm_reconciliation: envelope_only`); the Lab's and the bridge's PCM chains are never compared.
- No transcript and no audio is retained, by the Lab or by the product contract: transcript content, output transcription and output audio are `not_supported_by_product_privacy_model`.
- Outcomes of the Lab's own member-API requests (section revision, stale edit, withdrawal) and downloaded artifact bytes (SHA-256 against the declared digests) are canonical. A voice step's effect on a native task is `uncertain`: the product exposes no exchange binding on native tasks, so the join is by actor and time window. A complete run therefore reports harness `pass` and product `inconclusive`.
- WebRTC sender stats are corroboration only. The fake-Studio tests' loopback peer proves the published track is the Lab's, not packet flow through LiveKit.
- Cleanup `ownership` is `proven` only from the exchange's evidence naming this run's binding and grant; only then did the Lab request End, and only as the id-bound API End of that exchange. Otherwise the Lab never requested End and the exchange's end is `uncertain` or `unavailable` until observed not live. An end counts only when confirmed after the run's exchange join, and a malformed room snapshot is unknown, never "no live exchange".
