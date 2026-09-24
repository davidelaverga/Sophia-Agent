# A-008 microphone resampler review

This patch changes only browser microphone PCM conversion. It does not establish the cause of J6, change turn detection, or migrate capture to AudioWorklet.

At 44,100 Hz, cumulative 4,096-sample callbacks produce 2,972 or 2,974 PCM bytes. The callback's `frameDurationMs` describes source callback duration; `frameByteLength` reports actual PCM bytes. The production WebSocket sends each actual base64 frame with `audio/pcm;rate=16000`; the Voice relay forwards this opaque frame without a fixed byte-size check. The Lab's `browser-init.ts` records the decoded byte count per forwarded frame. Its input-leg verification in `worker.ts` sums actual per-frame bytes and sample counts and checks the digest chain. Existing Lab CSVs describe historical frames; they are not a future fixed-size contract. The unused `estimatePcm16ByteLength` helper was removed.

The stateful live path retains one resampler across callbacks. `pcm16Base64FromFloat32` remains a one-shot helper and starts a fresh filter on each call, so its first samples contain a filter startup transient. Low-rate 8/16 kHz capture is accepted without a throw; 8 kHz samples are duplicated to 16 kHz. No provider run has compared this patch with J6.

Focused tests cover 44.1 kHz fractional-phase SNR, 10 kHz attenuation, 8/16 kHz capture, variable frame bytes, irregular chunks, cumulative sample accounting over ten minutes, and per-callback CPU. On the local Apple Silicon host, the 4,096-sample CPU sample measured median 1.035 ms and p95 1.591 ms; CI hosts can differ. Group delay for the 63-tap downsampling filter is 31 input samples, below 1 ms at 44.1/48 kHz.
