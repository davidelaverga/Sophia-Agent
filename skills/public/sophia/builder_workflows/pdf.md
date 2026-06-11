# PDF Workflow Card

Use this card only for requested `.pdf` builds.

1. Plan with `write_todos`.
2. Read `/mnt/skills/public/pdf-report/SKILL.md`. Treat it as the report
   writing workflow: research, outline, rich source, local visuals, render,
   inspect, emit.
3. If the user requested charts, diagrams, or visuals, first read
   `/mnt/skills/public/visual-design/SKILL.md`, then create at least one local
   visual asset with `generate_visual_asset` under
   `/mnt/user-data/outputs/visuals/`. Use the generated `.png` path for PDF
   embedding; SVG is useful for HTML but Pandoc/XeLaTeX should receive PNG.
   Do not use image-generation for normal charts/diagrams; use it only when
   the user explicitly asks for generated illustrations or images.
4. Create Markdown or HTML source under `/mnt/user-data/outputs/`. Name the
   source after the document stem (for example `report.md` for `report.pdf`).
   Source creation is not completion.
   Reference generated PNGs before rendering, either with relative paths such
   as `![Diagram](visuals/diagram.png)` or with the full virtual path
   `![Diagram](/mnt/user-data/outputs/visuals/diagram.png)` — both resolve.
5. Your next substantive action after source creation must be
   `render_markdown_to_pdf(markdown_path=<source>, pdf_path=<target .pdf>)`.
6. Check the render result. If it reports `images_missing: true` or lists
   `missing_resources`, fix the image references in the source and render
   once more — a visuals-requested PDF with zero embedded images will be
   rejected at emit time with one repair turn.
7. If rendering succeeds and layout quality is `ok`, that rendered `.pdf` is
   authoritative. Immediately emit that exact `.pdf`. Do not emit the `.md`
   or `.html` source as the artifact, and do not run extra `bash`, replan,
   or render again.
8. If the harness injects a layout repair message, revise the source once,
   render once more, then emit the best usable PDF.

Styling: pick a theme with `render_markdown_to_pdf(theme=...)` or a
`sophia-theme:` key in the source's YAML frontmatter — `boardroom` (formal,
navy/serif), `minimal` (default, slate/sans), or `warm` (terracotta).
Adding `title:` (and optionally `subtitle:`) frontmatter produces a colored
cover page, and a table of contents is added automatically for long
documents — no extra flags needed.

Default unspecified PDF length is 10-15 pages. Avoid forced page breaks,
sparse tables, one-section-per-page layouts, and mostly empty continuation
pages.

## Failure Policy — No Silent Format Swaps

A valid rendered `.pdf` always wins. If `render_markdown_to_pdf` fails, is
unavailable (`pandoc_missing`), or the repaired PDF is unusable, emit a real
`.md` or `.html` fallback only with `requested_artifact_ext="pdf"`,
`artifact_is_fallback=true`, and a safe `fallback_reason` such as
`pdf_generation_failed`. If no usable fallback exists, emit with
`artifact_path=null` and an honest `companion_summary` explaining exactly
what failed. Never emit generator scripts as a PDF deliverable.
