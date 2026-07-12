# Sophia Production Presentation and PDF Regression Forensics

**Investigation window:** 2026-07-12 02:00-04:00 UTC

**Branch:** `codex/sophia-observability-v1`

**Production commits observed:** `18fa56e8`, then `5201c1e4`

**Evidence:** Render production logs, LangSmith EU traces, the downloaded PDF, current code and tests, commit history, prior audit reports, and four earlier downloaded PDFs

**Security note:** no API keys, authorization headers, raw provider payloads, or source document content are included in this report.

## Executive Summary

Two independent regressions are active.

1. **Presentations fail deterministically before authoring begins.** A July 11 change adds `max_retries=0` to per-invocation `model_settings`. LangChain forwards that dictionary into Anthropic's Messages API request, where `max_retries` is not a valid request parameter. Every tested presentation therefore dies on its first main model call with `AsyncMessages.create() got an unexpected keyword argument 'max_retries'`. The failure occurs before `prepare_deck_build`, before `DeckBuildService`, and before any deck content or artifact is produced.

2. **PDF reports ship the first partial HTML draft as a completed report.** Both PDF requests ended with a detached `Length: N-M pages` clause. The target parser only recognizes a range when an output noun or verb is within a short local context window, so both explicit ranges were dropped. Once the model wrote its first syntactically complete HTML file, the middleware forced `render_html_to_pdf`; once Chromium produced any readable PDF, it forced emit. There is no semantic gate for required sections, figures, conclusion, or references. The resulting 3- and 4-page drafts were delivered as success even though their own completion summaries explicitly said they were incomplete.

The downloaded PDF is not missing a cover. Its first page is polished and visually strong. The true regression is that the artifact stops after the cover, table of contents, and executive summary. The current `cover_missing` signal is also a false positive: it measures whether image-generation enrichment succeeded, not whether the rendered PDF visibly contains a cover.

These are not transient provider failures. The presentation exception reproduced across two deployments and three independent runs. The PDF behavior reproduced twice with different styling instructions. Both defect families remain present on the latest branch head inspected during this investigation.

## Severity and User Impact

| Finding | Severity | Confidence | User impact |
|---|---:|---:|---|
| Invalid `max_retries` request parameter crashes every presentation main-model call | P0 | Confirmed | 100% immediate presentation failure on the tested route |
| Explicit PDF page ranges are silently discarded | P0 | Confirmed | A 12-18 page request can pass as a 3-4 page PDF |
| First valid HTML write is treated as final report source | P0 | Confirmed | Partial outline/draft is rendered before the model finishes its todo plan |
| No semantic completeness contract for report sections and requested figures | P0 | Confirmed | TOC promises content that does not exist; missing body is not rejected |
| Completion truth allows `completed` plus `terminal_reason=pdf_generation_failed` | P0 | Confirmed | Gateway and LangSmith surface product failure as success |
| PDF blank-page check is defeated by footer page numbers | P1 | Confirmed | A visually empty page is reported as nonblank |
| PDF visual gate is boolean, not count-aware | P1 | Confirmed | One SVG can satisfy a request for four or more diagrams |
| `cover_missing` is an enrichment proxy, not rendered-cover inspection | P1 | Confirmed | Strong authored covers are mislabeled missing |
| Tests assert the invalid presentation setting instead of exercising provider serialization | P1 | Confirmed | Unit suite encoded the regression as expected behavior |

## Production Timeline

### Deployments

| Service | Deployment | Commit | Live time (UTC) |
|---|---|---|---|
| LangGraph | `dep-d99furm7r5hc73b7afqg` | `5201c1e4` | 02:48:07 |
| Gateway | `dep-d99fut67r5hc73b7akf0` | `5201c1e4` | 02:46:11 |
| Previous LangGraph/Gateway | prior live deploys | `18fa56e8` | approximately 02:09-02:11 |

Commit `5201c1e4` only changes gateway completion preservation and companion wakeup behavior. It does not alter presentation model invocation or PDF authoring. The redeploy therefore could not fix either regression.

### Runs

| Artifact | Task ID | Run/trace ID | Commit | Duration | Result |
|---|---|---|---|---:|---|
| 6-slide presentation #1 | `019f5421-a80a-7e83-bf59-47709fe8060f` | `019f5421-a80d-72d2-9a36-a6bfbbdfda9d` | `18fa56e8` | 1.55 s | Failed before first main provider request |
| 6-slide presentation #2 | `019f5421-ed09-7872-bd60-cde7a76545dc` | `019f5421-ed0c-73a3-9058-b9ee3124ace4` | `18fa56e8` | 3.10 s | Same exception; brief extraction had succeeded first |
| Markdown source document | separate builder task | root trace in the same window | `18fa56e8` | completed | Source document successfully emitted |
| PDF report #1 | `019f542a-b4ad-7772-846e-a469c7c41857` | `019f542a-b4af-7340-8005-8841ddeb5498` | `18fa56e8` | 98.15 s | 4-page incomplete draft delivered as success |
| PDF report #2 | `019f5431-59b4-75f1-8a2e-8cf37e389f39` | `019f5431-59b6-7f00-a65d-544da3d054c8` | `18fa56e8` | 99.75 s | 3-page incomplete draft delivered as success |
| 4-slide presentation #3 | `019f5470-11fa-7100-94f6-25510272180d` | `019f5470-1201-7ba2-8999-3ad193f2b549` | `5201c1e4` | 1.49 s | Same exception after redeploy |

All six LangSmith root runs in the window are marked `success` at the graph level. Three presentation roots contain a failed builder result, and both PDF roots contain contradictory completion fields. Clean LangGraph termination is therefore masking product-level failure unless an operator inspects nested outputs.

## Finding 1: Presentation Calls Carry an Invalid Anthropic Parameter

### What happened

Every presentation reaches the correct `deck_build_service` route and selects Anthropic `claude-sonnet-5`. On the first main model turn, before the HTTP request is sent, the call fails with:

```text
TypeError: AsyncMessages.create() got an unexpected keyword argument 'max_retries'
```

The error appears on the `ChatAnthropic` span and propagates through the model middleware chain. No `prepare_deck_build` call is emitted, no service execution starts, and no artifact exists.

### Root cause

Commit `d6d803f0` (`fix(builder): stabilize presentation runtime authoring`, 2026-07-11) introduced this request mutation in `builder_artifact.py`:

```python
settings = {
    **request.model_settings,
    "max_tokens": presentation_authoring_max_tokens(state),
    "timeout": float(timeout_seconds),
    "max_retries": 0,
}
return request.override(model_settings=settings)
```

`max_tokens` and request timeout are invocation settings. `max_retries` is not an Anthropic Messages API field; it belongs on the LangChain/model client configuration. The builder already configures the model client with `max_retries=1` in `builder_agent.py`. Injecting it again through per-call settings causes LangChain Anthropic to forward an unsupported keyword to `AsyncMessages.create`.

Code pointers:

- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:9846-9852`
- `backend/packages/harness/deerflow/agents/sophia_agent/builder_agent.py:141-148`
- `backend/tests/test_deck_prepare_runtime.py:272-289`

### Why tests missed it

`test_presentation_model_request_is_bounded_by_authoring_deadline` explicitly asserts that `request.model_settings["max_retries"] == 0`. The test validates dictionary shape only. It never invokes a real `ChatAnthropic` request builder or a strict provider stub that rejects unknown Messages API parameters. The test therefore codified the invalid field as correct behavior.

### Misclassification

The terminal result says:

- `failure_code=deck_authoring_model_failed`
- `root_failure_summary=Presentation authoring exceeded its bounded model budget before prepare_deck_build.`

No budget was exceeded. The call failed in about 1.5 seconds due to invalid local configuration. This message sends operators toward latency/token tuning instead of the deterministic request-construction bug.

## Finding 2: PDF Page Targets Were Lost

### What happened

The requests explicitly ended with:

- `Length: 12-16 pages.`
- `Length: 14-18 pages.`

In both root traces:

- `builder_pdf_requested_page_count=null`
- `requested_min_pages=null`
- `requested_max_pages=null`

The render results therefore had no target bounds. A 4-page and a 3-page result could return `layout_quality=ok` even though they were far below the explicit request.

### Root cause

`_page_target_is_output_context` inspects only the 100 characters before and after a page-count match. A detached `Length:` clause is accepted only if an output noun/verb such as `report`, `PDF`, or `create` is still within that local window. In these long prompts, the nearest such noun is more than 100 characters away.

The parser reproduces the failure locally:

```text
Length: 12-16 pages. => {}
Length: 14-18 pages. => {}
```

It succeeds when the noun is nearby (`Create a professional PDF report. Length: 12-16 pages.`), confirming that the range regex works and the context heuristic is the defect.

Code pointers:

- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py:356-405`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py:448-480`
- `backend/tests/test_sophia_visual_quality_v31.py:369-530`

The existing parser tests cover many source-vs-output ambiguities but do not cover a standalone `Length:` field at the end of a long artifact brief.

## Finding 3: The First HTML Write Became the Final Report

### Trace sequence

Both PDF runs followed nearly the same path:

1. Read the PDF and visual-design skills.
2. Perform web research.
3. Create a todo plan that still listed full report authoring and rendering as incomplete.
4. Spend one long model turn writing a closed HTML document.
5. On the next model turn, middleware sees an HTML source and forces `render_html_to_pdf`.
6. Chromium returns a technically readable PDF.
7. Middleware forces `emit_builder_artifact`.

The first run also spent one tool call on an invalid todo payload, but recovered immediately. That validation error is incidental and does not explain the incomplete output.

### Produced source was visibly partial

| Metric | PDF #1 | PDF #2 |
|---|---:|---:|
| HTML size | 11,724 characters | 11,757 characters |
| `<section>` tags | 3 | 3 |
| Heading tags | 5 | 3 |
| Inline SVG figures | 1 | 0 |
| Closed `</html>` | Yes | Yes |
| Requested major body sections | 6 plus front/back matter | 6 plus front/back matter |
| Requested diagrams/charts | at least 4 | at least 4 |

Syntactic closure was mistaken for semantic completion.

### Root cause

`_pdf_render_source_tool_choice_for_state` forces rendering whenever a preferred HTML source exists and no render has yet been attempted. It has no notion of draft/final state, expected section inventory, todo completion, or minimum authoring completeness.

`_pdf_terminal_tool_choice_for_state` then forces emit whenever a render succeeded and no layout repair is required. `_successful_pdf_ready_to_emit` checks file existence and technical layout state, not report semantics.

Code pointers:

- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:3712-3723`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:8739-8761`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:9295-9318`

The model is not the primary failure here. In both runs, it accurately reported that the draft was incomplete. The control plane overrode that knowledge and delivered anyway.

## Finding 4: Renderer Quality Gates Are Mechanical, Not Semantic

The HTML renderer reports:

| Metric | PDF #1 | PDF #2 |
|---|---:|---:|
| PDF bytes | 63,884 | 53,164 |
| Pages | 4 | 3 |
| Raster images | 0 | 0 |
| Visible vector visuals | 1 | 0 |
| Layout quality | `ok` | `ok` before visual repair |
| Short pages | 3 | 1 |
| Blank pages | 0 | 0 |

These metrics answer "can Chromium and pypdf read the file?" They do not answer "does the report contain the requested content?"

Specific gaps:

- No section/headline inventory is compared with the requested structure.
- No conclusion/references/abstract/TOC consistency check exists.
- Visual validation is boolean: `image_count > 0 or vector_visual_count > 0`. One SVG satisfies any number of requested figures.
- A TOC can list sections absent from the body.
- The page quality function returns `ok` for a short PDF when target bounds are absent.
- The blank-page threshold is `word_count <= 1`. Chromium adds a footer page number, so a visually empty page contains enough extracted tokens to evade the blank count.

The attached PDF demonstrates the last point. Page 2 is visually empty except for the footer, yet `blank_page_count=0`.

Code pointers:

- `backend/packages/harness/deerflow/sophia/tools/render_markdown_to_pdf.py:206-208`
- `backend/packages/harness/deerflow/sophia/tools/render_markdown_to_pdf.py:247-270`
- `backend/packages/harness/deerflow/sophia/tools/render_markdown_to_pdf.py:273-329`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:4690-4707`

## Finding 5: Completion Status Is Internally Contradictory

### PDF #1 root output

- `status=completed`
- `terminal_status=completed`
- `terminal_reason=pdf_generation_failed`
- `confidence=0.3`
- Summary: only cover, TOC, and executive summary exist; six sections and all requested diagrams are missing; "This is an incomplete draft."

### PDF #2 root output

- `status=completed`
- `terminal_status=completed`
- `terminal_reason=pdf_generation_failed`
- `confidence=0.2`
- `quality_warning=visuals_not_embedded`
- Summary: "Draft not ready - continuing to build the full report with diagrams before final delivery."

The second sentence is especially severe: a nonterminal progress message was persisted as the final completion summary and delivered.

### Root cause

`_apply_artifact_request_metadata` declares any artifact with a path completed unless its raw status already says failed/timed out. It then uses `fallback_reason` as `terminal_reason` without reconciling the contradiction. `_canonicalize_pdf_artifact_path` always calls this helper with `fallback_reason="pdf_generation_failed"`, even for a canonical PDF path.

The gateway only coerces success to failed when no artifact path/URL exists. A partial PDF has a path, so it remains a public success.

Code pointers:

- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:3385-3407`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:7982-7997`
- `backend/app/gateway/workers/builder_canvas.py:280-300`

LangSmith has the same truth gap: all affected root runs are `success` because LangGraph exits cleanly. The authoritative terminal status and reason need to be attached to indexed root metadata/tags and failing feedback, not only buried in outputs.

## Artifact Inspection and Historical Comparison

### Current downloaded PDF

`convert-the-ai-agent-memory-systems-mark.pdf` is a valid 63,884-byte, 4-page PDF with approximately 458 extracted words.

Visual inspection found:

- Page 1: polished dark cover with title, subtitle, memory-tier diagram, scope, references, and date.
- Page 2: effectively blank except for footer pagination.
- Page 3: table of contents that promises sections not present in the file.
- Page 4: executive summary and one comparison table.
- Missing: all six requested main content sections, implementation pseudocode, conclusion/references body, and the requested architecture/trade-off/read-write diagrams.

The root result's `cover_missing` condition is false for this artifact.

### Earlier downloaded report artifacts

| Artifact date/name | Pages | Approx. extracted words | Bytes | Cover observation |
|---|---:|---:|---:|---|
| Current AI Agent Memory Systems | 4 | 458 | 63,884 | Strong authored dark cover |
| Jun 24 JEPA technical report | 10 | 2,479 | 318,610 | Clean dark title cover |
| Jun 25 DeepAgents research report | 8 | 1,481 | 338,711 | Rich illustrated dark cover |
| Jun 26 Self-Improving Harnesses report | 11 | 1,634 | 177,585 | Rich illustrated dark cover |
| Jun 22 DeerFlow report | 6 | 966 | 501,092 | Clean dark title cover |

The historical evidence supports a real completeness regression: earlier reports consistently carried 2.0-5.4 times more extracted text and 1.5-2.75 times more pages than the current artifact. Cover quality itself is not uniformly regressed in the available current artifact; the control plane's `cover_missing` telemetry is simply not measuring rendered cover quality.

Prior audits also show that earlier report failures centered on page-count oscillation, visual grammar repetition, and HTML print fidelity. They did not show the current "first three sections are enough to emit" behavior as the dominant failure:

- `docs/audits/sophia-builder-observability-forensics-2026-06-24.md`
- `docs/audits/sophia-agentic-rl-artifact-forensics-2026-06-24.md`
- `docs/audits/sophia-builder-deck-failure-and-pdf-render-forensics-2026-06-26.md`

## Commit Attribution

| Commit | Attribution |
|---|---|
| `8865413c` (Jun 25) | Introduced HTML-to-PDF and the source-exists/render-success force flow. It established the current mechanical render contract but did not add semantic completeness. |
| `5da2841f`, `1c699e4c` (Jun 25-26) | Improved PDF render fidelity, cover CSS, vector detection, and page-count repair. These made earlier reports more visually reliable but still did not add a content manifest. |
| `f4e6e6d7` plus later parser patches | Added and refined page-target extraction. Source-vs-output protections became sophisticated, but a detached `Length:` field remained uncovered. |
| `d6d803f0` (Jul 11) | Direct cause of the immediate presentation crash: request-level `max_retries=0`. Also added a unit assertion that encoded the invalid setting. |
| `6fd76afb` (Jul 11) | Improved visible SVG counting. It does not cause early report termination, but the boolean visual gate remains too weak for requested figure counts. |
| `18fa56e8` (Jul 11) | Production commit for both PDFs and the first two presentations. Preserves completion fields but does not reconcile contradictory status/reason values. |
| `5201c1e4` (Jul 11) | Production commit for presentation #3. Gateway-only completion preservation; no fix for either root cause. |

At the time of the production investigation, the inspected branch head still contained the invalid `max_retries` setting, detached-length parser gap, eager PDF render/emit flow, and contradictory completion normalization. The remediation appendix below records the subsequent code changes; deploying commits after `5201c1e4` alone did not contain them.

## Recommended Solution Strategy

### P0: Restore presentation execution

1. Remove `max_retries` from per-call `model_settings` in `_bounded_presentation_model_request`.
2. If presentation authoring must have zero SDK retries, configure a dedicated model/client instance at construction time or use the supported client request-options mechanism. Do not pass client configuration through Messages API payload kwargs.
3. Add a provider-contract regression that runs the bounded request through `ChatAnthropic` request serialization with transport stubbed. The test must fail on any unknown Anthropic Messages parameter.
4. Preserve the actual exception class and safe message in root diagnostics. Use a distinct terminal reason such as `deck_authoring_model_invocation_error`; reserve deadline/budget language for real deadline/budget events.
5. Deploy this patch first and run one no-image and one image-bearing presentation canary before touching PDF behavior.

### P0: Stop incomplete PDF delivery

1. Recognize standalone structured fields such as `Length: 12-16 pages`, regardless of distance from the artifact noun. Keep source-document vetoes for phrases such as "summarize this 12-page PDF." Add exact incident prompt regressions.
2. Introduce a report authoring manifest before writing:
   - expected section IDs/titles;
   - required front matter and back matter;
   - expected visual IDs and minimum counts;
   - requested page bounds;
   - source/citation obligations.
3. Do not force render merely because any closed HTML file exists. Require an explicit final-source marker/tool call or deterministic manifest completeness first.
4. On render, inspect the HTML and assert that every required section/visual ID is present exactly once. Validate TOC links against actual section IDs.
5. Treat a semantically incomplete report as `failed` or `partial`, never `completed`, even when a readable PDF exists. The PDF may be retained as diagnostic/support output but must not be the primary completed artifact.

### P1: Strengthen PDF quality checks

1. Strip configured header/footer text before page word counts, or classify pages with only pagination/header boilerplate as blank.
2. Replace boolean visual presence with expected/found visual counts and IDs. A request for four diagrams must not pass with one SVG.
3. Separate cover inspection from image generation. Detect an authored cover structurally (`section.cover`, cover heading) and visually (first-page occupancy/contrast), whether it uses CSS, SVG, raster imagery, or typography only.
4. Add minimum report-density and content-volume checks tied to requested range and expected section count. Do not use word count alone, but a 458-word "12-16 page" report must be impossible to accept.
5. Keep bounded repairs, but direct them at missing manifest items rather than asking for whole-document rewrites.

### P1: Make terminal truth authoritative

1. Enforce a terminal invariant: `terminal_status=completed` requires a success-compatible `terminal_reason`, a primary deliverable, and no structural unmet conditions.
2. Never generate `completed + pdf_generation_failed`.
3. Reject final summaries that describe future work (`continuing`, `draft not ready`) or explicit incompleteness when status is completed.
4. Gateway success normalization must inspect terminal status/reason and structural completeness, not only artifact-path existence.
5. Attach terminal status/reason/root failure to the actual LangSmith root metadata and tags, and emit failing feedback for failed/partial runs while preserving clean graph termination.

## Test Plan

### Presentation

- Real `ChatAnthropic` request serialization rejects no builder-added parameters.
- First model call succeeds with bounded max tokens and timeout.
- No provider fallback occurs after authoring deadline/truncation failures.
- Invocation configuration errors preserve their real root cause.
- A canary reaches `prepare_deck_build`; service call/result counters reconcile exactly.

### PDF parsing

- Full incident strings parse `12-16` and `14-18` ranges.
- Bare `Length: N-M pages` parses in an artifact brief.
- "Summarize this 12-page PDF into a 3-page report" still targets 3, not 12.
- Range values propagate into renderer arguments and completion metadata.

### PDF completeness

- A closed HTML document with only cover/TOC/summary cannot render as terminal-ready.
- A TOC entry without a matching section ID fails.
- Missing conclusion/references fails when required.
- Four requested figures require four matching visual IDs.
- A footer-only page counts as blank.
- A CSS/SVG-authored cover satisfies the cover gate without image generation.
- `completed + *_failed` is rejected at builder and gateway boundaries.

## Post-Deploy Acceptance Criteria

1. Two presentation canaries complete within the configured eight-minute deadline.
2. No presentation trace contains `unexpected keyword argument 'max_retries'`.
3. Each presentation emits and executes exactly one successful prepare call unless one explicit bounded repair is required; counters reconcile and dangling count is zero.
4. Two report canaries using the exact `Length: N-M pages` wording preserve min/max bounds in state, renderer output, webhook, and LangSmith root metadata.
5. Reports contain every requested section and figure ID, stay within the accepted page tolerance, and contain no footer-only pages.
6. No completion has `terminal_status=completed` with a failure terminal reason, structural unmet condition, or self-described incomplete draft.
7. LangSmith root status metadata, gateway terminal status, completion webhook, and user-visible card all agree.

## Implemented Remediation

The follow-up patch on `codex/sophia-observability-v1` implements the recommended control contracts:

- Presentation invocation removes request-level `max_retries`, distinguishes invocation/configuration errors from deadlines, and exercises real Anthropic request serialization in regression tests.
- Detached `Length: N-M pages` fields now populate authoritative minimum/maximum page state while existing source-document ambiguity vetoes remain in force.
- Visual report kickoff derives explicit body-section, visual, word-count, cover, TOC, conclusion, and references requirements and injects a typed `report_manifest_v1` contract.
- `render_html_to_pdf` validates manifest section IDs, roles, visual IDs, word volume, and TOC targets before Chromium. The model-facing schema includes the manifest but excludes injected runtime state.
- A first semantic failure permits one targeted source repair. A second contract failure or an off-target render after the bounded page-layout repair budget terminates without a primary artifact.
- Existing HTML no longer triggers rendering before the normal completion window. Successful canonical PDFs require an accepted report contract for visual-report runs.
- Footer-only pagination is removed before blank-page word counts. Authored cover evidence is derived from the accepted source contract instead of image-generation enrichment alone.
- Builder, webhook, event persistence, gateway completion, and LangSmith metadata carry safe expected/found report diagnostics. Contradictory success plus a failed terminal status/reason is normalized to public failure even when a file path exists.

This code patch does not deploy production. The post-deploy canaries above remain mandatory because they validate provider behavior, Chromium output, webhook delivery, and root-trace agreement in the real service environment.

## Bottom Line

The presentation failures have one narrow deterministic cause: a client-level retry option was inserted into an Anthropic request payload. The PDF regression is a control-contract failure: explicit length was lost, syntactic HTML closure was treated as semantic completion, and artifact existence overruled the model's own admission that the report was unfinished.

The right repair is not to increase turns or relax quality gates. It is to make provider configuration type-correct, make report intent structured, and require semantic completion before render and delivery.
