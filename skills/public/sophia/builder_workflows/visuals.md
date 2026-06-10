# Visuals Workflow Card

Use this card when the user asks for charts, diagrams, visuals, visual
explanations, visual reports, or visual slide decks.

1. Read `/mnt/skills/public/visual-design/SKILL.md` before creating the final
   artifact or using visual-generation tools.
2. Choose the smallest useful visual set for the artifact.
3. Use `generate_visual_asset` to create local SVG/PNG assets under
   `/mnt/user-data/outputs/visuals/`.
4. Embed inline SVG or linked SVG/PNG for HTML. For PDF and PPTX, reference the
   generated PNG in the Markdown/HTML source or presentation plan before
   rendering/composing the final artifact.

## Two Visual Paths

Use `generate_visual_asset` for anything data-shaped: charts, diagrams,
timelines, flows, matrices, quadrants (deterministic, instant, no API cost,
unlimited). Use the image-generation skill for illustrative content: hero
images, section covers, conceptual scenes — capped at 3 generated images per
build (the cap never applies to charts). If image generation fails, continue
with charts and text; never stall the deliverable waiting on imagery.

Do not count remote chart URLs, generated Python scripts, or prose
descriptions as completed visuals. If visual generation fails entirely on a
visuals-requested build, deliver the strongest chart/text version and let the
quality warning surface honestly — never swap formats.
