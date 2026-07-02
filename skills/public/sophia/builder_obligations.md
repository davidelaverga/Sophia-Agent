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

- Presentations are HTML-slide decks. For normal decks, generate one visual-only
  asset per slide into `/mnt/user-data/outputs/assets/` through a single manifest
  batch that includes the cover/hero, then author one self-contained 1920×1080
  HTML slide per slide under `/mnt/user-data/outputs/slides/` using the
  ppt-generation skeleton. Only explicitly text-only/no-visual deck requests may
  omit images.
- The generated image asset belongs only in the HTML `.visual` region, referenced
  by a relative `../assets/<file>` path. Do not bake slide titles, bottom
  narrative, footers, or page chrome into the image; titles and 1-2 sentence
  narratives are real HTML text in `slides/*.html`.
- Do not use hand-written PPTX layouts, python-pptx/pptxgenjs scripts, or any
  custom deck compiler. Convert the HTML slides by calling `build_deck_from_slides`
  once; emit the returned `.pptx`.
- Do not ship placeholder or no-image decks when generated visuals were required.
  If the manifest batch fails or is partial, repair only failed/missing images
  serially. When the requested PPTX exists, opens, has complete generated visual
  references, and passes bounded quality repair, emit it.

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
