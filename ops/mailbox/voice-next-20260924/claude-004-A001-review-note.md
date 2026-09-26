# claude-004: A-001 review note. The provider-first reading is not accepted yet.

Epoch: voice-next-20260924 · Assignment: A-001 · In reply to: Codex's A-001 headline, relayed by Davide ("provider event 869 already contains a French partial transcript while English speech continues") · Written 2026-09-24T00:15Z

**Conclusion so far.** If event 869 carries the provider's own inputTranscription, the French did not come from app-side assembly. H3 is ruled out as the origin. However, it does not prove that D4 (the provider) is the first divergence. The audio may already have diverged at D2, before it reached the provider:

1. **The capture context ran at 44.1 kHz.** This is inferred from byte counts; please confirm it from recorded fields.
   - Every forwarded J6 frame is exactly 2,972 B: turn 1 is 115,908 B / 39 frames, and turn 2 is 219,928 B / 74 frames.
   - A 4,096-sample buffer at 44.1 kHz gives `floor(4096/(44100/16000))·2 = 2972`. At 48 kHz it would give 2,730.
2. **The app's downsampler has no anti-aliasing.** `pcm16Base64FromFloat32` (`frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts:5221`, called at `:8396`) takes the sample at the rounded-down index. It applies no low-pass filter, and 2.75625 is not a whole-number ratio. The ordinary microphone path uses the same function.
3. **Offline measurement.** Source: `claude-artifacts/a001-d2-alias-check.{py,txt}`, using Ubuntu espeak-ng 1.51 rather than the Lab's Debian build, so the waveform is not byte-verified. The table gives error against a band-limited reference.

   | Audio | Error at 44.1 kHz | Error at 48 kHz |
   |---|---|---|
   | J6 turn 2 (exact text, hash `918af93b…`) | −18.4 dB | −28.0 dB |
   | `a02_trailing_pause` fixture (Samantha, 16 kHz) | −24.9 dB | −58.2 dB |

   J6 turn 1's size (3.622 s) matches that fixture (3.669 s), and turn 1 came out in English. This measures distortion, not what the provider's recognizer does with it.

**Needed in the A-001 handback before I accept it (a table is fine):**
- The capture `AudioContext.sampleRate`, plus the recorded `frameDurationMs` and `frameByteLength` for turn 2.
- D1–D7, each marked intact / diverged / unknown with event IDs. For D4, give the complete provider chunk sequence and its timing relative to `audioStreamEnd`. For D6, give the actual turn-2 reply text.
- Whether turn 1 was `a02_trailing_pause` (fixture ID from its speak receipt), and its provider transcript language.
- The scheduler task before and after, with readback; the observed deployed components and any drift from the recorded set; both Lab services' states; the budget ledger; runs used out of 3, with End, export and settlement IDs.
- Any objection. You may challenge this D2 reading with evidence.

**Likely A-002, not yet issued:**
- **Repair.** A stateful, band-limited 44.1/48 kHz → 16 kHz downsampler at that single call site. Keep the existing output-length rule so frame and receipt byte counts stay the same. Other paths stay untouched.
- **Tests that fail before the fix and pass after:**
  - a tone above 8 kHz is attenuated instead of aliasing;
  - an in-band tone is preserved;
  - no discontinuity at frame boundaries.
- **Release.** Exact-candidate CI (the 7 known failures in #152/#153 must be unchanged), then deploy.
- **R2.** A post-fix run using the exact J6 text.
- **If R2 is still French:** R3 tests H1 (a language hint from the user's locale, never a product-wide en-US).

Do not start that work until A-002 is issued.
