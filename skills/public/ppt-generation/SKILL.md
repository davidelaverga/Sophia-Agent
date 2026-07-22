---
name: ppt-generation
description: Use this skill whenever the builder must create a fresh PowerPoint deck through prepare_deck_build with a creative plan and compact compiler-supported slide HTML.
---

# Sophia Deck Skill — PPTX

Fresh Sophia PPTX deck builds use `prepare_deck_build`. Screenshot-backed PPTX
and lower-level compiler workflows are not acceptable fallbacks.

Fresh decks are DeckBuildService builds by default. Read
`/mnt/skills/public/sophia/deck_craft.md`, the
`hands-on-deck/designing-slides`, `deck-impeccable`, and `deck-hallmark`
adapters selected there, then provide the creative plan, one shared stylesheet,
and compact slide bodies inside `prepare_deck_build`. The harness owns document assembly and sanitization,
planned assets and asset policy, native PowerPoint compilation, inspection, mechanical gates, and
terminal failure. It returns either the `.pptx` path or a clean failure.

## Building A Deck

1. Plan the deck as a D2.1 creative build:
   - write one explicit slide intent for every composition before authoring HTML
   - creative_plan: subject, audience, goal, viewing_context, subject_materials, story_arc, design_plan, image_strategy, image_strategy_rationale, image_assets, slide_compositions, skill_refs, plan_critique, anti_slop_commitments
   - generated images are declared only in creative_plan.image_assets
   - each slide composition must vary structure and rhythm where the story calls for it
   - every slide_compositions item requires `selector`, `slide_role`, `headline_intent`, `layout_name`, `composition_rationale`, `native_elements`, `image_asset_ids`, `required_element_ids`, and `structural_fingerprint`

2. For each slide provide:
   - title: 4-9 words
   - narrative: 1-2 concise sentences, <= 280 characters
   - role: cover, problem, context, architecture, process, comparison, evidence, timeline, or closing
   - layout_kind: cover_hero, single_visual_focus, visual_left_text_right, text_left_visual_right, comparison_two_column, timeline_flow, or closing_summary
   - speaker_notes: optional
   - html_body: native-convertible markup inside the slide canvas; no document or style tags
   - slide_css: omit it or pass an empty string for every compact-v2 slide so a later authenticated repair overlay retains the full 1 KiB channel
   - inline SVG is unsupported; every required semantic element uses stable `data-deck-*` attributes
   - at least two independent repair-addressable layout anchors: non-nested `section` or `div` direct children of the service-owned `main`, each with visible semantic text and an HTML `id` unique within its slide; the same two short anchor IDs may be reused in separate slide fragments so shared `#id` rules scale. Each anchor `id` must match `[a-z][a-z0-9_-]{0,31}`—a lowercase ASCII letter followed by at most 31 lowercase ASCII letters, digits, `_`, or `-`, for a maximum of 32 characters. Each anchor's `data-deck-id` must be unique within its slide, its `data-deck-role` must be nonempty, and it must use `data-deck-required="true"`

3. Set `authoring_contract="compact_model_html_v2"`. Provide one concise `deck_stylesheet` containing all fresh-deck CSS. Reuse shared classes and target each `html_body` under 4 KiB. The combined `html_body` bytes must stay within 4 KiB times the slide count; slides may borrow unused body budget, with each slide capped at the hard 6 KiB ceiling. Omit `slide_css` or pass an empty string for every slide so its full 1 KiB channel remains available to a later authenticated repair overlay, and keep the complete tool arguments under 48 KiB. The stylesheet must give the 1920x1080 canvas an explicit opaque background. In `deck_stylesheet`, give each repair anchor's short `#id` a flat rule with `position:absolute`, `box-sizing:border-box`, `margin:0`, and finite-pixel `left`, `top`, `width`, and `height`; keep it at least 48x24px and wholly on canvas. No other CSS selector matching an anchor may declare a nonzero margin or any logical or vendor margin property; reset margins on anchor descendants with separate descendant selectors. Keep required anchor geometry out of `slide_css` and inline styles. Do not use `!important`, `right`, `bottom`, `inset`, min/max sizing, `transform`, or `opacity` on an anchor, and do not use at-rules or nested CSS. Flex and grid may be used inside the anchors, so composition and visual direction remain subject-derived. Keep non-bleed geometry inside that canvas. Absolutely positioned descendants inside a positioned parent use parent-local `left`/`top`; never repeat the parent's slide-global offset on a nested child.

4. Call `prepare_deck_build(...)` exactly once with the authoring contract, concise creative_plan, deck_stylesheet, complete slide list, and requested output path. Emit no prose outside that tool call. One explicit repair retry is allowed only when the tool returns `retryable=true`.

5. The harness will:
   - validate/sanitize the creative plan and slide HTML,
   - prepare only the generated assets declared in creative_plan.image_assets,
   - compile through the native PowerPoint substrate,
   - inspect native editability,
   - validate mechanical gates,
   - return the `.pptx` path or a clean failure.

6. A valid `.pptx` result is terminalized by the harness immediately. If `prepare_deck_build` returns `retryable=true`, repair the exact creative/html/mechanical issue and call `prepare_deck_build` one more time. A second failure is terminal; do not loop on lower-level deck tools.

## Hard Rules

- This is the authoritative fresh-deck route. When `prepare_deck_build` is exposed, do not write prompt JSON files and do not hand-write slide HTML or `slides/*.html` files. Do not call `prepare_pptx_image_manifest`, do not run `image-generation/scripts/generate.py`, do not call `build_deck_from_slides`, and do not write python-pptx/pptxgenjs or any custom deck compiler. Those are internal harness steps behind `prepare_deck_build`.
- Screenshot-backed PPTX is a failed build, not a fallback. If native deck generation fails, emit `artifact_path=null` with the returned failure code and summary.
- Normal decks may use optional generated assets declared in creative_plan.image_assets. Full-bleed pictures are allowed only as assets/backgrounds inside an otherwise native deck with native text; a picture is never itself the whole slide. Only an explicitly plain text-only/no-visual request may set `visual_policy="text_only"`.
- Generated slide images are visual-area assets only. Do not bake slide title, narrative, footers, formulas, axis labels, paragraph text, page chrome, or large readable labels into images.
- Professional and technical are quality constraints, not styles. Derive visual direction from the subject, audience, goal, viewing context, and subject materials.
- Inline SVG is unsupported. Use compiler-supported HTML/CSS/PPTX-compatible structures.
- The shared stylesheet and compact slide bodies must be opaque to all edges and may be light or dark according to the request; no image-baked title or narrative.
- Keep slide text concise. Titles and narratives are real native slide text from the submitted HTML.
- A `prepare_deck_build` terminal failure is authoritative. Do not retry manually through lower-level tools. Retry `prepare_deck_build` only once when the failure says it is retryable and asks for corrected creative/html/mechanical input.

## QA Checklist

- Exactly one `prepare_deck_build` call for a fresh deck, or two only when the first result is a retryable D2.1 repair.
- Expected slide count and `.pptx` output path under `/mnt/user-data/outputs/`.
- The builder owns design and HTML; DeckBuildService owns sanitization, execution, native validation, and mechanical gates.
- Text-only/no-visual decks are used only when explicitly requested.
- Emit promptly once the tool returns a valid `.pptx`.
