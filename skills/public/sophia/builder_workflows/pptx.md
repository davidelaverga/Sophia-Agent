# PPTX Workflow Card

Use this card only for requested `.pptx` or slide-deck builds.

## Required DeerFlow-Native Sequence

1. Plan with `write_todos`, then create a presentation plan JSON under
   `/mnt/user-data/workspace/`.
2. Read `/mnt/skills/public/ppt-generation/SKILL.md`.
3. If the user requested charts, diagrams, or visuals, read
   `/mnt/skills/public/visual-design/SKILL.md`, then create local visual
   assets with `generate_visual_asset` BEFORE composing the deck, and
   reference each generated `.png` path from the plan using a per-slide
   `image`, `chart_path`, or `visual_path` field. The plan must reference
   the PNGs before you run the generator — a deck composed without them
   will be rejected at emit time when visuals were requested. Do not use
   the generated support PNG as the final artifact.
4. Generated imagery is ON BY DEFAULT for decks (unless the brief asks for a
   plain/text-only/minimal deck): use
   `/mnt/skills/public/image-generation/scripts/generate.py` to create 1 hero
   image (16:9, for the title slide) and up to 2 supporting images. HARD CAP:
   3 image-generation calls per build — calls beyond the cap are rejected.
   Save them under `/mnt/user-data/outputs/visuals/` and wire them into the
   plan: hero → slide 1 with `"layout": "full_bleed_image"` and `"image":
   <hero path>`; supporting images → `section_divider`/`content_image`
   slides. Charts stay on the `generate_visual_asset` path (no cap). If an
   image call fails, retry at most once with a simpler prompt, then continue
   without generated images — a chart/text deck is a valid deliverable.
5. Compose the deck with
   `/mnt/skills/public/ppt-generation/scripts/generate.py`, passing the plan
   and an output path under `/mnt/user-data/outputs/`. Pick a `theme`
   (boardroom/daylight/ember/mist) and per-slide `layout` values per the
   ppt-generation SKILL.md. Do not pass `--slide-images` unless you actually
   generated full-slide images.
6. Emit only after the `.pptx` exists and passes structural validation. If a
   valid `.pptx` exists, it is authoritative.

Reading the skill is not completion. Writing ad hoc `python-pptx` code,
generic `.py` files, or HTML before trying the skill workflow is drift.
A text-only deck does not satisfy a user request for charts, diagrams, or
visual explanations.

## Failure Policy — No Format Swaps

Format-swapped fallbacks are DISABLED for slide-deck requests: a `.md` or
`.html` emission for a `.pptx` request is rejected by the harness. If deck
composition or validation fails after one correction, emit with
`artifact_path=null` and an honest `companion_summary` explaining exactly
what failed (for example "the ppt-generation script rejected the plan
JSON"). Intermediate files you wrote under `/mnt/user-data/outputs/` stay
available to the user in the session artifacts list — say so in the
summary. Never emit a tiny/corrupt `.pptx`, `.py`, helper script, or test
file as a slide deck.
