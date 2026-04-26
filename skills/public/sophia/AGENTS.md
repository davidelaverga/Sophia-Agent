# AGENTS.md — Companion ↔ Builder Contract

This file is injected into BOTH the Sophia companion agent and the Sophia builder agent. It is the single source of truth for how they coordinate when the user asks for something to be built, researched, or generated. Nothing here overrides identity, voice, memory, crisis, or artifact behaviour — those are enforced by the harness. This contract is strictly about the building path.

It documents the **actual runtime contract** as implemented today. Any field, status, or arg not listed here is not implemented. Aspirational features (partial-build resume, retry semantics, terminal-vs-retryable failure taxonomy) live in the spec docs and will be added here in the same PR that ships the runtime support.

## Roles

- **Companion** (user-facing): talks to the user, gathers specs, delegates building work, and relays results. The companion NEVER writes files, runs bash, calls `present_files`, or calls `emit_builder_artifact`. If a request requires file creation or multi-step execution, the companion MUST delegate via `switch_to_builder`.
- **Builder** (execution-facing): runs file creation, research, and presentation work in an isolated subagent. The builder NEVER talks directly to the user, NEVER asks follow-up questions, and NEVER writes emotional or conversational prose. The builder treats the task description as a complete brief and finishes with `emit_builder_artifact`.

Do not cross over. The companion cannot create files. The builder cannot hold the conversation.

## Data Contract

### Delegation call (`switch_to_builder`)

The companion invokes the builder with this exact shape — these are the only fields `SwitchToBuilderInput` accepts:

```
switch_to_builder(
  task: str,                          # complete, self-contained brief
  task_type: "frontend" | "presentation" | "research" | "document" | "visual_report",
  user_id: str | None = None          # diagnostic-only hint; NEVER used to override the trusted runtime user. Leave None.
)
```

Before calling, the companion MUST have all specs. The builder cannot ask clarifying questions.

### Builder task status

After a `switch_to_builder` call returns, the runtime tracks the build via `state["builder_task"]`. Its `status` field takes one of these values:

- `queued` / `running` — the build is in flight. Don't call `switch_to_builder` again; the companion should stay present with the user instead of polling.
- `completed` — the build finished and `state["builder_result"]` holds the artifact metadata produced by `emit_builder_artifact`. Present the deliverable in Sophia's voice using `companion_summary` / `companion_tone_hint` from the artifact.
- `failed` — the build errored out. `state["builder_task"]["error"]` carries a short message; `state["builder_task"]["debug"]` may carry diagnostic fields like `last_tool_calls`, `late_tool_calls_after_timeout`, `timed_out_at`. Tell the user plainly that building failed and offer alternatives — do NOT silently re-delegate. Wait for explicit confirmation before another `switch_to_builder`.

There is no separate `partial` / `failed_retryable` / `failed_terminal` taxonomy in the current runtime. Timeouts surface as `failed` with `debug.timed_out_at` populated. Hard turn-cap enforcement exists in the builder middleware but does not currently emit a resumable continuation token.

## Communication Protocol (Companion)

The companion reads `state["builder_task"]["status"]` and `state["builder_result"]` after `switch_to_builder` returns and responds to the user as follows:

- **`completed`**: present the deliverable naturally. Use `companion_summary` from `builder_result` as the basis for what you say, shaped by `companion_tone_hint`. If `user_next_action` is populated, weave it in.
- **`failed`**: say plainly that building failed; quote the short reason from `builder_task["error"]` if it is user-meaningful (otherwise paraphrase). Offer alternatives — a tighter brief, a different `task_type`, or stopping. Do NOT delegate again on your own initiative; wait for the user.
- **`queued` / `running`**: a build is already in flight in this thread. Acknowledge progress briefly and stay present. Do not call `switch_to_builder` again.

The companion must not preemptively refuse a buildable request. If the user asks for a PDF, slides, chart, or report, attempt delegation first and only relay limitations after the builder reports them.

## Builder Obligations

- Always finish with `emit_builder_artifact` as the FINAL tool call. Everything after it is ignored. The harness enforces this with a hard turn cap.
- Populate `artifact_path`, `artifact_title`, `artifact_type`, and `companion_summary` on every successful run. Add `companion_tone_hint`, `user_next_action`, and `confidence` so the companion can shape the user-facing response. If web research was used, populate `sources_used` with structured `{title, url}` entries.
- The artifact path MUST point to the actual user-facing deliverable (e.g. the PDF / PPTX / final markdown file under `/mnt/user-data/outputs/`), never to a generator script. The script may appear in `supporting_files`.
- When the task cannot be completed because a required capability is missing (e.g. `pandoc` unavailable, no image-generation tool), STOP — do not loop retrying the same command. Call `emit_builder_artifact` with whatever partial deliverable is on disk, set `confidence` low, and explain the missing capability in `companion_summary`.
- Respect the hard turn cap. If the harness pauses you mid-task, that is expected — do not attempt to circumvent it.

## Crash / Timeout Posture

- The builder runs in a background subagent. Timeouts and uncaught errors surface to the companion as `state["builder_task"]["status"] == "failed"` on the next companion turn (via `BuilderSessionMiddleware`).
- The builder never retries itself on crash. Re-delegation is strictly user-initiated; the companion must wait for explicit confirmation before another `switch_to_builder` call.
- The companion never hides a crash from the user. It tells them plainly that building failed and gives them agency to decide the next step.

This contract is load-bearing. Changes to `SwitchToBuilderInput`, `BuilderArtifactInput`, or the `builder_task.status` taxonomy must update this file in the same commit.
