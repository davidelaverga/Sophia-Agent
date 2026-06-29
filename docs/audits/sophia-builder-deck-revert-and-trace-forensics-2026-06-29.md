# Sophia Builder — Deck Revert + Trace-Pipeline Forensics (2026-06-29)

**Date:** 2026-06-29
**Deployed commit (both services):** `23d20a5a "restore image-forward pptx builds"` (langgraph 14:50Z, gateway 14:46Z)
**Artifact analyzed:** `8-slide-technical-presentation-on-best-a.pptx` — **2 slides** delivered (requested 8), title/caption **clipped**.
**Failing run:** builder task `019f13de-551c-71b0-8e17-434410965755`, parent thread `019f13dd-…`, 14:52:45Z → 15:18:20Z (**~25.5 min**), completion `status=success` (degraded).

---

## Executive summary

Three separate problems are stacked; only the first is new today:

1. **Trace pipeline is misconfigured (and has been dark since ~2026-06-25).** The LangSmith key is an **EU org-scoped key** that *requires* a workspace tenant header, but Render's `LANGSMITH_WORKSPACE_ID` points at the **wrong workspace** (`464e1fa8-…`, which this key cannot access) → `403 on /runs/multipart`. The correct workspace is **`26b7385f-…`** (verified — it returns the Sophia project). Because of this, the 06-28 and 06-29 failures **never reached LangSmith** — this analysis is Render-logs-only.
2. **Image generation is failing/slow at the OpenAI layer — and this is compile-path-agnostic.** Today's build got **2 of 8 slide images** (`timeout` at 120 s on the heavy hero prompt; a `--manifest` batch that failed `not_outputs_path`; an `api_error`). **Anthropic returned `200 OK` throughout — credits were NOT the cause of this build.**
3. **The 06-29 "image-forward" revert (12 commits) made deck reliability/quality worse.** It **removed the partial-image "ship anyway" floor** (the single most important reliability fix) and **reintroduced baked-in-text clipping**. The underlying image-gen outage would hit either path, but the prior HTML path had a floor that shipped a degraded-but-complete 8-slide deck; the reverted path loops to the ceiling and ships only the 2 images that happened to succeed.

---

## 1. Trace pipeline — root cause + corrected fix

Tested the provided key directly against LangSmith:

- `/api/v1/info` is unauthenticated (200); **every authenticated endpoint returns `403 Forbidden` without a tenant header** on both EU and US bases → the key is **org-scoped**, not workspace-scoped.
- `/api/v1/workspaces` (EU) lists exactly one workspace: **`26b7385f-8e69-4a13-b4da-49873ae46191`** (org "Personal", free tier). With `X-Tenant-Id: 26b7385f-…`, `/sessions` returns **200** and the **Sophia** project.
- With `X-Tenant-Id: 464e1fa8-…` (the value currently in Render) → **403**. That workspace is not accessible to this key.

**Therefore the live 403 on `/runs/multipart` is a wrong-workspace-id, not a key-scope problem.** Render currently has `LANGSMITH_WORKSPACE_ID=464e1fa8-…` on **both** services — wrong.

**Correct fix (supersedes the earlier "remove the workspace id" guidance — that was based on assuming a workspace-scoped key):**
- Set `LANGSMITH_WORKSPACE_ID = 26b7385f-8e69-4a13-b4da-49873ae46191` on **both** services (this org key *requires* it).
- Keep `LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com`, `LANGSMITH_TRACING=true`, the EU `LANGSMITH_API_KEY`.
- Restart both (config is a cached process singleton, `tracing_config.py:77-79`).
- *(Alternative: mint a true workspace-scoped Service key inside that EU workspace; then the tenant id can be omitted. With the current org key it is mandatory.)*

**Impact of the misconfig:** LangSmith has **no traces after 2026-06-25**; the 06-28/06-29 failing builds were never ingested. Latest traces are 06-20 and 06-25 (both `success`); a working build then ran in **~7.2 min** (vs ~26 min today). Code-side tracing wiring is otherwise correct (`observability.py:151-161` only sends the tenant header when the env var is set; `_builder_langsmith_tracer` builds the ingest client from it).

> Minor: `LANGSMITH_PROJECT` is set to the literal value `"Sophia"` (with quotes). The config reader strips quotes (`tracing_config.py:52`), so the effective project is `Sophia` — but there are two projects in LangSmith (`Sophia` and `"Sophia"`) from past runs. Harmless, but worth tidying.

---

## 2. The failing build (Render logs, run `019f13de`)

Image-forward path. Timeline:

| Time (UTC) | Event |
|---|---|
| 14:52:45 | `start_builder_task task_type=presentation` dispatched |
| 14:53:26 | `deck_batch_check rejected=False manifest_seen=False success_count=0` (hero attempt) |
| 15:01:31 | image **FAIL** `error_class=timeout status_reason=missing_output` (120 s cap) |
| 15:10:21 | image **SUCCESS** `bytes=1399001` (→ slide 1) — hero took ~17 min |
| 15:11:41–52 | `--manifest` batch runs (`manifest_seen=True`) → items **FAIL** `not_outputs_path` + `missing_api_key`/`api_error` |
| 15:16:31 | image **SUCCESS** `bytes=1352325` (→ slide 2) |
| 15:18:18 | `emit_accepted pptx_generator_invoked=True valid_pptx_seen=True` (2-slide deck) |
| 15:18:20 | completion webhook `status=success` |

- **Image yield: 2/≥5.** One 120 s timeout (heavy full-slide prompt), a manifest batch failing `not_outputs_path`, an `api_error`. Image-forward = 1 image/slide, so **2 images → 2 slides**.
- **42 turns, ~25.5 min.** The hero alone consumed ~17 min (repeated slow/timed-out attempts).
- **Anthropic `200 OK` throughout; no `ProviderFallback`, no credit/`invalid_request` errors** in-window → **credits were not the trigger of this build.**
- **`not_outputs_path`**: `_virtual_output_status` (`builder_artifact.py:~4282`) flags this only when the produced path is **not under `/mnt/user-data/outputs/`**. The batch items landed somewhere the harness doesn't accept → those slides were lost. Most likely the new image-forward manifest guidance led the model to write outside the outputs prefix (prompt/path issue to confirm), not a classifier bug.
- **`missing_api_key` on one batch item is anomalous** (the key is present — other calls succeeded). Harness maps the literal `openai_api_key` stderr token → `missing_api_key`; a present-key API failure is normally `api_error`. Low-frequency, worth a glance but not the dominant cause.

---

## 3. Did the previous commits make it worse? — Yes (the 06-29 revert), with one genuine win

The 12 commits `74e9288e..23d20a5a` (all 2026-06-29) **reverted the deck contract from HTML-slides to full-slide-image-per-slide** and compile via `bash → ppt-generation/scripts/generate.py --plan-file`. `build_deck_from_slides` was removed from the toolset; authoring `slides/*.html` is now actively rejected.

| Capability | Effect of the revert | Evidence |
|---|---|---|
| **Partial-image "ship anyway" floor (WS-B)** | **LOST — critical.** `_pptx_compile_ready` reverted from slide-HTML-completeness to `_pptx_slide_assets_ready`, which requires `success_count ≥ target_count` (all images). 2 < 8 → never compile-ready → loops to ceiling → ships only succeeded images. No placeholder path. | `builder_artifact.py:497` (`_pptx_compile_ready`), `:459-467` (`_pptx_slide_assets_ready`) |
| **Deck text fidelity** | **WORSE.** Title/narrative are now **baked into the gpt-image bitmap**; gpt-image doesn't reliably honor the top/bottom "safe band" contract and `_normalize_slide_visual_aspect`'s center-crop trims the bands → clipped title/caption. HTML path had crisp DOM text positioned by CSS, structurally unclippable. | `image-generation/SKILL.md` (text "baked into the image"); `generate.py:~746` (center-crop) |
| **White bands** | **BETTER (real fix) but my CDP fix is now dead code.** The actual white-band cause was `_normalize_slide_visual_aspect` padding off-aspect output onto a **white** canvas; the revert replaces white-pad with **center-crop** → no white bands. The HTML-render CDP `--bg-color` backdrop never runs for decks now. | `generate.py:~746` (white-pad → crop) |
| **Parallel `--manifest` batch** | **KEPT** (still `ThreadPoolExecutor`); pre-batch manifest validation strengthened. Boolean guard still unlocks serial repairs after one batch (long-tail weakness, both paths). | `generate.py::_run_batch`; `builder_artifact.py:9983` |
| **Image-gen concurrency** | **WORSE for speed:** default `3 → 2` and requested concurrency now clamped to that max → more sequential waves. | `generate.py:~1025-1035` |
| **Image-gen timeout / retries** | **UNCHANGED:** 120 s / 3. (The 120 s cap is the source of the prod timeout — identical on both paths.) | `generate.py:630-665` |
| **Role-aware delivery card** | **KEPT + IMPROVED:** primary-file resolution intact; `47f989d3` adds the correct download filename. | `BuilderCompletionCard.tsx` |
| **`not_outputs_path` / `missing_api_key`** | **No regression in classification.** Present key → `api_error` (matches prod). | `builder_artifact.py:4279-4312`, `generate.py:667-669` |

**Net:** the revert traded a structurally-correct text path (crisp DOM text + a partial-failure floor) for a fragile baked-text path (clips text, no floor). It *did* correctly fix the white-band cause (crop vs white-pad). But the **image-gen outage is compile-path-agnostic** — the HTML path (`74e9288e`) was *not* implicated in the outage and its floor would have shipped a degraded-but-complete 8-slide deck instead of looping to a 2-slide result.

> **Doc drift:** `backend/CLAUDE.md` still documents the HTML-slide `build_deck_from_slides` pipeline (contradicts the reverted code). Code/SKILL are authoritative; the doc needs updating.

---

## 4. Root causes, ranked

1. **(Operator) OpenAI image-gen outage + 120 s timeout on heavy full-slide prompts** — the trigger for low yield. Full-slide prompts (title+diagram+caption baked in) are slower than the HTML path's visual-only images, so they hit the 120 s cap more often. *Compile-path-agnostic.*
2. **(Code, regression) No partial-image floor on the image-forward path** — turns a recoverable partial outage into a 26-min loop that ships 2/8. The WS-B floor that handled exactly this was removed in the revert.
3. **(Code, regression) Baked-in text + center-crop → clipped title/caption** — the image-forward contract reintroduced a class of defect the HTML path had eliminated.
4. **(Config) Trace pipeline blind** — wrong `LANGSMITH_WORKSPACE_ID` (`464e1fa8` vs correct `26b7385f`) → 403 since ~06-25 → no traces for the failing builds, slowing every diagnosis.
5. **(Code, minor) Concurrency 3→2 + boolean batch guard long-tail** — amplify runtime.
6. **(Confirmed NOT a cause this build) Anthropic credits** — `200 OK` throughout.
7. **(To confirm) `not_outputs_path` on the manifest batch** — image-forward manifest guidance may write outside the outputs prefix; verify the new SKILL's `image_path`/output conventions.

---

## 5. Recommendations

### Operator (do first — restores visibility + likely restores yield)
- **Fix traces:** set `LANGSMITH_WORKSPACE_ID=26b7385f-8e69-4a13-b4da-49873ae46191` on both services (do **not** remove it), keep EU endpoint + `LANGSMITH_TRACING=true`, restart. Confirm a build shows no `/runs/multipart 403` and appears in the Sophia project.
- **Confirm OpenAI image health:** billing/credits + gpt-image org verification on the langgraph key (the layer behind the `timeout`/`api_error`).

### Code (proposed — needs your go-ahead)
1. **Restore a partial-image floor on the image-forward path.** After the slide-count repair nudge is spent (or after N terminal/timed-out image failures), compile the deck with the images that succeeded + a neutral placeholder for the rest, ship with `quality_warning="visuals_partial"` + `missing_image_count` — never loop to the ceiling for a partial outage. (Re-implements WS-B for the new contract.) Add `timeout`/`api_error`/`insufficient_quota` handling so a sustained outage degrades fast instead of grinding 26 min.
2. **Stop clipping baked text.** Either (a) raise/respect the safe-band contract and validate via a render-and-inspect OCR pass before accept, or (b) — stronger — keep title/narrative as real text (the HTML path's structural guarantee) rather than baking it into the bitmap. Worth an explicit decision: the revert's white-band fix (crop) is good, but baked text is the wrong substrate for crisp, unclippable titles.
3. **Classify quota/rate/timeout truthfully** in `generate.py::_classify_exception` (add `insufficient_quota`/`rate_limit`) and **log the captured `raw_error`** into the harness `BuilderImageGeneration` line, so the next outage is readable from Render logs even if traces lag. (Carried over from the 06-28pm plan — still not done.)
4. **Raise the image-gen timeout for full-slide prompts** (or shrink prompt complexity); revisit the concurrency 3→2 drop once yield is healthy.
5. **Investigate `not_outputs_path`** on the manifest batch — ensure the image-forward manifest writes under `/mnt/user-data/outputs/`.
6. **Update `backend/CLAUDE.md`** to match the reverted image-forward contract (currently documents the removed HTML path).

### Strategic
The image-gen outage hurts **both** paths; the differentiator is the **floor**. Whichever deck substrate you keep (image-forward or HTML), the non-negotiable is: *a partial image outage must still ship a complete-looking deck (placeholders) within a few minutes, not loop to the ceiling and ship 2 slides.* That floor is what regressed.

---

## Evidence index
- Deployed commit: Render deploys API (`23d20a5a`, 14:50Z/14:46Z).
- Failing run: Render langgraph logs 14:52–15:18Z (image results, `deck_batch_check`, `emit_accepted`, `BuilderBudget`, Anthropic 200s).
- Deck artifact: `8-slide-technical-presentation-on-best-a.pptx` (2 slides, images 1536×864, title/caption clipped).
- LangSmith: org key probe (EU 403 w/o tenant; workspace `26b7385f` returns Sophia project; latest trace 06-25, ~7.2 min success baseline).
- Revert diff analysis: `git diff 74e9288e..23d20a5a` (full capability table above).
- Related: `docs/audits/sophia-builder-deck-imagegen-failure-forensics-2026-06-28pm.md`, `docs/audits/sophia-builder-presentation-loop-rendering-forensics-2026-06-29.md`.
