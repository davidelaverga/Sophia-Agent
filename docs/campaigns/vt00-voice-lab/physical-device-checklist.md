# VT00 periodic physical-device checklist

Status: `TEMPLATE — NO DEVICE RUN RECORDED`

This is a supplemental periodic check for real speaker/microphone, acoustic echo cancellation, and device-policy behavior. It does not replace the autonomous injected-PCM certification and must never use Davide's or another person's voice as an unapproved fallback.

## Test record

| Field | Value |
|---|---|
| Date / operator | `PENDING` |
| Approved synthetic playback source | `PENDING` |
| Device / OS / browser versions | `PENDING` |
| Input/output device identifiers (redacted) | `PENDING` |
| Network profile | `PENDING` |
| Exact frontend/gateway/voice SHAs | `PENDING` |
| Test run and evidence manifest IDs | `PENDING` |

## Safety and privacy preflight

- [ ] Dedicated synthetic principal and bounded campaign window are active.
- [ ] No ordinary user session, memory, learning, analytics, notification, or offline-work state is in scope.
- [ ] The room contains no bystanders or background speech likely to be captured.
- [ ] Only an approved synthetic fixture/TTS source will be played; no personal voice is required.
- [ ] Raw audio recording is disabled, or a documented exception and deletion deadline are attached.
- [ ] Output volume is at a safe level and an immediate mute/kill control is available.

## Device checks

- [ ] Browser permission names the intended microphone and denies camera access.
- [ ] The selected input sample rate/channel layout is recorded.
- [ ] The selected speaker/headset route is recorded.
- [ ] A deterministic fixture is acoustically played and produces input-level/PCM and transcription receipts.
- [ ] Provider output received, playback scheduled, actual playback started, and natural completion remain distinct.
- [ ] Headphone route: no unexpected duplicate or stale realization is heard.
- [ ] Speaker route: echo cancellation prevents Sophia output from becoming a retained new user turn.
- [ ] Barge-in after actual playback start produces correlated interruption/flush and retains the new input.
- [ ] Socket rotation restores the same logical session with prior/new epoch evidence.
- [ ] Device disconnect/reconnect yields typed state and no false completion receipt.
- [ ] Explicit end completes the product finalization path and releases the physical capture device.

## Postflight

- [ ] Zero browser, microphone, provider, synthetic session, and owned task resources remain.
- [ ] Evidence contains no unapproved raw audio, room speech, device serial, cookie, or credential.
- [ ] Any approved raw artifact has a deletion time and owner.
- [ ] Harness and product verdicts are recorded separately.
- [ ] Differences from injected-PCM behavior are filed with exact device/browser evidence.

Recommended cadence: before first promotion, after material browser/audio changes, and at least quarterly while the production Voice Lab remains active. The cadence and every result are `PENDING` until approved by the campaign owner.
