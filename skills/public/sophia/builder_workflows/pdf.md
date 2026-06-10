# PDF Workflow Card

Use this card only for requested `.pdf` builds.

1. Plan with `write_todos`.
2. If the user requested charts, diagrams, or visuals, first read
   `/mnt/skills/public/visual-design/SKILL.md`, then create at least one local
   visual asset with `generate_visual_asset` under
   `/mnt/user-data/outputs/visuals/`. Use the generated `.png` path for PDF
   embedding; SVG is useful for HTML but Pandoc/XeLaTeX should receive PNG.
3. Create Markdown or HTML source under `/mnt/user-data/outputs/`. Name the
   source after the document stem (for example `report.md` for `report.pdf`).
   Source creation is not completion.
   Reference generated PNGs before rendering, either with relative paths such
   as `![Diagram](visuals/diagram.png)` or with the full virtual path
   `![Diagram](/mnt/user-data/outputs/visuals/diagram.png)` — both resolve.
4. Your next substantive action after source creation must be
   `render_markdown_to_pdf(markdown_path=<source>, pdf_path=<target .pdf>)`.
5. Check the render result. If it reports `images_missing: true` or lists
   `missing_resources`, fix the image references in the source and render
   once more — a visuals-requested PDF with zero embedded images will be
   rejected at emit time with one repair turn.
6. If rendering succeeds and layout quality is `ok`, that rendered `.pdf` is
   authoritative. Immediately emit that exact `.pdf`. Do not emit the `.md`
   or `.html` source as the artifact, and do not run extra `bash`, replan,
   or render again.
7. If the harness injects a layout repair message, revise the source once,
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

## Failure Policy — No Format Swaps

Format-swapped fallbacks are DISABLED for PDF requests: a `.md` or `.html`
emission for a `.pdf` request is rejected by the harness. If
`render_markdown_to_pdf` fails, is unavailable (`pandoc_missing`), or the
repaired PDF is unusable, emit with `artifact_path=null` and an honest
`companion_summary` explaining exactly what failed. The Markdown source you
wrote stays available to the user in the session artifacts list — say so in
the summary. Never emit generator scripts as a PDF deliverable.
