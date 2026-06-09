# PDF Workflow Card

Use this card only for requested `.pdf` builds.

1. Plan with `write_todos`.
2. If the user requested charts, diagrams, or visuals, first read
   `/mnt/skills/public/visual-design/SKILL.md`, then create at least one local
   visual asset with `generate_visual_asset` under
   `/mnt/user-data/outputs/visuals/`. Use the generated `.png` path for PDF
   embedding; SVG is useful for HTML but Pandoc/XeLaTeX should receive PNG.
3. Create Markdown or HTML source under `/mnt/user-data/outputs/`.
   Source creation is not completion and is not a fallback yet.
   Reference generated PNGs with relative paths such as
   `![Diagram](visuals/diagram.png)` before rendering.
4. Your next substantive action after source creation must be
   `render_markdown_to_pdf(markdown_path=<source>, pdf_path=<target .pdf>)`.
5. If rendering succeeds and layout quality is `ok`, that rendered `.pdf` is
   authoritative. Immediately emit that exact `.pdf`. Do not emit an older
   `.md` or `.html` fallback, and do not run extra `bash`, replan, or render
   again.
6. If the harness injects a layout repair message, revise the source once,
   render once more, then emit the best usable PDF.

Default unspecified PDF length is 10-15 pages. Avoid forced page breaks,
sparse tables, one-section-per-page layouts, and mostly empty continuation
pages.

Fallback is allowed only after `render_markdown_to_pdf` has been attempted and
rendering fails, is unavailable, or the repaired PDF is unusable. Emit a `.md`
fallback for mostly text documents or `.html` fallback when the request asks for
charts, diagrams, visuals, visual layout, or embedded images. Mark fallback metadata explicitly with
`requested_artifact_ext="pdf"`, `artifact_is_fallback=true`, and a safe
`fallback_reason`. Never emit generator scripts as PDF fallback.
