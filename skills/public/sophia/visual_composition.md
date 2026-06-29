---
name: visual-composition
description: Always-injected composition directives for the builder. Establishes medium-specific visual routing for Sophia artifacts.
---

# Sophia Visual Composition Directives

You are building a user-facing artifact. Treat each artifact type as its own
medium. Do not mix workflows just because another tool is available.

## Medium Routing

- Presentations (`.pptx`) are pure image-forward decks. Generate one full-slide
  16:9 bitmap per slide into `/mnt/user-data/outputs/visuals/`, then compile
  with the `ppt-generation` script and a `deck_plan.json` containing one
  `image_path` per slide. Do not hand-write PPTX layouts or custom compiler
  scripts.
- PDF reports are authored as ONE self-contained HTML file and rendered with
  `render_html_to_pdf`. Draw BOTH data evidence (bar / line / column for
  quantitative, comparative, ranking, composition, trend) AND structural
  diagrams (box-and-arrow flow, comparison, mind-map) as **inline static
  `<svg>`** — no remote `generate_chart`, no client-side JS. Vary the figure
  family to fit each figure; never route every figure to the same kind. You may
  additionally generate up to 3 conceptual/editorial illustrations (a cover/hero
  plus key concepts) via the image-generation skill: no text baked into the
  image, theme-matched palette, referenced as `<img src="visuals/<name>.png">`.
  Reserve generated images for conceptual/aesthetic figures — every data chart
  and structural diagram is inline `<svg>`. Follow the pdf-report SKILL.md
  pattern library.
- HTML artifacts may use code-built visuals (SVG, CSS, Canvas) when that is
  the simplest faithful implementation.

## Presentation Invariants

- There is no alternate plain deck mode. A requested `.pptx` deck follows the
  full-slide image-forward pipeline.
- The slide style may be light or dark according to the user request and subject.
  A blank band/gutter at any edge is a defect, but dark backgrounds are not
  mandatory.
- Each generated slide image is the complete visible slide. Include a concise
  title, bottom narrative, and any required labels directly in the image prompt.
- Add concise speaker notes for narrative context, but never rely on notes as
  the only visible explanation for content slides.
- If a slide image fails QC, regenerate or repair once. If it still fails,
  report the issue honestly rather than switching to an engine-composed slide.

## PDF Report Invariants

- The final primary artifact is the `.pdf`. The HTML source, preview files, and
  assets are supporting/internal files unless explicitly requested.
- Every chart and diagram is inline `<svg>` authored in the report HTML —
  charts must render with real series and labels (never an empty frame), which
  inline SVG guarantees. Do not call a remote chart service.
- Diagrams must match the idea: architecture, flow, sequence, timeline, cycle,
  comparison, tree, or concept map. Do not route every figure to the same
  node-link architecture diagram.
- Use tables and prose when they are clearer than a figure. A report is not a
  deck and should not be all graphics.
- Every figure uses real labels, real data, and cited context where needed. Do
  not fabricate placeholder metrics or sources.

## Universal QA

- The delivered artifact must exist under `/mnt/user-data/outputs/`.
- Emit only the requested primary artifact unless the runtime explicitly reports
  that no primary artifact could be produced.
- No blank images, broken paths, missing resources, placeholder labels, or
  duplicate source/preview deliverables.
- When a valid requested-format artifact exists, emit it promptly. Do not keep
  looping for extra polish after the terminal criteria are satisfied.
