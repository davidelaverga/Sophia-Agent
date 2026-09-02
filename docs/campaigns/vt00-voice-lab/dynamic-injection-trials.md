# Voice Lab deterministic dynamic-injection trials

Status: `IMPLEMENTED — CLOSED DEPLOYMENT ASSERTION REQUIRED`

Falsifiable hypothesis: twenty sequential dynamic audio operations through the
production Voice Lab browser initialization script and a real Chromium WebAudio
`MediaStream` consumer each produce exactly one scheduled, started, and completed
input chain. A byte-identical concurrent replay of each operation returns the
same scheduling receipt and produces no second injection.

The test uses deterministic generated PCM, the real stream consumer, the actual
WebSocket forwarding boundary, and the production operation memoization path. It
requires 20 distinct operation identities, forwarded nonzero PCM for every
identity, exactly 20 schedule/start/completion events, and zero interrupted or
rejected events. Raw PCM is never copied into the evidence events.

This proof does not open a product mutation gate or substitute for the five
fresh deployed voice canaries. The full Voice Lab suite must remain green before
publication, followed by a closed exact-candidate deployment assertion with one
settled worker and zero active runs.
