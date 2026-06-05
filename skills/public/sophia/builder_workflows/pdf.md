# PDF Workflow Card

Use this card only for requested `.pdf` builds.

1. Plan with `write_todos`.
2. Create Markdown or HTML source under `/mnt/user-data/outputs/`.
3. Call `render_markdown_to_pdf(markdown_path=<source>, pdf_path=<target .pdf>)`.
4. If rendering succeeds and layout quality is `ok`, immediately emit the
   `.pdf`. Do not run extra `bash`, replan, or render again.
5. If the harness injects a layout repair message, revise the source once,
   render once more, then emit the best usable PDF.

Default unspecified PDF length is 10-15 pages. Avoid forced page breaks,
sparse tables, one-section-per-page layouts, and mostly empty continuation
pages.

If PDF rendering fails or is unavailable, emit a `.md` fallback for mostly text
documents or `.html` fallback when the request asks for charts, diagrams,
visuals, visual layout, or embedded images. Never emit generator scripts as PDF
fallback.
