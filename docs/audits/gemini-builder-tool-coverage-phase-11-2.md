# Gemini Builder Tool Coverage Audit - Phase 11.2

Date: 2026-05-19
Status: implemented for internal Gemini browser dogfood only; production voice remains `legacy_cascade`.

## Runtime Shape

`Browser microphone/speaker -> Gemini Live WSS with ephemeral token -> browser-captured toolCall -> authenticated backend relay -> existing Sophia tool execution -> client_actions.gemini_tool_response -> browser sends toolResponse -> Gemini resumes`

The browser still owns Gemini transport and audio. The backend owns Sophia tool execution. No custom Gemini-only tool was added.

## Prompt-Referenced Tool Coverage

| Tool | Existing Sophia source | Gemini declaration source | Gemini relay execution | Notes |
|---|---|---|---|---|
| `emit_artifact` | Companion tool wrapper around `deerflow.sophia.tools.emit_artifact_contract` | `emit_artifact_contract.ArtifactInput` | Validates/records the backend artifact contract and returns `toolResponse` | Required every companion turn; no text parsing. |
| `start_builder_task` | `deerflow.sophia.tools.start_builder_task` companion wrapper | `builder_lifecycle_contract.StartBuilderTaskInput` | Starts a real `sophia_builder` LangGraph run through HTTP and stores `async_tasks[builder_thread_id]` | Trusted user id comes from the dogfood session, not tool args. |
| `check_async_task` | deepagents `AsyncSubAgentMiddleware` lifecycle tool | `builder_lifecycle_contract.CheckAsyncTaskInput` | Reads tracked run status/result from LangGraph and updates session task state | Requires a task id launched in the same dogfood session. |
| `update_async_task` | deepagents `AsyncSubAgentMiddleware` lifecycle tool | `builder_lifecycle_contract.UpdateAsyncTaskInput` | Sends an interrupting follow-up run to the tracked builder thread | Preserves the original task id/thread id. |
| `cancel_async_task` | deepagents `AsyncSubAgentMiddleware` lifecycle tool | `builder_lifecycle_contract.CancelAsyncTaskInput` | Cancels the tracked LangGraph run and marks task state cancelled | Uses the tracked thread/run pair. |
| `list_async_tasks` | deepagents `AsyncSubAgentMiddleware` lifecycle tool | `builder_lifecycle_contract.ListAsyncTasksInput` | Lists session-scoped tracked builder tasks and refreshes non-terminal statuses where possible | Does not expose unrelated user/global tasks. |

## Boundary Checks

- `voice/.venv` does not need `deepagents`, `langgraph_sdk`, or `langchain_core` for Gemini tool declarations.
- Gemini setup no longer includes `sophia_tool_probe`.
- Gemini setup does not advertise a tool unless the relay has an execution path for it.
- The relay returns official Live API `toolResponse.functionResponses[]` payloads; the browser sends them over the active Gemini WSS.
- The debug page surfaces configured tools, last tool call, backend result, `task_id`, task status, and tool-response send-back.

## Remaining Gaps

- This does not move production `/voice/connect` off `legacy_cascade`.
- The full Sophia companion middleware chain still does not run inside the Gemini Live session.
- Mem0 writes, offline pipeline work, full skill routing, and production rollout are still out of scope for this phase.