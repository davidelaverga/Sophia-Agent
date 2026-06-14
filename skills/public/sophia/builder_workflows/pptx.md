# PPTX Workflow Card

Use this card only for requested `.pptx` or slide-deck builds.

## Required Sequence

1. Plan with `write_todos`, then create a presentation plan JSON under
   `/mnt/user-data/workspace/`.
2. Read `/mnt/skills/public/ppt-generation/SKILL.md`.
3. Normal decks default to polished visual treatment unless the user clearly
   asks for plain, text-only, or no-visual slides.
4. Create useful slide assets, not a slide-image album:
   - use chart/data skills or `generate_visual_asset` for numeric charts with
     explicit labeled `{label, value}` data;
   - use `generate_excalidraw_diagram` with raw Mermaid for process,
     architecture, system, concept, sequence, timeline, or comparison diagrams;
   - use `image-generation/scripts/generate.py` only for optional cover/hero,
     section, or illustrative imagery when it improves the deck.
5. Reference local PNG/JPEG assets from plan fields `image`, `chart_path`, or
   `visual_path`, then compose the deck with
   `/mnt/skills/public/ppt-generation/scripts/generate.py`.
6. Emit only after the `.pptx` exists and passes structural validation. A
   valid `.pptx` is authoritative.

The deck must contain editable text and meaningful slide structure. Generated
images, chart PNGs, Excalidraw diagrams, and SVG/PNG visuals are support
assets, never the primary slide-deck deliverable.
Use safe Office fonts and the supported theme palette; avoid side accent bars,
decorative stripes, gradients, and fake chart labels.

## Failure Policy — No Silent Format Swaps

A valid `.pptx` always wins. If deck composition or validation fails after
one correction and you have a real `.html` or `.md` user-facing fallback,
emit it only with `requested_artifact_ext="pptx"`,
`artifact_is_fallback=true`, and `fallback_reason="pptx_generation_not_completed"`.
If no usable fallback exists, emit with `artifact_path=null` and an honest
`companion_summary` explaining exactly what failed. Never emit a PNG support
asset, tiny/corrupt `.pptx`, `.py`, helper script, or test file as a slide
deck.
