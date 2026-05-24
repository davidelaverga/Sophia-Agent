# Phase 12.5C-B2 - Companion Artifact Routing / Builder Avoidance

Date: 2026-05-22
Status: implemented narrow routing-policy fix and focused tests; no artifact schema or orientation bridge change
Source branch: `test/artifact-visibility-proof-harness-phase-12-5c-b`
Working branch: `fix/companion-artifact-routing-builder-avoidance-phase-12-5c-b2`

## Why This Phase Exists

Phase 12.5C-B added code-path proof helpers for artifact visibility, but the first live Gemini smoke did not create a successful companion artifact. The user asked Sophia to create a short reflection artifact; Sophia shifted into Builder language, called builder lifecycle tools, and the `emit_artifact` call did not complete its provider `toolResponse` send-back.

That made the visibility question inconclusive. A model cannot prove it can see the previous artifact until the runtime can reliably produce one valid companion artifact without Builder hijacking the turn.

Non-goals preserved: no compact artifact orientation bridge, no 15-field migration, no artifact schema change, no Gemini/GPT routing default change, no VAD or turn-detection change, no `consult_skill`, no ritual tools, no memory writeback, no Builder storage/UI rewrite, no web tools, no full checkpointer replay, no full conversation-history injection, no full system-prompt rewrite, and no `users/**` or `backend/users/**` edits.

## Live Smoke Failure

Observed Gemini smoke:

- User: `Hey Sophia, create a short reflection artifact.`
- Sophia asked what idea to capture.
- User: `I just want to see the functionality working. So, please create a short reflection artifact.`
- Sophia replied that a build was starting for a reflection document.
- Later replies were Builder-like: `It's still building`, `Still running`, and `I'm watching for it.`
- The follow-up visibility probe, `without guessing what was your previous internal takeaway?`, could not be answered from a previous artifact.

Telemetry showed `artifactToolCallCount: 1`, `artifactCount: 0`, `builderToolCallCount: 3`, a `start_builder_task` response, two `check_async_task` calls, and an `emit_artifact` response suppressed after cancellation.

## Root Cause

The primary failure was model-visible ambiguity, not a missing UI renderer.

- `artifact` meant two things in the prompt/tool surface: Sophia's companion `emit_artifact` state record, and Builder's user-facing deliverable artifact.
- `start_builder_task` described broad `build/create/generate/research/present` handling, including documents and file creation.
- The injected companion-builder contract said fresh create/build/generate requests should call `start_builder_task` first, without explicitly excluding companion/session artifacts.
- `emit_artifact` was described as required internal metadata, but not as the route for user requests such as `create a short reflection artifact` or artifact-functionality tests.
- Declaration order already placed `emit_artifact` before Builder tools, so order was not the main suspect.
- The deterministic `BuilderCommandMiddleware` did not match the exact phrase because it requires a document-like noun and an `about/on` topic; the live hijack was the model choosing Builder from prompt/tool semantics.

The cancellation behavior itself was consistent with current Gemini safety rules: a Gemini `toolCallCancellation` marks the function call id as cancelled, backend completion after that point is recorded as stale, and the browser must not send a late `toolResponse`. This phase did not weaken that guard.

## Boundary

Companion artifact / `emit_artifact`:

- short reflection artifact;
- artifact-functionality test;
- session takeaway;
- emotional or meta-assessment;
- internal orientation;
- Presence artifact UI/session card.

This path is lightweight, synchronous, and not framed as a document build. A simple request such as `Create a short reflection artifact` belongs here.

Builder / `start_builder_task`:

- user asks for a document, file, report, markdown draft, slides, presentation, visual report, frontend, or downloadable artifact;
- user asks for a deliverable that may take async execution or external storage;
- user explicitly asks to build a reflection document or file.

If the word `artifact` is ambiguous, Sophia should ask one clarifying question instead of starting Builder.

## Fix

The fix is intentionally narrow:

- `emit_artifact` tool descriptions now name lightweight companion/session artifacts, short reflection artifacts, session takeaways, internal orientation, and Presence artifact UI state.
- Builder lifecycle descriptions now exclude lightweight companion/session artifacts and tell the model to ask one clarifying question when artifact-vs-document intent is ambiguous.
- The injected companion-builder contract now has an explicit `Companion Artifact vs Builder Deliverable` section and a compact routing rule: short reflection artifact -> `emit_artifact`; document/file/report/build/downloadable deliverable -> Builder; ambiguous artifact wording -> ask one clarifying question.
- The voice artifact prompt block now carries the same boundary so realtime setup has the policy even when the user uses the word `artifact` directly.

No schema fields, tool names, provider defaults, VAD settings, Builder storage, UI surfaces, or cancellation semantics changed.

## Tests

Focused coverage added or strengthened:

- Gemini declaration test asserts `emit_artifact` covers short reflection/session artifacts and that `start_builder_task` excludes them.
- Prompt test asserts the runtime prompt contains the three-way routing policy.
- Builder deterministic fast-path test asserts `Create a short reflection artifact.` is not pre-routed to Builder.
- Gemini relay test asserts a simulated `emit_artifact` call returns a `toolResponse`, emits public `sophia.artifact`, records completed diagnostics, and does not invoke Builder.

Existing cancellation tests remain unchanged and continue to assert stale `toolResponse` suppression after Gemini cancellation.

## Manual Smoke Plan

Smoke 1 - Companion artifact creation:

User: `Create a short reflection artifact.`

Expected: direct `emit_artifact`, no Builder, public `sophia.artifact`, `artifactCount >= 1`, `builderToolCallCount = 0`, and no successful-artifact `cancelled_before_tool_response_send`.

Smoke 2 - Functionality phrasing:

User: `I just want to test the artifact functionality. Please create a short reflection artifact.`

Expected: same as Smoke 1.

Smoke 3 - Explicit Builder distinction:

User: `Build me a reflection document I can download later.`

Expected: Builder is allowed and appropriate.

Smoke 4 - Resume visibility proof:

Only after Smoke 1 succeeds, ask: `Sophia, without guessing, what was your previous internal takeaway?`

Expected: now the 12.5C-B artifact visibility question is valid. If Sophia cannot answer the actual prior takeaway, 12.5C-C should implement a compact latest-artifact orientation bridge. If she answers accurately, native function-call/tool context may be enough.

## Deferred Work

- Compact artifact orientation bridge.
- 15-field artifact migration.
- Reconnect/reseed latest-artifact summary.
- `consult_skill`, ritual tools, time tools, web tools, or memory writeback.
- Broader Builder artifact storage/UI changes.

## Most Important Next-Prompt Context

12.5C-B2 fixes the precondition for artifact visibility proof: simple short reflection artifact requests should route to `emit_artifact`, not Builder. The successful path is model `toolCall.args` -> backend validation/tool response -> public `sophia.artifact`; public artifacts remain UI/telemetry only and are not an orientation bridge. Cancellation suppression is unchanged: do not send a stale Gemini `toolResponse` after `toolCallCancellation`.