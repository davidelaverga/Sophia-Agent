# R-011a — LangSmith 403 and Gemini key audit
Date: 2026-09-28. Read-only/no-spend; no deploy, settings, Lab, memory, or retention action.

## L. LangSmith multipart 403
| Dimension | sophia-voice | working gateway/LangGraph | Result |
|---|---|---|---|
| endpoint | EU; present | EU; present | equal; not the cause |
| workspace | present | present | equal; not the cause |
| `LANGSMITH_API_KEY` | present | present | equal; key itself is not different |
| base project (`LANGSMITH_PROJECT`) | present | present | equal |
| ingest project | `SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT`, present | base project | different; rejecting route |

Evidence: voice multipart POSTs to the EU `/runs/multipart` endpoint returned HTTP 403 while the same endpoint/workspace/key combination works for gateway/LangGraph.
The voice trace shell/project exists, but the incident trace has no inputs or outputs because multipart writes were rejected.
The only current routing difference is the voice-specific project override; its project authorization is incompatible with the shared key's effective scope.
`LANGCHAIN_API_KEY` is also present on all three services but differs from `LANGSMITH_API_KEY`; the manual voice recorder explicitly uses `LANGSMITH_API_KEY`.

Proposed exact change: on `sophia-voice`, set `SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT` equal to its current `LANGSMITH_PROJECT` (which equals the working gateway/LangGraph project); change nothing else.
Validation after approval: one no-spend voice greeting, confirm multipart HTTP success and populated inputs/outputs in the working project.
Rollback: restore only the previous `SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT` value.

## K. Gemini key
Production resolver order is `GOOGLE_API_KEY`, then `GEMINI_API_KEY`; both names are present on `sophia-voice`, so `GOOGLE_API_KEY` is selected and `GEMINI_API_KEY` is fallback.
The local voice code accepts the same two names; the local video-generation eval script accepts `GEMINI_API_KEY`.
Neither name is present in this machine's current shell or local repo env files, so no authenticated local provider eval can run now; no provider call was made.

## D3
Not run: Davide did not perform the explicit voice research request plus spoken correction during R-011a.
Task/run IDs, `[Voice build request]`, `[Voice build correction]`, completion/artifact status, and odd replies therefore remain unobserved and owed.
