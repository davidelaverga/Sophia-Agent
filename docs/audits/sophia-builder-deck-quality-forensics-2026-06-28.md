# Sophia Builder — Deck Quality Forensics

**Date:** 2026-06-28
**Author:** Production forensics (3 verified investigators, consolidated)
**Status:** Build NOW SUCCEEDS — 3 open defects, none deliverable-blocking

## Run identity

| Field | Value |
|---|---|
| Builder thread | `019f0b8a-3a09-77f0-af43-1ccc2c49bf34` |
| Run id | `019f0b8a-3a0c-...` |
| Parent (companion) thread | `019f0b89-5f22-...` |
| Deployed commit | `3f4c63b9` (local HEAD == both Render services) |
| Surface | webapp user |
| Task | "create an 8-slide technical presentation" (`task_type=presentation`) |

## Headline — the deck succeeds

**The `max_retries=3` image-gen fix worked.** This build produced a genuinely complete, high-quality deck:

- **8/8 images generated** (`image_generation_success_count=8`, `pptx_generator_picture_count=8`, `missing_images=0`)
- **Real `.pptx`, 16,803,915 bytes** (`build_deck_from_slides: build_success final_artifact_ext=pptx slide_count=8 size_bytes=16803915` — `lg_build.log:1439`)
- **`artifact_is_fallback=False`** — honest, format-correct primary

This is not a fallback, not a placeholder deck, not a format swap. The earlier image-gen failure class (single image yield, `artifact_is_fallback=true`) is resolved.

**Three open defects remain — all quality/UX/performance, none blocks the deliverable:**

1. **White-space artifacts in slides** — light/white bands clash with the dark-navy theme (major).
2. **A PDF delivered alongside the PPTX** — investigated; **perception, by design** (minor, not a bug).
3. **~17.5-min builder wall-clock** — slow; 85% is serialized image-gen (major).

---

## Executive summary

| Issue | Severity | Confirmed? | One-line root cause | One-line fix |
|---|---|---|---|---|
| White-space bands in slides | major | **Yes** | `render_html_to_png.mjs` screenshots with no opaque bg → Chromium paints default WHITE wherever model markup leaves the frame uncovered | Force opaque dark full-bleed bg before screenshot in the harness; add `html,body` bg + full-bleed visual in `SKILL.md` |
| PDF + PPTX "duplicate" | minor | **No** (perception) | The `.pptx` is the sole deliverable; the `.preview.pdf` is the by-design canvas render source, excluded from every download surface | No correctness fix — optional UX hint/badge to close the mental-model gap |
| ~17.6-min wall-clock | major | **Yes** | Image-gen ran as ~9 SERIAL single-image bash calls (14.9 min = 85%) instead of hero + ONE `--manifest` batch; the batch backstop never fired | Harden + matcher-robust the deck-batch backstop so it hard-rejects post-hero singles until a `--manifest` batch runs |

---

## Trace visibility is STILL broken — Render-logs-only forensics

> **CALLOUT.** The operator set `LANGSMITH_WORKSPACE_ID` after the prior forensics. The log confirms the half-fix took partial effect (`workspace_id_present: True`, and `/v1/metadata/submit -> 204`), **BUT `/runs/multipart` STILL returns `403 Forbidden`.** LangSmith run traces remain unavailable. This entire forensics is therefore **Render-logs-only** (`/tmp/deck_inspect/lg_build.log`), with pixel forensics on the unzipped PPTX media.
>
> **Diagnosis.** The org-scoped key can submit metadata (`/v1/metadata/submit -> 204`) but cannot write runs (`/runs/multipart -> 403`). The most likely causes: the API key is **org-scoped, not workspace-scoped**, and/or it is **missing the tracing / `runs:write` scope**, and/or the workspace header is applied to the metadata path but **not to the ingest (runs) path**. Setting `LANGSMITH_WORKSPACE_ID` alone does not grant run-write on an org key.
>
> **Recommendation (operator).** Verify the key is a **WORKSPACE-scoped** key (not org-scoped) with **tracing write** enabled — or grant that scope to the current key. Until then, run-level traces (e.g. the exact bash command strings for run `019f0b8a-3a0c`) cannot be inspected, which is the single biggest residual evidence gap (see slowness §3, "STILL UNRESOLVED").

---

## Issue 1 — White-space bands in composed deck

**Defect.** The 8-slide deck (`create-an-8-slide-technical-presentation (2).pptx`) renders with light/WHITE vertical bands against its dark-navy theme: a near-white band down the **right edge of slide 1**, and **two pure-white bands flanking the central diagram on slides 3 and 5**. The white is inside the model-authored slide-HTML screenshots, not the pptx placement.

**Confirmed real (not perception, not a benign placeholder).**
- Bands measure **pure RGB(255,255,255)** on slide 3 (interior runs x=[604..808] and x=[3031..3235] @2x) and ~RGB(207–219) near-white down slide 1's right edge (x=[3541..3839]). Slide-3 canvas edges are dark navy RGB(10,15,30).
- **Not** the WS-B missing-asset placeholder (that is `#ececf2` gray + "visual unavailable" text — `render_html_to_png.mjs:105-109`). Build reported **`missing_images=0`** (`lg_build.log:1439`); emit diagnostics `image_generation_success_count=8 / picture_count=8 / artifact_is_fallback=False`.
- **Not** a pptx letterbox: every media PNG is a perfect 16:9 3840×2160, and `compile_pptx.mjs:125-138` places pictures full-bleed (x:0,y:0,w:13.333,h:7.5). **`compile_pptx.mjs` is ruled OUT.**

### Root cause
1. **Harness (load-bearing).** `render_html_to_png.mjs:188-192` calls `page.screenshot({clip:{0,0,1920,1080}})` with **`omitBackground` unset (default false)** → Chromium paints its **default WHITE page background**. Any pixel not covered by an opaque element renders white. The render path injects no background (`build_deck_from_slides.py:123-130` passes only `--width/--height`); the context (`:161-165`) sets viewport only. There is **no harness-level opaque dark backstop** independent of model markup.
2. **Skeleton.** `ppt-generation/SKILL.md:61` sets `html, body { margin:0; padding:0 }` with **no `background`**; only `.slide` (`:63`) is dark `#0e1626`. Wherever `.slide` (or an opaque element) doesn't cover the frame, the white body shows. `.visual` (`:69-70`) uses an inset sub-box with `object-fit:contain` — a structural letterbox source. The skeleton is the only background contract the model sees; `builder_task.py:1209-1218` `pptx_visual_guidance` restates no background/full-bleed rule.
3. **Model deviation compounds it.** Measured slide-3 gaps (~100px at x logical 302..404 / 1515..1617) do **not** match the bare-skeleton contain-gap geometry (predicted ~276px at 80..356 / 1564..1840), so the model authored a custom centered-card layout whose gutters fall over the **unpainted white body**. The gaps being **pure white, not navy**, proves the uncovered region sits over `body` (white), not over an opaque dark `.slide` — confirming the *mechanism* (default white bg) while correcting the detail (model-custom layout over white body, not simply the skeleton's contain-gap).

### Evidence
- `render_html_to_png.mjs:188-192` (screenshot, no `omitBackground`), `:161-165` (context, no bg), `:105-109` (placeholder is gray, not white).
- `build_deck_from_slides.py:123-130` (no bg flag), `lg_build.log:1439` (`missing_images=0`).
- `ppt-generation/SKILL.md:61` (no html/body bg) vs `:63` / `:69-70`.
- Pixel forensics on `/tmp/deck_inspect/unzipped/ppt/media/image-{1,3,5}-1.png`.

**Residual (does not change root cause):** the exact model-authored slide HTML was not in saved evidence (PPTX media holds only rendered PNGs; no `slides/*.html` copy under `/tmp/deck_inspect`), so per-slide markup is inferred from pixel geometry rather than read directly. The harness-level white default is load-bearing regardless of markup.

### Fix
- **Harness backstop (primary).** Inject an opaque dark full-bleed background before screenshot, e.g. `page.addStyleTag({content:'html,body{background:#0e1626!important;margin:0;padding:0}'})` before `page.screenshot` (~`:188`), or a `--bg-color` arg defaulting to `#0e1626`. Keep `omitBackground` unset (we WANT an opaque bg). An opaque `.slide` still paints on top — `!important` on `html,body` only fills regions the model left uncovered. Closes the failure class regardless of model markup.
- **Skeleton.** Add `background:#0e1626` to `html,body` in `SKILL.md`; switch the visual to full-bleed (`background-size:cover` / `object-fit:cover` over a full-frame `.slide`) with overlaid title/narrative; add a hard rule: "the slide must be opaque dark to the edges — never leave the page background visible."
- **Plumb + test.** Carry `--bg-color` from `build_deck_from_slides.py` (`:123-130`) and add a golden test asserting no interior pure-white in the rendered PNG of a slide that leaves an uncovered region.

---

## Issue 2 — Deck "PDF + PPTX" — VERDICT: (C) Perception, by design

**The user received ONE deliverable: the `.pptx`. The PDF is the by-design canvas render source, not a second deliverable.** Not a duplicate-deliverable regression. The `.preview.pdf` is correctly excluded from every download surface; it exists only so the webapp (no native PowerPoint renderer) can display the deck on its PDF canvas.

### Root cause
The Phase-0 deck pipeline produces a single `.pptx` (`build_deck_from_slides`). After a valid `.pptx` emit, `BuilderArtifactMiddleware._attach_pptx_canvas_preview` renders a `<deck>.preview.pdf` via headless LibreOffice (`deerflow/sophia/pptx_preview.py`) purely as a render aid. The webapp canvas renders the deck through that PDF; the download button serves the `.pptx`. A user who views the deck on-canvas (a PDF render) and then downloads it (a `.pptx`) can read this as "two formats" — that is the perception artifact.

### Evidence
- **One deliverable, one PDF (render aid), no second authored PDF:**
  - `build_deck_from_slides: build_success final_artifact_ext=pptx slide_count=8 size_bytes=16803915` — `lg_build.log:1439`
  - `fire_completion_webhook: dispatching ... artifact_path='mnt/user-data/outputs/create-an-8-slide-technical-presentation.pptx'` (single `artifact_path`, the `.pptx`) — `lg_build.log:1481`
  - `emit_accepted`=1, completion-webhook dispatch=1 (grep counts)
  - `render_html_to_pdf` / `render_markdown_to_pdf` invocations = **0**; authored `.pdf` under outputs besides `.preview.pdf` = **0** ⇒ verdict B (a separately-authored PDF report) ruled out. Presentation task_type only offers `build_deck_from_slides`, no PDF-authoring tool.
  - `[PptxPreview] rendered canvas preview ... .preview.pdf bytes=3958651` — `lg_build.log:1469` (render aid only)
- **`.preview.pdf` excluded from the thread artifact list (download data source) on every backend surface:**
  - `backend/app/gateway/routers/artifacts.py:371` — `_is_builder_support_artifact_path` lists `.preview.pdf`
  - `backend/app/gateway/artifact_registry.py:71` (`_SUPPORT_ARTIFACT_SUFFIXES`) and `:215`
  - Confirmed live: `GET /api/threads/{parent}/artifacts` returned `builder_task_thread_count=1` (only the `.pptx`).
- **Frontend never renders the preview as a downloadable row — two independent guards:**
  - `frontend/src/app/components/session/PresenceArtifactSecondarySurfaces.tsx:161-163` — library list filters to `role === 'primary'` only.
  - `frontend/src/app/lib/builder-artifacts.ts:260-261` — `classifyBuilderArtifactFileRole` classifies any `*.preview.pdf` as `'preview'`.
- **Canvas affordances point the right way, with an explicit hint:**
  - `frontend/src/app/components/session/ArtifactStage.tsx:521-540` — `openHref` and `downloadHref` built from `primaryFile?.path` (the `.pptx`).
  - `ArtifactStage.tsx:541-543` — `renderHref` (in-canvas render ONLY) is the sole reference to the preview (`renderFile?.path`), gated on `canvasPreviewKind === 'pptx_pdf_preview'`.
  - `ArtifactStage.tsx:1723` — toolbar already ships `previewDownloadHint = "Preview - download is PowerPoint"`.
  - Completion payload exposes the preview only as `artifact_preview_filename` render hint, never as a second `artifact_path` (`builder_canvas.py:592`, `builder_events.py:338-340`).
- The multiple `artifact_registry` upserts noted earlier are re-upserts of the **same** `.pptx` primary across mirror/registry/canvas passes — the registry carries the same `.preview.pdf` suffix exclusion (`artifact_registry.py:71/215`), so none register the preview as its own deliverable.

### Fix
No correctness fix is warranted — the system is behaving as designed and is well-guarded on all surfaces. Optional perception-gap hardening only:
1. **(Optional, low risk)** Make the existing `previewDownloadHint` more prominent/persistent for `pptx_pdf_preview` decks and/or add a "PowerPoint (.pptx)" format badge on the deck card — `frontend/src/app/components/session/ArtifactStage.tsx`.
2. **(Optional, test-only)** Add a regression in `frontend/src/__tests__/session/useSessionBuilderArtifactLibrary.test.ts` asserting a pptx completion carrying `artifact_preview_filename` yields exactly one downloadable row (the `.pptx`) and zero rows for the `.preview.pdf`, locking current behavior against a future re-leak (the regression class flagged in the 2026-06-24 forensics).

---

## Issue 3 — Deck build slowness — ~17.6 min builder wall-clock

**Verdict:** The deck is genuinely complete and high quality (8/8 images, valid 16.8 MB `.pptx`, `artifact_is_fallback=False`, crisp HTML slides — `/tmp/deck_inspect/slide3.png`). The problem is purely **wall-clock**: ~17.6 min builder time (~20-25 min user-perceived). **85% is serial image generation** that should have been one parallel batch.

Deployed commit verified `3f4c63b9` (local HEAD == both Render services).

### Per-phase time budget (builder dispatch → completion webhook)

| Phase | Window (UTC) | Duration | Share |
|---|---|---|---|
| Companion dispatch + builder boot | 00:03:50 → 00:04:02 | 12 s | 1% |
| Research (turns 1-5: web_search/fetch/plan) | 00:04:02 → 00:04:24 | 22 s | 2% |
| **Image-gen SERIAL (turns 6-23, ~9 bash calls)** | **00:04:24 → 00:19:19** | **14.9 min (895 s)** | **85%** |
| Slide-HTML authoring 2nd pass (turns 25-32) | 00:19:19 → 00:20:36 | 77 s | 7% |
| Render+compile deck (turn 33, build_deck_from_slides) | 00:20:36 → 00:21:01 | 25 s | 2% |
| Emit model turn + preview PDF + webhook | 00:21:01 → 00:21:24 | 23 s | 2% |
| **TOTAL** | | **17.6 min** | |

Image-gen sub-breakdown (5 successful waves, 8 images): hero@00:06:27 (2.0 min), img@00:09:30 (3.0 min), **turn-21 call 00:09:36→00:15:27 (5.8 min for 2 imgs — the "stall")**, img@00:17:21 (1.8 min), img@00:19:15 (1.8 min). `attempt_count=15` for `success=8` ⇒ 7 transient-429 retries (OpenAI client `max_retries=3`, `timeout=120s`).

### Root cause

**Primary — image generation was serialized, not batched.** The model issued the slide images as ~9 single `generate.py --slide-visual` bash calls (turns 6,8,17-23) over 15 min, instead of the SKILL-mandated **hero + ONE `--manifest` batch** (which runs remaining slides concurrently at `SOPHIA_IMAGE_GEN_CONCURRENCY=3`). Proof: `image_generation_manifest_seen` is never set and `--manifest`/`IMAGEGEN_BATCH` never appear in the log. The batch path exists and works (`skills/public/image-generation/scripts/generate.py:822` `_run_batch`, `ThreadPoolExecutor`).

**The backstop that should have forced the batch never fired.** `_deck_batch_directive_rejection` (`builder_artifact.py:9642`, wired at `:9789`) is designed to reject a post-hero single `--slide-visual` call and redirect to `--manifest`. Grep for `phase=deck_batch_nudge` = **0 hits**. All preconditions were met by turn 17 (requested_ext=pptx — confirmed by the turn-3 ppt-generation correction; hero `success_count≥1` via the additive reducer `state.py:183`). The gate fires correctly in an isolated repro for the canonical command, so this is a real production gap — most likely (a) it is a **one-shot** nudge (`deck_batch_directive_emitted` escape at `:9659`) with a path-prefix-sensitive matcher (`_IMAGE_GENERATION_PATH_MARKERS` all absolute, `:243-248`) that the model's actual command form dodged, or (b) detection requires `--slide-visual` and misses a bare `generate.py` call. Raw bash strings are not logged (only tool names), so this cannot be fully closed from logs. (Confidence: medium.)

**The "6-min stall" is not idle.** Turn-21's single image-gen bash ran 00:09:36→00:15:27; the interleaved log lines are unrelated `default_user` companion polls (webapp build-awareness / `check_async_task` on a different thread). The 5.8 min for 2 images is gpt-image latency plus in-SDK exponential-backoff retries that serialize *inside* an already-serial call (`generate.py:550-594`, timeout 120s, max_retries 3).

**Double slide authoring** (turns 9-16 then 25-32, `write_file_count=17`) wasted ~8 turns: the model authored slides while waiting on serial images, referencing not-yet-existing PNGs, then re-authored after images landed. `SKILL.md:15-50` step order is correct (1 plan, 2 generate ALL images, 3 author HTML, 4 build) but the harness does not enforce "images before slides."

**Web research is force-gated before substantive tools** on fresh decks (`_research_gate_active`, `builder_artifact.py:5343-5386`; image-gen bash has write markers so `_is_safe_pre_research_bash=False`). Cost was small here (22 s) but it strictly precedes image-gen.

### Evidence index
- Turn map + bash turns: `/tmp/deck_inspect/lg_build.log` lines 136-1410
- Emit diagnostics: line 1470 (`attempt_count=15 success_count=8 picture_count=8`)
- Research diagnostics: line 1477 (`write_file_count=17`, `builder_web_search_count=1`)
- Gate: `builder_artifact.py:9642-9687`, markers `:243-248`, reducer `state.py:152-192`

**STILL UNRESOLVED:** the exact reason `_deck_batch_directive_rejection` logged zero nudges. The gate, its wiring, and the deployed commit (`3f4c63b9` has 3 references) are all present and correct. Raw bash command strings are not in this log; closing this needs either the command-prefix added to the bash `after_model` log, or a LangSmith trace of run `019f0b8a-3a0c` — **which is blocked by the `/runs/multipart 403` above.**

---

## Recommended fixes, prioritized

Ranked by impact. **[CODE]** = lead can implement; **[OPERATOR]** = Render env / LangSmith.

### P0 — Harden + fix the deck-batch backstop **[CODE]** (Issue 3)
- **Change:** Make batch enforcement HARD and matcher-robust. (a) Broaden detection — treat ANY post-hero single `generate.py` slide-image call as a violation regardless of `--slide-visual` (detect by output path under `assets/*.png`); relax the path marker to a substring match on `image-generation/scripts/generate.py` to catch relative/alt-prefix forms. (b) Drop the one-shot `deck_batch_directive_emitted` escape — keep rejecting post-hero singles until a `--manifest` batch is seen (retain the `image_generation_manifest_seen` escape so stray-failure repairs work AFTER a batch). (c) Add a `[BuilderImageGeneration] phase=deck_batch_check` debug log on every image-gen bash.
- **File:** `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:9642` (`_deck_batch_directive_rejection`) + `:9762` (`_image_generation_block_command`); markers `:243-248`.
- **Expected impact:** Converts 9 serial calls (14.9 min) → hero + ONE 7-item parallel batch (~2-3 min). **~12 min / ~70% wall-clock saving.**
- **Risk:** Low-medium. A too-aggressive hard reject could loop if the model cannot author a valid manifest — mitigate with a turn-bounded escape (after 2 batch rejections, allow singles + stamp a quality note). Cover with `tests/test_builder_image_generation_cap.py` + `tests/test_image_generation_batch.py`.

### P1 — Force opaque dark backstop in the render harness **[CODE]** (Issue 1)
- **Change:** Inject `page.addStyleTag({content:'html,body{background:#0e1626!important;margin:0;padding:0}'})` before `page.screenshot` (or a `--bg-color` arg defaulting to `#0e1626`). Keep `omitBackground` unset.
- **File:** `backend/packages/harness/deerflow/sophia/js/render_html_to_png.mjs:188-192`.
- **Expected impact:** Deterministically closes the white-band failure class regardless of model markup — the harness owns the conversion, so it owns the backstop.
- **Risk:** Low. A hardcoded bg could clash with a deliberately light deck; mitigate via `--bg-color` override. `!important` on `html,body` only paints regions the model left uncovered (opaque `.slide` still wins on top).

### P2 — Log bash command prefixes **[CODE]** (Issue 3 / observability)
- **Change:** Log the first ~120 chars of each bash command (sanitized, env-export-stripped) alongside `tools=bash`, or stamp into `builder_pptx_diagnostics`. Currently only the tool NAME is logged.
- **File:** `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py` (bash `after_model` log site, near line 136).
- **Expected impact:** Closes the forensic gap that prevented confirming WHY the batch gate missed; future image-gen invocations become distinguishable in prod logs.
- **Risk:** Low. Truncate + redact; cap length, strip env prefixes.

### P3 — Fix the `SKILL.md` deck skeleton **[CODE]** (Issue 1)
- **Change:** Add `background:#0e1626` to `html,body`; switch the visual to full-bleed (`background-size:cover` / `object-fit:cover` over a full-frame `.slide`) with overlaid title/narrative; add a hard rule "slide must be opaque dark to the edges."
- **File:** `skills/public/ppt-generation/SKILL.md:61` (+ `:63`, `:69-70`).
- **Expected impact:** Removes both the white-default exposure and the structural letterbox source; matches the user's stated "dark backgrounds with heavy visuals" preference (Mem0 score 0.929 in this run).
- **Risk:** Medium. `cover` crops image edges vs `contain`. For full-slide generated imagery `cover` is correct; if a diagram must be fully visible, keep `contain` over an opaque dark `.slide` (the html/body+`.slide` bg fix then renders gaps navy, not white).

### P4 — Images-before-slides ordering guard **[CODE]** (Issue 3)
- **Change:** Reject `slides/*.html` `write_file` calls that reference an `assets/*.png` not yet on disk, with a directive to finish image generation first. Kills the double-authoring (turns 9-16 then 25-32).
- **File:** `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py` (near `_deck_batch` / compile-latch logic).
- **Expected impact:** Saves ~8 wasted model turns (~77 s+).
- **Risk:** Low-medium. Scope the reject to references whose target PNG is enumerated in the slide plan but missing; bound to one rejection per slide. Cover with `tests/test_build_deck_from_slides.py`.

### P5 — Raise `SOPHIA_IMAGE_GEN_CONCURRENCY` (3→5-6) **[CODE/OPERATOR]** (Issue 3)
- **Change:** Once the batch path is enforced, raise concurrency toward the org's gpt-image RPM ceiling so a 7-item batch finishes in ~2 waves. Keep `max_retries=3` (it yielded 8/8 here); retries now overlap across the pool.
- **File:** `backend/skills/public/image-generation/scripts/generate.py:567-594` (`_image_gen_max_retries`), `:855-864` (`_run_batch` concurrency) — env-gated, so an operator can set the value once the RPM tier is verified.
- **Expected impact:** Further cuts post-batch image-gen time (3 waves → 2).
- **Risk:** Medium. Higher concurrency re-risks 429 saturation; gate behind verified RPM tier. Validate via `tests/test_image_generation_batch.py` + a live `SOPHIA_BUILDER_FORCE_PROVIDER` eval.

### P6 — Plumb `--bg-color` + golden white-pixel test **[CODE]** (Issue 1)
- **Change:** Carry `--bg-color` from `build_deck_from_slides.py` into `_slide_render_command` (default `#0e1626`); add a golden test rendering a slide that leaves an uncovered region and asserting zero interior pure-white pixels.
- **File:** `backend/packages/harness/deerflow/sophia/tools/build_deck_from_slides.py:123-130` + `tests/test_build_deck_from_slides.py`.
- **Expected impact:** Single source of truth for the dark backstop; pins the invariant against skeleton/prompt drift.
- **Risk:** Low. Additive plumbing + test; use a band/gutter-region check, not a blanket "no white anywhere."

### P7 — Skip/parallelize forced research for `task_type=presentation` **[CODE]** (Issue 3, optional)
- **Change:** For decks, skip the forced research-before-substantive gate or let hero/batch image-gen run in parallel with a single research turn.
- **File:** `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py:5343-5386`.
- **Expected impact:** ~22 s+ here, more on research-heavy decks; lets the long image-gen batch start sooner.
- **Risk:** Medium. Some decks want fresh research in slide content; gate on absence of explicit research intent. Validate with `tests/test_builder_prompt_contract.py`.

### P-OPS — Fix LangSmith run-trace ingestion **[OPERATOR]** (cross-cutting)
- **Change:** Verify the LangSmith API key is **WORKSPACE-scoped** (not org-scoped) with **tracing / `runs:write`** enabled; or grant that scope. Re-test `/runs/multipart` returns 2xx, not 403.
- **Expected impact:** Restores run-level traces, which would have let P2's command-prefix question be answered directly; unblocks future forensics.
- **Risk:** None to code. Operator-side credential/scope change.

---

## What is already correct / not a regression

- **8/8 image yield** — the `max_retries=3` image-gen fix worked; `image_generation_success_count=8`, `picture_count=8`, `missing_images=0`.
- **Exact-canvas clip** — `render_html_to_png.mjs` clips to the exact 16:9 deck canvas (no scrollbar, no pptx-level letterbox); every media PNG is a perfect 3840×2160 and `compile_pptx.mjs` places pictures full-bleed.
- **Thread-artifact exclusion of the preview works** — the `.preview.pdf` is excluded from every download surface (backend `artifacts.py:371`, `artifact_registry.py:71/215`; frontend role filter + classifier); the user got exactly one downloadable deliverable (`builder_task_thread_count=1`).
- **Honest emit metadata** — `artifact_is_fallback=False`, `final_artifact_ext=pptx`, real 16,803,915-byte `.pptx`; no format swap, no fallback dishonesty.
- **Deck content quality** — slides are genuinely complete and well-composed (verified via screenshots). The white bands and slowness are the only defects; the build itself is a real, high-quality success.
