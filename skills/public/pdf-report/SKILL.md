---
name: pdf-report
description: Use this skill whenever the builder must create a PDF report, brief, explainer, or technical document. Sophia PDF reports are deterministic Markdown-to-PDF artifacts with local PNG figures.
---

# Sophia Report Skill - PDF

Sophia PDF reports are source-first documents. Author Markdown, embed local PNG
figures, and render with `render_markdown_to_pdf`. The PDF renderer owns table
of contents, citations, page layout, and typography.

Do not use generated slide images in PDF reports. Do not emit Markdown source
or preview files as the final artifact unless explicitly requested.

## Workflow

1. Plan the section spine, target page count, and figure placements.
2. Research as needed and preserve citations.
3. Author clean Markdown with headings, prose, tables, citations, and local PNG
   figure references.
4. Generate deterministic figures:
   - Connected structure: `generate_excalidraw_diagram`.
   - Quantitative evidence: use the chart-visualization skill to choose the
     chart/table/callout grammar, then render deterministically.
   - Tables/stat boxes: Markdown tables or LaTeX-friendly callouts when they
     are clearer than a chart.
5. Render with `render_markdown_to_pdf`, passing requested page-count
   parameters when the user asked for a length.
6. Inspect the render result. Repair missing resources or page-count drift once.
7. Emit the `.pdf` as the primary artifact.

## Figure Grammar

Pick the figure form that matches the content:

- Architecture/system structure: nested containers or node-link diagram.
- Process: flow, sequence, lifecycle, or timeline.
- Comparison: table, side-by-side panels, or grouped chart.
- Quantitative trend: line/area chart.
- Composition/share: stacked bar, treemap, donut only when values justify it.
- Distribution: histogram, box plot, density, or small multiples.
- One/few numbers: stat callout, not a chart.

Avoid repetitive diagrams. A report with several figures should show more than
one grammar when the source material supports it. Repetition is acceptable only
when repeated measurement is the actual analytic point.

## Figure Requirements

- Use real labels and values. Never invent placeholder data.
- Embed PNG files in Markdown: `![Caption](assets/figure.png)`.
- Keep captions specific and source-aware.
- Keep SVG as a secondary asset for HTML or inspection only; the PDF should
  embed PNG.
- Do not include missing, remote-only, or broken images.

## Markdown Requirements

- Use frontmatter with `title`, optional `subtitle`, and optional
  `sophia-theme`.
- Use clean heading levels so the TOC is generated correctly.
- Cite researched claims inline.
- Prefer prose over unnecessary graphics.
- Use Markdown tables for tabular comparisons.

## QA Checklist

- Requested `.pdf` exists and opens.
- Page count is near the requested target or the render result explains the
  bounded drift.
- TOC and headings are coherent.
- Citations are present where factual claims require them.
- Figures are embedded, legible, varied when appropriate, and not repeated from
  one generic diagram template.
- Only the primary PDF is user-visible by default.
