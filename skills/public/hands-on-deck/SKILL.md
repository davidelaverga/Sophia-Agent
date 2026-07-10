---
name: hands-on-deck
description: Sophia's service-safe native PowerPoint design contract for fresh PPTX builds.
---

# Hands-on-deck for Sophia

Use this adapter for every fresh `.pptx` task handled by the Sophia builder.
It exposes the upstream design principles without exposing the upstream direct
CLI workflow.

## Required reading

Read `/mnt/skills/public/hands-on-deck/designing-slides.md` before authoring a
creative plan or slide HTML.

## Sophia overrides

- The authoritative Sophia slide canvas is **1920x1080 CSS px**. Ignore the
  upstream 1280x720 examples; those target a different deck size.
- Fresh deck execution goes only through `prepare_deck_build`.
- Do not call `deck.py`, `html2patch.py`, `python-pptx`, PPTXGenJS, shell
  scripts, or legacy deck tools directly.
- Inline SVG is unsupported. Use compiler-supported HTML/CSS native shapes,
  text, borders, tables, and planned local images.
- Every semantically required element needs a unique `data-deck-id`, a
  `data-deck-role`, and `data-deck-required="true"`.
- Generated images may provide atmosphere, texture, photography, or metaphor.
  Labels, arrows, values, formulas, timelines, architecture, and exact
  relationships must remain native.

The builder owns the creative plan and slide HTML. DeckBuildService validates,
executes, compiles, and mechanically verifies them.
