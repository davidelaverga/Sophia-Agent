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

Do not count remote chart URLs, generated Python scripts, or prose
descriptions as completed visuals. If visual generation fails, emit a truthful
fallback only when a usable fallback file exists and fallback metadata is
explicit.
