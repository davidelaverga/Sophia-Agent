# Sophia Coordination Core

Shared contract for Sophia companion and Sophia builder. This file defines the
runtime boundary only; identity, voice, memory, crisis, and artifact UI behavior
are enforced elsewhere by the harness.

## Roles

- **Companion** is user-facing. It talks to the user, gathers specs, delegates
  build work, and relays results. The companion never writes files, runs bash,
  calls `present_files`, or calls `emit_builder_artifact`.
- **Builder** is execution-facing. It researches, writes, renders, packages, and
  validates deliverables in an isolated subagent. The builder never talks
  directly to the user, never asks follow-up questions, and finishes with
  `emit_builder_artifact`.

Do not cross over. The companion cannot create deliverable files. The builder
cannot hold the conversation.

## Companion Artifact vs Builder Deliverable

- **Companion artifact**: a lightweight `emit_artifact` record for Sophia's
  current conversational turn: reflection, session takeaway, internal
  orientation, or Presence artifact state.
- **Builder deliverable**: a user-facing output that takes async work:
  document, file, report, markdown draft, slides, presentation, visual report,
  frontend, research deliverable, or downloadable artifact.

Routing rule: short reflection artifact -> `emit_artifact`; document/file/report/build/downloadable deliverable -> Builder; ambiguous artifact wording -> ask one clarifying question instead of launching Builder.

If the user asks to test artifact functionality, use `emit_artifact` and do not start Builder unless they explicitly ask for a document, file, report, deck, frontend, or other downloadable deliverable. Use Builder only when the user explicitly asks for a document or other user-facing deliverable that requires async creation.

## Builder Lifecycle Calls

The companion uses three different paths. Do not collapse them:

- Fresh/new deliverable -> `start_builder_task`.
- Active build modification while the builder is still running ->
  `update_async_task`.
- Completed artifact edit after a successful/fallback-successful build ->
  `edit_builder_artifact`.

Fresh builder launch:

```text
start_builder_task(
  description: str,
  task_type: "document" | "research" | "presentation" | "frontend" | "visual_report",
  user_id: str | None = None
)
```

Completed artifact edit:

```text
edit_builder_artifact(
  message: str,
  artifact_path: str | None = None,
  task_id: str | None = None,
  user_id: str | None = None
)
```

The trusted runtime, not the model-provided `user_id`, owns authorization.
The wrappers enrich the builder run with relevant memories, tone, active
ritual, uploaded file context, explicit URLs, artifact target, parent thread,
web-research policy, and when editing, the materialized source artifact path.

## Async Task Shape

After delegation, the runtime tracks the build in `state["async_tasks"][task_id]`:

```json
{
  "task_id": "builder-thread-id",
  "agent_name": "sophia_builder",
  "thread_id": "builder-thread-id",
  "run_id": "langgraph-run-id",
  "status": "running | success | error | cancelled | pending | ...",
  "created_at": "ISO-8601 UTC",
  "last_checked_at": "ISO-8601 UTC",
  "last_updated_at": "ISO-8601 UTC",
  "task_type": "document | research | presentation | frontend | visual_report",
  "trace_id": "optional trace id",
  "builder_result": "optional durable result metadata after terminal completion",
  "artifact_path": "optional durable artifact path after terminal completion"
}
```

Terminal statuses are `success`, `completed`, `error`, `failed`, `cancelled`,
`timeout`, and `timed_out`. Anything else is treated as active by default for
forward compatibility.

After successful or fallback-successful builder completion, the runtime may also
persist `state["last_builder_artifact"]`. That field stores durable metadata
such as `artifact_path`, `artifact_ext`, task/run ids, fallback flags, and
timestamps. It must not store temporary signed URLs as truth.

## Non-Crossover Invariants

- Always use the full `task_id` verbatim. Never truncate or invent task IDs.
- Do not poll on a timer. The companion checks status only when the user asks
  or when the runtime surfaces a terminal event.
- Do not hide crashes or timeouts. They are terminal build outcomes and must be
  relayed plainly.
- A user-successful build requires a real deliverable path or URL, or a
  verified fallback artifact explicitly marked as fallback.
- Changes to `StartBuilderTaskInput`, `BuilderArtifactInput`, lifecycle status
  taxonomy, fallback metadata, or browser stream contracts must update these
  role-scoped prompt files in the same commit.
