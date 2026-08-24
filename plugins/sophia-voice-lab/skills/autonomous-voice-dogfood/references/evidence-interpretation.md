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
