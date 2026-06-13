# PPTX Workflow Card

Use this card only for requested `.pptx` or slide-deck builds.

## Required DeerFlow-Native Sequence

1. Plan with `write_todos`, then create a presentation plan JSON under
   `/mnt/user-data/workspace/`.
2. Read `/mnt/skills/public/ppt-generation/SKILL.md`.
3. Normal slide decks default to the DeerFlow visual path unless the user
   explicitly asked for a plain/text-only/no-visual deck. FIRST run
   `python /mnt/skills/public/image-generation/scripts/generate.py --preflight`
   (on failure, continue chart/text-only — the skip is recorded honestly).
   Then generate one 16:9 slide image per slide, sequentially, using the
   previous slide image as the reference for the next slide. HARD CAP: 8
   image-generation calls per presentation build — calls beyond the cap are
   rejected. Do not batch or parallelize slide images.
4. If the deck asks for charts, diagrams, data visuals, or visual
   explanations, read `/mnt/skills/public/visual-design/SKILL.md`, then use
   `generate_visual_asset` for those deterministic chart/diagram assets and
   reference each generated `.png` path from the plan using `image`,
   `chart_path`, or `visual_path`. These support assets improve individual
   slides; they are not the final artifact.
5. Compose the deck with
   `/mnt/skills/public/ppt-generation/scripts/generate.py`, passing the plan
   and an output path under `/mnt/user-data/outputs/`. Pick a `theme`
   (boardroom/daylight/ember/mist) and per-slide `layout` values per the
   ppt-generation SKILL.md. For the visual path, pass all generated
   `--slide-images` in slide order. Omit `--slide-images` only for explicit
   plain/text-only/no-visual decks or when image-generation preflight failed.
6. Emit only after the `.pptx` exists and passes structural validation. If a
   valid `.pptx` exists, it is authoritative.

Reading the skill is not completion. Writing ad hoc `python-pptx` code,
generic `.py` files, or HTML before trying the skill workflow is drift.
A text-only deck does not satisfy a user request for charts, diagrams, or
visual explanations.

## Failure Policy — No Silent Format Swaps

A valid `.pptx` always wins. If deck composition or validation fails after
one correction and you have a real `.html` or `.md` user-facing fallback,
emit it only with `requested_artifact_ext="pptx"`,
`artifact_is_fallback=true`, and a safe `fallback_reason` such as
`pptx_generation_not_completed`. If no usable fallback exists, emit with
`artifact_path=null` and an honest `companion_summary` explaining exactly
what failed (for example "the ppt-generation script rejected the plan
JSON"). Never emit a PNG support asset, tiny/corrupt `.pptx`, `.py`, helper
script, or test file as a slide deck.
