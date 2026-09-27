# R-012a — LangSmith project correction
Date: 2026-09-28. One approved sophia-voice environment change; no other service, Lab, memory, retention, database, or CPU action.

## Read-only precondition
- Voice logs, 2026-09-27 21:50:17–21:56:04 UTC: EU `/runs/multipart` repeatedly returned HTTP 403.
- Exact response detail: `{"error":"Forbidden"}`. It named no attachment, plan/quota, workspace header, or endpoint problem.
- Voice LangSmith project retention is 14 days; four earlier traces were visible.
- 2026-09-26 17:45:47 and 23:28:58 in the LangSmith UI had both populated input and output.
- 2026-09-26 17:46:06 and 2026-09-27 01:14:54 had input only; no trace showed an error field.

## Change
- Service: `sophia-voice` only.
- Changed only `SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT`, making it equal to that service's current `LANGSMITH_PROJECT`.
- The prior value was recorded privately for rollback; no value or secret is printed here.
- Render action: **Save and deploy**. No rebuild from the configured branch was used.
- Deployment: `dep-dasq6cjbc2fs738csd70`; trigger `Environment updated`; source `f128af0c5604139b3d20d10424877001b1c0a7cd`; status Live; duration 22.4 s.

## Readback
- `/version`: exact build `f128af0c5604139b3d20d10424877001b1c0a7cd`.
- `/ready`: HTTP 200, status ready.
- Lab: `ENABLED=false`; `KILL=true`; mutation ready remains false.
- Saved variable is present and equals `LANGSMITH_PROJECT`; rollback value remains privately retained.

## Validation pending
- Davide's next voice session must show successful multipart ingest and a trace with populated input and output.
- If it still returns 403, restore only the privately recorded prior project value and report the new response detail.
