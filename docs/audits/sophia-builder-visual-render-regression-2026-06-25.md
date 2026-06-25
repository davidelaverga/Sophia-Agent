# Sophia Builder — Visual-Render Regression Forensics (post-redeploy)

**Date:** 2026-06-25 (build session ~14:06–15:00 UTC) · **Author:** Claude
**Branch/commit live in prod:** `codex/sophia-observability-v1` @ **`f0e97db3`** (langgraph + gateway, deployed 13:43–13:44 UTC — i.e. *my* visual overhaul `170c6586`+ was live)
**Trigger:** After redeploying the 2026-06-24 fixes, the user reports: the **deck still loops a long time** (quality good), and the **PDF now uses varied (non-repetitive) graphs but every single visual failed to render**.
**Providers:** Render ✅ · LangSmith ⚠️ (afternoon builder traces did not land) · artifact inspected (rendered to PNG)
**Evidence bundle:** `docs/audits/_logs_2026-06-25/` (cleaned Render logs, forensic timeline, rendered PDF pages)

---

## 0. Executive summary

My 2026-06-24 overhaul (`170c6586`) **achieved its intent — and exposed a worse failure underneath it.**

| Symptom | What my change did | Result | Root cause |
|---|---|---|---|
| **PDF visuals** | Removed local `generate_excalidraw_diagram` (graphviz); routed **all** report visuals to `generate_chart` | **Variety ✅ but every visual broken** — charts render as empty dark boxes, diagrams missing entirely | `generate_chart` renders **remotely** via Alipay GPT‑Vis with a **strict per‑type data schema the model is never told**; wrong data → empty PNG (charts) or thrown error swallowed as `success=False` (diagrams) |
| **Deck looping** | Added a `--manifest` parallel‑batch path + hero‑anchor *prompt* nudge | **Still serial (~30+ min)** | The batch nudge is **prompt‑only and contradicted by the authoritative `ppt-generation/SKILL.md`**, which still prescribes serial per‑slide generation; the model followed the card |

**Net:** I traded the PDF's old *repetitive‑but‑rendered* graphviz diagrams for *varied‑but‑entirely‑broken* GPT‑Vis output, and the deck batch fix never took effect. Both root causes are **verified with live reproduction** against the production renderer.

**The fix direction is LOCAL‑FIRST:** the remote GPT‑Vis path is fundamentally fragile for offline PDF/PPTX assembly (it's a chat‑oriented, schema‑strict remote service). Render report visuals with the **local** `generate_visual_asset` engine (+ graphviz for node‑link diagrams), and harness‑enforce deck image batching instead of hoping the prompt is followed.

---

## 1. Evidence — the build session

Companion thread `019eff19-a1aa-7f20-9503-212297dbd2bf`. Backend confirmed at `f0e97db3`.

| Build | Run | Outcome |
|---|---|---|
| 10‑slide deck | `019eff1a-e7c7` | ✅ pptx (good slides) — but ~30+ min, serial image gen |
| PDF report #1 | `019eff42-d997` | (restarted) |
| **PDF report #2** (the attached artifact) | `019eff45-88d5` | ✅ pdf delivered — **all 11 visuals broken** |

### 1a. PDF: chart-render results (run `019eff45`)
`generate_chart` was called **11×** with genuinely varied families (my re‑steer worked):

| Family | `[BuilderVisualDiagnostics]` result |
|---|---|
| `flow_diagram` ×2, `network_graph`, `mind_map`, `organization_chart` | **success=False**, png_bytes=None, png_error=None (no image) |
| `bar`, `sankey`, `radar`, `line`, `treemap`, `column` | success=True, png_bytes 29k–63k — **but the bytes are an empty dark canvas** |

`render_markdown_to_pdf`: `image_count=7 source_image_ref_count=7 images_missing=False short_page_count=6 layout_quality=ok`. It embedded the 7 empty PNGs without complaint; the 4 failed diagrams left 6 sparse pages.

### 1b. PDF: visual ground truth (rendered artifact)
- **p2 "Figure 1: Agent Collaboration Loop"** — captioned as a flow diagram, but the embedded image is an **empty bar chart** ("Accuracy Improvement %", axes `category`/`value`/`0`, no bars). (`_logs_2026-06-25/pdf_pages/fig1_empty_barchart_p2.png`)
- **p4 "Figure 3: Sankey"** — a **pure black box**, title only. (`fig3_black_sankey_p4.png`)
- **p6 "Figure 4: Line Chart"** — title + axes + a lone legend dot, **no line**. (`fig4_empty_linechart_p6.png`)
- Text, headings, tables, references: **good quality**. The failure is 100% in the visual layer.

### 1c. Deck: serial image generation (run `019eff1a`)
`script_invoked → BuilderImageGeneration` pairs are strictly **one image per turn**, ~2.5–3 min each; **one call ran ~10 minutes then failed** (`success=False error_class=api_error status_reason=missing_output`). The `--manifest` batch path was **never invoked**.

### 1d. LangSmith
Afternoon builder traces (14:06+) **did not land** — the latest visible "Sophia Builder" trace is the 01:51 morning run. A trace‑landing gap on `f0e97db3` (ironic given PR #144's subject). Render structured logs carried the evidence instead.

---

## 2. Root cause #1 — PDF: `generate_chart` is a remote, schema-strict renderer the model calls blind

**Verdict: mostly-confirmed, reproduced live.**

`generate_chart` is **not** a local renderer. `generate_report_chart.py` shells `node skills/public/chart-visualization/scripts/generate.js <spec.json>`, which **POSTs to the remote Alipay GPT‑Vis service** `https://antv-studio.alipay.com/api/gpt-vis` ([generate.js:34‑39,62‑77](skills/public/chart-visualization/scripts/generate.js)) and returns an image URL the Python tool downloads ([generate_report_chart.py:353‑360,396‑448](backend/packages/harness/deerflow/sophia/tools/generate_report_chart.py)). GPT‑Vis enforces an **exact per‑chart‑type data schema** that the fork **never tells the model**, and `generate.js` **swallows every per‑spec error** (catch → `console.error` → exits **0**). Two failure modes follow:

**(a) Empty charts** (`bar/line/radar/sankey/treemap/column`). GPT‑Vis wants `data` as an array of objects with exact keys — `bar=[{category,value}]`, `line=[{time,value}]`, `radar=[{name,value}]`, `sankey=[{source,target,value}]`. The model sent a tolerated‑but‑wrong shape (e.g. `[{x,y}]`, `[{label,value}]`). The service returns **HTTP 200 + a valid PNG URL**, but with no series mapped it draws only the frame: title + default field‑name axis labels (`category`/`value`/`time`) + a `0` tick. `_valid_image_response` ([:227‑236](backend/packages/harness/deerflow/sophia/tools/generate_report_chart.py)) only checks the bytes are a **non‑empty image**, so an empty‑plot PNG (29–63 KB) **passes → success=True** and is embedded as a dead figure.

**(b) Failed diagrams** (`flow_diagram/network_graph/mind_map/organization_chart`). These need `data.nodes`/`data.edges` **nested** under `data`. A wrong payload makes the remote **throw**; `generate.js` catches it, writes to **stderr**, prints **no URL**, and **still exits 0** ([generate.js:143‑161](skills/public/chart-visualization/scripts/generate.js)). The wrapper's `_generation_error_payload` gates the failure branch on `returncode != 0` **only** ([generate_report_chart.py:363‑393](backend/packages/harness/deerflow/sophia/tools/generate_report_chart.py)); since node exited 0, it falls through to `_extract_first_url("") = None` → `error_type="chart_url_missing"` with no `png_bytes`/`png_error` keys → the observed `success=False png_bytes=None png_error=None`.

**Live reproduction** (node v22 against the prod service):
- `bar data=[{category,value}]` → correct 3‑bar chart; `bar data=[{x,y}]` / `[{label,value}]` → **HTTP 200, a 35–47 KB PNG that is title + `category`/`value` axes + `0` only** (exactly the prod symptom).
- `flow_diagram data.nodes/edges` → valid URL; top‑level `nodes/edges` → stderr `Cannot read properties of undefined (reading nodes)`, **empty stdout, exit 0**.

**Why the model guesses wrong:** the `generate_chart` docstring ([:516‑531](backend/packages/harness/deerflow/sophia/tools/generate_report_chart.py)) says only "pass exact labeled chart arguments in data" — it never states the per‑type schema, and there is **no per‑turn guidance** supplying it (grep: zero matches).

> Minor correction from verification: the `phase=tool_result` diagnostic *does* print the failing tool name (`visual_type`/`chart_tool`), only the `error_type` string is hidden in `visual_asset_error_class`. So the regression is debuggable from logs, just not surfaced to the model for retry.

---

## 3. Upstream cross-reference — the fork built offline assembly on a chat-only remote renderer

Verified against `git show upstream/main:…`:

- Upstream ships the **byte‑identical** `chart-visualization/scripts/generate.js` (same Alipay GPT‑Vis remote). **There is no local chart/diagram renderer anywhere in upstream** (no matplotlib/plotly/vega/node‑canvas/graphviz built‑in path).
- **Critically, upstream exposes it ONLY as an agent SKILL.** `SKILL.md` mandates: *read `references/<tool>.md` first to get the schema → run `node generate.js '<payload>'` → return the image URL to the user.* Upstream has **no `generate_report_chart.py` Python tool wrapper** and **never embeds chart bytes into a self‑contained PDF/PPTX** — it surfaces URLs to a **chat** user who can see/retry.

So the empty/missing‑render behaviour is an **inherent limitation of the GPT‑Vis path that upstream never confronts**, because upstream doesn't do offline document assembly. **The fork diverged twice:** (1) it wrapped the remote skill in a Python `generate_chart` tool the model calls **blind** (no "read the schema reference first" step, no schema in the docstring); (2) it built a deliverable‑assembly pipeline (`render_markdown_to_pdf` embedding the bytes) on top of a renderer designed to hand URLs to a human. My `170c6586` then made this wrapped tool the **sole** report‑visual path by removing the local graphviz diagram tool.

---

## 4. Root cause #2 — Deck: the parallel-batch fix was prompt-only and overruled by the authoritative serial card

**Verdict: mostly-confirmed.**

Two independent causes:
1. **Conflicting guidance.** `builder_task.py`'s completion instruction tells the model the **PPTX workflow card is authoritative** and to "read its SKILL.md and follow its workflow." The fork's `skills/public/ppt-generation/SKILL.md` still prescribes a **serial per‑slide loop** ("Generate one PNG per slide… QC each slide image. Repair/regenerate once"). My `170c6586` added the hero‑anchor batch nudge to **two** places (`builder_task.py pptx_visual_guidance` + `image-generation/SKILL.md`) but **left `ppt-generation/SKILL.md` serial**. The model followed the step‑numbered authoritative card → one image per turn.
2. **Upstream is serial by design.** Upstream's `ppt-generation/SKILL.md` mandates "one at a time… never concurrently" because each slide uses the **previous slide** as its style reference (an unparallelizable chain). I switched the anchor to a fixed **hero** image (which makes parallelism *sound*) and added a real `--manifest` ThreadPoolExecutor path, but left the upstream serial card un‑migrated.

Plus: the **~10‑minute hung image call** — `generate.py`'s OpenAI client has **no per‑call timeout** ([generate.py:548](skills/public/image-generation/scripts/generate.py)); upstream's image path uses `timeout=60`.

> Correction from verification: there is **no `<builder_workflow_card>` for PPTX** — `skills/public/sophia/builder_workflows/` contains only `research.md` (despite CLAUDE.md referencing `{pdf,pptx}.md`). The "authoritative card" the model reads is `ppt-generation/SKILL.md` directly.

---

## 5. Root cause #3 (minor) — LangSmith trace-landing gap

Afternoon builder runs (on `f0e97db3`) did not land in LangSmith; only the morning run is visible. Investigate the builder graph's tracing flush on the new batch/serial paths separately (e.g. `client.flush` timing). Non‑blocking for this regression, but it removed a diagnostic channel.

---

## 6. Recommended fixes (prioritized; all verified safe vs CLAUDE.md constraints)

**P0 — Make report visuals render (LOCAL‑FIRST).** The remote GPT‑Vis path is the wrong foundation for offline documents.
1. **Register the orphaned local `generate_visual_asset`** ([generate_visual_asset.py](backend/packages/harness/deerflow/sophia/tools/generate_visual_asset.py)) as the **primary** report‑visual tool in `builder_tools.py` for document/report task types — it renders bar/line/charts + `architecture_diagram`/`process_flow`/`concept_map` **locally (SVG→PNG), no egress, no schema fragility**. *(Note: this reverses the plan's earlier "don't wire generate_visual_asset" decision — that decision assumed `generate_chart` worked; it doesn't.)*
2. **Restore local node‑link diagrams**: un‑delete `generate_excalidraw_diagram` (local graphviz `dot`, still installed, rendered correctly) **or** use `generate_visual_asset`'s structural kinds. Re‑steer `builder_task.py` prompts accordingly.
3. **Demote `generate_chart` (remote GPT‑Vis) to optional/fallback.** If kept at all: (a) embed the **exact per‑type schema** in the docstring + a per‑turn guidance block; (b) make `generate.js` **fail loud** (`process.exit(1)` + error to stdout on per‑spec failure) so the wrapper catches `chart_generation_failed`; (c) **detect empty‑plot PNGs** (pixel‑variance / non‑background‑pixel count), treat as `success=False` so the visual gate forces a repair; (d) fix the diagnostic to surface `error_type`.

**P1 — Stop the deck loop (harness‑enforced batching).**
4. **Pre‑generate all slide images from the plan JSON inside the harness** (extend `_maybe_autowire_pptx_plan_visuals` or a pre‑compile hook) and run them concurrently — don't rely on the model calling `generate.py` per slide. *(Or, minimally, intercept consecutive single‑image calls and reject with a "use the manifest" directive.)*
5. **Rewrite `ppt-generation/SKILL.md`** to the hero‑anchor batch flow and delete the serial language (the source of the conflict).
6. **Add a per‑call image timeout** (`OpenAI(timeout=~120s, max_retries=0)`) on both single and `--manifest` paths.
7. **Regression test:** an N>3‑slide build issues ≤2 image‑gen invocations (one hero + one manifest), not N.

**P2 — Hygiene.**
8. Investigate the LangSmith trace‑landing gap on `f0e97db3`.

---

## 7. Appendix

**Identifiers:** companion thread `019eff19…`; deck run `019eff1a-e7c7`; PDF run `019eff45-88d5` (restart of `019eff42-d997`). Backend live `f0e97db3`.
**Evidence files** (`docs/audits/_logs_2026-06-25/`): `pdf_build.txt`, `deck_build.txt`, `recursiv.txt`, `_timeline.md`, `pdf_pages/{fig1_empty_barchart_p2,fig3_black_sankey_p4,fig4_empty_linechart_p6}.png`.
**Remote dependency:** `https://antv-studio.alipay.com/api/gpt-vis` (the single point of failure for `generate_chart`).
**Repro:** `node skills/public/chart-visualization/scripts/generate.js <spec.json>` — `bar` with `data=[{x,y}]` → empty PNG; with `data=[{category,value}]` → correct chart.
> ⚠️ The `_logs_2026-06-25/` bundle contains production identifiers; treat as internal, do not commit secrets.
