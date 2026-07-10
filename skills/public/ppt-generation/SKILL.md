---
name: ppt-generation
description: Use this skill whenever the builder must create a PowerPoint deck or presentation (.pptx). By default, fresh Sophia decks are built through prepare_deck_build: the builder submits a creative plan and model-authored slide HTML sources, and the harness owns sanitization, planned assets, native PowerPoint compilation, inspection, mechanical gates, and terminal failure. If prepare_deck_build is not exposed, follow the explicit non-production diagnostic legacy tools that are exposed instead.
---

# Sophia Deck Skill — PPTX

Legacy note: fresh Sophia PPTX deck builds must use `prepare_deck_build`.
Screenshot-backed PPTX is not an acceptable fallback for fresh decks. The
legacy lower-level route below is only for explicit non-production diagnostics
when `prepare_deck_build` is not exposed.

Fresh decks are DeckBuildService builds by default. Read
`/mnt/skills/public/sophia/deck_craft.md`, then provide the creative plan and
slide HTML sources inside `prepare_deck_build`. The harness owns sanitization,
planned assets and asset policy, native PowerPoint compilation, inspection, mechanical gates, and
terminal failure. It returns either the `.pptx` path or a clean failure.

## Building A Deck

1. Plan the deck as a D2.1 creative build:
   - write one explicit slide intent for every composition before authoring HTML
   - creative_plan: subject, audience, goal, story_arc, design_plan, image_strategy, image_assets, slide_compositions, anti_slop_commitments
   - generated images are declared only in creative_plan.image_assets
   - each slide composition must vary structure and rhythm where the story calls for it
   - every slide_compositions item requires `selector`, `slide_role`, `headline_intent`, `layout_name`, `composition_rationale`, `native_elements`, and `image_asset_ids`

2. For each slide provide:
   - title: 4-9 words
   - narrative: 1-2 concise sentences, <= 280 characters
   - role: cover, problem, context, architecture, process, comparison, evidence, timeline, or closing
   - layout_kind: cover_hero, single_visual_focus, visual_left_text_right, text_left_visual_right, comparison_two_column, timeline_flow, or closing_summary
   - speaker_notes: optional
   - html_source: complete native-convertible slide HTML/CSS on a 1920x1080 opaque canvas

3. Call `prepare_deck_build(...)` exactly once with the creative_plan, complete slide list, and requested output path, except for one explicit repair retry when the tool returns `retryable=true`.

4. The harness will:
   - validate/sanitize the creative plan and slide HTML,
   - prepare only the generated assets declared in creative_plan.image_assets,
   - compile through the native PowerPoint substrate,
   - inspect native editability,
   - validate mechanical gates,
   - return the `.pptx` path or a clean failure.

5. A valid `.pptx` result is terminalized by the harness immediately. If `prepare_deck_build` returns `retryable=true`, repair the exact creative/html/mechanical issue and call `prepare_deck_build` one more time. A second failure is terminal; do not loop on lower-level deck tools.

## Legacy Emergency Route

Use this section only in explicit non-production diagnostics when the current tool list does not expose
`prepare_deck_build` and does expose `prepare_pptx_image_manifest` plus
`build_deck_from_slides`. In that explicit legacy route, follow the active
tool schemas and builder briefing for the lower-level deck workflow: create the
deterministic manifest through `prepare_pptx_image_manifest`, run one manifest
image batch, render `slides/*.html` that reference the generated assets, and
compile with `build_deck_from_slides`. Do not mix this route with
`prepare_deck_build`.

## Hard Rules

- When `prepare_deck_build` is exposed, do not write prompt JSON files and do not hand-write slide HTML or `slides/*.html` files. Do not call `prepare_pptx_image_manifest`, do not run `image-generation/scripts/generate.py`, do not call `build_deck_from_slides`, and do not write python-pptx/pptxgenjs or any custom deck compiler. Those are internal harness steps behind `prepare_deck_build`.
- Screenshot-backed PPTX is a failed build, not a fallback. If native deck generation fails, emit `artifact_path=null` with the returned failure code and summary.
- Normal decks may use optional generated assets declared in creative_plan.image_assets. Full-bleed pictures are allowed only as assets/backgrounds inside an otherwise native deck with native text; a picture is never itself the whole slide. Only an explicitly plain text-only/no-visual request may set `visual_policy="text_only"`.
- Generated slide images are visual-area assets only. Do not bake slide title, narrative, footers, formulas, axis labels, paragraph text, page chrome, or large readable labels into images.
- Default aesthetic is restrained professional technical unless the user asks otherwise. Do not use chalkboard, handwritten, whiteboard, sketch, cyberpunk, neon, classroom, or playful styles unless explicitly requested.
- Slide HTML sources must be opaque to all edges and may be light or dark according to the request; no image-baked title or narrative.
- Keep slide text concise. Titles and narratives are real native slide text from the submitted HTML.
- A `prepare_deck_build` terminal failure is authoritative. Do not retry manually through lower-level tools. Retry `prepare_deck_build` only once when the failure says it is retryable and asks for corrected creative/html/mechanical input.

## QA Checklist

- Exactly one `prepare_deck_build` call for a fresh deck, or two only when the first result is a retryable D2.1 repair.
- Expected slide count and `.pptx` output path under `/mnt/user-data/outputs/`.
- DeckBuildService owns sanitization, planned assets, native deck validation, and mechanical gates.
- Text-only/no-visual decks are used only when explicitly requested.
- Emit promptly once the tool returns a valid `.pptx`.
