# Sophia Realtime Comparative Dogfood - Phase 9

Date: 2026-05-17
Status: manual comparative dogfood and evaluation harness. Production voice remains `legacy_cascade`.

## 1. Purpose

Phase 9 gives Edward a repeatable manual protocol for comparing the two experimental browser dogfood paths that now exist:

- OpenAI browser WebRTC plus trusted backend sideband.
- Gemini browser Live WebSocket plus trusted backend relay.

This phase does not choose a winner, promote a provider, or alter provider transport. It makes the existing Phase 8A and Phase 8B paths easier to run, verify, score, and hand off.

The active production runtime remains `legacy_cascade`. Treat these dogfood paths as internal evaluation surfaces only.

## 2. Environment Setup

Use a fresh shell per provider run. Do not compare providers from shells with mixed or stale runtime variables.

### Legacy Baseline

Use this to confirm the normal app still starts in the default cascade mode.

```powershell
$env:SOPHIA_VOICE_RUNTIME_MODE = "legacy_cascade"
$env:SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED = "false"
$env:SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED = "false"
$env:SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED = "false"

$env:ANTHROPIC_API_KEY = "..."
$env:STREAM_API_KEY = "..."
$env:STREAM_API_SECRET = "..."
$env:DEEPGRAM_API_KEY = "..."
$env:CARTESIA_API_KEY = "..."
```

It is also valid to leave `SOPHIA_VOICE_RUNTIME_MODE` unset for default legacy behavior, but set it explicitly during comparison notes so the run record is unambiguous.

### OpenAI Browser Dogfood

```powershell
$env:SOPHIA_VOICE_RUNTIME_MODE = "openai_realtime"
$env:SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED = "true"
$env:SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED = "true"
$env:SOPHIA_OPENAI_REALTIME_MODEL = "gpt-realtime-2"
$env:OPENAI_API_KEY = "sk-..."

$env:ANTHROPIC_API_KEY = "..."
$env:STREAM_API_KEY = "..."
$env:STREAM_API_SECRET = "..."
```

The browser must receive only the ephemeral `client_secret.value` from the backend. Never put `OPENAI_API_KEY` in a `NEXT_PUBLIC_*` variable, frontend env file, browser code, or test fixture that mimics browser state.

### Gemini Browser Dogfood

```powershell
$env:SOPHIA_VOICE_RUNTIME_MODE = "gemini_live"
$env:SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED = "true"
$env:SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED = "true"
$env:SOPHIA_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview"
$env:GOOGLE_API_KEY = "..."  # or GEMINI_API_KEY

$env:ANTHROPIC_API_KEY = "..."
$env:STREAM_API_KEY = "..."
$env:STREAM_API_SECRET = "..."
```

The browser must receive only the ephemeral Google Live auth token. Never put `GOOGLE_API_KEY` or `GEMINI_API_KEY` in a `NEXT_PUBLIC_*` variable, frontend env file, browser code, or test fixture that mimics browser state.

## 3. Startup Commands

From the repository root on Windows:

```powershell
.\scripts\start-all.ps1
```

This launcher starts:

- LangGraph on `http://localhost:2024`
- Gateway on `http://localhost:8001`
- Voice server on `http://localhost:8000`
- Frontend on `http://localhost:3000`

Stop all services before switching provider env:

```powershell
.\scripts\start-all.ps1 -Stop
```

Workspace tasks may also be used when preferred:

- `Start Sophia App`
- `Launch Sophia Dev`
- `Launch Sophia Dev App`

For Unix-like local dev, the repo-level fallback remains:

```bash
make dev
make stop
```

Logs to watch during manual comparison:

```powershell
Get-Content .\logs\voice.log -Wait
Get-Content .\logs\gateway.log -Wait
Get-Content .\logs\frontend.log -Wait
```

## 4. Dogfood Entry Points

## Preferred UI Workflow

When the goal is a normal comparative dogfood pass rather than low-level transport debugging, use the internal launcher first.

1. Open `http://localhost:3000/debug/realtime`.
2. Pick the provider card for the run you are about to execute.
3. Jump to `/debug/realtime/openai` or `/debug/realtime/gemini` from that launcher.
4. Run the same Phase 9 scenario matrix for the provider page you opened.
5. Return to `/debug/realtime` and fill the manual run recorder for that provider.
6. Download the JSON run record and copy the Markdown summary immediately after the run.
7. Repeat the same workflow for the other provider before comparing recommendations.

The launcher does not replace the protocol in this document. It is a structured front door and recorder for the same manual comparison process.

### OpenAI Browser WebRTC

Protected frontend/gateway surface:

- `POST /api/sophia/<user_id>/voice/dogfood/openai/browser-session`
- `POST /api/sophia/<user_id>/voice/dogfood/openai/sideband`
- `GET /api/sophia/<user_id>/voice/dogfood/openai/events?session_id=<session_id>`
- `POST /api/sophia/<user_id>/voice/dogfood/openai/disconnect`

Expected transport label in the start response:

```text
openai_browser_webrtc_with_server_sideband
```

Verification anchors:

- Browser WebRTC connects to OpenAI with the ephemeral `client_secret.value`.
- The browser extracts an `rtc_*` call id from the OpenAI `Location` header.
- The backend sideband attaches to that `rtc_*` call id.
- Public SSE contains only `sophia.*` event names.

### Gemini Browser Live WebSocket

Protected frontend/gateway surface:

- `POST /api/sophia/<user_id>/voice/dogfood/gemini/browser-session`
- `POST /api/sophia/<user_id>/voice/dogfood/gemini/relay`
- `GET /api/sophia/<user_id>/voice/dogfood/gemini/events?session_id=<session_id>`
- `POST /api/sophia/<user_id>/voice/dogfood/gemini/disconnect`

Expected transport label in the start response:

```text
gemini_browser_websocket_ephemeral_token_with_backend_relay
```

Verification anchors:

- Browser opens Gemini Live WSS with the ephemeral auth token in `access_token`.
- Browser sends `setup` first.
- Browser waits for `setupComplete` before streaming microphone audio.
- Browser relays only Gemini server messages to the backend relay.
- Public SSE contains only `sophia.*` event names.

## 5. Event Evidence Summary Helper

Phase 9 adds a small internal utility at `voice/realtime/dogfood_evaluation.py`.

It summarizes already-normalized public payloads and reports:

- total normalized `sophia.*` event count
- event counts by type
- first and last event type
- first timestamps when payloads include timestamp-like fields
- presence of `agent_started` and `agent_ended`
- final transcript and artifact presence
- interruption markers
- provider error markers
- public event boundary leaks
- missing required turn evidence

Example use from a local harness or debugger:

```python
from voice.realtime.dogfood_evaluation import summarize_dogfood_events

summary = summarize_dogfood_events(
    public_payloads,
    session_id="browser-openai-1",
    provider="openai-gpt-realtime-2",
    transport="openai_browser_webrtc_with_server_sideband",
)
print(summary.as_dict())
```

Required turn evidence for a complete companion-style run:

- `sophia.user_transcript`
- `sophia.turn` with `phase=agent_started`
- final `sophia.transcript`
- `sophia.artifact`
- `sophia.turn` with `phase=agent_ended`

Some provider runs may not emit a structured artifact yet. Record that as an event-health gap rather than silently treating it as a voice-quality issue.

## 6. Manual Scenario Matrix

Run the same scenario ids, in the same order, for OpenAI and Gemini. Use the same prompt wording unless the provider clearly fails to understand the audio and you must repeat yourself. If you repeat, record it.

For every scenario, capture:

- what was said
- whether TTFA felt slow, normal, or fast
- whether interruption behavior matched expectation
- whether visible transcript matched the spoken content
- whether public events stayed under `sophia.*`
- whether OpenAI sideband or Gemini relay was healthy
- any disconnect, reconnect, or provider error

### S01 - Standard Greeting

What to say: `Hey Sophia, can you hear me?`

Listen/watch for: Fast first response, natural greeting, no generic assistant over-explaining.

Logs/events to verify: `sophia.user_transcript`, `sophia.turn agent_started`, `sophia.transcript`, `sophia.turn agent_ended`.

Good: One visible user transcript, one concise Sophia response, no duplicate turn phases.

Failure: No response, duplicate assistant starts, provider-native event names in SSE, or a response that sounds like setup/debug narration.

### S02 - Short Direct Answer

What to say: `Give me a two-sentence explanation of why turn-taking matters in voice interfaces.`

Listen/watch for: Short answer, direct structure, no long lecture.

Logs/events to verify: Final `sophia.transcript` arrives after partials or as a single final; `agent_ended` arrives once.

Good: The answer is complete and short, and audio starts quickly.

Failure: Rambling answer, missing final transcript, or audio continues after `agent_ended`.

### S03 - Long Reflective Answer

What to say: `I want the longer version. Why does a voice companion feel different from chat when it is done well?`

Listen/watch for: Longer but still Sophia-like reflection, clear pacing, no generic essay voice.

Logs/events to verify: Transcript accumulates coherently; no duplicate final transcript surfaces.

Good: Longer answer feels intentional and emotionally grounded.

Failure: Provider drops audio, transcript diverges from audio, or response becomes generic productivity-assistant prose.

### S04 - User Interruption Mid-response

What to say: Start S03, then interrupt during Sophia's answer with `Actually, pause. Say that more simply.`

Listen/watch for: Active response stops or gracefully yields; new answer addresses the interruption.

Logs/events to verify: Interruption/cancel marker in `sophia.turn` or `sophia.turn_diagnostic`; no stale continuation from the cancelled response.

Good: Provider handles barge-in without duplicate assistant messages.

Failure: Old audio continues over the new turn, stale transcript lands after interruption, or no interruption marker appears.

### S05 - Silence / Pause Handling

What to say: `Give me a second.` Then remain silent for 8-10 seconds.

Listen/watch for: Sophia does not fill the silence unnecessarily.

Logs/events to verify: No unsolicited extra assistant turn unless the provider legitimately heard a new input.

Good: Silence is held; session stays alive.

Failure: Provider hallucinates a turn, closes the session, or produces a nervous check-in too quickly.

### S06 - Quick Back-and-forth Turn-taking

What to say: `Name one useful debugging habit.` Then after answer: `Another.` Then: `One more, shorter.`

Listen/watch for: Fast turn-taking, no drift, no accumulating delay.

Logs/events to verify: Each user turn maps to one visible transcript and one assistant lifecycle.

Good: Three clean turns with stable latency.

Failure: Turns merge incorrectly, provider misses a short utterance, or the second/third response is delayed much more than the first.

### S07 - Emotionally Delicate User Statement

What to say: `I got some bad news today and I do not really know what to do with myself.`

Listen/watch for: Gentle, grounded response; no advice rush; no therapy cosplay.

Logs/events to verify: Artifact event if available; tone-related fields should be plausible if artifact arrives.

Good: Sophia meets the feeling before moving it.

Failure: Cheerleading, generic crisis-like escalation without reason, or too much instruction.

### S08 - Low-energy / Withdrawn User Tone

What to say: In a low voice: `I do not know. I am just tired.`

Listen/watch for: Lower energy match, short response, no pressure to perform.

Logs/events to verify: Transcript quality on quiet audio; no missing user transcript.

Good: Sophia gives a small opening rather than a pep talk.

Failure: Misheard transcript, overly energetic delivery, or response asks too much.

### S09 - Slight Frustration / Mild Anger

What to say: `This whole thing is annoying. It keeps almost working and then falling apart.`

Listen/watch for: Does not get defensive; acknowledges frustration with some steadiness.

Logs/events to verify: One assistant response; no provider error under raised voice.

Good: Sophia names the stuckness and helps narrow it.

Failure: Apology loop, bland troubleshooting script, or emotional mismatch.

### S10 - Masked Discomfort With Humor

What to say: `Everything is totally fine, obviously, I love being personally victimized by my own backlog.`

Listen/watch for: Picks up humor plus discomfort; does not flatten the joke.

Logs/events to verify: Transcript preserves enough punctuation/wording to show the joke landed.

Good: Sophia responds with lightness and accuracy.

Failure: Treats it literally, misses discomfort, or becomes too jokey.

### S11 - Natural Language Switch

What to say: `Possiamo continuare in italiano per un minuto? Mi viene piu naturale cosi.`

Listen/watch for: Switches to Italian naturally if supported by the current runtime/prompt scope.

Logs/events to verify: Transcript captures Italian sufficiently; assistant response language matches.

Good: Language switch is smooth and sustained.

Failure: Refuses unnecessarily, mixes languages awkwardly, or answers in English despite clear request.

### S12 - Tool-call-shaped Event Observation

What to say: `At the end of this answer, do whatever your current Sophia turn protocol requires internally.`

Listen/watch for: Spoken response should not narrate internals.

Logs/events to verify: If provider emits structured tool calls, they become `sophia.artifact` or internal-only events through the normalizer. No raw tool call names should leak to public SSE unless intentionally represented by `sophia.*`.

Good: Event path stays structured and public names stay `sophia.*`.

Failure: Assistant reads JSON aloud, artifact is parsed from text, or provider tool names leak to frontend state.

### S13 - Artifact-related Event Observation

What to say: `Give me a short reflection and close the turn normally.`

Listen/watch for: Normal spoken response; no artifact narration.

Logs/events to verify: `sophia.artifact` appears when the provider emits `emit_artifact`; required 13 fields are present if artifact validation is active.

Good: Artifact arrives as structured event evidence, not as assistant text.

Failure: Missing artifact on a companion-style turn, malformed artifact, or voice delivery fields missing without safe defaults.

### S14 - Provider Error / Disconnect Simulation

What to do: During an active session, deliberately close the browser connection or stop the voice server after capturing at least one normal turn. Restart services before the next provider run.

Listen/watch for: UI and logs fail visibly but safely; no silent success claim.

Logs/events to verify: Provider error marker if available, terminal diagnostic if normalized, clean close/disconnect path.

Good: Failure is diagnosable and session can be restarted.

Failure: UI hangs indefinitely, stale audio continues, or the next session inherits broken state.

### S15 - Session Close and Recovery

What to do: Close the dogfood session, start a new session with a new session id, then repeat S01.

Listen/watch for: Clean second start; no old audio/event stream leakage.

Logs/events to verify: Disconnect endpoint returns success; new stream url points to the new session id; event summary for the old run remains distinct.

Good: New session behaves as fresh.

Failure: Old session events appear in the new run, sideband/relay stays attached to the wrong session, or close returns 404 for an active session.

## 7. Comparative Scoring Rubric

Use 1-5 for every category. Score each provider only after running the same scenario set.

General anchors:

- 1 = blocking failure or unusable behavior
- 2 = works only with obvious defects
- 3 = usable but materially rough
- 4 = strong internal dogfood candidate
- 5 = excellent, repeatable, and low-surprise

Scorecard categories:

| Category | 1 | 3 | 5 |
|---|---|---|---|
| Perceived TTFA / response speed | Often feels stalled or exceeds practical voice patience | Usually acceptable but inconsistent | Fast and stable across short and long turns |
| Interruption handling | Stale audio or duplicate messages after barge-in | Interrupts work but rough edges remain | Barge-in feels natural and leaves clean event evidence |
| Transcript quality | Frequent wrong words or missing turns | Understandable with some errors | Accurate enough for UI and memory/artifact implications |
| Assistant audio naturalness | Robotic, clipped, or fatiguing | Usable but noticeably synthetic | Comfortable, expressive, and listenable over time |
| Fidelity to Sophia voice/register | Generic assistant or advice bot | Some Sophia traits, inconsistent | Feels recognizably like Sophia across scenarios |
| Emotional attunement | Mismatched intensity or advice rush | Often appropriate, misses edge cases | Consistently matches, then gently lifts |
| Event stream correctness | Raw provider names leak or lifecycle duplicates | Mostly correct with gaps | Stable `sophia.*` flow with required turn evidence |
| Session stability | Frequent disconnects or unrecoverable errors | Occasional recoverable issues | Long enough dogfood session without transport drama |
| Operational ease | Hard to start or debug; unclear failures | Manageable with careful notes | Repeatable start, clear logs, easy teardown |
| Future tool integration friendliness | Tool/artifact path unclear or text-parsed | Structured but incomplete | Structured tool events align cleanly with Sophia invariants |

Overall recommendation:

- `pass`: Average score >= 4.0, no category below 3, no event correctness blocker.
- `promising but needs fixes`: Average score >= 3.0 with clear fixable issues.
- `block`: Any security leak, raw provider event leak to public SSE, repeated missing lifecycle events, or average score below 3.0.

## 8. Required Run Order

Recommended first comparative pass:

1. Legacy sanity check: S01, S04, S07.
2. OpenAI full matrix: S01-S15.
3. Stop services and clear provider env.
4. Gemini full matrix: S01-S15.
5. Repeat the two most ambiguous scenarios for both providers in reverse provider order.
6. Fill one run record per provider using `docs/testing/templates/sophia-realtime-dogfood-run-template.md`.
7. If a run is close, repeat on a different network or machine before making any migration recommendation.

## 9. Validation Commands

Focused Phase 9 helper:

```powershell
python -m pytest voice/tests/test_dogfood_evaluation.py -q
```

Focused dogfood regression set:

```powershell
python -m pytest voice/tests/test_openai_browser_dogfood.py voice/tests/test_gemini_browser_dogfood.py voice/tests/test_realtime_dogfood_session.py -q
```

Runtime, adapter, and normalizer regression set:

```powershell
python -m pytest voice/tests/test_realtime_runtime_selection.py voice/tests/test_realtime_runtime_factory.py voice/tests/test_openai_realtime_provider_adapter.py voice/tests/test_gemini_live_provider_adapter.py voice/tests/test_realtime_normalizer.py -q
```

Full voice suite:

```powershell
python -m pytest voice/tests -q
python -m compileall -q voice/realtime
```

Frontend and backend checks when proxy routes are touched:

```powershell
cd frontend
pnpm lint
pnpm typecheck
```

```powershell
cd backend
uv run pytest tests/test_voice_gateway.py -q
```

## 10. Non-Claims

- Do not claim OpenAI or Gemini is better until run records exist.
- Do not compare providers with different scenario wording.
- Do not promote a runtime based on one impressive demo.
- Do not treat audio quality alone as success; event correctness, interruption handling, and sideband/relay health are equally important.
- Do not use Gemini sideband language. Gemini browser dogfood is WSS plus relay.
- Do not change `SOPHIA_VOICE_RUNTIME_MODE` default away from `legacy_cascade`.