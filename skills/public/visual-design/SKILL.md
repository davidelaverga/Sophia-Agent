---
name: visual-design
description: Use this skill before creating charts, diagrams, visual reports, visual slide decks, or visual PDF/HTML artifacts. It gives compact design, chart-selection, accessibility, and visual-density guidance for local visual assets.
---

# Visual Design Skill

Use this skill when a requested artifact needs charts, diagrams, visuals,
visual explanations, visual reports, or visual slide decks.

Adapted from the MIT-licensed `nextlevelbuilder/ui-ux-pro-max-skill`
design guidance. Keep this as decision guidance only; final visual assets must
be generated locally under `/mnt/user-data/outputs/`.

## Required Workflow

1. Read this file before using visual-generation tools or creating the final
   artifact when the user requested visuals.
2. Choose the minimum useful visual set: one clear chart/diagram is better
   than several decorative weak ones.
3. Create local visual assets with `generate_chart` (the chart-visualization
   skill) for both structural diagrams (flow, network, mind-map, fishbone,
   organization-chart, sankey) and numeric/data charts; do not treat remote
   chart URLs as deliverable assets.
4. Embed or reference the local visual assets in the final HTML, PDF source, or
   PPTX plan before emitting the artifact.

## Visual Quality Rules

- Every visual must explain a real idea, comparison, timeline, process, or
  relationship from the artifact.
- Use concise titles and labels. Avoid paragraphs inside diagrams.
- Prefer high contrast, readable type, and semantic color. Do not rely on color
  alone; include labels, icons, or grouping.
- Keep layout density balanced: avoid mostly empty pages/slides, oversized
  tables, or one tiny chart on a full page.
- Use a consistent palette and typography across the artifact.
- For PDF reports, use no more than two figures from any one figure family.
- Make charts self-contained with title, legend/labels, source context when
  appropriate, and units when numeric.

## Chart And Diagram Selection

- Trends over time: line chart.
- Category comparison: bar chart.
- Part-to-whole with few categories: donut/pie chart.
- Chronology or staged development: timeline.
- Workflow or process: Excalidraw process flow.
- System layers, components, or architecture: Excalidraw architecture diagram.
- Tradeoffs or options: comparison matrix or quadrant.
- Concept relationships: Excalidraw concept map.

## Target-Specific Guidance

- HTML: inline SVG or local SVG/PNG assets are both acceptable.
- PDF: reference local SVG/PNG assets from the Markdown/HTML source before
  rendering. Do not rely on browser-only scripts.
- PPTX: generated slide images must contain the requested visual evidence
  directly in the bitmap.

## Done Criteria

A visual artifact is complete only when the final deliverable contains the
requested visual evidence: inline SVG, embedded media, chart/diagram
parts, or local generated assets referenced by the delivered file.
