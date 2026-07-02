# Sophia Builder 6-Slide PPTX Forensics — 2026-07-02

## Scope

Investigated the latest production deck artifact:

- Artifact: `/Users/davidelaverga/Downloads/build-a-6-slide-visual-presentation-on-l.pptx`
- Render window: 2026-07-02, latest matching production run around `16:12:14Z` to `16:19:22Z`
- LangSmith root run: `019f239a-2a81-7b83-b21c-5a3ee13a9cc9`
- Builder task/thread: `019f239a-2a7f-7a52-9ce5-f73eaa52b8a3`
- Live Render commit: `034b911fe2d7093cbc42ef9930713eb26c36a41c`

Raw/sanitized evidence saved under:

- `docs/audits/_logs_2026-07-02_latest_deck/`
- Render logs: `langgraph_builder_0000_1820.jsonl`, `langgraph_imagegen_0000_1820.jsonl`, `gateway_task_019f239a.jsonl`
- LangSmith safe root output: `langsmith/root_outputs_safe.json`
- Artifact inspection: `pptx_internal_summary.json`
- Rendered montage: `build-a-6-slide-visual-presentation-on-l-montage.png`

No API keys, prompts, or provider secrets were written to the report.

## Executive Summary

The deck did not fail structurally. It compiled and uploaded as a valid `.pptx`, with six full-slide raster screenshots and no overflow. The product failure is that image generation failed completely, then the deployed builder still compiled and emitted a deck built from DOM/CSS-only slide HTML. That produced the same family of defects as before: dense, dashboard/card-like slides, dark neon-blue styling, and no actual generated slide visuals.

The biggest finding is a deploy/code gap. Production is live on commit `034b911f`, but the current working tree contains newer mandatory-visual-completeness gates that are not in that deployed commit. In deployed code, `presentation_completion_ready` accepts a deck once `build_deck_from_slides` succeeds and `picture_count >= slide_count`. Because the HTML-to-PPTX route always wraps every slide screenshot as one picture, that check passes even when zero generated visual assets exist.

## What Went Right

1. Render and LangSmith are both usable enough for root-level forensics.
   - LangSmith root run landed in project `Sophia`.
   - Root metadata records `task_type=presentation`, the task/thread IDs, and deployed commit `034b911f`.

2. The PPTX wrapper path worked mechanically.
   - Artifact size: `2,484,328` bytes.
   - Six slides.
   - Six media screenshots, each `3840x2160`.
   - Each slide XML contains exactly one picture.
   - `slides_test.py` reported no overflow.

3. The production completion metadata was honest enough to expose the image failure.
   - `image_generation_status: failed`
   - `image_generation_reason: api_error`
   - `image_generation_outcome: attempted=2, succeeded=0, skip_reason=failed_after_retry`
   - `quality_warning: visual_quality_warning`

## What Went Wrong

### 1. Image generation failed before any useful visual asset was produced

Render logs show two image-generation attempts:

- `16:12:54Z`: `success=False`, `bytes=0`, `error_class=api_error`, `status_reason=missing_output`, `raw_error=None`
- `16:12:56Z`: same result
- `16:12:56Z`: `phase=stop_directive attempts=2 error_class=api_error`

LangSmith root outputs confirm:

```json
{
  "image_generation_attempt_count": 2,
  "image_generation_success_count": 0,
  "image_generation_error_class": "api_error",
  "image_generation_status": "failed"
}
```

This was not the new desired path. There was no complete manifest batch, no generated visual count, and no serial repair after a real batch attempt.

### 2. The parallel manifest path never ran

Render logs repeatedly show:

```text
[BuilderImageGeneration] phase=deck_batch_check rejected=False manifest_seen=False success_count=0
```

The deployed prompt contract still says to generate the hero/cover first, then batch the remaining slides. In this run, the hero-like single calls failed twice, so the system never reached the manifest. That means the latest desired behavior, "one manifest for all slide visuals including cover/hero," was not active in production.

### 3. Production still compiled a deck after image generation failed

After image generation failed:

- `16:17:36Z`: builder forced `build_deck_from_slides`
- `16:18:03Z`: first compile succeeded: `slide_count=6`, `missing_images=0`, `overflow_slides=0`
- `16:18:03Z`: quality gate blocked once for `chrome` and `density`
- `16:18:52Z`: second compile succeeded
- `16:18:52Z`: quality gate soft-passed after repair with 4 remaining `density` gaps
- `16:19:22Z`: gateway published terminal `status=success` while `image_generation_status=failed`

The important nuance: `missing_images=0` means no broken `<img>` references in slide HTML. It does not mean generated slide visuals were complete. The deck can have zero generated assets and still pass `missing_images=0` if the slide HTML simply omits visual `<img>` blocks.

### 4. The artifact is valid but visually regressed

Rendered artifact observations:

- Full-bleed dark/navy style with bright cyan/orange accents.
- Dense panel/card composition on slides 3, 4, 5, and 6.
- Slide 4 has a busy chart/table/dashboard layout.
- Slide 5 is explicitly card-heavy and dashboard-like.
- Slide 6 has stacked horizontal cards plus an abstract ring graphic.

The deck is not blank. It is a valid screenshot deck. The issue is that it fell back to DOM-generated technical diagrams/cards instead of generated visual assets, and the deployed quality gate allowed the remaining density issues to ship with a warning.

## Code Cross-Reference

### Deployed commit `034b911f`

In deployed `builder_artifact.py`, `_presentation_completion_ready` only checks:

- PPTX generator success count
- latest valid `.pptx`
- `picture_count >= slide_count`
- requested slide count repair

It does not require generated visual completeness. In deployed code:

```python
if not _pptx_picture_count_satisfies_slide_count(diagnostics):
    return False
...
return True
```

Likewise, `_pptx_valid_output_already_terminal` only checks latest PPTX plus picture count. Because `build_deck_from_slides` wraps every slide screenshot as a picture, this can mark a no-generated-visual deck terminal.

The deployed task guidance still says:

```text
generate the hero/cover image first ... then write ONE JSON manifest listing every remaining slide image
```

The deployed skill docs also still allow:

```text
A slide may omit the image when the request is plain
```

That is too permissive for normal presentation requests.

### Current working tree

The current working tree contains the intended fixes that production did not exercise:

- `_pptx_generated_visuals_complete(...)`
- `_pptx_visual_completeness_counts(...)`
- `_deck_compile_visuals_rejection(...)`
- compile readiness requiring generated visuals to exist and be referenced
- batch-first prompt wording for all slide visuals including cover/hero
- final metadata fields such as `expected_generated_visual_count`, `successful_generated_visual_count`, `referenced_visual_count`, and `missing_expected_visual_count`

Those changes are not present in live commit `034b911f`, so redeploying `034b911f` could not fix this failure mode.

## Possible Root Causes

### RC1 — Production deployed an older mitigation, not the latest mandatory-visual gate

Confidence: high.

The live services are on `034b911f`. The local working tree has additional uncommitted changes that directly address this failure mode. Production behavior matches `034b911f`, not the working tree.

Impact: image generation can fail, but the deck still compiles as a "successful" HTML screenshot PPTX.

### RC2 — Hero-first steering still creates a dead end before batch generation

Confidence: high.

The deployed guidance asks for a single hero/cover image first. The builder allowed those single calls (`deck_batch_check rejected=False manifest_seen=False`). Both failed, then the stop directive prevented further image calls. No manifest ran.

Impact: the "parallelization path" is bypassed entirely. There is no diagnostic 6-image batch to prove or disprove parallel image reliability.

### RC3 — Image-generation error remains too opaque

Confidence: medium-high.

Logs only show `api_error`, `missing_output`, `raw_error=None`. The failures happened almost immediately, not after the configured 240-second timeout, which suggests an immediate SDK/API/runtime rejection or a command/path failure whose stderr did not include a raw provider body. Without child trace pagination or captured stderr, the exact provider reason is not proven.

Impact: we cannot distinguish auth/org access, invalid model/size, prompt-file issue, SDK/runtime issue, or immediate OpenAI API rejection from the available production logs alone.

### RC4 — The compile health check conflates PPTX wrapper screenshots with generated visual completeness

Confidence: high.

The final PPTX has six pictures because every rendered slide screenshot is a picture. That is not evidence that six generated visual assets exist. The live code uses `picture_count` as a terminal readiness signal.

Impact: no-image/DOM-only decks can look structurally correct to the compiler and gateway.

### RC5 — Visual quality gate is too willing to ship dense decks after one repair

Confidence: high.

The first compile was blocked for `chrome` and `density`. The second compile still had four density gaps but soft-passed with `visual_quality_warning`. The user sees a bad deck, while the system records success with warning.

Impact: quality warnings are not strong enough for normal visual presentation asks when the deck remains visibly dense/card-heavy.

### RC6 — LangSmith child-run retrieval is still not operationally smooth

Confidence: medium.

Root run read worked. Child pagination via the LangSmith SDK repeatedly hung and had to be interrupted, even with a small child limit. Root outputs were useful, but child spans were not practically available from this local API path.

Impact: trace-level investigation still depends too much on Render logs and root final state. The new child spans are only useful if they can be queried reliably.

## Bottom Line

This run failed for two stacked reasons:

1. The image path failed before producing any image and never reached the batch path.
2. The deployed code still allowed a zero-generated-image HTML-slide deck to compile and publish as success.

The immediate fix is not another Render redeploy of `034b911f`; production needs the newer mandatory visual-completeness changes committed, pushed, and redeployed to both `sophia-langgraph` and `sophia-gateway`. After that, a deck with `attempted=2`, `succeeded=0`, and no referenced generated assets should fail clearly with `artifact_path=null` instead of compiling a visually degraded PPTX.
