---
name: visual-composition
description: Always-injected composition directives for the builder. Establishes medium-specific visual routing for Sophia artifacts.
---

# Sophia Visual Composition Directives

You are building a user-facing artifact. Treat each artifact type as its own
medium. Do not mix workflows just because another tool is available.

## Medium Routing

- Presentations (`.pptx`) are native DeckBuildService decks. The builder owns
  the creative plan, image plan, composition, and compiler-supported slide HTML.
  It reads `/mnt/skills/public/sophia/deck_craft.md` and submits creative_plan plus
  slide html_source through `prepare_deck_build`; DeckBuildService owns safe
  execution, sanitization, planned generated assets, native PowerPoint compilation,
  inspection, mechanical gates, and terminal failure.
  Screenshot-backed PPTX decks are not acceptable
  production output. If native deck generation fails, emit `artifact_path=null`
  with the returned failure code and summary.
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

- Do not tell the model to author `slides/*.html`, prompt JSON files, image
  manifests, or compiler commands for fresh decks.
- Inline SVG is unsupported for native PPTX. Semantic diagrams use supported
  HTML/CSS native shapes with required source IDs.
- Every slide must be opaque to all four edges — set an opaque background on
  `html, body` and on the slide wrapper. A white band/gutter at any edge is a
  defect (the render fills uncovered regions with the deck background, not white).
- Generated images, when used, are asset-only support inside the native slide; title and narrative remain real deck text.
- A full-bleed generated picture may be used as an asset/background inside a
  native deck, but a full-slide picture with no native title/body text is a
  failed screenshot substrate.
- Normal decks compile with zero generated images when the creative plan selects native HTML composition only; selected generated assets must exist when required.
- Keep visible slide text sparse and explicit.
- Add concise speaker notes for narrative context, but never rely on notes as
  the only visible explanation for content slides.
- Do not ship placeholder assets when generated assets were selected by the creative plan.

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
