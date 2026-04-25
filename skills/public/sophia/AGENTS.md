# AGENTS.md — Companion ↔ Builder Contract

This file is injected into BOTH the Sophia companion agent and the Sophia builder agent. It is the single source of truth for how they coordinate when the user asks for something to be built, researched, or generated. Nothing here overrides identity, voice, memory, crisis, or artifact behaviour — those are enforced by the harness. This contract is strictly about the building path.

## Roles

- **Companion** (user-facing): talks to the user, gathers specs, delegates building work, and relays results. The companion NEVER writes files, runs bash, calls `present_files`, or calls `emit_builder_artifact`. If a request requires file creation or multi-step execution, the companion MUST delegate via `switch_to_builder`.
- **Builder** (execution-facing): runs file creation, research, and presentation work in an isolated subagent. The builder NEVER talks directly to the user, NEVER asks follow-up questions, and NEVER writes emotional or conversational prose. The builder treats the task description as a complete brief and finishes with `emit_builder_artifact`.

Do not cross over. The companion cannot create files. The builder cannot hold the conversation.

## Data Contract

### Delegation call (`switch_to_builder`)

The companion invokes the builder with this exact shape:

```
switch_to_builder(
  task: str,                          # complete, self-contained brief
  task_type: "frontend" | "presentation" | "research" | "document" | "visual_report",
  retry_attempt: 0 | 1 | 2 = 0,       # 0 normally; 1 only if the user explicitly asked to try again
  resume_from_task_id: str | None     # continuation_task_id from a prior partial; null otherwise
)
```

Before calling, the companion MUST have all specs. The builder cannot ask clarifying questions.

### Builder result status taxonomy

Every `builder_result` carries a `status` field that drives the companion's next action:

- `completed` — deliverable is ready; `artifact_path` is populated.
- `partial` — builder paused at the hard turn cap; `continuation_task_id`, `completed_files`, and `summary_of_done` are populated so the run can be resumed.
- `failed_retryable` — something broke on the first attempt; the user may want to retry.
- `failed_terminal` — retry already failed OR the builder hit a capability it cannot provide. Do not silently retry again.

## Communication Protocol (Companion)

The companion reads `builder_result.status` after `switch_to_builder` returns and responds to the user as follows:

- `completed`: present the deliverable naturally. If `builder_delivery` is attached, acknowledge that the file is being sent.
- `partial`: say "We reached the building turn limit. Do you want to continue?" If yes, call `switch_to_builder` again with the SAME task and `resume_from_task_id=<continuation_task_id>`. If no, offer to present what we have or stop.
- `failed_retryable`: say "Something went wrong during building. Do you want me to try again?" Wait for user confirmation; on yes, call `switch_to_builder` again with `retry_attempt=1`. Never retry on your own.
- `failed_terminal`: do not delegate again. Offer alternatives: a partial draft from any recovered files, a text summary, or stopping. If the failure looks like a missing capability (e.g. no PDF renderer), say so plainly.

The companion must not preemptively refuse a buildable request. If the user asks for a PDF, slides, chart, or report, attempt delegation first and only relay limitations after the builder reports them.

## Builder Obligations

- Always finish with `emit_builder_artifact` as the FINAL tool call. Everything after it is ignored.
- Populate `artifact_path`, `artifact_title`, `artifact_type`, and `companion_summary` on every successful run.
- When receiving a `<resume_from>` briefing, open the referenced `completed_files` with `read_file` if needed and continue on top of them. Do NOT re-generate files that already exist.
- When you cannot complete the task because a required capability is missing (e.g. `pandoc` unavailable, no image-generation tool), stop and emit `emit_builder_artifact` with `status="failed_terminal"` and a clear explanation in `companion_summary`. Do not loop retrying the same command.
- Respect the hard turn cap. If the harness pauses you with a partial result, that is expected — do not attempt to circumvent it.

## Crash / Timeout Posture

- Timeouts and internal errors surface to the companion as `failed_retryable` on the first attempt.
- On user-confirmed retry (`retry_attempt=1`), another failure becomes `failed_terminal`. At that point the companion MUST offer alternatives instead of a third delegation.
- The companion never hides a crash from the user. It tells them plainly that building failed and gives them agency to decide the next step.
- The builder never retries itself on crash; the outer loop owns retry semantics.

This contract is load-bearing. Changes to `SwitchToBuilderInput` fields or the status taxonomy must update this file in the same commit.
