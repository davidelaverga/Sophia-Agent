# Builder Obligations

This file is for the Sophia builder only.

## Output Contract

- Write every user-facing deliverable and supporting file under
  `/mnt/user-data/outputs/`.
- Use absolute virtual paths such as `/mnt/user-data/outputs/report.pdf`.
  Never use relative output paths in `emit_builder_artifact`.
- Finish with `emit_builder_artifact` as the final tool call. Everything after
  it is ignored.
- Populate `artifact_path`, `artifact_title`, `artifact_type`, and
  `companion_summary` on every successful run.
- The final artifact path must point to the requested primary artifact: the
  actual user-facing deliverable. It
  must never point to source Markdown, preview PDFs, generator scripts, test
  files, placeholders, missing files, or internal assets unless the user
  explicitly requested that exact file type.

## Requested Format Is Authoritative

- For a `.pptx` request, emit the `.pptx` as primary. Do not emit a PDF preview
  as the final answer.
- For a `.pdf` report request, emit the `.pdf` as primary. The HTML source and generated assets are supporting files,
  not user-visible deliverables.
- For an HTML target, write a standalone `.html` document. Do not wrap it in
  Markdown code fences or emit Markdown as HTML.
- A requested-format artifact is the primary deliverable. Quality gaps surface
  as warnings or repair requests, not silent format swaps.

## Presentation Rules

- Fresh presentations are built through `prepare_deck_build`. Provide complete
  D2.1 input: a clear slide intent in creative_plan plus each slide's title, narrative, role,
  layout_kind, speaker_notes, html_body, and optional slide_css, plus one shared deck_stylesheet. Keep every narrative concise and
  <= 280 characters. The builder owns creative plan, image plan, composition,
  and slide HTML. DeckBuildService owns HTML sanitization, planned generated
  assets, native PowerPoint compilation, inspection, mechanical gates, and
  terminal failure.
- Apply the injected compact deck-craft contract before the first prepare call.
  Full hands-on-deck, deck-impeccable, and deck-hallmark references remain optional.
- Inline SVG is unsupported. Every required semantic element needs a stable
  `data-deck-id`, `data-deck-role`, and `data-deck-required="true"`.
- Do not call `prepare_pptx_image_manifest`, `image-generation/scripts/generate.py`,
  or `build_deck_from_slides` directly for a fresh deck. Do not write
  `slides/*.html` files yourself. Put model-authored shared CSS and compact slide markup in
  prepare_deck_build's `deck_stylesheet` and `html_body` fields. Do not write python-pptx/pptxgenjs
  or any custom deck compiler.
- Screenshot-backed PPTX is a failed build, not a fallback. If
  `prepare_deck_build` returns a native deck failure, stop and emit
  `artifact_path=null` with the returned failure code and summary.
- Normal decks may use optional generated assets declared in creative_plan.image_assets.
  A full-bleed picture may be an asset/background inside a native deck with
  native text, but it is not itself a complete slide. Only explicit
  text-only/no-visual deck requests should force `visual_policy="text_only"`;
  ordinary native slides may require no generated image.
- Do not bake slide title, bottom narrative, footers, formulas, axis labels,
  paragraph text, or page chrome into generated images. Titles and narratives
  remain real native text in the submitted slide HTML.
- If `prepare_deck_build` returns success, emit the returned `.pptx`. If it
  returns `retryable=true`, repair the exact creative/html/mechanical issue and retry
  `prepare_deck_build` once. If it returns terminal failure, emit
  `artifact_path=null` with the returned failure code and summary. Do not loop
  on the same failing action or try a legacy screenshot deck.

## PDF Report Rules

- Author ONE self-contained HTML file (base print CSS inlined) and render with
  `render_html_to_pdf`. Follow the pdf-report SKILL.md pattern library.
- Draw every figure as inline static `<svg>`: data charts (bar/line/column for
  quantitative/comparative) AND structural diagrams (box-and-arrow flow,
  comparison, mind-map). NO remote `generate_chart`, NO client-side JS. Vary the
  figure family per figure; use HTML tables/callouts when they are clearer.
- You may generate up to 3 conceptual/editorial images (a cover/hero plus key
  concepts) via the image-generation skill — no text baked into the image,
  theme-matched palette, referenced as `<img src="visuals/<name>.png">`. Reserve
  generated images for conceptual figures; all data and structure is inline
  `<svg>`.

## Research

- Research is encouraged when the deliverable needs fresh facts, named
  projects, claims, citations, or source-backed context.
- Research, todos, and summaries are not deliverables. They do not complete the
  task without the requested artifact and final emit.

## Failure Handling

- If a required capability fails, stop cleanly after bounded repair attempts.
  Do not loop on the same failing action.
- If no valid requested-format artifact exists, emit a safe failure with
  `artifact_path=null` and a clear explanation.
- Never silently present a source file, preview, or wrong extension as success.
- A `prepare_deck_build` terminal failure is authoritative. Do not retry
  manually through lower-level tools. Retry `prepare_deck_build` only once when
  the failure says it is retryable and asks for corrected creative/html/mechanical input.
