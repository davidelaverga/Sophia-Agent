# Sophia Realtime Dogfood Run Record

Use one file per provider run. Keep the scenario ids aligned with `docs/testing/sophia-realtime-comparative-dogfood-phase-9.md`.

## Run Metadata

- Date/time:
- Tester:
- Branch:
- Commit or dirty-worktree note:
- Provider: `openai_realtime` | `gemini_live` | `legacy_cascade`
- Runtime mode:
- Transport type:
- Model:
- General notes:
- User id:
- Dogfood session id:
- Browser/device:
- Network:
- Microphone/speaker path:
- Prompt/instructions override, if any:

## Environment

- `SOPHIA_VOICE_RUNTIME_MODE`:
- `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED`:
- Provider adapter flag:
- Provider credential present on backend only: yes | no
- Frontend exposed provider standard key: no | yes, explain immediately
- Services started with:
- Relevant logs captured:

## Session Health

- Start response status:
- Event stream URL:
- OpenAI sideband attached: yes | no | n/a
- OpenAI `rtc_*` call id:
- Gemini setupComplete observed: yes | no | n/a
- Gemini relay receiving server messages: yes | no | n/a
- Disconnect status:
- Recovery after new session: pass | fail | not tested

## Event Evidence Summary

- `sophia.*` event count:
- Event counts by type:
- First event type/time:
- Last event type/time:
- `agent_started` observed: yes | no
- `agent_ended` observed: yes | no
- Final transcript observed: yes | no
- Artifact observed: yes | no
- Builder task observed: yes | no | n/a
- Interruption markers:
- Provider error markers:
- Public provider event leaks: no | yes, list
- Missing required event evidence:
- Helper output path or pasted summary:

## Scenario Results

| ID | Executed | Perceived latency | Transcript notes | Audio notes | Event health notes | Failures |
|---|---|---|---|---|---|---|
| S01 | yes/no |  |  |  |  |  |
| S02 | yes/no |  |  |  |  |  |
| S03 | yes/no |  |  |  |  |  |
| S04 | yes/no |  |  |  |  |  |
| S05 | yes/no |  |  |  |  |  |
| S06 | yes/no |  |  |  |  |  |
| S07 | yes/no |  |  |  |  |  |
| S08 | yes/no |  |  |  |  |  |
| S09 | yes/no |  |  |  |  |  |
| S10 | yes/no |  |  |  |  |  |
| S11 | yes/no |  |  |  |  |  |
| S12 | yes/no |  |  |  |  |  |
| S13 | yes/no |  |  |  |  |  |
| S14 | yes/no |  |  |  |  |  |
| S15 | yes/no |  |  |  |  |  |

## Scorecard

Use 1-5. Do not score a category above 3 if its event evidence is missing.

| Category | Score | Notes |
|---|---:|---|
| Perceived TTFA / response speed |  |  |
| Interruption handling |  |  |
| Transcript quality |  |  |
| Assistant audio naturalness |  |  |
| Fidelity to Sophia voice/register |  |  |
| Emotional attunement |  |  |
| Event stream correctness |  |  |
| Session stability |  |  |
| Operational ease |  |  |
| Future tool integration friendliness |  |  |

Overall score:

Recommendation: `pass` | `promising but needs fixes` | `block`

## Observed Failures

- Failure id:
- Scenario id:
- What happened:
- Repro steps:
- Logs/events:
- Severity: blocker | major | minor
- Suspected owner: provider transport | adapter mapper | normalizer | frontend connector | gateway/voice server | unknown

## Comparative Notes

- Strongest behavior:
- Weakest behavior:
- Most important uncertainty:
- What should be repeated:
- What should not influence the decision:

## Final Decision Notes

- Would you dogfood this provider again tomorrow? yes | no
- What must be fixed before broader internal use:
- What evidence would change this recommendation: