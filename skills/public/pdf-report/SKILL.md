---
name: pdf-report
description: Use this skill whenever the builder must create a PDF report, brief, explainer, or technical document. It preserves the pipeline's strengths (auto table-of-contents, citations, pagination) by authoring source for pandoc+LaTeX, and applies the visual-director logic so figures vary and fit. Read before building any report.
---

# Sophia Report Skill — PDF

You are authoring a **report**: substance-forward, prose carries the argument, visuals *earn their place*. Avoid both failures — a wall of text, and a deck-in-disguise where every page is a graphic. Keep it consistent: one design language, figures that look like a set.

The renderer (`render_markdown_to_pdf` → pandoc → xelatex, Sophia template) typesets and handles citations/TOC; *you* author and art-direct.

> **Report type:** this is the research/technical report (pandoc+LaTeX). A *visual report* (magazine/pitch, HTML→Chromium + hallmark) is a separate product — don't use this skill for that.

## 1. Source-first
Author **Markdown**, then render. Markdown-first is what lets pandoc do references, TOC, page breaks, footnotes automatically. Plan the section spine and where each visual goes before writing. Add a figure only where it beats the paragraph it replaces.

## 2. Keep what works — write *for* pandoc
- **TOC:** generated from clean `#`/`##`/`###` headings — don't fake structure with bold.
- **Pagination:** xelatex owns page breaks; don't hand-place them.
- **Citations:** cite inline; pandoc assembles the ordered reference list. Every researched claim carries a citation. **Never invent sources.**
- **Tables:** Markdown tables for tabular data; the template styles them.
- Do **not** drop to `reportlab`/`fpdf` or `create_pdf_artifact` — they bypass structure, citations, and design.

## 3. Decide the treatment (full taxonomy in the always-on directives)
Prose is the default; a visual must beat the paragraph. Connected structure → node diagram (graphviz). Quantitative → chart. Comparison → table/grouped bar. One/few numbers → `tcolorbox` stat callout (not a chart). Time → timeline. Concept/opener with no technical fit → illustration (sparingly, §5). Don't force a node graph on a non-relational idea; a single number is a callout.

## 4. Variety
Vary figure types across sections (don't repeat one diagram style section after section — a real prior defect). Use at most two figures from any one family in a report: for example no more than two `diagram:architecture`, no more than two `chart:bar`, no more than two `chart:line`, and no more than two `visual:matrix`. Not every section needs a figure; some are pure prose. One consistent figure language (shared chart palette, shared graphviz styling, one illustration style).

## 5. The substance toolkit
- **Charts** (`generate_report_chart`, `generate_visual_asset`, `data-analysis`) — the workhorse; **real labels and values**, no "Item N", no fabricated data, no chart without data; clean (no 3-D/chartjunk). Use `generate_report_chart` when the report needs the chart-visualization taxonomy (area, dual axes, sankey, treemap, radar, funnel, distributions, maps, etc.); pass the selected tool's labeled data in `chart_args` and log why that chart family fits. Do not default to repeated bar/line charts when the evidence is better served by sankey, treemap, radar, funnel, distribution, heatmap, timeline, or table/callout.
- **Diagrams** (`generate_excalidraw_diagram`, graphviz) — connected nodes only; short single-line labels. Select the diagram_type intentionally: architecture, system_map, timeline, sequence, cycle, concept_map, comparison, lifecycle, tree, or flow. Do not route every structure to architecture.
- **Illustrations / conceptual figures** (`image-generation`) — **sparing accents** (cover, section opener, occasional concept), concrete and beautiful, one style across the document. Use them when the idea benefits from an illustrative/conceptual visual without dense text; do not use them for precise report diagrams, labels, or charts. Heavily-conceptual reports may lean on them more, but they still earn clarity. If preflight fails, drop and let prose/figures carry.

**Embed PNG, not SVG.** xelatex embeds PNG reliably but not SVG — so for every figure in the report use the **`.png`** the tool emits (the graphviz diagram tool produces both PNG and SVG; PNG is for the PDF, SVG is for HTML). Figures enter as `![caption](assets/figure.png)`; the template handles placement, numbering, and captions.

## 6. Design system (LaTeX-native, from brand tokens)
The look comes from the Sophia LaTeX template — the LaTeX expression of `brand/tokens.md` (brand fonts via fontspec, brand palette in headings/rules/links/`tcolorbox`, modern `titlesec`, branded `fancyhdr`, generous `geometry`). You write clean Markdown; the template applies the system. Hierarchy via type and color, sufficient contrast, no clutter.

**Mechanics:** select the brand theme via the `render_markdown_to_pdf(theme=…)` param or a `sophia-theme:` key in the source's YAML frontmatter; `title:` (and optional `subtitle:`) frontmatter produces the cover page; the table of contents is generated automatically for longer documents — no extra flags. Default length when unspecified: ~10–15 pages; if the user requested a length, pass `requested_pages=N` or `requested_min_pages`/`requested_max_pages` to `render_markdown_to_pdf`. Avoid forced page breaks, sparse tables, and mostly-empty continuation pages.

## 7. Workflow
1. **Plan** (`write_todos`): section spine + figure placements + variety check.
2. **Research** with the skill matching the request: `deep-research` (general topic), `academic-paper-review` (one paper), `systematic-literature-review` (multi-paper survey). Capture citations as you go.
3. **Author the Markdown** — clean headings (drive the TOC), prose-first, tables, inline citations, PNG figure refs.
4. **Generate visuals** — charts (real labels + data; prefer `generate_report_chart` for rich report charts), diagrams (short labels, graphviz, PNG for embedding), any illustrations (one style).
5. **Render** with `render_markdown_to_pdf` — TOC and references auto-generate. Pass requested page-count args when the brief includes them. After it returns, **check the result**: if it reports `images_missing`/`missing_resources` or `layout_warning=page_count_off_target`, fix once and render **once more** (the harness allows one repair turn; a visuals-requested PDF with zero embedded images or repeated figure-family monotony is rejected once).
6. **Inspect & QA** (§8), fix once, then emit the `.pdf` — it is authoritative; do not emit the `.md`/`.html` source.

## 8. QA checklist
Structure (TOC correct; clean hierarchy; logical order) · Citations (inline → generated ordered references; no invented sources) · Correctness (real chart/diagram labels and values; no "Item N"/blanks; no overflow) · Variety (figure types rotate; not every section a figure) · Legibility & cohesion (brand fonts/palette; contrast; one figure language) · Pagination (no stranded headings/figures). Structurally-correct but monotonous/under-designed fails QA.
