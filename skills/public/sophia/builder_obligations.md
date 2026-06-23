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
- For a `.pdf` report request, emit the `.pdf` as primary. Markdown source and generated assets are supporting files,
  not user-visible deliverables.
- For an HTML target, write a standalone `.html` document. Do not wrap it in
  Markdown code fences or emit Markdown as HTML.
- A requested-format artifact is the primary deliverable. Quality gaps surface
  as warnings or repair requests, not silent format swaps.

## Presentation Rules

- Presentations are pure image-forward. Generate one full-slide image per slide
  using the ppt-generation and image-generation skills.
- The slide image must contain its own title band and, for content slides, a
  bottom caption/takeaway band. The PPTX compiler adds only that bitmap plus
  speaker notes.
- Do not use engine-composed PPTX layouts, compiler-drawn text overlays, or
  generated PDF previews as the primary deck artifact.
- When the requested PPTX exists, has the expected slide count, and passes
  required checks, emit immediately.

## PDF Report Rules

- Author Markdown and render with `render_markdown_to_pdf`.
- Use local figures only: `generate_excalidraw_diagram` for connected
  diagrams, chart-visualization guidance plus local chart rendering for
  quantitative evidence, and Markdown tables/callouts when they are clearer.
- Do not use slide-image generation or retired report chart tools for PDFs.
- Embed PNG figure files into the Markdown before rendering.

## Research

- Research is encouraged when the deliverable needs fresh facts, named
  projects, claims, citations, or source-backed context.
- Research, todos, and summaries are not deliverables. They do not complete the
  task without the requested artifact and final emit.

## Failure Handling

- If a required capability fails, stop cleanly after one bounded repair attempt.
  Do not loop on the same failing action.
- If no valid requested-format artifact exists, emit a safe failure with
  `artifact_path=null` and a clear explanation.
- Never silently present a source file, preview, or wrong extension as success.
