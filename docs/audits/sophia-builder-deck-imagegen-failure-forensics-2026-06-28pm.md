# Sophia Builder — Post-Deploy Deck Failure Forensics (2026-06-28 PM)

**Date:** 2026-06-28 (post-`74e9288e` redeploy)
**Status:** Two `task_type=presentation` builds failed. **Root cause: OpenAI image generation (`gpt-image-2`) failed on every attempt** (`api_error` / `missing_output`). The deck code shipped in `74e9288e` is **not** implicated. A pre-existing **resilience gap** turned the image outage into a hard build failure instead of a degraded-but-delivered deck.

## Deployment

| Service | Live commit | Deployed |
|---|---|---|
| sophia-langgraph (srv-…l4fg) | `74e9288e5f` | 2026-06-28T14:55:03Z |
| sophia-gateway (srv-…l4g0) | `74e9288e5f` | 2026-06-28T14:53:20Z |

Both services are on HEAD `74e9288e` (the deck-quality fix). Redeploy was clean.

## The two failed runs

| Run | Builder thread | Dispatched | Failed | Duration |
|---|---|---|---|---|
| Build 1 | `019f0ec6-4c57-7ae2-b561-a8e72acf3cb9` | 15:08:24Z | webhook 15:20:13Z | ~11 min, 43 turns |
| Build 2 | `019f0edd-81eb-7d32-8f71-0d1895f50ff6` | 15:33:45Z | webhook 16:08:42Z | ~35 min |

Identical signature on both.

## What the logs show

- **Image generation failed on the first (and effectively only) attempt:**
  `[BuilderImageGeneration] model=gpt-image-2 success=False output_ext=png bytes=0 error_class=api_error status_reason=missing_output` (build 1 @15:09:06, build 2 @15:34:27).
- **Only ONE image call was ever billed:** `[BuilderBudget] … image_calls=1 image_cost=$0.07 est_cost=$1.81` (build 1). The model did **not** cleanly retry image generation; it spent the rest of the run (~31 non-image `bash` turns + 2 `write_file`) flailing — 2,034,827 input tokens, 11 min — without producing any image.
- **`build_deck_from_slides` was NEVER called** (0 occurrences in either run). `pptx_generator_invoked=False`.
- **Emit was rejected repeatedly** as a format-swapped fallback:
  `phase=emit_rejected … pptx_generator_invoked=False image_generation_invoked=True valid_pptx_seen=False pptx_integrity_reason=pptx_fallback_before_generation_attempt fallback_ext=html`. The model gave up on the deck and tried to emit **HTML**, which is correctly rejected for a `.pptx` target → ceiling → `status=error`.
- **Traces are STILL 403:** `workspace_id_present: True` but `/runs/multipart → 403 Forbidden`. LangSmith run traces remain unavailable; forensics is Render-logs-only.

## Root cause analysis

### 1. Trigger — OpenAI image generation is failing (external / config), NOT a code regression
- The **same** deck produced **8/8 images and a valid 16.8 MB `.pptx` at 00:20Z** (run `019f0b8a`, commit `3f4c63b9`). Four hours later, on the same image-gen code, every attempt fails.
- **`git diff 3f4c63b9..74e9288e` touches NOTHING in the image-gen path** — `skills/public/image-generation/` and `start_builder_task.py` are unchanged (verified empty diff). `74e9288e` only changed the PNG renderer, `build_deck_from_slides` (`--bg-color`), the deck steering gates, tests, skills text, and frontend. **My code is not the trigger.**
- The harness classifies the failure as `error_class=api_error` (present key, API-level failure) — NOT `missing_api_key`/`auth_invalid`/`org_not_verified`. Combined with a sustained, total failure across two runs over a ~1-hour window, the most probable causes (operator must confirm — see below) are:
  1. **OpenAI quota / billing exhausted** (`insufficient_quota` surfaces as an APIError → `api_error`). Most likely for a total, sustained failure.
  2. **`OPENAI_API_KEY` invalid / rotated / revoked** — a 401 the script doesn't special-case would also land as `api_error`.
  3. A prolonged OpenAI rate-limit/5xx outage (less likely to total-fail for an hour despite `max_retries=3`).
- **Observability gap:** the raw OpenAI error message (`insufficient_quota` vs `rate_limit_exceeded` vs `invalid_api_key`) lives in the image-gen bash stderr but is **not** surfaced in the Render logs — the harness only records the coarse `api_error` (`builder_artifact.py:3985-3999`). With LangSmith also 403, the precise provider reason cannot be read from logs.

### 2. Amplifier — resilience gap: an image-gen outage becomes a hard failure
- The terminal-error short-circuit that redirects the model to "proceed with text/charts" only fires for **`{missing_api_key, auth_invalid, org_not_verified, egress_blocked}`** (`builder_artifact.py:286`). **`api_error` / `missing_output` are excluded**, so a total image-gen outage produces no redirect — the model is left to flail.
- The **WS-B partial-image degradation** (render missing images as placeholders, ship the deck with `quality_warning="visuals_partial"`) lives **inside `build_deck_from_slides`**. Because the model never authored slides + called that tool, WS-B never engaged. The deck path has **no floor**: zero images → no deck at all, rather than a text/placeholder deck.
- Net: a recoverable "visuals unavailable" condition degraded into an 11–35 min, multi-dollar hard failure with no deliverable.

### 3. Cleared — the 2026-06-28 deck-quality changes (`74e9288e`) did not cause this
- `[Sophia/deck-order]` (the new slides-before-images guard) **never fired** in either run.
- `[BuilderImageGeneration] phase=deck_batch_check rejected=False` — the hardened batch backstop correctly **allowed** the hero call (success_count=0).
- No `_deck_improvisation_rejection` firings. The WS3 gates are downstream of image generation and behaved as designed.

## Recommendations

### Operator (urgent — this is the trigger)
1. **Check OpenAI billing/quota and key validity for `sophia-langgraph`.** Confirm `OPENAI_API_KEY` is set, valid, not rotated/revoked, has remaining image quota/credits, and the org retains `gpt-image` access. The 00:20Z 8/8 success on identical code means decks should recover once the OpenAI side is healthy.
2. **LangSmith key:** make it **workspace-scoped with `runs:write`** so `/runs/multipart` stops 403-ing — without traces, the raw provider error is invisible.

### Code (follow-up — propose, not yet implemented)
1. **Surface the raw provider error.** Log the first stderr line of a failed image-gen bash (sanitized) alongside `error_class`, so `insufficient_quota` vs `rate_limit` vs `invalid_api_key` is visible in prod logs even with LangSmith down.
2. **Give the deck path a floor on image-gen outage.** After N consecutive `api_error`/`missing_output`/`empty_output` image failures, treat it like a terminal redirect: steer the model to **author the slide HTML with its text content and call `build_deck_from_slides` anyway** — the WS-B renderer already placeholders missing visuals, so a deck still ships (`quality_warning="visuals_partial"`/`visuals_unavailable`) instead of failing. This converts a total image outage from a hard failure into a degraded delivery.
3. (Optional) Cap the post-failure flail: once images are known-failing, stop letting the model spend 30+ turns / millions of tokens before the floor engages.

## Evidence index
- Image-gen results: build1 @15:09:06, build2 @15:34:27 (`success=False error_class=api_error status_reason=missing_output`).
- Budget: build1 @15:20:13 (`image_calls=1 est_cost=$1.81`).
- Emit reject: build1 @15:20:10, build2 @16:08:39 (`pptx_generator_invoked=False … pptx_fallback_before_generation_attempt`).
- Turn map: build1 turns 1-43 (turns 10-41 all `bash`, 1 `deck_batch_check`).
- Trace 403: @15:08:26 (`/runs/multipart 403`, `workspace_id_present: True`).
- Diff: `git diff --stat 3f4c63b9..74e9288e` — image-gen path unchanged.
- Terminal-error set: `builder_artifact.py:286`. Error classification: `builder_artifact.py:3985-3999`.
