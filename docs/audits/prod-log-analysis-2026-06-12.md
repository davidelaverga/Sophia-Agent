# Sophia Production Artifact Analysis - 2026-06-12

## Scope

This report covers the production tests from the last-six-hours log pull on 2026-06-12, focused on the artifact failures reported after redeploy:

- Presentation slides still looked basic.
- PDF requests failed or produced presentations instead.
- A Markdown document succeeded.

Sources checked:

- Render logs for `sophia-langgraph`, `sophia-gateway`, and `sophia-voice`.
- Vercel production logs for `sophia-ei.com`.
- Downloaded artifacts:
  - `/Users/davidelaverga/Downloads/create-a-polished-pdf-report-that-reinfo.pptx`
  - `/Users/davidelaverga/Downloads/create-an-actual-pdf-report-not-a-presen.pptx`
  - `/Users/davidelaverga/Downloads/create-a-markdown-document-for-the-user.md`
- Current branch code around target resolution, builder workflow prompts, PPTX/PDF validation, and completion routing.

Production was on commit `7738eaa8ea476bd7557874e3800fdc8eaed89545` from `codex/sophia-stream-canvas-v1`.

## Executive Summary

The main failure is not frontend artifact delivery and not a missing PDF runtime.

The strongest evidence is that `render_markdown_to_pdf` succeeded twice in production, producing valid PDFs with embedded images, but those runs had already been classified as `target_ext=pptx`. Because the requested target was wrong, the harness rejected the model's attempted PDF emits as invalid for a PPTX run. One later run completed as a valid PPTX even though the user asked for an actual PDF.

The slide deck path is structurally healthier than before: it produced valid PPTX packages instead of corrupt 5-byte decks. But quality is still shallow. The decks contain pictures, but no native chart parts, sparse text, and no sign that the higher-level visual/polished deck path meaningfully improved composition. The harness currently proves "valid package with some images," not "good presentation with meaningful charts and diagrams."

Vercel logs did not show matching frontend route failures or runtime errors. The production frontend was hitting auth/memory routes normally. The artifact issue is overwhelmingly backend orchestration: target-format derivation, edit-context contamination from prior artifacts, and weak quality gates.

One operational note matters: the log window also shows Anthropic primary calls failing with `401 invalid x-api-key`, with OpenAI fallback carrying the session. That kept the app alive, but it likely changed builder behavior and quality. Even with fallback working, this should be fixed separately.

## What Went Well

### Markdown Build Worked

The Markdown task launched correctly:

- `task_type=document`
- `target_ext=md`
- `target_ext_source=explicit_markdown_deliverable`
- web research enabled
- terminal completion accepted with `artifact_ext=md`

The downloaded Markdown file is substantial:

- 19,522 bytes
- about 19,480 characters
- no images or SVGs, which is acceptable if the request was text-only

This means the core builder path, artifact upload, gateway terminal event, and frontend artifact action path were functioning for simple document output.

### PDF Runtime Is Present And Can Render

Production logs show successful PDF renders:

- `pandoc_available=true`
- `xelatex_available=True`
- `render_success`
- first render: `page_count=6`, `image_count=3`, `layout_quality=ok`
- second render: `page_count=9`, `image_count=2`, `layout_quality=ok`

So the PDF failure is not primarily missing `pandoc`, missing LaTeX, or a broken `render_markdown_to_pdf` tool.

### PPTX Integrity Gate Improved

The downloaded PPTX artifacts are real Office packages:

- `create-a-polished-pdf-report-that-reinfo.pptx`
  - 173,594 bytes
  - 11 slides
  - 4 media images
  - valid `[Content_Types].xml`
  - valid `ppt/presentation.xml`
- `create-an-actual-pdf-report-not-a-presen.pptx`
  - 133,375 bytes
  - 6 slides
  - 3 media images
  - valid `[Content_Types].xml`
  - valid `ppt/presentation.xml`

This is a major improvement over earlier corrupt or tiny PPTX artifacts.

### Frontend/Vercel Did Not Show The Primary Failure

The Vercel production logs sampled in the same window were dominated by:

- `/api/v1/auth/me`
- `/api/memory/recent`
- bot noise such as `/wp-admin/install.php`, `/xmlrpc.php`, `/robots.txt`

No clear frontend runtime exception or artifact proxy failure appeared in the sampled logs. The visible wrong-file outcome matches backend terminal events, not a frontend rendering/drop issue.

## What Failed

### 1. PDF Requests Were Classified As PPTX Runs

Two intended PDF flows launched as PPTX:

At `10:05:56 UTC`:

- `task_type=visual_report`
- `artifact_source=latest_emit_artifact_tool_call`
- `target_ext=pptx`
- `target_ext_source=explicit_presentation_deck`
- source artifact materialized from a prior `.pptx`

At `10:09:49 UTC`:

- `task_type=document`
- `artifact_source=latest_emit_artifact_tool_call`
- `target_ext=pptx`
- `target_ext_source=explicit_presentation_deck`

This is the central failure. The system believed it was building or editing a presentation, even when the user asked for an actual PDF report.

### 2. The PDF Renderer Succeeded, Then The Harness Rejected The PDF

In the misclassified PPTX runs, the builder did reach the PDF renderer:

- `10:06:33 UTC`: PDF render succeeded, 6 pages, 3 images.
- `10:11:06 UTC`: PDF render succeeded, 9 pages, 2 images.

But because the active target was `pptx`, later artifact validation rejected `.pdf` emits:

- `pptx_invalid_artifact_extension:.pdf`
- missing-path retries against PDF filenames
- eventual failed terminal for one run
- eventual PPTX terminal for another run

This is why the attached "actual PDF report" download is a `.pptx`, not a `.pdf`.

### 3. Prior Artifact Context Is Contaminating New Output Format Decisions

The start logs show `artifact_source=latest_emit_artifact_tool_call` and `artifact_source=last_builder_artifact_state` during the problematic launches.

That means the builder launch was not making a clean output-format decision from the current user request alone. It was also carrying prior artifact metadata into the description or edit context. Since prior artifact filenames ended in `.pptx`, and target-extension matching checks PPTX before PDF, the previous presentation context could win over the new "PDF" instruction.

The code path in `backend/packages/harness/deerflow/sophia/tools/start_builder_task.py` currently has this ordering:

```python
_REQUESTED_OUTPUT_EXTENSION_PATTERNS = (
    ("pptx", "explicit_presentation_deck", _PPTX_OUTPUT_RE),
    ("pdf", "explicit_pdf_deliverable", _PDF_OUTPUT_RE),
    ...
)
```

That ordering is reasonable only if the scanned text is the user's current deliverable request. It becomes dangerous if the scanned text also includes previous artifact filenames, edit context, or generated assistant wording.

### 4. PPTX Quality Gate Is Too Shallow

The successful PPTX artifacts are structurally valid but basic.

Artifact inspection:

- First PPTX:
  - 11 slides
  - 4 pictures
  - 0 native chart parts
  - several slides under 45 words
  - many slides have no picture
- Second PPTX:
  - 6 slides
  - 3 pictures
  - 0 native chart parts
  - sparse content

Logs confirm the harness accepted the first deck with:

- `pptx_generator_invoked=True`
- `valid_pptx_seen=True`
- `pptx_generator_picture_count=4`
- `image_generation_invoked=False`
- `image_generation_attempt_count=0`

That proves the generated file is a valid PPTX with media. It does not prove the deck is visually rich, diagram-heavy, chart-heavy, or polished.

The gap is a quality definition problem: the gate accepts package integrity plus picture count, while the user expectation is "good slides with charts and diagrams."

### 5. PPTX Skill Read Tracking Looks Inconsistent

For the accepted first deck, logs show:

- earlier: `presentation target needs ppt-generation correction ... pptx_skill_read_seen=False`
- later accepted: `pptx_skill_read_seen=False`, `pptx_generator_invoked=True`, `valid_pptx_seen=True`

The builder did invoke the generator successfully, but the final diagnostics still showed `pptx_skill_read_seen=False`. That weakens our ability to prove the model read and followed the skill instructions before using the workflow.

This could be harmless instrumentation drift, but it matters because the current plan depends on "read the skill first, then execute the skill path."

### 6. Image Generation Was Not Used

Across the relevant PPTX completions:

- `image_generation_status=None`
- `image_generation_reason=None`
- `image_generation_invoked=False`
- `image_generation_attempt_count=0`
- `image_generation_success_count=0`

This is not automatically a bug because we intentionally moved image generation toward opt-in. But for a "polished" or highly visual slide-deck request, there should at least be a logged skip reason:

- explicit plain/minimal deck requested
- image generation not requested
- image generation unavailable
- deterministic visuals selected instead
- provider key missing or failed

Today the outcome is ambiguous.

### 7. Anthropic Primary Provider Was Down

The existing production report draft and logs show Anthropic calls failing with:

- `401 invalid x-api-key`

OpenAI fallback handled the run, which is good. But this affects quality analysis:

- builder behavior may differ from the expected Anthropic primary
- companion phrasing and routing may differ
- brief extraction or advisory passes that depend on Anthropic can degrade or skip

This is not the root cause of "PDF became PPTX," but it is a quality and observability concern.

## Timeline

| Time UTC | Event | Result |
|---|---|---|
| 09:34 | Markdown document run launched as `target_ext=md` | Completed successfully as Markdown |
| 09:56 | Visual/PPTX run launched as `target_ext=pptx` | Completed as valid PPTX, but basic deck |
| 09:57 | First PPTX terminal accepted | `requested_artifact_ext=pptx`, `artifact_ext=pptx`, success |
| 10:05 | Intended PDF/revision launched as `target_ext=pptx` | Misclassified from the start |
| 10:06 | `render_markdown_to_pdf` succeeded | Valid PDF existed, but run target was PPTX |
| 10:06 | PDF emit rejected as invalid for PPTX | Terminal failed with missing/rejected path |
| 10:09 | "Actual PDF report" run launched as `target_ext=pptx` | Misclassified again |
| 10:11 | `render_markdown_to_pdf` succeeded again | Valid PDF existed, but target was still PPTX |
| 10:11 | PPTX validation/retry path ran | Final terminal accepted as PPTX |

## Likely Root Causes

### Root Cause A - Output Format Is Resolved From Polluted Context

The resolver is seeing previous artifact context and/or assistant-normalized wording, not just the current user instruction. This explains why "actual PDF report" can become `target_ext=pptx` after a prior PPTX existed in the same session.

The current logs do not include the matched text, by design, so the exact string that triggered `_PPTX_OUTPUT_RE` is not visible. The safe fields are enough to show the wrong rule won:

- `target_ext=pptx`
- `target_ext_source=explicit_presentation_deck`
- `artifact_source=latest_emit_artifact_tool_call`
- prior source artifact extension was `pptx`

### Root Cause B - Explicit Current Request Does Not Have Absolute Precedence

The system needs a two-tier format resolver:

1. Current user turn / explicit tool args.
2. Prior artifact context only if the current turn is silent about output format.

Today, previous `.pptx` context can override a new PDF request.

### Root Cause C - PDF Authority Is Not Strong Enough Across Target Conflicts

The PDF render tool can produce a good-enough PDF, but the completion layer still obeys the wrong `target_ext`. Once a valid PDF render exists and the user requested PDF, the PDF should be authoritative. If target resolution says PPTX while a PDF render exists, the run should either:

- repair the target to PDF, or
- fail with a format-conflict error before producing the wrong artifact type.

### Root Cause D - PPTX Quality Gates Are Package Gates, Not Presentation Gates

The deck compiler and integrity checks now prevent corrupt files. They do not enforce:

- meaningful chart/diagram presence
- adequate visual density per slide
- adequate content density
- design variety
- whether generated visual assets were actually embedded in the right slides
- whether the PPT skill was read before composition

That is why the presentation can be technically valid and still feel like a thin template.

## Recommendations

### Immediate Fixes

1. **Make target format resolution current-turn-first.**

   Add separate fields:

   - `user_requested_ext`
   - `context_inferred_ext`
   - `final_target_ext`
   - `format_resolution_source`
   - `format_override_applied`

   Prior artifact extension should only influence `final_target_ext` when the current user turn does not specify a deliverable format.

2. **Make explicit PDF override prior PPTX context.**

   If the current turn contains `pdf`, `PDF report`, `actual PDF`, `not a presentation`, `not slides`, or `as/in/to PDF`, it must veto prior `.pptx` context.

3. **Add a format-conflict guard.**

   If `target_ext=pptx` but the builder successfully renders a PDF and attempts to emit it, do not loop through PPTX rejection. Check whether the current user request asked for PDF. If yes, switch authority to the PDF or fail with a clear format-conflict diagnostic.

4. **Persist safe target-decision traces.**

   Do not log prompt text. Log rule names and text source only:

   - `matched_rule=explicit_pdf_deliverable`
   - `matched_source=current_user_turn`
   - `ignored_context_rule=explicit_presentation_deck`
   - `source_artifact_ext=pptx`

5. **Fix the Anthropic key.**

   OpenAI fallback worked, but production should not silently run entirely on fallback during quality-sensitive builder tests.

### PDF Path Fixes

1. **Treat a valid PDF render as terminal-authoritative when the current user requested PDF.**

   If `render_markdown_to_pdf` succeeds and `user_requested_ext=pdf`, the next accepted completion should be the rendered PDF unless it fails existence or quality checks.

2. **Route PDF reports through `pdf-report/SKILL.md` with proof.**

   Track:

   - `pdf_report_skill_read`
   - `pdf_source_path`
   - `pdf_render_attempted`
   - `pdf_render_success`
   - `pdf_image_count`
   - `pdf_quality_warning`

3. **Do not let previous presentation artifacts define PDF edit targets.**

   If the user asks to convert or rebuild a prior deck as a PDF report, that is a conversion/rebuild flow, not "continue editing this PPTX."

### PPTX Quality Fixes

1. **Strengthen PPTX quality metrics.**

   Keep structural validation, but add:

   - minimum text density per content slide
   - minimum picture/chart/diagram evidence when visuals requested
   - chart/diagram evidence mapped to the plan, not just total media count
   - reject/repair if all visuals are decorative or repeated
   - require at least one visual on content slides when the user asks for charts/diagrams

2. **Make skill-read proof reliable.**

   A successful deck should not report `pptx_skill_read_seen=False` unless the generator can prove it followed a compiled plan that already incorporated the skill contract.

3. **Log image-generation skip reasons.**

   For every PPTX run:

   - `image_generation_policy=not_requested|plain_deck|visual_deck|explicit_user_request`
   - `image_generation_invoked=true|false`
   - `image_generation_skip_reason=...`

4. **Do not equate deterministic visual assets with good deck design.**

   `generate_visual_asset` is support infrastructure. The model still needs to author a strong deck plan and decide how charts/diagrams support the argument.

### Prompt And Coordination Fixes

1. **Clarify completed-artifact edits versus new-format rebuilds.**

   "Make this into an actual PDF report" should not silently inherit the prior PPTX target. It should be treated as a new output-format conversion/rebuild from prior content.

2. **Remove stale contradictory prompt guidance.**

   `CLAUDE.md` still says generated imagery is on by default for decks, while newer workflow cards make image generation conditional. The builder-facing prompt and repo docs should agree.

3. **Make workflow cards target-authoritative only after target truth is correct.**

   Workflow cards cannot rescue a run if the wrong target card is injected. Fix target truth before adding stricter workflow gates.

## Recommended Implementation Order

1. Patch target-extension resolution to separate current-user intent from prior artifact context.
2. Add unit tests for exact failure shapes:
   - prior artifact `.pptx` + current request "actual PDF report, not a presentation" => `pdf`
   - prior artifact `.pptx` + current request "make another slide deck" => `pptx`
   - "presentation in PDF format" => `pdf`
   - "PowerPoint deck based on a PDF source" => `pptx`
3. Add PDF authority guard: successful render + current PDF intent wins over stale PPTX context.
4. Add PPTX quality metrics and reliable skill-read proof.
5. Add image-generation policy skip logging.
6. Clean prompt/document contradictions around image generation and target workflows.

## Bottom Line

The system did not fail because PDF generation is absent. It failed because target truth drifted before the builder started. Once a PDF request was mislabeled as PPTX, the harness correctly rejected PDFs and either failed or delivered a PPTX.

The slide path is now structurally safe but creatively weak. We need to raise the gate from "valid PPTX package with some media" to "valid presentation with meaningful visual evidence and adequate content density."

The next fix should focus on current-turn output-format authority, PDF render authority, and PPTX quality instrumentation before adding more visual-generation machinery.
