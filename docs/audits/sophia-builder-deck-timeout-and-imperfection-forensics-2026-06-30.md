# Sophia Builder — Deck Timeout + Imperfection Forensics (2026-06-30)

**Author:** Claude (Opus 4.8), forensic session for Davide
**Scope:** Two presentation builds run by the user on 2026-06-29 (evening): an 8-slide deck that **timed out**, and a 4-slide deck that **succeeded but rendered with imperfections** (`create-a-4-slide-professional-presentati.pptx`).
**Method:** Render production logs (sophia-langgraph) + LangSmith traces (now ingesting) + byte-level inspection of the delivered `.pptx` + deployed-vs-HEAD code cross-reference, with a 5-agent adversarial verification pass over each root cause.

---

## TL;DR

Both builds ran on the **deployed commit `7d529a00`**, which is **4 fix-commits behind** the branch HEAD `a7e42ce2`. But the headline is the opposite of comforting:

> **A redeploy of HEAD is necessary but does NOT fix either observed problem at the root.** It removes one cosmetic defect (the garbled baked-in title text) and adds a safety net for a *different* failure mode — but the 8-slide **timeout** and the 4-slide **quality defects** (cramped text, template chrome, any residual hallucinated bitmap text) are both caused by code paths that are **byte-identical between `7d529a00` and `a7e42ce2`**.

Two independent failure mechanisms:

| # | Build | Outcome | Root cause | Fixed by redeploying HEAD? |
|---|-------|---------|-----------|----------------------------|
| **P1** | 8-slide | **Timeout, no artifact** | A deterministic **image-batch deadlock** (`manifest_rejected` ↔ `deck_batch_nudge`) starves all post-hero slide images → model never authors slides → loops to the 45-turn ceiling. Amplified by image-gen latency. | **No** — the deadlock code is identical at HEAD |
| **P2** | 4-slide | **Delivered, imperfect** | An **internal contradiction** in the deployed commit: the gpt-image "visual" was prompted to *bake the whole slide* (title/narrative/labels) → garbled text. Plus **ungated slide-authoring defects** (cramped DOM text, template chrome). | **Partial** — redeploy removes the bake-in instruction; cramped text + chrome remain ungated |

---

## 1. Environment & evidence

**Deploy state (Render API, verified 2026-06-30 ~00:30Z):**

| Service | Live deploy | Commit | Finished |
|---|---|---|---|
| `sophia-langgraph` (srv-…l4fg) | `dep-d91fbi67…` | **`7d529a00`** | 2026-06-29 22:52:17Z |
| `sophia-gateway` (srv-…l4g0) | `dep-d91fbjgj…` | **`7d529a00`** | 2026-06-29 22:48:46Z |

**Commits on branch HEAD `a7e42ce2` but NOT deployed:** `3a242827` (visual-only `--slide-visual` prompt), `aed0ac16` (force HTML deck compile + opacity fix), `c220679c` (PDF page-target veto), `a7e42ce2` (PDF `.pdf` suffix guard). Both presentation builds ran *after* the 22:52Z deploy → **both on `7d529a00`.**

**LangSmith:** `LANGSMITH_WORKSPACE_ID=26b7385f-8e69-4a13-b4da-49873ae46191` is now correctly set on langgraph — the operator applied the fix I flagged on 2026-06-29, and traces for this window **ingested correctly** (`api_key_present: True, workspace_id_present: True`). Both builds appear in the `Sophia` project as "Sophia Builder" root runs.

**The two runs (Render logs + LangSmith durations):**

| Build | Request | Run id | Start | Duration | Deliverable status |
|---|---|---|---|---|---|
| **#1** | "build me an 8 slides deck about the harness abilities…" | `019f159d-a62e-…` | 23:01:22Z | 12.6 min | **`status=timeout, artifact_path=None`** |
| **#2** | "…compress to only 4 slides … same topic but 4 slides" | `019f15b9-79f8-…` | 23:31:45Z | 19.4 min | `status=success` (delivered the `.pptx`) |

> Note: LangSmith shows Build #1 run-status `success` because the langgraph *graph* returned normally (via timeout-as-terminal handling). The **deliverable** status was `timeout` with no artifact — don't conflate the two.

---

## 2. Build #1 (8-slide) — the timeout

### Timeline (Render logs, `sophia-langgraph`)

```
23:01:22  dispatch: task_type=presentation target_ext=pptx (8-slide deck)
23:03:41  [BuilderImageGeneration] gpt-image-2 success=True (hero, 1.39 MB)   ← 1 image only
23:04:05  [BuilderImageGeneration] phase=manifest_rejected                    ← batch call rejected
23:04:20  phase=deck_batch_check rejected=True manifest_seen=False success_count=1
23:04:20  phase=deck_batch_nudge                                             ← single fallback rejected
23:04–23:12  ~30× [BuilderResearchDiagnostics] phase=progress (web_search stuck at 1)
             two ~4-min gaps (hung image-gen retry windows)
23:12:02  write_file ext=py  (model improvises a python compiler)
23:12:08  artifact_integrity ext=html valid=false reason=html_too_small bytes=6 requested_ext=pptx
23:12:08–23:13:25  forcing tool_choice=write_file (non_artifact_turns=42→44, ceiling=45, "no output file yet")
23:13:55  fire_completion_webhook status=timeout artifact_path=None
```

It generated **one** image (the hero), **never authored a single `slides/*.html`**, **never called `build_deck_from_slides`**, and reached the ceiling with only a 6-byte HTML file on disk.

### Root cause: a deterministic image-batch deadlock

The deck pipeline expects: hero image → write a manifest JSON → run `generate.py --manifest <file>` (one parallel batch) for the rest. Two harness gates trap the model when that doesn't go perfectly:

1. **`_unreadable_manifest_rejection`** (`builder_artifact.py:757-776`) fires when a `--manifest` call points at a manifest that isn't a **readable JSON with >0 `items` already on disk**. Critically, this check runs at **bash-dispatch time, before the command executes** (`wrap_tool_call`/`awrap_tool_call`, `:9883`/`:10445`), reading the file via `host.read_text` (`_manifest_item_count_status`, `:725-748`). **A manifest written-and-run in the same `&&`-chained bash call does not exist yet at intercept → rejected.**

2. **`_deck_batch_directive_rejection`** (`builder_artifact.py:10025-10084`) then rejects **every post-hero non-`--manifest` image-gen call** (`success_count≥1`) — the `deck_batch_nudge` — until `image_generation_manifest_seen` flips, which only happens after a real `IMAGEGEN_BATCH` summary is parsed (`:964`).

**The trap:** after the hero, a `--manifest` call whose manifest isn't yet a readable on-disk file is rejected as unreadable; a single `--slide-visual` fallback is rejected for not being a manifest. The directive's only two exits are *"write a readable manifest in a prior call"* or *"stop cleanly with `artifact_path=null`"* — **there is no degrade-to-placeholders / author-the-slides-anyway escape.** A model that trips the readability rule has no productive path to the other 7 images. It drifts (the improvisation guard at `:10103` only blocks `python-pptx`/`pptxgenjs`, not arbitrary `.py`), and burns turns to the 45-turn ceiling (`builder_budget.py:94`).

The adversarial pass downgraded my initial "probabilistic" framing: **this is a deterministic dead-end, not bad luck.** And every function involved is **byte-identical between `7d529a00` and `a7e42ce2`** — so **redeploying HEAD does not fix Build #1.** (HEAD's only deck change, the restored compile-force, is gated on `slides/*.html` existing — which this build never wrote — so it can never fire here.)

---

## 3. Build #2 (4-slide) — delivered but imperfect

### Timeline

```
23:31:45  dispatch (4-slide)
23:32:22  read skills (visual-design, ppt-generation, image-generation)
23:34:45  gpt-image-2 success (hero, 1.25 MB)
23:35:27  manifest_seen=True  (batch launched)
23:37:17  gpt-image-2 success (1.06 MB)
23:45:25  gpt-image-2 success=False error_class=timeout "APITimeoutError"   ← 598s after batch launch
23:47:18  gpt-image-2 success (1.04 MB)   (retry landed)
23:49:10  gpt-image-2 success (1.07 MB)
23:50:46  build_deck_from_slides: build_success ext=pptx slide_count=4 size=10478654 missing_images=0
23:50:46  forcing tool_choice=emit_builder_artifact (reason=presentation_completion_ready)
23:51:12  fire_completion_webhook status=success
```

The HTML-slide path **worked**: 4 images, all 4 embedded (`missing_images=0`), compiled to a valid 10.4 MB `.pptx`. But it took ~19 min, dominated by image-gen latency (see §4).

### The delivered deck (byte inspection)

The `.pptx` is **4 slides, each a single full-bleed 16:9 image, with ZERO PPTX text runs**. This is by design: `build_deck_from_slides` screenshots each whole-slide HTML page to a 1920×1080 PNG (`render_html_to_png.mjs:234`, full-viewport clip) and `compile_pptx.mjs` wraps each PNG as one full-bleed picture (`addFullBleedVisual → addImage x:0 y:0 w:13.333 h:7.5`, `text_runs:0`). **All text — crisp or garbled — is rasterized into the slide screenshot.**

Visible defects (catalogued from the rendered slides):

1. **Garbled baked-in text in the generated visual.** Slide 1's central sphere is a gpt-image with ghosted text **"Qwen LWM"** (a hallucinated, misspelled "Qwen LWM") sitting behind the crisp DOM title "Qwen as a Language World Model." On the bottom-left, the image's baked labels ("Qwen / Alibaba DAMO Academy", "Qwen5 (2025)") ghost through behind the DOM feature strip.
2. **Cramped, dense, tiny DOM body text** — e.g. slide 1's bottom band crams **6 feature columns** into the lower 25% of the frame; slides 2/3 have illegibly small bottom paragraphs.
3. **Leftover "template chrome"** — a top eyebrow nav-row of tiny caps + a bottom icon strip, repeated across slides, that the model invented and isn't in the slide template.

### Root cause of defect #1: an internal contradiction in the deployed commit

At `7d529a00`, the deck SKILL and the image script **disagree**:

- `ppt-generation/SKILL.md:24-25` tells the model the slide image is **VISUAL-ONLY** — *"no title, narrative, labels, or chrome baked in; those are real HTML text."*
- But `image-generation/scripts/generate.py`'s `_SOPHIA_SLIDE_ZONE_CONTRACT` (`:98-103`), which `_build_prompt` injects into **every** `--slide-visual` prompt (`:508`), still commands gpt-image to *"render the entire 16:9 presentation slide as a complete bitmap. **Bake in the visible slide title, bottom narrative, labels, diagrams, and layout.**"*

So the model correctly authored DOM title/narrative **and** requested a "visual-only" asset — but the harness silently overrode the request and told gpt-image to bake the whole slide. Image models can't spell reliably → garbled bitmap text → doubled/ghosted text where the DOM layer doesn't fully cover the full-bleed image.

**Commit `3a242827` (HEAD, not deployed)** rewrites `_SOPHIA_SLIDE_ZONE_CONTRACT` to *"Visual-only slide asset: render ONLY the slide's visual … Do NOT bake in the slide title, a bottom narrative band, a footer, page numbers, or any slide chrome."* **Redeploying fixes defect #1.**

### Defects #2 and #3 are UNGATED and fixed by NO commit

This is the important, non-obvious finding. The HTML-slide deck path has **no slide-quality gate at all** — at HEAD or deployed:

- The only deck gate is missing-image counting → `quality_warning="visuals_partial"` (`build_deck_from_slides.py:339-362`). There is **no render-and-inspect, text-fit, `scrollHeight`/overflow, or chrome-detection check.**
- The text-fit engine that *does* exist (`generate_visual_asset.py:330`, "VQ-1 deterministic text-fit") is for **SVG chart visuals only** and is **not imported** by the deck path.
- `render_html_to_png.mjs` screenshots with `overflow:hidden`, so any cramped or overflowing text the model authors is **silently clipped and faithfully rasterized** into the deck.
- `ppt-generation/SKILL.md` defines only `.title`/`.visual`/`.narrative` and offers **soft prose guidance** ("keep text concise… a wall of text still looks bad") with no enforcement. It is byte-identical at HEAD.

So the cramped text and template chrome are pure model-authoring quality defects that **survive a redeploy untouched.** Slide visual quality is, today, **completely unverified** on the deck path.

---

## 4. Shared contributor: image-gen latency (the 19-min / timeout pressure)

Both builds were dominated by slow gpt-image-2 calls. The deployed `generate.py` (identical at HEAD):

- per-call timeout **120s** (`_image_gen_timeout_seconds`, `:639-642`, default when `SOPHIA_IMAGE_GEN_TIMEOUT` unset — confirmed unset on Render)
- **`max_retries=3`** → the OpenAI SDK makes **4 attempts** per call (`_base_client.py` retry loop), raising `APITimeoutError` only after the 4th
- batch **concurrency 2** (`:1029-1036`); `ThreadPoolExecutor` holds a stuck thread's slot for the whole chain

**A single hung image therefore dead-waits ≈ 4 × 120s ≈ 480–600s** (matching Build #2's observed **598s** gap, 23:35:27→23:45:25) and, at concurrency 2, **serializes the rest of the batch behind it.** This is the ~8-min stalls in both builds. The OpenAI image endpoint was evidently degraded/slow that night; the retry×timeout product turned each transient hang into a multi-minute wedge.

> **Doc/code mismatch worth noting:** `CLAUDE.md` and a code comment reference a 600s default, but the **actual code default is 120s** (`generate.py:632-674`). Build #2's ~598s is the **120s × 4-attempt retry product**, not a single 600s timeout. Anyone tuning the env var must reason about the *product*, not the single bound.

This latency is **unchanged at HEAD** — redeploy does nothing for it.

---

## 5. What a redeploy actually fixes (and doesn't)

| Concern | Deployed `7d529a00` | HEAD `a7e42ce2` | Redeploy verdict |
|---|---|---|---|
| Garbled baked-in title/label text in visuals (P2 #1) | Baked-slide contract | Visual-only contract (`3a242827`) | ✅ **Fixed** |
| Cramped tiny DOM body text (P2 #2) | Ungated | Ungated (identical) | ❌ Open |
| Template chrome / eyebrow / icon strip (P2 #3) | Ungated | Ungated (identical) | ❌ Open |
| 8-slide image-batch deadlock → timeout (P1) | Deadlock | Deadlock (identical) | ❌ Open |
| Image-gen 4×120s dead-wait on a hung call | 120s×4, conc 2 | Identical | ❌ Open |
| Slides-authored-but-not-compiled failure mode | None-stub (no force) | Compile-force restored (`aed0ac16`) | ✅ Fixed (a *different* mode than either observed build) |

**Net: redeploy is necessary-but-insufficient.** It improves P2's worst single defect and adds a correctness net for a deck failure mode neither of these builds hit, but it fixes **neither of the user's two observed problems at the root.**

---

## 6. Recommendations (prioritized)

### Must-do code fixes (these are what actually close the observed problems)

1. **Break the P1 deadlock — give the deck-batch directive a real escape (highest leverage).**
   In `_deck_batch_directive_rejection` / the image-block path: after N rejections **or** on a manifest-readability failure, **force the model onto the placeholder path** — let it author `slides/*.html` now and let the renderer's missing-asset placeholder + `visuals_partial` ship a degraded-but-delivered deck — instead of only ever saying "write a manifest or quit." *Alternatively/additionally*, defer the manifest-readability check to **post-execution** so a written-and-run manifest is accepted. This single change turns Build #1 from a timeout into a delivered deck.

2. **Add a real slide-quality gate to the HTML-slide deck path (closes P2 #2/#3).**
   At minimum a Chromium `scrollHeight`/overflow probe in `render_html_to_png.mjs` that flags clipped/overflowing text and triggers one bounded re-author turn; harden `ppt-generation/SKILL.md` to **forbid eyebrow/icon-strip chrome** and cap body-text density per slide. Today deck visual quality is entirely unverified — the existing text-fit engine is SVG-chart-only and not wired into the deck path.

3. **Deploy HEAD `a7e42ce2`** (gateway + langgraph together) regardless — it removes the baked-text contradiction (P2 #1) and adds the compile-force net. Just don't expect it to fix P1 or the cramped-text/chrome defects.

### Operational (no code, do immediately)

4. **Bound image-gen latency via env vars on `sophia-langgraph`:**
   `SOPHIA_IMAGE_GEN_TIMEOUT=60`, `SOPHIA_IMAGE_GEN_MAX_RETRIES=1`, `SOPHIA_IMAGE_GEN_CONCURRENCY=4` — caps worst-case dead-wait at ~120s (2×60s) and stops one hung item serializing the batch. (Validate the concurrency against your OpenAI image RPM tier.)

5. **Fix the doc/code mismatch:** correct `CLAUDE.md`'s "600s default" reference to the actual 120s, noting the retry-product math.

### Process

6. Until the P1 deadlock fix lands, **larger decks (≥6 slides) carry real timeout risk** under image-endpoint latency. The 4-slide retry was the right instinct.

---

## 7. Reproduction / evidence index

- **Render logs:** `render logs -r srv-d7be5s9r0fns7397l4fg --start 2026-06-29T22:55:00Z --end 2026-06-30T00:00:00Z --limit 1000 -o json --confirm`
- **LangSmith:** EU endpoint, `X-Tenant-Id: 26b7385f-…`, project `Sophia` (session `7dd40980-…`); root runs `019f159d-a62e-…` (Build #1) and `019f15b9-79f8-…` (Build #2).
- **Deck:** `create-a-4-slide-professional-presentati.pptx` — 4 slides, 4 full-bleed PNGs (`ppt/media/image-{1..4}-1.png`), zero text runs.
- **Key code (deployed `7d529a00`):** `image-generation/scripts/generate.py:98-103,508,632-674,1029-1036`; `builder_artifact.py:757-776,725-748,10025-10084,8053-8058,964`; `build_deck_from_slides.py:339-362`; `render_html_to_png.mjs:102-148,234`; `compile_pptx.mjs:124-189`; `builder_budget.py:94`.
- **Fix commits on HEAD:** `3a242827` (visual-only contract), `aed0ac16` (compile-force + opacity).

*Verified by a 5-agent adversarial pass (deployed-vs-HEAD code read, 143 tool calls); all four root-cause hypotheses confirmed, the "just redeploy" conclusion explicitly refuted.*
