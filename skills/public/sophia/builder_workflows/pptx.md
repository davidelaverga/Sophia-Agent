# PPTX Workflow Card

Use this card only for requested `.pptx` or slide-deck builds.

## Required DeerFlow-Native Sequence

1. Plan with `write_todos`, then create a presentation plan JSON under
   `/mnt/user-data/workspace/`.
2. Read `/mnt/skills/public/ppt-generation/SKILL.md`.
3. If the user requested charts, diagrams, or visuals, read
   `/mnt/skills/public/visual-design/SKILL.md`, then create local visual
   assets with `generate_visual_asset` and reference them from the plan.
4. Compose a valid no-image deck first with
   `/mnt/skills/public/ppt-generation/scripts/generate.py`, passing the plan
   and an output path under `/mnt/user-data/outputs/`. Do not pass
   `--slide-images` unless you actually generated slide images.
5. Use `/mnt/skills/public/image-generation/scripts/generate.py` only when the
   user explicitly requests generated images, illustrations, visual scenes, or
   image-heavy slides. If image generation fails, continue with the no-image
   PPTX path rather than immediately falling back to HTML.
6. Emit only after the `.pptx` exists and passes structural validation. If a
   valid `.pptx` exists, it is authoritative; do not emit an HTML or Markdown
   fallback instead.

Reading the skill is not completion. Writing ad hoc `python-pptx` code,
generic `.py` files, or HTML before trying the skill workflow is drift.
A text-only deck does not satisfy a user request for charts, diagrams, or
visual explanations.

## Failure And Fallback

If deck composition or validation fails after one correction, create a real
`.html` fallback for visual/chart/diagram decks or `.md` fallback for mostly
text decks. The fallback must be under `/mnt/user-data/outputs/`,
browser-readable if HTML, and emitted with explicit fallback metadata:
`requested_artifact_ext="pptx"`, `artifact_is_fallback=true`, and a safe
`fallback_reason` such as `pptx_generation_not_completed`. Never emit a
tiny/corrupt `.pptx`, `.py`, helper script, or test file as a slide deck.
