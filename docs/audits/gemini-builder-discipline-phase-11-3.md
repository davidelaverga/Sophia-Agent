# Gemini Builder Discipline Audit - Phase 11.3

Date: 2026-05-19
Status: implemented for internal Gemini browser dogfood only; production voice remains `legacy_cascade`.

## Live Failure Observed

The first real Phase 11.2 live smoke proved Gemini Live could connect, stream audio, relay public `sophia.*` events, advertise the existing Builder/Lifecycle tools, and execute the real `emit_artifact` path. It also exposed two behavior gaps:

- Gemini called `check_async_task` with an invented task id (`789654321`) before any builder task had been launched or listed in that trusted session.
- Assistant transcript output included pseudo-tool syntax shaped like `try{emit_artifact{active_goal:...`, which should only ever happen through structured Gemini `toolCall`, never spoken/text transcript.

The backend was right to reject the invented task id. The issue was model/tool-use discipline and recovery feedback, not a need to weaken session scoping.

## Fix Strategy

- Builder/Lifecycle function declarations now state explicit sequencing: `start_builder_task` is first for fresh build/create/generate/research requests and lifecycle tools require real tracked ids from `start_builder_task` or `list_async_tasks` in the current trusted session.
- The canonical Companion/Builder contract now says never to invent task IDs and to call `start_builder_task` first for fresh buildable requests.
- Unknown lifecycle task ids still fail closed, but the relay now returns a Gemini-compatible `toolResponse` with `ok:false`, `error_type: "unknown_task_id"`, tracked ids, and recovery guidance so Gemini can self-correct.
- The Gemini mapper filters assistant text surfaces that begin like raw tool invocations, preventing pseudo-tool syntax from entering public `sophia.transcript` while preserving structured `toolCall` handling.
- `/debug/realtime/gemini` now distinguishes tool execution rejection from relay/WSS failure and shows last start id, tracked ids, lifecycle id use, rejection reason, and recovery guidance.

## Stability Notes

Builder/Lifecycle should be considered live-smoke ready when Edward can demonstrate this chain on `/debug/realtime/gemini`:

1. `start_builder_task` launches a real task and returns a real id.
2. A follow-up status question triggers `check_async_task` with that same id.
3. `list_async_tasks` can recover the id if context is ambiguous.
4. Unknown ids produce `ok:false` recovery guidance without breaking Gemini WSS or public SSE.
5. No pseudo-tool syntax appears in spoken output or public assistant transcript.

Remaining risk: Gemini may still occasionally choose the wrong tool despite stricter declarations. The backend remains authoritative and fail-closed; future stabilization should be based on repeated live smoke records, not one successful run.