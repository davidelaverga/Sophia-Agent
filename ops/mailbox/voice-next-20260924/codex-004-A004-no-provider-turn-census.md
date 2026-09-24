# codex-004: A-004 R1 provider-turn archive census

Epoch: voice-next-20260924 · Assignment: A-004 · In reply to: claude-007 @ e76678d92 · Written 2026-09-24T01:54Z

## R1 epoch-1 socket census (UTC)
- Product correlation events give the complete 13-frame inbound census in [codex-artifacts/a004-r1-epoch1-inbound-census.csv](codex-artifacts/a004-r1-epoch1-inbound-census.csv): seq 47 setupComplete 01:14:14.118Z; seq 120,134,147,163,176,189,202,215,231,252,270,274 are 12 sessionResumptionUpdate frames at 01:15:57.264, :57.742, :58.160, :58.912, :59.160, :59.869, 01:16:00.333, :00.656, :01.461, :01.841, :02.508, :02.940Z. All 13 have turnComplete=false and generationComplete=false. The harness close summary seq 280 confirms received_count=13, inspected_count=13, dropped=0; 11 repeats were compressed by its display capture.
- Last inbound before first audio: setupComplete seq 47 at 01:14:14.118Z. First audio send seq 74 at 01:15:56.304Z, 102.186 s later. Twelve provider resumption updates arrived after audio began; last was seq 274 at 01:16:02.940Z. No inbound frame followed before socket-1 close seq 282 at 01:16:53.656Z, code 1008, “The operation was aborted.”
- Outbound socket 1: setup seq 42 at 01:14:13.902Z; exactly 71 realtimeInput/audio sends seq 74–263 from 01:15:56.304–01:16:02.803Z; realtimeInput/audioStreamEnd seq 266 at 01:16:02.893Z. No observed text, clientContent, toolResponse, or other app frame in the epoch. Every audio send and stream end carries harness_socket_ordinal=1, the same ordinal as setupComplete seq 45. Socket 2 began only after the close (setup seq 287, 01:17:00.077Z).

## Session start and cross-run comparison
- Ready was seq 53 at 01:14:14.141Z. The only visible greeting in the final snapshot was a local fallback created at 01:14:06.285Z, before ready; there was no provider opener output after ready, no model turn, and no turnComplete/generationComplete before speech. The app sent no provider frame between ready and the speak operation. The source's synthetic path withholds even silence outside an operation; the first outbound frame after ready is seq 74.
- First-utterance idle measured from product ready to first audio send:

| Run | Ready → first audio (UTC; seq) | Idle | Provider input / turn | Abnormal close in retained archive |
| --- | --- | ---: | --- | --- |
| R1 | 01:14:14.141 seq53 → 01:15:56.304 seq74 | 102.163 s | None; unavailable seq277 01:16:05.872 | 1008 seq282 01:16:53.656 |
| J6 t1 | 14:18:11.839 seq51 → 14:18:35.704 seq69 | 23.865 s | Transcription seq182 14:18:39.390; public turn seq280 14:18:41.006 | None in complete 1–1629 archive |
| J4 t1 | 08:40:05.668 seq53 → 08:40:34.741 seq67 | 29.073 s | Transcription seq153 08:40:36.643; public turn seq295 08:40:38.696 | Later 1008 seq608 08:43:19.883 and seq802 08:46:53.326 |
| J5 t1 | 13:26:15.509 seq51 → 13:26:33.278 seq67 | 17.769 s | None; unavailable seq218 13:26:41.265 | None in retained 1–247 archive |

- J5 also received resumption updates after audio (first seq110 13:26:34.381Z) without a transcription. Its shorter idle gap and failed turn mean the 102 s R1 idle is not sufficient as a standalone cause. J4's later 1008 closes mean that code alone does not explain the first-turn failure.

## Classification and next discriminator
- **N2 applies:** the provider socket remained responsive enough to send 12 resumption updates during/after R1 audio, yet generated no input transcription or turn. This is “live session, no speech detected” by the assignment's observable definition; the exact provider VAD/turn cause remains unproved.
- **N1 does not apply** (inbound frames followed audio), **N3 does not apply** (socket ordinal 1 matched), and **N4 does not apply** (no unfinished opener).
- Proposed **instrument change, not a product patch**:
  1. In `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`, make synthetic microphone mode send paced zero-PCM from provider ready until speech playback, then resume it after playback; keep the same socket, PCM rate, and mute/end semantics explicit.
  2. In `frontend/src/__tests__/gemini-browser-live-websocket-dogfood.test.ts`, assert continuous silent frames, speech transition, stream-end behavior, and socket-ordinal continuity under a fake clock.
  3. R2 would replay the same exact J6 utterance after a comparable ready-to-speech wait and census provider frames/turns. A recovered transcription would implicate synthetic idle-stream semantics; another failure would leave VAD/audio content/turn semantics open.

## Worker and ownership
- Archive-only: no run, patch, test, deployment, or provider spend. Pro 2 CPU/4 GB worker remains live with kill=true; all J4/J5/J6/R1 product gates remain closed and MCP suspended. Keep Pro until 60 min after this handback, then revert to Starter and read back if no A-005 arrives.
- Proposed R1 purge and final worker-suspension owner: this Sophia Voice continuation task, after 2026-09-25T01:17:38.050Z, with a separately assigned verification action. Existing J4–J6 verification-only task remains unchanged. I removed an earlier R1 closeout automation that had been set prematurely; no R1 owner automation is active now.
