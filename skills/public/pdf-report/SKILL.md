---
name: pdf-report
description: Use this skill when the builder needs to create a polished PDF report, brief, explainer, technical document, or visual report. The skill guides source-first report writing, local charts/diagrams, PDF rendering, quality inspection, and truthful fallback.
---

# PDF Report Skill

## Purpose

Create a high-quality PDF by authoring a rich Markdown or HTML source document
first, then compiling it with `render_markdown_to_pdf`. The renderer packages
the report; it is not the creative author.

Do not use `create_pdf_artifact` for normal reports. That helper is only for
explicit smoke tests, demos, or "simple PDF" checks.

## Workflow

1. Plan with `write_todos`.
2. Research before writing when the topic depends on external facts. If
   `builder_web_search` returns usable factual sources, fetch at least one
   approved result with `builder_web_fetch`.
3. If the user requested charts, diagrams, visual explanations, or a visual
   report, read `/mnt/skills/public/visual-design/SKILL.md` and create local
   visual assets with `generate_visual_asset`.
4. Write a report source under `/mnt/user-data/outputs/`, usually
   `/mnt/user-data/outputs/<slug>.md`. Use HTML source only when the layout
   needs richer visual structure.
5. Reference local PNG visuals in the source with relative paths such as
   `![Architecture](visuals/architecture.png)` or virtual output paths such
   as `![Architecture](/mnt/user-data/outputs/visuals/architecture.png)`.
6. Render with:

```text
render_markdown_to_pdf(markdown_path="/mnt/user-data/outputs/<slug>.md", pdf_path="/mnt/user-data/outputs/<slug>.pdf")
```

7. Inspect the render result. If it reports missing images, sparse layout, or
   unusable quality, repair the source once and render again.
8. Emit the valid `.pdf` immediately after quality passes.

## Report Quality

- Default unspecified length: 10-15 pages for substantial technical reports,
  shorter when the user explicitly asks for a concise document.
- Use strong section hierarchy, compact tables, source notes, and concrete
  examples.
- Avoid one-section-per-page layouts, excessive page breaks, mostly empty
  continuation pages, and oversized tables that waste pages.
- For visual requests, include at least one actual embedded chart/diagram
  asset. Prose descriptions of visuals are not enough.

## Visual Rules

- Use `generate_visual_asset` for bar/line/pie charts, timelines, process
  flows, architecture diagrams, comparison matrices, quadrants, and concept
  maps.
- Use image-generation only when the user explicitly asks for generated
  images, illustrations, visual scenes, or artwork.
- Never use remote chart URLs as final visual evidence. All deliverable
  visuals must be local assets under `/mnt/user-data/outputs/visuals/` or
  inline source visuals.

## Failure And Fallback

A valid rendered PDF is authoritative. If rendering is unavailable or the PDF
remains unusable after the bounded repair pass, emit a real Markdown or HTML
fallback only when it is a usable user-facing document and the completion is
marked with:

- `requested_artifact_ext="pdf"`
- `artifact_is_fallback=true`
- `fallback_reason="pdf_generation_failed"` or a similarly safe reason

Never emit helper scripts, test files, missing paths, or raw sources as a
normal PDF success.
