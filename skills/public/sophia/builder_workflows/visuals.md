# Visuals Workflow Card

Use this card when the user asks for charts, diagrams, visuals, visual
explanations, visual reports, or visual slide decks.

1. Read `/mnt/skills/public/visual-design/SKILL.md` before creating visual
   assets or emitting a visual deliverable. The harness blocks visual asset
   calls until this discipline is read.
2. Choose the smallest useful visual set for the artifact.
3. Use `generate_visual_asset` for numeric charts and data-shaped visuals with
   explicit labeled `{label, value}` data. Use `generate_excalidraw_diagram`
   for technical diagrams by passing raw Mermaid. Both write local SVG/PNG
   assets under `/mnt/user-data/outputs/visuals/`.
4. Embed inline SVG or linked SVG/PNG for HTML. For PDF and PPTX, reference the
   generated PNG in the Markdown/HTML source or presentation plan before
   rendering/composing the final artifact.

## Two Visual Paths

Use `generate_visual_asset` for data-shaped visuals: bar/line/pie charts,
matrices, quadrants, and compact quantitative graphics. Use
`generate_excalidraw_diagram` for architecture, process, timeline, system,
concept, comparison, cycle, and sequence diagrams; write these as Mermaid, not
manual coordinates. Use the image-generation skill only for illustrative
content: hero images, section covers, conceptual scenes, or polished
atmosphere. PPTX uses a presentation-specific cap; the cap never applies to
charts or Excalidraw diagrams. If image generation fails,
continue with diagrams, charts, and text; never stall the deliverable waiting
on imagery.

Do not count remote chart URLs, generated Python scripts, or prose
descriptions as completed visuals. Do not invent placeholder labels (`Item 1`)
or fake values. If visual generation fails entirely on a visuals-requested
build, deliver the strongest chart/text version and let the quality warning
surface honestly — never swap formats.
