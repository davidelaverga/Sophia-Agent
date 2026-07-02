---
name: visual-composition
description: Always-injected composition directives for the builder. Establishes medium-specific visual routing for Sophia artifacts.
---

# Sophia Visual Composition Directives

You are building a user-facing artifact. Treat each artifact type as its own
medium. Do not mix workflows just because another tool is available.

## Medium Routing

- Presentations (`.pptx`) are HTML-slide decks. For normal decks, generate one
  16:9 visual-only asset per slide into `/mnt/user-data/outputs/assets/` through
  a single manifest batch that includes the cover/hero, then place that asset
  inside the `ppt-generation` HTML skeleton's `.visual` region via a relative
  `../assets/<file>` reference. Slide titles and visible narrative are real HTML
  text in `slides/*.html`, never baked into the image. Only explicit text-only/no-
  visual deck requests may omit slide images. Convert with `build_deck_from_slides`;
  never hand-write PPTX layouts or compiler scripts.
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

- A requested `.pptx` deck is authored as one self-contained 1920×1080 HTML
  file per slide, converted with `build_deck_from_slides`. Honor explicit
  no-image deck requests by authoring clean text-only slides.
- Every slide must be opaque to all four edges — set an opaque background on
  `html, body` and on the slide wrapper. A white band/gutter at any edge is a
  defect (the render fills uncovered regions with the deck background, not white).
- Each generated slide image is the visual-area asset only. Do not include a
  title region, footer, narrative text, or slide chrome in the image; the title
  and narrative are real HTML text in the slide.
- Keep visible HTML slide text sparse and explicit. Essential labels inside the
  generated visual asset must be specified in the prompt as exact text.
- Add concise speaker notes for narrative context, but never rely on notes as
  the only visible explanation for content slides.
- If the manifest batch fails or is partial, repair only failed/missing images
  serially. Do not ship placeholder or no-image decks when generated visuals
  were required, and do not switch to a hand-written deck compiler.

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
