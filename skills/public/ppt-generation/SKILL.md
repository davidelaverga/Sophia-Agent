---
name: ppt-generation
description: Use this skill whenever the builder must create a PowerPoint deck or presentation (.pptx). By default, fresh Sophia decks are built through prepare_deck_build: the builder submits slide intent, and the harness owns prompt files, image generation, slide rendering, PPTX compilation, evaluation, and terminal failure. If prepare_deck_build is not exposed, follow the route-specific legacy tools that are exposed instead.
---

# Sophia Deck Skill — PPTX

Fresh decks are DeckBuildService builds by default. You provide slide intent only; the
harness creates prompt files, prepares and runs the image batch, renders safe
slide HTML templates, compiles the PPTX, evaluates it, and returns either the
`.pptx` path or a clean failure.

## Building A Deck

1. Plan the deck as slide intent only. For each slide provide:
   - title: 4-9 words
   - narrative: 1-2 sentences
   - role: cover, problem, context, architecture, process, comparison, evidence, timeline, or closing
   - layout_kind: cover_hero, single_visual_focus, visual_left_text_right, text_left_visual_right, comparison_two_column, timeline_flow, or closing_summary
   - visual_prompt: required for normal decks; describe the visual substance only
   - speaker_notes: optional

2. Call `prepare_deck_build(...)` exactly once with the complete slide list and the requested output path.

3. The harness will:
   - write prompt JSON files,
   - prepare the image batch manifest,
   - run image generation,
   - render slide HTML from safe templates,
   - compile the PPTX,
   - evaluate hard/soft gates,
   - return the `.pptx` path or a clean failure.

4. Emit the returned `.pptx` with `emit_builder_artifact(artifact_type="presentation")`. If `prepare_deck_build` returns failure, emit `artifact_path=null` with its `failure_code` and `failure_summary`; do not loop on lower-level deck tools.

## Legacy Emergency Route

Use this section only when the current tool list does not expose
`prepare_deck_build` and does expose `prepare_pptx_image_manifest` plus
`build_deck_from_slides`. In that explicit legacy route, follow the active
tool schemas and builder briefing for the lower-level deck workflow: create the
deterministic manifest through `prepare_pptx_image_manifest`, run one manifest
image batch, render `slides/*.html` that reference the generated assets, and
compile with `build_deck_from_slides`. Do not mix this route with
`prepare_deck_build`.

## Hard Rules

- When `prepare_deck_build` is exposed, do not write prompt JSON files, do not hand-write slide HTML, do not call `prepare_pptx_image_manifest`, do not run `image-generation/scripts/generate.py`, do not call `build_deck_from_slides`, and do not write python-pptx/pptxgenjs or any custom deck compiler. Those are internal harness steps behind `prepare_deck_build`.
- Normal decks require generated visuals: one visual-only asset per slide. Only an explicitly plain text-only/no-visual request may set `visual_policy="text_only"`.
- Generated slide images are visual-area assets only. Do not bake slide title, narrative, footers, formulas, axis labels, paragraph text, page chrome, or large readable labels into images.
- Default aesthetic is restrained professional technical unless the user asks otherwise. Do not use chalkboard, handwritten, whiteboard, sketch, cyberpunk, neon, classroom, or playful styles unless explicitly requested.
- Harness-rendered slide templates must be opaque to all edges and may be light or dark according to the request; no image-baked title or narrative.
- Keep slide text concise. Titles and narratives are real slide text rendered by the harness template.
- A `prepare_deck_build` terminal failure is authoritative. Do not retry manually through lower-level tools unless the failure says it is retryable and asks for corrected slide intent.

## QA Checklist

- Exactly one `prepare_deck_build` call for a fresh deck.
- Expected slide count and `.pptx` output path under `/mnt/user-data/outputs/`.
- Normal decks have one generated visual per slide or fail honestly.
- Text-only/no-visual decks are used only when explicitly requested.
- Emit promptly once the tool returns a valid `.pptx`.
