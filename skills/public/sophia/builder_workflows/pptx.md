# PPTX Workflow Card

Use this card only for requested `.pptx` or slide-deck builds.

## Required DeerFlow-Native Sequence

1. Plan with `write_todos`, then create a presentation plan JSON under
   `/mnt/user-data/workspace/`.
2. Read `/mnt/skills/public/ppt-generation/SKILL.md`.
3. Read `/mnt/skills/public/image-generation/SKILL.md`.
4. Generate slide images sequentially with
   `/mnt/skills/public/image-generation/scripts/generate.py`.
   Slide 1 establishes the visual system. Slide 2+ must use the previous slide
   image as `--reference-images`; the previous slide image is the style
   reference that preserves continuity.
5. Compose the deck with
   `/mnt/skills/public/ppt-generation/scripts/generate.py`, passing the plan,
   all slide images in order, and an output path under `/mnt/user-data/outputs/`.
6. Emit only after the `.pptx` exists and passes structural validation.

Reading the skill is not completion. Writing ad hoc `python-pptx` code,
generic `.py` files, or HTML before trying the skill workflow is drift.

## Failure And Fallback

If image generation or deck composition fails after one correction, create a
real `.html` fallback for visual/chart/diagram decks or `.md` fallback for
mostly text decks. The fallback must be under `/mnt/user-data/outputs/`,
browser-readable if HTML, and emitted with fallback metadata. Never emit a
tiny/corrupt `.pptx`, `.py`, helper script, or test file as a slide deck.
