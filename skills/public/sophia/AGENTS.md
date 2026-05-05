# AGENTS.md — Companion ↔ Builder Contract

This file is injected into BOTH the Sophia companion agent and the Sophia builder agent. It is the single source of truth for how they coordinate when the user asks for something to be built, researched, or generated. Nothing here overrides identity, voice, memory, crisis, or artifact behaviour — those are enforced by the harness. This contract is strictly about the building path.

It documents the **actual runtime contract** as implemented today. Any field, status, or arg not listed here is not implemented. Aspirational features (partial-build resume, retry semantics, terminal-vs-retryable failure taxonomy) live in the spec docs and will be added here in the same PR that ships the runtime support.

## Roles

- **Companion** (user-facing): talks to the user, gathers specs, delegates building work, and relays results. The companion NEVER writes files, runs bash, calls `present_files`, or calls `emit_builder_artifact`. If a request requires file creation or multi-step execution, the companion MUST delegate via `start_builder_task`.
- **Builder** (execution-facing): runs file creation, research, and presentation work in an isolated subagent. The builder NEVER talks directly to the user, NEVER asks follow-up questions, and NEVER writes emotional or conversational prose. The builder treats the task description as a complete brief and finishes with `emit_builder_artifact`.

Do not cross over. The companion cannot create files. The builder cannot hold the conversation.

## Data Contract

### Delegation call (`start_builder_task`)

The companion invokes the builder with this exact shape — these are the only fields `StartBuilderTaskInput` accepts:

```
start_builder_task(
  description: str,                                  # complete, self-contained brief
  task_type: "document" | "research" | "presentation" | "frontend" | "visual_report",
  user_id: str | None = None                         # diagnostic-only hint; NEVER used to override the trusted runtime user. Leave None.
)
```

Before calling, the companion MUST have all specs. The builder cannot ask clarifying questions. The wrapper enriches the description with relevant memories from this session, current emotional context, active ritual, and explicit URLs the user provided — so a well-formed `description` need not repeat those.

The wrapper returns immediately with a task_id; companion keeps talking to the user while the build runs in the background.

### Builder task lifecycle

After `start_builder_task` returns, the runtime tracks the build via `state["async_tasks"][task_id]`. Each entry has this shape:

```
{
  "task_id": str,                                   # same value as thread_id
  "agent_name": "sophia_builder",
  "thread_id": str,
  "run_id": str,
  "status": "running" | "success" | "error" | "cancelled" | "pending" | …,
  "created_at": ISO-8601 UTC,
  "last_checked_at": ISO-8601 UTC,
  "last_updated_at": ISO-8601 UTC,
  "task_type": str,                                 # echoed from the launch
  "demo_mode": bool,                                # true if the wrapper normalized a generic demo prompt
  "trace_id": str
}
```

Status semantics (terminal-status blacklist; default-active for forward-compat):

- **terminal**: `success`, `completed`, `error`, `failed`, `cancelled`, `timeout`, `timed_out` — build is over; companion may launch a new one if the user asks.
- **non-terminal**: anything else (`running`, `pending`, `interrupted`, etc.) — build is still in flight; do NOT call `start_builder_task` again. The wrapper enforces this guard internally and refuses duplicate launches.

### Lifecycle tools (deepagents native)

Once a task is running, the model has four lifecycle tools available:

- `check_async_task(task_id)` — fetch live status + result. Use only when the user asks "how's it going?" or after a clearly-long-enough wait. Do NOT poll on a timer; statuses cached in conversation history are stale.
- `update_async_task(task_id, message)` — send new instructions to a running build (e.g. "actually, make it 2 slides not 5"). The thread_id stays the same; the builder picks up the update mid-run.
- `cancel_async_task(task_id)` — stop a running build at the user's request.
- `list_async_tasks(status_filter?)` — recall task_ids after context compaction or when the user references "that document we started".

When `check_async_task` returns `status="success"`, the result is included in the response. The companion presents the deliverable in Sophia's voice using `companion_summary` / `companion_tone_hint` from the artifact metadata produced by `emit_builder_artifact`.

## Communication Protocol (Companion)

The companion reads `state["async_tasks"]` and the response from `check_async_task` and responds to the user as follows:

- **build still running** (status not in the terminal set): a build is in flight in this thread. Acknowledge progress briefly and stay present. Do not call `start_builder_task` again — the wrapper rejects duplicate launches; trust that and stay with the user.
- **build succeeded** (`status="success"`): present the deliverable naturally. Use `companion_summary` from the builder's artifact as the basis for what you say, shaped by `companion_tone_hint`. If `user_next_action` is populated, weave it in.
- **build errored / cancelled** (`status="error"`, `"failed"`, `"cancelled"`, `"timeout"`): say plainly that building failed; quote the short reason if it is user-meaningful (otherwise paraphrase). Offer alternatives — a tighter brief, a different `task_type`, or stopping. Do NOT call `start_builder_task` again on your own initiative; wait for the user.

The companion must not preemptively refuse a buildable request. If the user asks for a PDF, slides, chart, or report, attempt delegation first and only relay limitations after the builder reports them.

## Builder Obligations

- Always finish with `emit_builder_artifact` as the FINAL tool call. Everything after it is ignored. The harness enforces this with a hard turn cap.
- Populate `artifact_path`, `artifact_title`, `artifact_type`, and `companion_summary` on every successful run. Add `companion_tone_hint`, `user_next_action`, and `confidence` so the companion can shape the user-facing response. If web research was used, populate `sources_used` with structured `{title, url}` entries.
- The artifact path MUST point to the actual user-facing deliverable (e.g. the PDF / PPTX / final markdown file under `/mnt/user-data/outputs/`), never to a generator script. The script may appear in `supporting_files`.
- When the task cannot be completed because a required capability is missing (e.g. `pandoc` unavailable, no image-generation tool), STOP — do not loop retrying the same command. Call `emit_builder_artifact` with whatever partial deliverable is on disk, set `confidence` low, and explain the missing capability in `companion_summary`.
- Respect the hard turn cap. If the harness pauses you mid-task, that is expected — do not attempt to circumvent it.

## Crash / Timeout Posture

- The builder runs in a background subagent dispatched via deepagents `AsyncSubAgentMiddleware` over LangGraph SDK ASGI in-process transport. Timeouts and uncaught errors surface as a terminal status (`error`, `failed`, `timeout`, `timed_out`) in `state["async_tasks"][task_id]` on the next `check_async_task` call.
- The builder never retries itself on crash. Re-delegation is strictly user-initiated; the companion must wait for explicit confirmation before another `start_builder_task` call.
- The companion never hides a crash from the user. It tells them plainly that building failed and gives them agency to decide the next step.

This contract is load-bearing. Changes to `StartBuilderTaskInput`, `BuilderArtifactInput`, or the lifecycle status taxonomy must update this file in the same commit.
