# Sophia Builder — Deck Failure & PDF Render Imperfections Forensics (2026-06-26)

**Date:** 2026-06-26
**Audience:** Sophia engineering (Davide)
**Branch / HEAD:** `codex/sophia-observability-v1` @ `8865413c` ("fix(builder): render reports via HTML→PDF (inline SVG); enforce deck batch")
**Author:** Builder forensics pass (adversarially verified against top-of-branch source)

---

## 1. Executive Summary

The **HTML→PDF report path works end-to-end** — headless Chromium renders the model-authored self-contained HTML with inline SVG and the page-number footer, and the file is produced. But the rendered PDFs carry **render imperfections** that the base print CSS (`report.css`) and the `pdf-report` skill cannot prevent: long code lines clip at the A4 right margin (no `<pre>` wrap rule), and a model-authored table-beside-code layout collides and overflows its column (no safe multi-column primitive with `min-width: 0`).

In contrast, **deck (`.pptx`) builds failed on both observed runs** at the compile→emit stage — once as a worker timeout with no output file (`019f0168`), once as a terminal halt on a compiled deck written under a name the emit gate did not recognize (`019f0178`). Both trace to the **same underlying gap**: the deck **compile step has no documented command or output-path contract** in the skill, so the model improvises a custom compile that lands the `.pptx` at a non-target name (`t.pptx`); the emit gate then validates the *model-emitted* path (the slug), finds it missing, and rejects. Recovery is also non-authoritative (see D1b): the ceiling fallback *did* promote `t.pptx`, but its success webhook failed to deliver and a parallel `wrap_tool_call` path terminal-halted the run anyway.

**Attribution matters here:** the deck compile-command gap **predates `8865413c`** — my 2026-06-25 deck work fixed *image generation* (the hero-anchor `--manifest` batch, which works: `image_calls=20` completed fast) and did **not** touch the compile→emit path. The deck failures are a **pre-existing compile→emit fragility**, now the dominant failure since image-gen no longer is. The PDF render gaps (F1–F3), by contrast, **were introduced by `8865413c`** (the new HTML→PDF path shipped without code-block / multi-column CSS that the old pandoc path handled).

> **Evidence-provenance note.** Both sections are now code-fact verified against HEAD (`8865413c`). PDF findings (F1–F5): verified against `report.css` (full), `render_html_to_pdf.mjs` (full), `SKILL.md` (full), grep-confirmed absences. Deck findings (D1–D4): the workflow's automated deck-verifier crashed mid-run, so the compile→emit chain was verified **manually** afterward against `builder_artifact.py` (`_log_missing_emit_candidate` / `_emit_candidate_verified` :1843–1870; `_promoted_deliverable_from_outputs` / `_promotable_output_candidates` :5905), `supabase_artifact_store.py` (`check_artifact_object_exists` / HEAD probe :672, :935), and `ppt-generation/SKILL.md` (:126) + the compiler CLI (`scripts/generate.py` `--plan-file`/`--output-file` :1050–1062). Attributions below reflect that manual pass.

---

## 2. What We Tested & Deploy Context

| Item | Value |
|---|---|
| Live commit | `8865413c` — deployed 2026-06-25 **00:08:49Z** |
| Parent (companion) thread | `019f0158` |
| Deck run #1 | `019f0168` — **worker timeout, no output file produced** |
| Deck run #2 | `019f0178` — **terminal halt; deck compiled as `t.pptx`, emit target mismatch** |
| PDF reference | An **earlier, out-of-window** successful render, attached for visual inspection of render quality (not from this test window) |
| Image-gen | hero-anchor `--manifest` batch, `image_calls=20`, completed fast (NOT a failure site) |

Both deck runs were dispatched under the same parent companion thread (`019f0158`). The PDF artifact examined for render imperfections is a **prior successful build** attached for reference — the PDF *path itself works*; what we are auditing there is render fidelity, not a failure.

---

## 3. Issue 1 — Deck Builds Fail (`.pptx`)

> **Status: code-fact CONFIRMED** (manual pass after the automated deck-verifier crashed). Verified against `builder_artifact.py` (emit verification + ceiling promotion), `supabase_artifact_store.py` (HEAD probe), and `ppt-generation/SKILL.md` + the compiler CLI.

### The two failure modes share one upstream cause

Both runs reached the point of **trying to produce a deck**, neither delivered. The upstream cause is the same: **the skill never tells the model how to compile the deck** (no command, no output-path contract), so the model improvises a custom compile (it wrote a `.py` generator at turn 32, `ext=py`, then looped on `bash`). The two runs then diverged only in *where* they got stuck:

- **`019f0178`** improvised a compile that produced a **valid `.pptx` at `t.pptx`** (`artifact_integrity ext=pptx valid=true bytes=27387 source=local`), but the model emitted the **slug** path `…/create-an-8-slide-presentation-deck-on-l.pptx`, which doesn't exist → emit rejected → terminal halt.
- **`019f0168`** never produced *any* promotable `.pptx` — it churned `write_file`/`bash` until `hard ceiling reached at turn=45 → forcing end with fallback`, and the ceiling scan found nothing to promote (`artifact_path=None`, `status=timeout`).

---

### D1 — Deck compile step has no command / output-path contract → model improvises → output lands off-target; emit gate rejects the model-emitted path (PRIMARY)

- **Severity:** high · **Verdict:** confirmed · **Attribution:** **pre-existing** (compile-command gap predates `8865413c`; not introduced by the deck-batch wave)
- **Supposed vs Actual:**
  - *Supposed:* the compile step runs a documented command that writes the `.pptx` to the deterministic target path, and the emit gate promotes that file.
  - *Actual:* `ppt-generation/SKILL.md` documents explicit *image-gen* commands (`:27`, `:53`) but the compile step (`:126`) only says *"Compile with the PPTX workflow"* — **no command, no output path**. There is **no PPTX builder workflow card** (`skills/public/sophia/builder_workflows/` has only `research.md`). The real compiler is `python /mnt/skills/public/ppt-generation/scripts/generate.py --plan-file … --output-file …` (`scripts/generate.py:1050–1062`) — undocumented in the skill. So the model improvises (`write_file` `ext=py` at turn 32 + `bash` loop) and the `.pptx` lands at `t.pptx`. The emit gate (`_emit_candidate_verified` / `_log_missing_emit_candidate`, `builder_artifact.py:1843–1870`) validates the **model-emitted** `artifact_path` by checking `(<outputs>/relative).is_file()` **OR** `check_artifact_exists` (Supabase). For the emitted slug both are False → `file missing for emit verification: … local=False supabase=False` → rejected → 2nd reject → terminal halt (`missing_emit_path_rejections`).
- **Why image-gen being fixed didn't help:** my `8865413c` rewrite made the *image* steps explicit and added the hero-anchor `--manifest` batch (which works). It did **not** add a compile command, so the long-standing compile gap is now the dominant failure. The explicit-image / vague-compile asymmetry may make improvisation at the compile step *more* likely, but that is unproven; the gap itself is old.
- **Code pointers:** `skills/public/ppt-generation/SKILL.md:126`; `scripts/generate.py:1050–1062`; `builder_artifact.py:1843` (`_log_missing_emit_candidate`), `:1855` (`_emit_candidate_verified`).

### D1b — Ceiling-fallback recovery is non-authoritative: it *did* promote `t.pptx`, but the success didn't stick

- **Severity:** high · **Verdict:** confirmed · **Attribution:** pre-existing control-flow defect, exposed by D1
- **Supposed vs Actual:**
  - *Supposed:* when the primary emit fails, the ceiling fallback promotes any valid in-format file under `/mnt/user-data/outputs/`, delivers it, and ends the run cleanly.
  - *Actual:* the **after_model** path *did* promote `t.pptx` — `_promoted_deliverable_from_outputs` → `_promotable_output_candidates` (`builder_artifact.py:5905`) found it, uploaded it (`Uploaded artifact object … t.pptx bytes=27387`), and fired `fire_completion_webhook status=success artifact_path='…/t.pptx'`. **But** (a) `Builder-events webhook delivery failed`, and (b) the **parallel `wrap_tool_call` (node=tools) path independently re-rejected the same emit and terminal-halted** the run (`suppressing async model call after terminal halt reason=missing_emit_path_rejections`). The two paths aren't coordinated, so the net result is a failed deck despite a promoted artifact existing.
- **Code pointers:** `builder_artifact.py:5905` (`_promoted_deliverable_from_outputs`); the after_model short-circuit + `wrap_tool_call` emit-rejection paths (`:9847` consecutive-missing counter, `:8476` terminal-halt suppression); `fire_completion_webhook` delivery (`deerflow.sophia.builder_events`).

### D2 — Supabase existence probe returns 400 → treated as "missing" (secondary, latent)

- **Severity:** medium · **Verdict:** confirmed · **Attribution:** pre-existing (same family as the 2026-06-12 ledger-400 fix)
- **Supposed vs Actual:**
  - *Supposed:* the "does this artifact exist in the mirror?" probe returns 200/404 cleanly, so the emit gate's "disk OR Supabase" check can pass via the Supabase leg.
  - *Actual:* `check_artifact_object_exists` (and the per-thread `check_artifact_exists`) do `http.head(url)` and treat **any non-2xx — including 400 — as missing** (`supabase_artifact_store.py:672`, `:935`, `:679` "treating as missing"). Production logs show `status=400` for *every* pptx probe (`Supabase HEAD check failed … status=400; treating as missing`). The upload writes to object scheme `artifacts/<user>/<thread>/artifact_<id>/<file>`, but the existence probe queries `sophia_builder/<thread>/<file>` — a **scheme mismatch**, and Supabase Storage HEAD on that endpoint returns 400. So the Supabase leg of the emit check can **never** pass. It only bites when the disk check *also* fails (wrong filename) — exactly the deck case; the PDF was unaffected (its disk check passed).
- **Code pointers:** `supabase_artifact_store.py:672, :679, :911, :935`; compare the 400-tolerant handling already applied in `delegation_ledger.py`.

### D3 — Worker timeout, no output file (`019f0168`) — same root cause, earlier on the clock

- **Severity:** high (symptom of D1) · **Verdict:** confirmed · **Attribution:** symptom of D1
- **Supposed vs Actual:**
  - *Supposed:* the build emits a deliverable within budget, or fails honestly with `artifact_path=null` + a truthful summary.
  - *Actual:* after `image_calls=20`, the run spent ~3.5 min with `forcing tool_choice=write_file before emit … no output file yet` (turns 42–44) until `hard ceiling reached at turn=45 → forcing end with fallback`; the ceiling scan found **no promotable `.pptx`** → `status=timeout artifact_path=None`. The model never produced an output file at all (not even a `t.pptx`).
- **Code pointers:** the hard-ceiling fallback + `_build_ceiling_fallback`; `forcing tool_choice=write_file` path in `builder_artifact.py`.

### D4 — Duplicate tool_result churn during the stuck loop (symptom)

- **Severity:** low · **Verdict:** confirmed (symptom, not an independent defect) · **Attribution:** symptom of D1
- **Supposed vs Actual:**
  - *Supposed:* each tool call yields one tool_result; the dangling-tool-call patcher drops duplicates request-side.
  - *Actual:* during the stuck `bash` compile loop, the patcher repeatedly dropped the **same** bash tool-call ids (`Injecting/reordering N ToolMessage(s) … duplicate results dropped: bash:toolu_01FF1Ly…`, growing 3→8). The patcher is working (it *does* drop them), but the repeated improvised-compile attempts inflate the cycle count and burn budget — a consequence of D1, not a patcher defect.
- **Code pointers:** `patch_dangling_tool_call_messages` (duplicate-proof drop); the emit-rejection loop in `builder_artifact.py`.

---

## 4. Issue 2 — PDF Render Imperfections (HTML→PDF path)

> **Status: code-fact CONFIRMED** (except F5, uncertain). Verified against `report.css` (full file, 110 lines), `render_html_to_pdf.mjs` (full file), and `SKILL.md` (238 lines). Grep confirmed the cited absences (zero `pre` / `white-space` / `overflow-wrap` / `word-break` / `grid` / `column-gap` / `min-width` / `section-label` / `letter-spacing` occurrences).

The HTML→PDF path itself is sound — the renderer is a thin print wrapper. Every imperfection below is an **authoring-surface gap**: the base CSS (`report.css`) defines no rule for the element, and the skill (`SKILL.md`) gives the authoring model no pattern or constraint, so the model emits unbounded markup that a fixed-width PDF (no horizontal scroll) clips or collides.

### F1 — No `<pre>` code-block rule → long code lines overflow and clip at the page edge (pages 6 & 8)

- **Severity:** high · **Verdict:** confirmed · **Attribution:** regression from `8865413c`
- **Supposed vs Actual:**
  - *Supposed:* `<pre>...</pre>` code blocks wrap (or otherwise stay inside the printable column) so no line is cut off at the A4 right margin.
  - *Actual:* `report.css` styles **only inline `code`** (line 107: font-family/size/background/padding/border-radius). There is **no `pre` selector anywhere** in the file. A `<pre>` therefore inherits the browser default `white-space: pre` — no wrapping. In a paginated PDF there is no horizontal scroll, so any line wider than the ~178 mm printable column is simply clipped. This matches the observed cut import lines (`from deepagents.middleware import SubagentM`(cut), `from langchain.chat_models import init_chat`(cut)) on pages 6 and 8.
- **Root cause:** base print CSS handles inline `code` only; it never defines a block-code style. Authored `<pre>` falls back to non-wrapping browser defaults with no `max-width` guard, and the renderer injects no wrapping CSS (F4) — wrapping is entirely the authored CSS's job.
- **Code pointers:**
  - `skills/public/pdf-report/assets/report.css:107` (only `code` styled; no `pre` rule)
  - `skills/public/pdf-report/assets/report.css:1-110` (no `white-space`/`overflow-wrap`/`word-break` anywhere)
  - `backend/packages/harness/deerflow/sophia/js/render_html_to_pdf.mjs:66-74` (`page.pdf` injects no wrapping CSS)
  - `skills/public/pdf-report/SKILL.md:85-191` (pattern library has no code-block guidance)
- **Fix:** add a `pre` / `pre code` rule to `report.css` (see §6, P1).

### F2 — No safe two-column primitive (no `min-width: 0`) → table+code side-by-side collides and clips (page 8)

- **Severity:** high · **Verdict:** confirmed · **Attribution:** regression from `8865413c`
- **Supposed vs Actual:**
  - *Supposed:* A model-authored side-by-side layout (left: comparison table, right: code block) keeps each column inside its track without one column overflowing the other.
  - *Actual:* `report.css` has **no content two-column / grid primitive** (grep: zero `grid` / `column-gap` / `min-width`). The only flex containers are `.cover` (line 47), `.stat-band` (98), and `.toc li` (82) — none intended for side-by-side body content, and none set `min-width: 0` on children. CSS flex/grid items default to `min-width: auto`, so a child whose intrinsic content (a non-wrapping `<pre>` per F1, or a `width:100%` table at line 85) is wider than its track **refuses to shrink and overflows** — producing the page-8 CREWAI-column clip and the "Integration Pattern" heading wrapping under the code block.
- **Root cause:** no documented/styled safe two-column container, and flex/grid children lack the `min-width: 0` override needed to let wide content shrink. Compounded by F1 (the code child never wraps) and `table { width: 100% }` (line 85) sizing to the full column even in a half-width track.
- **Code pointers:**
  - `skills/public/pdf-report/assets/report.css:1-110` (no grid/two-column primitive; no `min-width:0`)
  - `skills/public/pdf-report/assets/report.css:85` (`table { width: 100% }` — fills whatever column it lands in)
  - `skills/public/pdf-report/assets/report.css:98-99` (`.stat-band` flex children `.stat` have no `min-width:0`)
  - `skills/public/pdf-report/SKILL.md:159-208` (comparison + figure grammar — no two-column primitive, no wide-side-by-side warning)
- **Fix:** add a guarded `.cols-2` grid with `min-width: 0` + overflow-wrap on children (see §6, P1).

### F3 — SKILL.md pattern library omits code-block and safe two-column guidance

- **Severity:** medium · **Verdict:** confirmed · **Attribution:** regression from `8865413c`
- **Supposed vs Actual:**
  - *Supposed:* the skill's pattern library + HTML requirements steer the authoring model toward layouts that render cleanly to a fixed-width PDF — including code blocks and any multi-column content.
  - *Actual:* `SKILL.md` covers only inline-SVG figure families (bar/line/flow/comparison/donut, lines 91–189) and figure grammar. There is **no `<pre>` wrap pattern, no `max-width` guidance, no safe two-column/grid primitive, and no warning against wide side-by-side content**. The "HTML requirements" (219–227) mention `<table>` but say nothing about code or column width. So the model authored an unbounded `<pre>` and an ad-hoc table+code row with nothing in the skill or CSS to keep them in bounds.
- **Root cause:** the HTML→PDF skill (landed with `8865413c` / PR #145) was scoped to inline-SVG figures and prose; common report elements (code listings, multi-column layouts) got neither patterns nor constraints, and the base CSS has no fallback rules for them (F1/F2).
- **Code pointers:**
  - `skills/public/pdf-report/SKILL.md:85-208` (figure-only pattern library)
  - `skills/public/pdf-report/SKILL.md:219-238` (HTML requirements + QA checklist — no code/column items)
- **Fix:** docs-only extension of SKILL.md (code-block note, two-column note, QA-checklist items) — see §6, P1.

### F4 — `render_html_to_pdf.mjs` injects no wrapping CSS (confirms the fix site is the CSS, not the renderer)

- **Severity:** low · **Verdict:** confirmed (not a defect) · **Attribution:** pre-existing by design
- **Supposed vs Actual:**
  - *Supposed (hypothesis):* the renderer might inject defensive CSS to wrap overflow content.
  - *Actual:* the renderer only does: `parseArgs` → launch Chromium → `page.goto(file://…, waitUntil: networkidle)` → `page.pdf({ format: 'A4', printBackground: true, margin: 16mm default, displayHeaderFooter: true, headerTemplate: <empty>, footerTemplate: <page numbers> })`. It adds **no `addStyleTag` and no content stylesheet**. Overflow/wrapping behavior is therefore entirely determined by the authored HTML + inlined `report.css` — confirming F1/F2 are the actionable fix sites, not the renderer.
- **Code pointers:**
  - `backend/packages/harness/deerflow/sophia/js/render_html_to_pdf.mjs:42-45` (header/footer templates only)
  - `backend/packages/harness/deerflow/sophia/js/render_html_to_pdf.mjs:66-74` (`page.pdf` options — no content CSS injection)
  - `backend/packages/harness/deerflow/sophia/tools/render_html_to_pdf.py:80,114-115` (default margin 16mm)
- **Fix:** **no change to the renderer.** Optional defense-in-depth (NOT recommended over fixing the CSS): `await page.addStyleTag({ content: 'pre{white-space:pre-wrap;overflow-wrap:anywhere}' })` before `page.pdf` — but this masks authoring issues; fix it in `report.css` (F1) so the same rules apply in any preview.

### F5 — Cover section-label first-glyph clip ("ѕYSTEM") — NOT explainable from `report.css`

- **Severity:** low · **Verdict:** **uncertain (needs source HTML)** · **Attribution:** unknown
- **Supposed vs Actual:**
  - *Supposed:* the cover label "SYSTEM TOPOLOGY OVERVIEW" renders with its first glyph fully visible.
  - *Actual:* `report.css` contains **no `.section-label` (or any label) rule** — grep returns zero `section-label` / `letter-spacing` / `text-transform` / `::first-letter` occurrences. The `.cover` rules (40–61) define background, padding (`40mm 22mm 22mm`), flex column, `h1`/`.subtitle`/`.meta`/`.cover-figure` — none of which clip a label's first glyph. The garble in the evidence ("ѕYSTEM" — a Cyrillic-lookalike small "s") is more consistent with a **font/glyph substitution** or an **author-inlined style** (negative text-indent, a `::first-letter`/drop-cap rule, `letter-spacing` with `overflow:hidden`, or an inline-SVG `<text>` with a clipped `x` origin) than with anything in the base CSS. The base CSS cannot produce this; the cause lives in the model-authored HTML's own `<style>` overrides or an inline SVG label, which is not available to this pass.
- **Root cause:** indeterminate from base assets. Most likely an author-inlined cover-label style or a Chromium glyph-substitution artifact — none originate in `report.css`.
- **Code pointers:**
  - `skills/public/pdf-report/assets/report.css:40-61` (`.cover` block — no label rule, no clip-capable property)
  - `skills/public/pdf-report/assets/report.css` (grep: no `section-label`/`letter-spacing`/`text-transform`/`::first-letter`)
- **Fix:** cannot fix from `report.css` alone — requires the produced report HTML. If reproduced as an author letter-spacing/uppercase label, add a vetted base rule and document it (see §6, P2). Keep classified **LOW-confidence / needs-source-HTML** until reproduced.

---

## 5. Root-Cause Summary Table

| # | Issue | Root cause | Attribution | Severity | Fix |
|---|---|---|---|---|---|
| D1 | Deck compiled off-target (`t.pptx`); emit gate validates the model-emitted slug path → rejected | Compile step has **no command / output-path contract** in the skill → model improvises → file lands off-target | **pre-existing** (compile gap predates `8865413c`) | high | Document compile CLI + pin output to `outputs/<slug>.pptx` (§6 P0.1) |
| D1b | Ceiling promoted `t.pptx` but success didn't stick (webhook delivery failed + parallel `wrap_tool_call` terminal-halt) | After_model ceiling promotion not coordinated with `wrap_tool_call` rejection; webhook delivery not retried | pre-existing control-flow, exposed by D1 | high | Make ceiling promotion authoritative + retry webhook (§6 P0.2) |
| D2 | Supabase existence probe → 400 → "missing" | HEAD probe treats any non-2xx as missing; upload/check object-path **scheme mismatch** | pre-existing (ledger-400 family) | medium | Treat 400 like 404; align object-path scheme (§6 P1d) |
| D3 | Worker timeout, no output file (`019f0168`) | Downstream of D1 — no promotable output → loop until hard ceiling (turn 45) | symptom of D1 | high | Resolved by D1 |
| D4 | Duplicate tool_result churn | Build thrashing while stuck (consequence of D1); patcher works | symptom of D1 | low | Resolved by D1 |
| F1 | Code lines clip at page edge (pp. 6 & 8) | No `pre` rule in `report.css`; `<pre>` inherits `white-space: pre` | regression `8865413c` | high | Add wrapping `pre`/`pre code` rule (§6 P1) |
| F2 | Table+code side-by-side collides/clips (p. 8) | No two-column primitive; flex/grid children default `min-width: auto` | regression `8865413c` | high | Add `.cols-2` grid + `min-width:0` (§6 P1) |
| F3 | SKILL.md omits code/column patterns | Skill scoped to inline-SVG figures only | regression `8865413c` | medium | Extend SKILL.md (§6 P1) |
| F4 | Renderer injects no wrapping CSS | Thin print wrapper by design (correct) | pre-existing by design | low | No change (fix in CSS) |
| F5 | Cover first-glyph clip ("ѕYSTEM") | Not in `report.css`; author-inlined style or glyph substitution | unknown | low | Needs source HTML; vetted `.section-label` once reproduced (§6 P2) |

---

## 6. Recommended Fixes, Prioritized

### P0 — Unblock deck delivery (Issue 1, primary)

**Pin the deck compile output AND reconcile the emit/target path so a validly-compiled deck under any name is promoted.** Two halves, both required:

1. **Document the exact compile command + output filename in `skills/public/ppt-generation/SKILL.md`** (the compile step at `:126` currently says only "Compile with the PPTX workflow"). Use the **verified** compiler CLI (`scripts/generate.py:1050–1062` — note the flags are `--plan-file`/`--output-file`, not `--plan`/`--output`):
   ```bash
   python /mnt/skills/public/ppt-generation/scripts/generate.py \
     --plan-file /mnt/user-data/outputs/deck_plan.json \
     --output-file /mnt/user-data/outputs/<slug>.pptx
   ```
   State that the output path is **load-bearing** — emit that exact `.pptx`; never improvise a short name (`t.pptx`). (Optionally add a minimal PPTX builder workflow card under `skills/public/sophia/builder_workflows/pptx.md`, since only `research.md` exists today.)

2. **Make the ceiling-fallback promotion authoritative (D1b).** The after_model ceiling path already promotes a valid `.pptx` from `/mnt/user-data/outputs/` (`_promoted_deliverable_from_outputs`, `builder_artifact.py:5905`) — but in `019f0178` it fired `status=success(t.pptx)` while the parallel `wrap_tool_call` path still terminal-halted the run and the success webhook failed to deliver. Coordinate the two: once the ceiling has promoted+uploaded a valid in-format artifact, **end the run on that success** (don't let `wrap_tool_call` re-reject), and ensure the completion webhook delivery is retried (the terminal-events retry path already exists for the gateway leg). A correctly-built artifact under "the wrong name" must be **delivered**, not discarded by a racing rejection.

Half (1) prevents the off-target compile in the first place; half (2) guarantees that even if the model still mis-names the file, a valid deck is delivered. Together they resolve D1, and by removing the stuck loop eliminate D3 (timeout) and D4 (churn).

### P1 — PDF render fidelity + mirror probe robustness

**(a) Add a wrapping code-block rule to `skills/public/pdf-report/assets/report.css`** (after line 107):
```css
pre {
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 8.5pt;
  line-height: 1.4;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 1.5mm;
  padding: 3mm;
  margin: 4mm 0;
  white-space: pre-wrap;       /* wrap long lines */
  overflow-wrap: anywhere;     /* break unbreakable tokens like long import paths */
  word-break: break-word;
  max-width: 100%;
  page-break-inside: avoid;
}
pre code { background: none; padding: 0; font-size: inherit; border-radius: 0; }
```

**(b) Add a guarded safe two-column primitive to `report.css`:**
```css
.cols-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; align-items: start; page-break-inside: avoid; }
.cols-2 > * { min-width: 0; overflow-wrap: anywhere; }   /* let wide children shrink */
.cols-2 pre, .cols-2 table { max-width: 100%; }
```

**(c) Extend `skills/public/pdf-report/SKILL.md`** (docs-only):
- HTML requirements → **Code blocks:** always `<pre><code>…</code></pre>`; the base CSS wraps long lines — never rely on horizontal scroll, it does not exist in a PDF; keep lines short where practical.
- HTML requirements → **Two-column layouts:** use `<div class="cols-2">…</div>`; do NOT place a wide table beside a code block; prefer stacking full-width blocks vertically; wide tabular comparisons span the full page width, not a half-column shared with code.
- QA checklist → add "No code line is clipped at the page edge" and "No column overlaps/clips its neighbor."

**(d) Make the Supabase mirror existence/HEAD probe 400-tolerant** (D2): in `deerflow.sophia.storage.supabase_artifact_store` (and/or `supabase_mirror.py`), treat a **400** from the HEAD/exists probe like a 404 ("no object yet") for the first-write shape, logging `debug` rather than `warning` — exactly the correction already applied in `delegation_ledger.py` for the ledger first-turn mirror.

### P2 — Cover-label hardening (after reproduction)

**(F5) Reproduce the "ѕYSTEM" first-glyph clip with the produced report HTML in hand**, then:
- If it's an author letter-spacing/uppercase label, add a vetted base rule to `report.css` and document `.section-label` in `SKILL.md` so the model uses it instead of an ad-hoc style:
  ```css
  .section-label { font-family: var(--font-sans); text-transform: uppercase; letter-spacing: 0.12em; padding-left: 0.12em; }
  ```
  (trailing letter-spacing adds phantom space after the last glyph; the matching left padding prevents the first glyph being shaved.)
- If it's an inline-SVG `<text>`, ensure `x` ≥ a few user units from the viewBox left edge.

Keep F5 LOW-confidence / needs-source-HTML until reproduced.

---

## 7. What Is NOT Broken

- **Image generation (hero-anchor batch).** `image_calls=20` completed fast via the single parallel `--manifest` batch (hero-anchor → concurrent rest). The 2026-06-25 deck-batch enforcement (one batch after the hero) is working as designed at the image-generation layer. Image-gen is **not** a failure site in either deck run.
- **HTML→PDF renderer core.** `render_html_to_pdf.mjs` is a correct, thin print wrapper: it loads the self-contained HTML via `file://`, waits for `networkidle`, prints A4 with margins + a page-number footer, and verifies non-zero bytes. Inline SVG rasterizes crisply; relative `<img>` refs resolve. The renderer is **not** where any PDF defect originates (F4).
- **PDF path delivery.** The HTML→PDF path produces a real, in-format PDF deliverable — the imperfections (F1/F2/F5) are render-fidelity issues inside an otherwise-working document, not delivery failures.
