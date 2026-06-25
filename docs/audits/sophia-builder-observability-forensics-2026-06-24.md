# Sophia Builder — Production Observability Forensics

**Date:** 2026-06-24 (build session 2026-06-25 ~00:57–01:58 UTC)
**Author:** Claude (observability investigation)
**Branch:** `codex/sophia-observability-v1` · PR [#144](https://github.com/davidelaverga/Sophia-Agent/pull/144) "Fix Sophia builder LangSmith trace landing"
**Trigger:** User ran a PPTX presentation + a 10‑page PDF report (JEPA topic). Presentation quality good but builder looped a long time; the report repeated one node‑link diagram and one page failed to render; the deck delivered both `.pptx` *and* `.pdf`; the finished artifact appeared only in the side panel, not the inline card.
**Providers connected:** Render ✅ · LangSmith ✅ · Vercel ✅
**Evidence bundle:** `docs/audits/_logs_2026-06-24/` (langgraph/gateway logs, LangSmith tool runs, forensic timeline, rendered PDF pages)

---

## 0. Executive summary

The build session ran on **backend at HEAD (`36d3172c`)** and a **frontend whose code is byte‑identical to HEAD** (the deployment is 6 commits behind, but none of those 6 commits touch `frontend/`). **Every issue below is therefore a current, reproducible bug — none is a stale‑deploy artifact.**

The report's **text was genuinely good** (clean abstract, equations, comparison tables, 12 references). All four problems live in the **visual + delivery** layers.

| # | Symptom | Root cause (one line) | Primary fix | Sev | Effort |
|---|---|---|---|---|---|
| 1 | Builder loops; report #1 **failed** then needed manual restart | PDF page‑count gate is an **exact‑equality** bound (10≠11) and exhausting 2 whole‑document re‑render repairs is wired to a **terminal failure** (`artifact_path=null`) | Tolerance band + downgrade to delivered‑with‑warning | **High** | S–M |
| 2 | Presentation delivered **`.pptx` + `.pdf`** | The deck's `<deck>.preview.pdf` (canvas render aid) leaks into the thread artifact list as a **second deliverable card** (gateway local‑disk leg admits it) | Stamp `role="preview"` / bind to parent deck in the gateway list endpoint | **Med** | S–M |
| 3 | **Same node‑link diagram repeated**; one page's graph **blank** | Model is **prompt‑steered** to the single‑grammar `generate_excalidraw_diagram` (Graphviz `dot`) instead of the 26‑type `generate_chart`; a failed visual leaves a **dead `![](…png)` ref** → empty figure | Re‑steer tool selection to `generate_chart` diagram families + hard‑repair dangling image refs | **High** | S–M |
| 4 | Artifact in **side panel** but not **inline card** | Inline card reads the **ephemeral canvas SSE** (lost on the failed→restart **run replacement** + reconnect, `replay_count=0`); side panel reads the **durable** artifact list | Reconcile inline card from the durable artifact index on (re)connect | **Med** | M |
| 5 | **Deck took ~21 min** ("looping") | **8 `gpt-image-2` calls run strictly serially** (~2 min each, `quality="high"`), ~17 of the 21 min — not a repair loop; the image skill has no batch/parallelism and the cap is **8** (docs say 3) | Parallelize image generation + lower quality/size for non-hero + reconcile the cap | **High** | M |

**Cross‑cutting insight:** the model's *inputs* were good (LangSmith shows varied `diagram_type` and valid chart specs); the failures are in the **gates, renderers, and delivery plumbing** — not the LLM.

---

## 1. Provider connectivity (reusable runbook)

This is the "set up for connecting to the providers" the team asked for. All three are reachable from this machine.

### 1.1 Render (backend logs) — ✅ fully working
- CLI authenticated via `~/.render/cli.yaml` (account `Sophia`, workspace `tea-d38p978dl3ps73a64hi0`). `RENDER_API_KEY` is also exported in `~/.zshrc`.
- Services:

| Service | ID | Type |
|---|---|---|
| `sophia-gateway` | `srv-d7be5s9r0fns7397l4g0` | web |
| `sophia-langgraph` | `srv-d7be5s9r0fns7397l4fg` | web |
| `sophia-voice` | `srv-d7be5s9r0fns7397l4f0` | web |

- Pull logs (JSON is concatenated objects — `jq` reads them natively; strip ANSI):
```bash
render logs -r srv-d7be5s9r0fns7397l4fg \
  --start 2026-06-25T01:30:00Z --end 2026-06-25T02:00:00Z --limit 1000 -o json --confirm \
  | jq -r '"\(.timestamp)\t\(.message)"' | sed -E 's/\x1b\[[0-9;]*m//g'
```
- Useful filters: `--text "sophia_builder"`, `--text "builder-events"`, `--level error`. **Limit caps at ~1000 lines per call** — narrow the time window to avoid silent truncation.
- Deploy commit (REST, key from `~/.render/cli.yaml`):
```bash
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/<srv-id>/deploys?limit=2" \
  | jq -r '.[].deploy | "\(.commit.id[0:12]) \(.status) \(.commit.message)"'
```

### 1.2 LangSmith (traces) — ✅ working (needs API key + workspace)
- **The CLI OAuth token was revoked** ("refresh token has been revoked"). Use an API key instead. Region is **EU**; the workspace header is mandatory or you get `403 Forbidden` (not 401).
- Env: `LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com`, `LANGSMITH_PROJECT=Sophia` (both in `~/.zshrc`). Workspace `26b7385f-8e69-4a13-b4da-49873ae46191` ("Workspace 1"). Project `Sophia` = `0170007e-c2c4-402f-91c0-9a708acaeab3`.
```bash
export LANGSMITH_API_KEY=<lsv2_sk_…>
langsmith trace list --project Sophia --workspace 26b7385f-8e69-4a13-b4da-49873ae46191 --limit 8 --format json
langsmith run list --project Sophia --workspace <ws> --trace-ids <id1>,<id2> \
  --run-type tool --include-io --since 2026-06-25T01:40:00Z --limit 100 --format json
```
- **PR #144 result: trace landing is CONFIRMED WORKING.** All three JEPA "Sophia Builder" root traces are present with full tool I/O. (Render logs also show `POST /v1/metadata/submit → 204` to eu.smith during the run.)

### 1.3 Vercel (frontend) — ✅ connected (REST; no CLI installed)
- No `vercel` CLI and no token in env; use the REST API with a token (`vcp_…`).
- User `davidelaverga`; team **Sophia** `team_DHqYIiMtenetBlh3ILlEoBVS`. **Production project = `sophia-agent-front`** (`prj_tvMjnsC0mrUu0HRNcgu4dmpnlJjy`); the `frontend` project has no deployments.
```bash
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v6/deployments?projectId=prj_tvMjnsC0mrUu0HRNcgu4dmpnlJjy&teamId=team_DHqYIiMtenetBlh3ILlEoBVS&limit=5"
```
- ⚠️ **No log drains are configured** (`/v2/integrations/log-drains` → `[]`), so **historical runtime/function logs are not retrievable via API** (the `/v3/deployments/{id}/events` runtime window returns empty for past time). Build logs *are* available. **Recommendation:** add a Log Drain (e.g. to a sink or Render gateway) so frontend SSE/proxy route logs become queryable for future incidents. Frontend behaviour here was reconstructed from source + gateway correlation, which is where the bug actually lives.

---

## 2. Forensic timeline — the JEPA build session

Companion thread `019efc46-a421-7422-8e78-67b2fbfd8bde`, user `CUyZxRFmDNON…`. Times UTC.

| Build | Builder thread / run | Window | Outcome |
|---|---|---|---|
| **PPTX deck** | thread `019efc47` / run `019efc47-9e32` | 00:57–01:18 (~21m) | ✅ success — `create-an-8-slide-presentation-on-jepa-j.pptx` **+ `.preview.pdf`** |
| **Report #1** | thread `019efc72` / run `019efc72-43ad` | 01:43–01:50 (~7m) | ❌ **failed** — `status=error, artifact_path=null` |
| *(companion echo glitch)* | run `019efc78` | 01:50:31 | the "echoing my own reply" UI bug in the screenshot |
| **Report #2 (restart)** | thread `019efc79` / run `019efc79-4f48` | 01:51–01:58 (~7m) | ✅ success — `create-a-10-page-technical-report-on-jep.pdf` |

Per‑build detail:

- **PPTX (`019efc47`)** — turn 3 needed a "ppt‑generation correction" (it initially drifted toward HTML, `pptx_generator_invoked=False, fallback_ext=html`), then recovered; **8/8 image‑gen calls succeeded** (12.1 MB), `pptx picture_count=9`; emitted `final_ext=pptx artifact_is_fallback=False` plus a 2.12 MB `…preview.pdf`. Both surface as artifact cards → the "pptx **and** pdf" symptom.
- **Report #1 (`019efc72`)** — visuals: `generate_excalidraw_diagram` ×3 + `generate_chart` ×2. `render_markdown_to_pdf` ×3 → **9pp → 18pp → 11pp**, all `layout_warning=page_count_off_target` (`requested_pages=10`). Terminal: `BuilderArtifact: terminal PDF page-count failure requested_pages=10 actual_pages=11 page_delta=1 repair_attempts=2` → completion webhook `status=error, artifact_path=None`. **An 11‑page PDF was thrown away over a 1‑page delta.**
- **Report #2 (`019efc79`)** — `render_markdown_to_pdf` ×3 → **9pp → 16pp → 10pp** (last `layout_quality=ok`, `short_page_count=4`); `forcing tool_choice=emit_builder_artifact after successful PDF render (repair_attempts=2)`; completion `status=success`. This is the attached 318,610‑byte / 10‑page PDF.

**User‑visible cost:** ~14 min across two report attempts (one a dead loss) + ~21 min for the deck.

---

## 3. Deployment topology & branch state

| Tier | Service / project | Live commit | Note |
|---|---|---|---|
| Backend | `sophia-langgraph` (Render) | **`36d3172c`** (HEAD) @ 00:37 UTC | live during session |
| Backend | `sophia-gateway` (Render) | **`36d3172c`** (HEAD) @ 00:36 UTC | live during session |
| Frontend | `sophia-agent-front` (Vercel) | `a8cbf8f1` @ 06‑23 | 6 commits behind HEAD |
| Branch | local `codex/sophia-observability-v1` | `36d3172c` | **synced** with origin (0/0), = PR #144 tip |

- The branch is already **at the last git state of the PR** — nothing to pull.
- The 6 commits the frontend is "behind" (`24757b12`, `c2643fc7`, `28c53b43`, `9a8509ce`, `9c8c90eb`, `36d3172c`) are **all backend builder‑gate changes — `git diff a8cbf8f1..HEAD -- frontend/` is empty.** So the deployed frontend code = HEAD frontend code. **A frontend redeploy alone fixes nothing here.**
- ✅ **Conclusion:** all four issues are present in current HEAD code and were exercised live. They are real bugs, not deploy drift.

---

## 4. Root‑cause analyses

> Findings below were produced by a 5‑investigator + adversarial‑verifier workflow reading HEAD code, then cross‑checked against Render logs, LangSmith tool I/O, and the rendered PDF. Verifier corrections are folded in.

### Issue 1 — Builder loops & report #1 failed (PDF page‑count gate)

**Severity: High.** Verdict: *mostly‑confirmed* (recommendations all safe; one residual fix flagged).

**Root cause.** The page‑count "gate" treats an exact request as a **zero‑tolerance equality** bound, and exhausting its 2 repair attempts is wired to a **terminal failure** that discards a perfectly readable PDF.

- Dispatch stamps `builder_pdf_requested_page_count=10` (`_page_count_target` → `_pdf_page_target_updates`, `builder_task.py:443/515`).
- `_pdf_requested_page_bounds` collapses the exact count to `(10, 10)` ([builder_artifact.py:2427](backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py)):
  ```python
  exact = state_or_result.get("requested_page_count") or state_or_result.get("builder_pdf_requested_page_count")
  if isinstance(exact, int) and exact > 0:
      return exact, exact            # ← one-page-wide window
  ```
- `_pdf_page_count_off_target` ([:2447](backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py)) → `not (10 <= 11 <= 10)` = **True**, so 9/11/16 are all "off target".
- Each miss injects a **whole‑document rewrite** repair (`_pdf_layout_repair_message` "expand … add narrative paragraphs/examples/evidence" or "compact … trim/combine"), nulls `builder_pdf_render_result`, and forces a **fresh ~90 s Sonnet turn** — so the loop is slow *and* oscillates (9→18→11, 9→16→10). It also inflates `short_page_count` (2→3→4) because padding to a count creates thin sub‑80‑word pages.
- After `_PDF_PAGE_COUNT_REPAIR_MAX = 2`, `_pdf_render_page_count_failed_after_repairs` ([:2392](backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py)) fires `_pdf_page_count_failure_fallback` (`:8659`) → `artifact_path=None, confidence=0.0, failure_code="pdf_page_count_off_target"`. **This violates the `backend/CLAUDE.md` invariant "A delivered artifact in the requested format is never a fallback."**

**Evidence.** LangSmith shows every `render_markdown_to_pdf` returned `success:true` (the renderer worked); Render shows the terminal `page_delta=1` failure; the attached PDF is the *restart's* output (the first build's 11‑page PDF was discarded).

**Recommendations.**
1. **(S/low)** Tolerance band: in `_pdf_requested_page_bounds`, return `(exact-N, exact+N)` with `N=1` (or `max(1, round(exact*0.1))`). 11 vs 10 then never triggers repair or failure.
2. **(M/med)** **Never terminal for a rendered PDF.** Replace the `_pdf_page_count_failure_*` path with emit‑the‑PDF + `quality_warning="page_count_off_target"` + capped confidence, mirroring the existing `visuals_not_embedded` precedent. *Residual fix the verifier flagged:* also relax the `wrap_tool_call` emit‑time rejection at `builder_artifact.py:6923‑6932`, or the emit path still forces `artifact_path=null`.
3. **(S/low)** Cheaper repair: drop `_PDF_PAGE_COUNT_REPAIR_MAX` to 1, and make the directive a **targeted ±1 section** edit rather than a full‑document rewrite (kills the `short_page_count` inflation).
4. **(M/low)** Add a repair **wall‑clock cap** that ships the best PDF + warning once elapsed crosses the force‑emit fraction.
5. **(S/low)** Symmetry: relax `_layout_quality`'s `page_count != requested_pages` to ±1 in `render_markdown_to_pdf.py:262` so the tool stops telling the model "off target" on an acceptable render.

---

### Issue 2 — Presentation delivered `.pptx` **and** `.pdf` (preview leak)

**Severity: Med.** Verdict: *mostly‑confirmed*.

**Root cause.** `<deck>.preview.pdf` is a **render‑only** raster of the deck (headless LibreOffice) for the PDF canvas — never a first‑class registry record. It leaks into the user‑visible set only through the gateway thread‑list endpoint `GET /api/threads/{id}/artifacts`, whose two source legs **disagree** about it:

- Local‑disk leg `_add_output_artifacts_from_dir` filters via `_is_builder_support_artifact_path` ([routers/artifacts.py:355‑369](backend/app/gateway/routers/artifacts.py)) — its suffix tuple **omits `.preview.pdf`**, so the preview is admitted as a normal artifact (→ second card).
- Supabase leg `_is_supabase_thread_list_support_artifact_path` deliberately **keeps** `.preview.pdf` (so the canvas resolver can find it post‑deploy).
- A third list, `artifact_registry._SUPPORT_ARTIFACT_SUFFIXES` ([artifact_registry.py:66‑74](backend/app/gateway/artifact_registry.py)), *does* include `.preview.pdf`. So the inconsistency is specifically the router‑local helper.

The frontend already excludes previews by `role` in **two** filters in `PresenceArtifactSecondarySurfaces.tsx` (lines 161‑163 and 226‑229) — but the role classification depends on the gateway/list carrying the right signal, and the local‑disk leg surfaces the preview as a plain artifact before that.

**Recommendations.**
1. **(S/low)** Immediate consistency fix: add `.preview.pdf` to `_is_builder_support_artifact_path`'s suffix tuple so the local‑disk leg stops admitting previews as deliverables (matches `_SUPPORT_ARTIFACT_SUFFIXES`).
2. **(M/med)** Make the gateway list endpoint authoritative: add a `role` field to the thread artifact item, classify `.preview.pdf → "preview"` once, and **bind it to its parent deck** (preview as a property of the `.pptx` row) — so a PPTX request's deliverable set is exactly `{the .pptx}`.
3. **(S/low)** Enforce preview exclusion once at the frontend library boundary (`useSessionBuilderArtifactLibrary` / `normalizeBuilderArtifactLibrary`), keeping the preview only as the resolved canvas render file.
4. **(S/low)** Regression test: PPTX completion → thread‑list yields exactly `{the .pptx}` with the preview bound as a render hint (both local‑disk and Supabase legs).

---

### Issue 3 — Repetitive node‑link diagram + one page failed to render

**Severity: High.** Verdict: *mostly‑confirmed*. **This is the most important fix and the cheapest.**

**Root cause (two parts).**

**3a — Repetition is a tool‑selection problem, not a "bypass."** The upstream chart skill is **NOT** bypassed at the render layer: `generate_report_chart.py` shells out to the upstream `skills/public/chart-visualization/scripts/generate.js` (AntV/GPT‑Vis, **26 types** including `network-graph`, `mind-map`, `flow-diagram`, `fishbone`, `sankey`, `organization-chart`, radar, treemap, venn). That variety is fully wired. The problem is the **prompt steering**:
- `builder_tools.py:46‑47` wires **both** `generate_chart` (26 families) **and** the fork‑custom `generate_excalidraw_diagram` (Graphviz `dot` — the *only* node‑link grammar; `diagram_type` only changes layout knobs like `rankdir/shape/splines`, never the grammar).
- `builder_task.py:1227` tells the model: *"For quantitative/comparative figures, call `generate_chart`; reserve `generate_excalidraw_diagram` for connected‑node structure."* The model reads "technical architecture/pipeline" as "connected‑node structure" and **repeatedly reaches for `generate_excalidraw_diagram`** → every figure is the same boxes‑and‑arrows DAG.

**LangSmith proof:** the model sent *varied* `diagram_type` (`flow`, `architecture`, `comparison`) with distinct nodes/edges — so the input is fine; the single‑grammar renderer collapses them. **Visual proof (attached PDF):** Fig 1 *"JEPA Core Architecture"* (`architecture`) and Fig 2 *"JEPA Training Pipeline"* (`flow`) are **visually interchangeable** — identical node shapes, identical group→colour palette (purple inputs / blue encoders / green states / yellow predictor / grey loss), identical top‑down arrow layout. (Screenshots: `_logs_2026-06-24/pdf_pages/fig1_architecture_diagram_p4.png`, `fig2_flow_diagram_p6.png`.)

The fork's **variety gate** (`_report_grammar_diversity_problems`, `builder_artifact.py:3294‑3340`) is **fooled by varied `diagram_type` labels**: 3 figures with distinct *declared* kinds give `len(counts)>=2` (passes the `<2` branch) and `figure_count=3<4` (skips the `>50%` branch) — so 3 visually‑identical diagrams slip through. (It *does* catch 3 *identically‑labelled* diagrams via the `len<2` branch.)

There is also an **orphaned** engine: `generate_visual_asset.py` has ~10 genuinely distinct layouts (process_flow, architecture, comparison_matrix, concept_map, radial, chevron, layered, matrix‑grid) + a VQ‑7 fingerprint dedup + G‑VIS goldens — **fully tested but not wired into `builder_tools.py`** (disconnected in a Jun‑23 change).

**3b — The blank page.** Report #2 generated **4 visuals but only 3 embedded** (`image_count=3`): the **radar chart silently dropped**, and the **bar chart rendered EMPTY** — Fig 3 *"World Model Architecture Comparison"* shows the title and axis labels (`category`, `value`, `0`) but **no data bars** (screenshot `fig3_bar_chart_EMPTY_p8.png`). When a visual call fails, the builder leaves its `![](visuals/x.png)` reference in the Markdown; `render_markdown_to_pdf` computes `images_missing/missing_resources` but doesn't treat it as a hard repair signal — so the dead/empty figure ships.

**Recommendations.**
1. **(S/low, highest leverage)** **Re‑steer tool selection.** Update `builder_task.py:1227` + `skills/public/sophia/visual_composition.md` so structural diagrams route to `generate_chart`'s `flow-diagram / network-graph / mind-map / fishbone / organization-chart / sankey` families. The variety is already installed — this alone breaks the repetition.
2. **(M/med)** Wire the orphaned `generate_visual_asset` into `builder_tools.py` for report task types (or fold its renderers into `generate_excalidraw_diagram`) — reverts the Jun‑23 regression and gives 10 distinct layouts with built‑in dedup.
3. **(M/low)** Add a per‑call dedup guard to `generate_excalidraw_diagram` (fingerprint resolved kind + sorted node labels + edge pairs; return `error_type="duplicate_diagram"`), mirroring `generate_report_chart`'s collision avoidance.
4. **(M/med)** Tighten the variety gate: flag when ≥2 figures share a grammar even below 4 figures, and **hash the rendered PNG bytes** rather than trusting the self‑declared `visual_type` (catches "different label, identical picture").
5. **(S/low)** **Fix the blank page:** make `render_markdown_to_pdf` treat `source_image_ref_count>0` with `missing_resources` (or a known failed visual) as a **bounded repair turn** — regenerate or strip the dead ref before the final emit. Also surface chart‑render failures (empty plot) from `generate_chart` instead of silently embedding an empty image.

---

### Issue 4 — Artifact in side panel but not the inline card

**Severity: Med.** Verdict: *partly‑wrong* (real bug, but narrower than first stated — corrections folded in).

**Root cause.** The inline card and the side panel read **two unsynchronized sources**:
- **Inline card** ← `useBuilderCanvas` (builder‑canvas **SSE** + snapshot), surfaced in `useSessionRouteExperience.ts` as `builderCompletion = builderCanvas.completion ?? completionFromTerminalCanvasTask(...)`.
- **Side panel** ← `useSessionBuilderArtifactLibrary`, which **polls** `GET /api/threads/{id}/artifacts` (the durable merged list).

The canvas SSE worker (`workers/builder_canvas.py`) keeps the terminal completion **only in the in‑memory history of the currently‑active run**; `recent_events()/replay_after()` return only the active run's history. In this session, **report #1 failed and report #2 (restart) became the active run** — so report #1's terminal was superseded, and on the **EventSource reconnect churn** (Render gateway logs: `subscriber closed → opened, replay_count=0` around 01:48) the live terminal was missed. The durable poller (side panel) still had the artifact; the ephemeral stream (inline card) did not.

**Verifier correction (important):** the snapshot endpoint **does** durably recover **within the 15‑min TTL** (it hydrates from `async_tasks/last_builder_artifact` + `ArtifactRegistry` via `_hydrate_completed_task_deliverable` and emits `active_task.completion`). So the real bug surface is narrower: the **superseded‑by‑active‑run (failed→restart)** case and the **>15‑min‑old** case — exactly the restart scenario here.

**Recommendations.**
1. **(M/med, smallest fix)** Make the inline card **reconcile from the durable artifact index** when `builderCanvas` reports a terminal/absent active task but `completion` is null — promote the `completionFromTerminalCanvasTask` fallback to also fire from the polled library (keyed by the latest completed builder task). The side panel already has the data. *Preserve* `completionFromTerminalCanvasTask`'s pass‑through of `artifact_is_fallback` (don't mint a fallback flag client‑side).
2. **(M/med)** Snapshot endpoint: reconstruct the terminal completion for the latest completed task **even when superseded by a newer run or older than TTL** (relax `_should_hide_stale_terminal_snapshot`; the frontend already rehydrates the snapshot on SSE error).
3. **(M/med)** Worker: persist the **last terminal completion per (task_id, run_id) durably**, not purged when a newer run becomes active — so a reconnecting subscriber for a completed/superseded run still gets its terminal.
4. **(S/low)** Replay the terminal on every fresh subscribe even without a `Last-Event-ID`; add a regression test that subscribes **after** `publish_completion` and asserts the terminal is replayed.

---

### Issue 5 — The deck took ~21 minutes ("looping") — serial image generation

**Severity: High.** Source: Render `BuilderImageGeneration`/`BuilderSkill` timing + LangSmith run durations + the image-gen skill source.

**This is a different failure mode from the report loops — it is NOT a repair loop.** The deck (`019efc47`) did legitimate, good work (8 distinct slide images, one per slide, all bytes differ; the quality you liked). The 21 minutes is almost entirely **serial image generation**:

- **8 `gpt-image-2` calls, each ~2 minutes, run one after another** (Render `script_invoked → BuilderImageGeneration success` pairs): 00:57:49→00:59:49, 01:00:02→01:02:21, 01:02:42→01:04:45, 01:04:58→01:07:06, 01:07:21→01:09:30, 01:09:49→01:11:56, 01:12:15→01:14:23, 01:14:38→01:17:04. That's **~17 of the ~21 minutes**.
- LangSmith corroborates: one `Sophia Image Generation OpenAI Call` = **144 s**; the hosting `bash` turn = **145 s**; LLM "think" turns average just **7.7 s**. So wall-clock is dominated by the OpenAI calls, not the model.
- The build's 27-turn signature is a `bash`(image-gen)↔`write_file` alternation — the model generates one image per turn, writes the slide, repeats. The agent loop is **idle-blocked ~145 s, eight times**.

**Why it's serial and slow (root causes):**
1. **No batch/parallelism.** `skills/public/image-generation/scripts/generate.py` generates **one image per process invocation** (single `--prompt`, `client.images.generate(...)`, no `nargs`/async). The model can only invoke it once per bash turn, so the 8 images are strictly serial across turns.
2. **Every slide image is `quality="high"`.** [generate.py:656](skills/public/image-generation/scripts/generate.py) hardcodes `quality = "high" if slide_visual else None` at a large 16:9 size → ~2 min/image. There's no "high hero, medium supporting" tiering.
3. **The cap is 8, and the docs say 3.** `_IMAGE_GENERATION_MAX_CALLS = 8` ([builder_artifact.py:251](backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py)); `_IMAGE_GENERATION_MAX_CALLS_PDF = 0` (:253). Both `CLAUDE.md` and `backend/CLAUDE.md` still document the cap as **3** ("`_IMAGE_GENERATION_MAX_CALLS = 3`" / VQ-5 "pdf=2, else 3") — **stale doc/code drift**. The deck hit the cap of 8 exactly; the line-246 comment still calls it "a hard per-build call cap" without the number.
4. *(Minor)* turn-3 `ppt-generation correction` — the model initially drifted toward HTML (`fallback_ext=html, valid_pptx_seen=False`) and was corrected; small cost.

**Recommendations.**
1. **(M/med, biggest win) Parallelize image generation.** Give the image skill a batch mode (accept N prompts, `asyncio.gather` the API calls) or have the harness/PPTX plan collect all slide-image prompts up front and fire them concurrently. 8×~2 min serial (~16 min) → ~2–3 min wall-clock. This also removes 7 model round-trips.
2. **(S/low) Tier the quality/size.** Use `quality="high"` only for the hero/cover; `"medium"` (and a smaller size) for supporting slide images. Cuts per-image latency materially with negligible deck-quality loss.
3. **(S/low) Reconcile the cap + fix the docs.** Decide the real cap (8 distinct images for an 8-slide deck is defensible *if parallelized*; otherwise consider hero + a few supporting). Update `CLAUDE.md` + `backend/CLAUDE.md` (both say 3) and the line-246 comment to match the code.
4. **(S/low) Add an image-generation wall-clock budget / progress signal.** Surface "generating image k/8" so a 17-min image phase isn't perceived as a hang (the Telegram/webapp progress relay hides `bash`, so image gen shows no live signal — see backend/CLAUDE.md `_HIDDEN_TOOLS`).

> Note this is orthogonal to the report looping (Issue 1): reports get `_IMAGE_GENERATION_MAX_CALLS_PDF = 0` (no `gpt-image`), so their visuals are charts/diagrams only — which is why Issue 3b's empty bar chart and dropped radar matter there, and why the deck (with 8 real images) looked good but slow.

---

## 5. Upstream deer-flow scan (`bytedance/deer-flow`)

Scanned `upstream/main` (DeerFlow 2.0, HEAD `b66e3253`) for diagram/chart variety and builder imports.

**Bypass verdict:** *There is no upstream contradiction.* The fork **vendors and wires the upstream chart‑visualization skill** (`generate_report_chart.py` shells out to `skills/public/chart-visualization/scripts/generate.js` — byte‑identical to upstream, 26 chart/diagram types). The "bypass" is entirely in the **fork's own tool‑selection prompt** (Issue 3a): the custom `generate_excalidraw_diagram` competes with `generate_chart` and the prompt steers structural figures to it.

### Diagram/chart candidates

| Upstream path | What it is | Fork status | Adopt |
|---|---|---|---|
| `skills/public/chart-visualization/scripts/generate.js` | AntV/GPT‑Vis renderer, 26 types (network‑graph, mind‑map, flow‑diagram, fishbone, sankey, org‑chart, radar, treemap, venn…) | **byte‑identical, already wired** | **skip** (already in; just *use* it — Issue 3a) |
| `skills/public/chart-visualization/references/generate_{network_graph,mind_map,flow_diagram,fishbone_diagram,organization_chart,sankey_chart}.md` | Per‑type arg specs the model reads before building node/edge/hierarchy payloads | all 26 vendored | **adapt (M)** — point the builder prompt at these 6 node‑link grammars |
| `skills/public/chart-visualization/SKILL.md` | Manifest + intelligent chart‑selection workflow | present (1 frontmatter key differs) | reference‑only |
| `skills/public/ppt-generation/`, `skills/public/image-generation/` | Deck/image skills | present (fork‑customized) | skip |

### Builder import candidates

| Upstream path | What it is | Adopt |
|---|---|---|
| `backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py` | P0 safety: hashes tool‑calls, warns + strips at threshold | reference‑only — relevant to runaway‑loop hardening (complements Issue 1's wall‑clock cap) |
| `…/middlewares/tool_output_budget_middleware.py` | Caps tool‑output size re‑injected into context | reference‑only (M) — keeps long builder runs from ballooning context |
| `…/middlewares/skill_activation_middleware.py` | Explicit `/skill` activation + SKILL.md injection | reference‑only (M) |
| `…/tools/builtins/view_image_tool.py` | In‑process image view (preview‑raster self‑review) | skip (fork already has preview‑raster review) |

**Net:** the highest‑value upstream "adoption" is to **actually use what's already vendored** (the 26‑type `generate_chart` diagram families) by fixing the fork's prompt — not a new import.

---

## 6. Prioritized action plan

**P0 — stop losing builds & fix the visible report defects**
1. PDF page‑count **tolerance band** + **never‑terminal** for a rendered PDF (Issue 1 #1, #2 incl. the `6923‑6932` residual). *S–M.*
2. **Re‑steer diagram tool selection** to `generate_chart` families (Issue 3 #1) — one prompt/skill edit, breaks the repetition. *S.*
3. **Hard‑repair dangling/empty visuals** so no blank figure ships (Issue 3 #5). *S.*

**P1 — delivery correctness & deck speed**
4. Stop the `.preview.pdf` second card (Issue 2 #1 immediate, then #2 role‑binding). *S→M.*
5. **Parallelize deck image generation** (Issue 5 #1) — the single biggest builder‑speed win: ~16 min serial → ~2–3 min. *M.*
6. Inline card **reconciles from the durable artifact index** on reconnect (Issue 4 #1). *M.*

**P2 — robustness, variety depth & hygiene**
7. Wire `generate_visual_asset` + diagram dedup + PNG‑hash variety gate (Issue 3 #2–#4). *M.*
8. Canvas worker durable terminal persistence + snapshot reconstruction for superseded/expired runs (Issue 4 #2–#4). *M.*
9. **Tier image quality/size** (high hero, medium supporting) + **reconcile the image cap (code=8, docs=3) and fix the docs** (Issue 5 #2–#3). *S.*
10. Add a **Vercel log drain** so frontend runtime logs are queryable next time (§1.3). *S.*
11. Consider upstream `tool_output_budget` / `loop_detection` middlewares for long‑run hardening (§5). *Reference.*

All recommendations were checked against the `CLAUDE.md` hard constraints (middleware order, soul.md immutability, Mem0 authority, `runs/stream`, `lead_agent` untouched, "delivered artifact is never a fallback"). The verifier confirmed **none violate a constraint**; Issue 1 #2 actively *restores* the never‑a‑fallback invariant.

---

## 7. Appendix

**Identifiers**
- Companion thread `019efc46-a421-7422-8e78-67b2fbfd8bde` · user `CUyZxRFmDNON…`
- PPTX run `019efc47-9e32-7c90-90df-459078305129`
- Report‑#1 (failed) run `019efc72-43ad-7c41-a2fa-1b89bbd2b48f`
- Report‑#2 (restart) run `019efc79-4f48-7db2-97b6-c911b9b3f8c1`
- LangSmith project `Sophia` (`0170007e…`), workspace `26b7385f…`, EU endpoint

**Evidence files** (`docs/audits/_logs_2026-06-24/`)
- `langgraph.txt`, `gateway.txt`, `gateway_builder.txt`, `presentation.txt`, `pptx_search.txt` — cleaned Render logs
- `ls_report_tool_runs.json` — LangSmith tool I/O (both report traces)
- `_timeline.md` — raw forensic timeline + cross‑provider addendum
- `pdf_pages/fig1_architecture_diagram_p4.png`, `fig2_flow_diagram_p6.png`, `fig3_bar_chart_EMPTY_p8.png` — visual evidence

> ⚠️ The `_logs_2026-06-24/` bundle contains production identifiers (user_id, thread_ids, Supabase project ref). Treat as internal; do not commit secrets. No API keys/tokens are stored in this report or the bundle.

**Key code references**
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py` — page‑count gate (`2427`, `2447`, `2392`, `8659`), emit rejection (`6923‑6932`), variety gate (`3294‑3340`)
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py:443/515/1227` — page target + diagram prompt steering
- `backend/packages/harness/deerflow/sophia/tools/{generate_excalidraw_diagram,generate_report_chart,generate_visual_asset,render_markdown_to_pdf}.py`
- `backend/app/gateway/routers/artifacts.py:355‑369` · `artifact_registry.py:66‑74` — preview suffix lists
- `backend/app/gateway/{routers,workers}/builder_canvas.py` — canvas SSE durability
- `frontend/src/app/session/{useSessionRouteExperience,builder-canvas-completion}.ts`, `hooks/useBuilderCanvas.ts`, `components/session/PresenceArtifactSecondarySurfaces.tsx`
