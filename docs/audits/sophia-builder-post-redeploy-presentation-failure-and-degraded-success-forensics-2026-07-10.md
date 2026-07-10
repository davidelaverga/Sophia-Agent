# Sophia Builder Post-Redeploy Presentation Failure and Degraded Success Forensics

**Date:** 2026-07-10
**Environment:** Render production, LangSmith EU project `Sophia`
**Branch:** `codex/sophia-observability-v1`
**Deployed commit:** `82c68f2cc6eb00af4c0c038b43debe2e059f2356`
**Artifact inspected:** `/Users/davidelaverga/Downloads/create-a-6-slide-technical-presentation (1).pptx`
**Artifact SHA-256:** `229906dbbcdbafc046882885e369f783d883efc9981cfabba825764436717d54`

## Executive Summary

The two presentation tasks exercised the latest deployed code. The failures were not caused by a stale Render deployment, Anthropic overload, OpenAI provider fallback, or Mem0 guidance.

The first task failed after a valid six-slide native deck reached the mechanical gate. Slide 5 was just below the sparse-render threshold, so the runtime requested its single bounded repair. That broad LLM repair introduced a new 19 px vertical overflow, causing the second and final native compilation to fail. The runtime then correctly terminated without shipping an artifact, but surfaced the generic `deck_prepare_retry_exhausted` reason instead of preserving the more useful compiler failure.

The second task completed, but it was not a provider or artifact fallback. It remained on Anthropic throughout and produced a normal native DeckBuildService artifact. It took four emitted `prepare_deck_build` calls because two calls failed Pydantic validation before entering the service, a third failed slide HTML validation, and only the fourth succeeded. Those pre-service validation failures are outside the two-result prepare state machine, allowing repeated long model correction turns while the run approached its eight-minute deadline.

The successful artifact is structurally editable but visually defective. Slides 4 and 6 lost their primary diagrams. The accepted source used inline SVG for a circular loop and two timelines, following the repository's published deck guidance. The native `html2patch` converter does not implement SVG primitives. It silently drops `<circle>`, `<line>`, and `<path>` elements, while converting SVG `<text>` as ordinary HTML text and defaulting its color to black because it reads CSS `color` rather than SVG `fill`. This exactly matches the rendered artifact: invisible geometry, black text on a dark background, and large empty regions.

The current quality gates did not catch this semantic rendering loss. They check overflow, coarse pixel density, chrome, and limited visual-contract conditions, but not text contrast, source-to-output element retention, or planned-diagram completeness. A deck can therefore pass with unreadable text and missing core diagrams. The finalizer then emits success with warnings, while also incorrectly reporting native diagrams as `visuals_not_embedded` because it only counts media, chart, and Office diagram package parts as visual evidence.

## Evidence Scope

This analysis cross-references:

- Render deploy state and production logs for `sophia-langgraph` and `sophia-gateway`.
- LangSmith EU root traces and child spans for both presentation tasks.
- Builder completion payloads and gateway terminal events.
- The attached PPTX's OOXML structure, text, colors, shapes, and rendered slides.
- The current branch implementation of prepare validation, DeckBuildService, `html2patch`, mechanical gates, evaluation, and artifact finalization.

All timestamps below are UTC.

## Deployment Validation

Both Render services were live on the branch head used for this analysis:

| Service | Deploy | Live at | Commit |
| --- | --- | --- | --- |
| `sophia-langgraph` | `dep-d98g6cjtqb8s73fjrnig` | 2026-07-10 14:40:13 | `82c68f2` |
| `sophia-gateway` | `dep-d98g6e3tqb8s73fjrsfg` | 2026-07-10 14:37:44 | `82c68f2` |

The deployment therefore contained the latest branch changes. Redeploying the same commit again would not address these failures.

## Run Summary

| Property | Attempt 1 | Attempt 2 |
| --- | --- | --- |
| Builder thread | `019f4c8f-c803-7a83-bd15-0125db582b68` | `019f4c99-8dbc-7b31-902b-7017bc4ffb82` |
| Run / trace | `019f4c8f-c808-7990-a1ad-05657bff08e6` | `019f4c99-8dbe-7373-b068-aab2948e05c6` |
| Started | 15:05:20 | 15:16:00 |
| Duration | 6m 44.7s | 7m 37.7s |
| Total tokens | 453,018 | 481,371 |
| Trace cost | $0.7650 | $0.9058 |
| Actual prepare results | 2 | 2 |
| Emitted prepare calls | 5 observed model/provider calls | 4 tool calls |
| Outcome | Failed, no artifact | Completed with warnings |
| Provider fallback | None | None |
| Artifact fallback | None | None |

Trace links:

- [Attempt 1 LangSmith trace](https://eu.smith.langchain.com/o/26b7385f-8e69-4a13-b4da-49873ae46191/projects/p/7dd40980-665a-4f4a-95c3-582e6270b707/r/019f4c8f-c808-7990-a1ad-05657bff08e6?trace_id=019f4c8f-c808-7990-a1ad-05657bff08e6)
- [Attempt 2 LangSmith trace](https://eu.smith.langchain.com/o/26b7385f-8e69-4a13-b4da-49873ae46191/projects/p/7dd40980-665a-4f4a-95c3-582e6270b707/r/019f4c99-8dbe-7373-b068-aab2948e05c6?trace_id=019f4c99-8dbe-7373-b068-aab2948e05c6)

## Attempt 1: Valid Deck, Failed Repair

### Timeline

1. The first real `prepare_deck_build` execution started at 15:08:48 on builder turn 8.
2. The creative plan was accepted for six slides with `image_strategy=diagram_native` and zero generated-image assets.
3. `html2patch` completed successfully with 109 patch operations.
4. Native inspection found 69 text shapes, 103 total shapes, zero pictures, and a native editability score of 1.0.
5. Lint and render completed. The first mechanical gate rejected slide 5 as `sparse_rendered_slide` because its non-background ratio was `0.023`, below the hard `0.025` threshold.
6. The runtime scheduled its one bounded repair and returned to the model with the real tool result.
7. The repair model turn consumed about 2m 53s.
8. The second actual prepare execution failed in `html2patch`: `05-evolution-blueprint.html` overflowed vertically by 19 px.
9. The runtime terminated with `deck_prepare_retry_exhausted`; the gateway emitted `error`, no artifact, and `fallback_reason=deck_build_service_failed`.

### What Worked

- The first compile, native inspection, lint, render, and mechanical gate all ran.
- The sparse slide was correctly prevented from shipping.
- The bounded repair limit prevented an unbounded compile loop.
- No incomplete PPTX was surfaced as success.
- The trace carried failing `builder_terminal_success=0` feedback even though LangGraph itself ended cleanly.

### What Failed

- The repair was delegated as a broad model rewrite instead of a constrained mechanical correction for slide 5.
- The repair fixed neither a deterministic property nor a bounded selector-level parameter. It introduced a different compiler failure.
- The terminal reason hid the actionable second failure. `deck_prepare_retry_exhausted` describes control flow, while `deck_native_html2patch_failed` with the 19 px overflow describes the defect.
- The run consumed more than 450,000 tokens to end with no artifact.

### Attempt 1 Root Cause

The immediate failure was a repair regression: a coarse sparse-slide gate triggered a full LLM-authored slide repair, and that repair introduced vertical overflow. The underlying design problem is that deterministic rendering failures are repaired through an unconstrained generative turn rather than a service-owned, selector-scoped operation.

## Attempt 2: Slow Native Success With Lost Diagrams

### This Was Not a Provider Fallback

The user-visible behavior resembled a fallback, but the production evidence does not show one:

- The trace contains ten `ChatAnthropic` spans and no `ChatOpenAI` span.
- The gateway completion says `artifact_is_fallback=false` and has no fallback reason.
- Image generation is `not_required`, not failed or bypassed.
- The artifact was generated by the normal native DeckBuildService path.

What did occur was the runtime's bounded prepare repair path, followed by acceptance of a warning-bearing native artifact. Provider fallback, gateway artifact fallback, and quality-degraded native success are distinct states and should remain separately observable.

### Timeline

1. The first `prepare_deck_build` call at 15:19:55 failed Pydantic validation because `slides` was passed as a JSON string rather than a list.
2. The second call at 15:21:03 failed with the same schema error.
3. The third call at 15:22:16 entered DeckBuildService but failed slide validation on slide 1:
   - canvas was not exactly 1920 x 1080 px;
   - the slide did not declare an opaque background.
4. The fourth call at 15:23:27 entered DeckBuildService and succeeded.
5. The first valid artifact arrived after 455,544 ms, only about 24 seconds before the strict 480-second deadline.
6. The gateway emitted success at 15:23:39 and uploaded the 38,647-byte PPTX that was attached for this analysis.

### Why Four Calls Were Possible

The prepare state machine recorded only service-level results:

- `prepare_call_count=4`
- `prepare_result_count=2`
- `prepare_retry_executed=true`

The first two tool argument failures occurred in Pydantic before DeckBuildService and before normal prepare result accounting. Consequently, the "at most two prepare executions" contract bounded service executions but did not bound emitted tool calls, schema-correction turns, or their wall-clock and token cost.

### Successful Service Diagnostics

The final service execution reported:

- six slides;
- native editability score `1.0`;
- 55 native text shapes in service diagnostics;
- zero pictures and zero media;
- nine lint findings and three tiny unresolved overlap residues;
- six density warnings;
- `quality_warning=native_lint_residue; deck_quality_warning`;
- mechanical gate passed with no hard failure.

Rendered non-background ratios were:

| Slide | Ratio |
| --- | ---: |
| 1 | 0.1020 |
| 2 | 0.5191 |
| 3 | 0.1784 |
| 4 | 0.0386 |
| 5 | 0.0742 |
| 6 | 0.0868 |

Slide 4 passed because `0.0386` exceeds the current `0.025` sparse threshold, even though its primary visual was missing and most of its labels were unreadable.

## Artifact Findings

### Structural Inspection

The attachment contains:

- 6 slides;
- 93 ordinary PowerPoint shapes;
- 12 connectors, all on slide 4;
- 105 total shape/connector objects;
- 0 picture shapes;
- no `ppt/media/` package entries;
- no chart parts;
- no Office diagram parts.

The deck is therefore genuinely native and editable. Its poor quality is not caused by a raster fallback.

The local geometry QA found no overflow. That is consistent with the production result but also demonstrates that geometry-only validation cannot detect missing semantics or unreadable contrast.

### Visual Inspection

- **Slide 1:** Clean but very sparse. It reads as a title card rather than a substantial technical opening.
- **Slide 2:** Two large generic panels with extensive unused space and little visual hierarchy beyond bullets.
- **Slide 3:** Three horizontal memory bands, with the lower half mostly empty apart from a thin persistence line.
- **Slide 4:** Functionally broken. The intended circular synthesis loop is absent. Most labels render black on the dark `#0B1220` background, making them effectively unreadable.
- **Slide 5:** Readable four-box pipeline, but visually thin and underdeveloped for a technical process slide.
- **Slide 6:** Functionally incomplete. The intended dual-track timelines, rails, and nodes disappear; headings and explanatory text remain over very large empty fields.

At least two of six slides lost their principal semantic diagrams. This is a rendering-contract failure, not merely an aesthetic preference.

## Exact Compiler Failure Mechanism

The accepted successful input used inline SVG:

- slide 4 used an SVG circle, lines, paths, and ten SVG text elements for a synthesis loop;
- slide 6 used two SVG timelines composed of lines and circles;
- the SVG text explicitly declared light `fill` colors;
- the source HTML did not request black diagram text.

The repository guidance in `skills/public/sophia/deck_craft.md` recommends native HTML, SVG, and CSS for architecture, process, and evidence slides. The HTML sanitizer also permits inline SVG.

However, `third_party/hands_on_deck/hands_on_deck/tools/pptx/html2patch.py` has no SVG primitive conversion path:

- `<circle>`, `<line>`, and `<path>` are traversed as ordinary DOM nodes, have no supported HTML background or border representation, and are dropped;
- SVG `<text>` is treated as an HTML text block;
- text styling reads CSS `color`, not the SVG `fill` attribute;
- when CSS color is absent, the converter defaults the text color to `000000`.

This produces the exact artifact observed:

1. SVG geometry disappears.
2. SVG labels survive as ordinary text.
3. Their light SVG fill is ignored.
4. They become black on a near-black slide.

The model followed the documented authoring contract, while the compiler implemented a narrower contract. The sanitizer and validator accepted content that the converter could not faithfully represent.

## Why Existing Gates Accepted the Bad Deck

### 1. Sparse Rendering Is a Coarse Pixel Threshold

`mechanical_gates.py` hard-fails a rendered slide only when its non-background ratio is below `0.025`. Slide 4's remaining text and connectors produced `0.0386`, enough to pass despite the absent loop and unreadable labels.

The threshold is not slide-role aware. A sparse cover may be valid, while a process, architecture, or timeline slide with the same density is likely incomplete.

### 2. There Is No Contrast Gate

The mechanical gate does not calculate text/background contrast. Its dark/light check only targets a different failure mode on majority-light decks. It cannot identify black text on a dark background.

### 3. There Is No Semantic Retention Gate

The runtime does not compare source visual elements or creative-plan commitments with native output and rendered evidence. It therefore cannot detect that SVG circles, paths, and timeline rails disappeared.

### 4. Density Is Only a Warning

The evaluator's hard checks are overflow, chrome, and visual contract. Density is soft. All six slides can receive density warnings while the deck still returns `passed=true`.

### 5. Warning-Bearing Artifacts Still Ship as Success

DeckBuildService merges lint and evaluator warnings into the result, but its accepted-artifact finalizer uploads and completes the artifact when no configured hard failure is present. The current warnings describe degraded quality but do not block success.

### 6. Lint Residue Wiring Is Inconsistent

The native service returns flat fields such as `lint_residue_count`. The mechanical gate helper expects a nested `lint_fix.residue_count` object. As a result, native residue is not converted into mechanical-gate issues. The three residues in this artifact were tiny and not the central defect, but the mismatch makes the gate less trustworthy.

## Observability Defects

### False `visuals_not_embedded`

The artifact finalizer counts PPTX visual evidence only when the package contains media, charts, or Office diagram parts. Native PowerPoint shapes and connectors do not count. This deck deliberately used `diagram_native` with zero expected generated images, yet final diagnostics marked `visuals_missing=true` and capped confidence at 0.65.

This is a false positive. A native diagram can be valid without media, but it needs shape-level and rendered-quality evidence.

### Stale Picture Count

Legacy completion logic assigns a PPTX generator picture count equal to slide count on successful output. The trace therefore reports a generator picture count of six even though inspection found zero pictures and no media. That field was appropriate for the old full-slide raster route, not the native D2 route.

### Control-Flow Reason Replaces Root Failure

Attempt 1 ended as `deck_prepare_retry_exhausted`, obscuring the final actionable error `deck_native_html2patch_failed` and its 19 px overflow. Terminal payloads should carry both:

- stable control-flow reason, such as `prepare_retry_exhausted`;
- terminal failure code and stage from the last authoritative service result.

### LangSmith Root Status Semantics

Attempt 1's LangGraph root span is technically `success` because the graph terminated cleanly, while builder metadata and gateway status correctly indicate failure. The existing failing feedback is useful, but dashboards must filter on authoritative `terminal_status`, `terminal_reason`, and feedback rather than raw LangSmith run status alone.

## Mem0 Assessment

The first run injected five relevant memories, including self-improving harness context, prior presentation preferences, and a preference for dark, highly visual decks. These memories aligned with the task and creative direction.

There is no evidence that memory caused either failure:

- attempt 1 failed on a deterministic sparse threshold followed by repair overflow;
- attempt 2 failed schema and canvas validation before succeeding;
- the final visual damage maps exactly to unsupported SVG conversion.

No memory changes are recommended for this incident.

## Root Cause Ranking

### P0: Published SVG Contract Is Not Implemented

Inline SVG is encouraged and accepted, but not faithfully compiled. This directly caused the broken successful artifact and can affect any process, architecture, loop, or timeline slide that uses SVG primitives.

### P0: Quality Gates Do Not Detect Semantic Rendering Loss

The gate can pass missing diagrams and unreadable text because it lacks contrast and source-to-output retention checks. This converts a deterministic compiler defect into a user-visible success.

### P1: Tool Schema Failures Escape Prepare Attempt Accounting

Two malformed `slides` arguments triggered two expensive correction cycles before the bounded service state machine began. This explains most of the second task's long runtime and leaves the 12-turn/eight-minute contract too dependent on the model correcting tool arguments promptly.

### P1: Repair Is Too Generative for Mechanical Failures

Attempt 1's sparse-slide repair introduced overflow. Deterministic failures need constrained, selector-scoped repairs or service-owned transforms.

### P1: Warning Policy Allows Clearly Degraded Success

Six density warnings, missing semantic diagrams, native lint residue, and unreadable text did not prevent upload. The current warning model is too permissive for presentation artifacts.

### P2: Diagnostics Mix Native and Legacy Raster Semantics

False `visuals_not_embedded`, a fabricated six-picture count, and ambiguous use of "fallback" make the incident harder to classify and can drive incorrect runtime decisions.

## Recommended Fix Direction

### 1. Close the SVG Contract Gap Immediately

For the short-term production fix, reject inline SVG in `.pptx` slide HTML before compilation with a retryable, selector-specific error such as `deck_svg_not_native_convertible`. The repair instruction should require supported HTML/CSS boxes, borders, text, and connectors.

Do not silently accept SVG until `html2patch` supports the required primitives. Longer term, implement native conversion for at least SVG line, rect, circle, path, text, fill, stroke, stroke width, and transforms, backed by render-equivalence tests.

Update `deck_craft.md`, sanitizer behavior, validator behavior, and compiler capability from one shared supported-feature contract so they cannot drift independently.

### 2. Make Slide Arguments Typed and Normalizable

Introduce a typed `DeckSlideInput` model for selector, role, title, and HTML source. Add a bounded pre-validator that can safely parse a JSON-encoded list when the model sends one, with input size and nesting limits.

Count pre-service schema failures in prepare diagnostics and cap them. A malformed call should receive at most one deterministic normalization/correction opportunity rather than another unrestricted multi-minute model turn.

### 3. Add Semantic and Contrast Gates

Before normal success, require:

- WCAG-style contrast checks for native text against its effective local background;
- per-slide source-to-native retention counts for supported visual primitives;
- creative-plan commitments matched to actual native shapes and rendered evidence;
- hard failure when process, architecture, loop, or timeline slides lose their planned structure;
- role-aware density thresholds, with looser cover treatment and stricter content-slide treatment.

For any source construct that cannot be measured or converted, fail before upload instead of issuing a soft warning.

### 4. Make Repair Deterministic and Selector-Scoped

Move common mechanical repairs into DeckBuildService:

- overflow: reduce padding, gap, or font size only within the failing selector and bounded limits;
- sparse content slide: request or insert a supported native composition, not a full-deck rewrite;
- unsupported SVG: convert from a supported declarative diagram model or request an HTML/CSS rewrite for that slide only;
- low contrast: apply a palette-safe text color correction.

Preserve one bounded model repair for semantic changes, but prevent it from rewriting unaffected slides and require the repaired slide to pass the original gate plus compiler validation.

### 5. Promote Severe Quality Warnings to Terminal Failure

Do not emit normal success when any of these remain after the bounded repair:

- unreadable or low-contrast text;
- planned diagram primitives missing from output;
- unsupported source constructs dropped by conversion;
- every content slide receives a density warning;
- native rendering reports a semantic-retention warning.

Return a clean, reason-specific failure rather than a low-confidence artifact that is technically editable but unusable.

### 6. Correct Native Observability

- Count native shapes and connectors as visual evidence when the accepted plan uses `diagram_native` and expects no generated images.
- Remove the legacy `picture_count=slide_count` assignment for native output.
- Preserve `artifact_is_fallback=false`; add a separate `degraded_quality` or `quality_gate_status` field.
- Read the actual flat native lint residue fields or standardize the report schema.
- Record `prepare_schema_failure_count`, `prepare_service_call_count`, and `prepare_emitted_call_count` separately.
- Preserve the final service failure code alongside the state-machine terminal reason.

## Proposed Delivery Sequence

1. Add a regression fixture containing the exact slide 4 circular SVG and slide 6 timeline SVG patterns from this run.
2. Implement and test the immediate SVG rejection/repair contract.
3. Add typed slide inputs and bounded JSON-string normalization.
4. Add contrast, semantic-retention, and role-aware density gates.
5. Replace broad mechanical repair with selector-scoped service repair where deterministic.
6. Correct native visual and prepare-call diagnostics.
7. Run focused deck/runtime tests, the AGENTS.md builder/gateway sweep, the full backend suite, and Sentrux.
8. Deploy and execute two six-slide production canaries.

## Post-Deploy Acceptance Criteria

Each canary should satisfy all of the following:

- first real prepare begins by turn 8 or 120 seconds;
- total runtime remains below 480 seconds;
- no more than one normalized schema correction;
- every emitted prepare call has a matching accounted result or schema failure;
- no unsupported SVG is silently dropped;
- zero low-contrast text runs;
- planned process/timeline/architecture elements are retained in native and rendered output;
- no content slide passes solely because it barely exceeds a global sparse-pixel threshold;
- no all-slide density-warning success;
- gateway, builder metadata, LangSmith feedback, and artifact fallback fields agree;
- failed canaries return the authoritative compiler or quality failure code, not only a retry-exhaustion wrapper.

## Conclusion

The latest runtime stabilization work successfully bounded service retries and prevented the first invalid deck from shipping. It did not yet make deck compilation deterministic end to end. Tool schema errors can still create expensive correction loops before service accounting, and the native compiler accepts a documented SVG authoring pattern that it cannot preserve.

The highest-value next change is not another timeout adjustment or provider fallback. It is to make the authoring contract, converter capabilities, and terminal quality gates agree. Until SVG is either supported or rejected, and until semantic loss and contrast are hard-gated, production can continue to return structurally valid but visually broken decks as successful artifacts.
