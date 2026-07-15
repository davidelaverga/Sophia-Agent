# Sophia Deck Craft

Fresh PPTX decks are designed, not templated.

## Required Planning Order

1. Apply the injected hands-on-deck, deck-impeccable, and deck-hallmark guidance; full references are optional.
2. Pin subject, audience, goal, and viewing context.
3. Name subject-specific materials, diagrams, metaphors, vocabulary, and texture.
4. Choose palette, typography, grid, signature, and slide rhythm.
5. Decide image strategy and exact non-semantic image roles.
6. Critique the plan on deck-hallmark's six axes.
7. Revise the weakest point and record final scores.
8. Author one shared compiler-supported deck stylesheet plus compact slide HTML bodies with semantic source IDs.
9. Call `prepare_deck_build` with the creative plan, shared stylesheet, and all slide bodies.

## Creative Plan Contract

Use canonical selectors and provide one composition for every slide. The
minimum shape is:

```json
{
  "subject": "Agent runtime reliability",
  "audience": "Platform engineers",
  "goal": "Explain the failure controls",
  "viewing_context": "Projected in a platform architecture review",
  "subject_materials": ["control-flow rails", "runtime signals", "circuit-breaker states"],
  "story_arc": "Failure signal to deterministic recovery",
  "design_plan": {
    "source": "creative_plan",
    "subject": "Agent runtime reliability",
    "audience": "Platform engineers",
    "goal": "Explain the failure controls",
    "style_lane": "runtime_control_plane",
    "palette": [
      {"name": "night", "hex": "#101828", "role": "slide substrate"},
      {"name": "signal", "hex": "#38BDF8", "role": "runtime paths"},
      {"name": "paper", "hex": "#F8FAFC", "role": "primary text"},
      {"name": "warning", "hex": "#F59E0B", "role": "failure states"}
    ],
    "typography": {"display": "Cambria", "body": "Calibri"},
    "grid": {},
    "signature": "control-flow rails",
    "rhythm": "alternate system views with evidence",
    "anti_slop_profile": [],
    "requested_style_terms": []
  },
  "image_strategy": "diagram_native",
  "image_strategy_rationale": "Exact runtime relationships must remain editable and labeled natively",
  "image_assets": [],
  "slide_compositions": [{
    "selector": "slide:1",
    "slide_role": "cover",
    "headline_intent": "Frame reliability as a runtime property",
    "layout_name": "asymmetric_control_plane_cover",
    "composition_rationale": "A single strong system motif opens the story",
    "native_elements": ["headline", "system rail", "status marker"],
    "image_asset_ids": [],
    "required_element_ids": ["cover-headline", "control-rail"],
    "structural_fingerprint": "left headline crossed by one horizontal control rail",
    "risk_notes": []
  }],
  "skill_refs": ["hands-on-deck/designing-slides", "deck-hallmark/slop-test"],
  "plan_critique": {
    "initial_scores": {"philosophy": 4, "hierarchy": 4, "execution_feasibility": 3, "specificity": 4, "restraint": 4, "variety": 3},
    "weakest_point": "The first plan repeated the control rail too literally",
    "revision_made": "Reserved the rail for transitions and varied the evidence compositions",
    "final_scores": {"philosophy": 4, "hierarchy": 4, "execution_feasibility": 4, "specificity": 4, "restraint": 4, "variety": 4}
  },
  "anti_slop_commitments": ["Vary composition by narrative role"]
}
```

The compatibility aliases `slide`, `role`, and `layout` map only to
`selector`, `slide_role`, and `layout_name`. They do not replace
`headline_intent` or `composition_rationale`.

## Image Rules

- Generated images are assets, not complete slides.
- Never bake titles, narrative, labels, formulas, axis text, captions, or callouts into images.
- Use native HTML/PPTX text and shapes for semantic information.
- Hero or full-bleed images are allowed only as assets inside slides that still contain native text.
- Technical architecture, process, comparison, and evidence slides use native HTML/CSS/PPTX-compatible structures, not bitmap diagrams.
- Inline SVG is unsupported by the current native compiler and must not be used.

## Anti-Slop Rules

- Structural sameness is the main AI tell.
- Do not reuse the same title/image/narrative skeleton on every slide.
- No generic SaaS card grids, icon tiles, fake chrome, or repeated eyebrows unless they encode real sequence.
- No gradients, glass, neon, pure black, pure white, or system-font-only deck as defaults.
- Make the deck bolder through hierarchy, proportion, pacing, evidence, and one committed visual idea.

## Compact HTML Rules

- New calls use `authoring_contract="compact_model_html_v2"`: shared CSS <= 8 KiB, each `html_body` <= 4 KiB, each `slide_css` <= 1 KiB, creative-plan JSON <= 12 KiB, and complete serialized arguments <= 48 KiB.
- Put shared CSS in `deck_stylesheet`; use `slide_css` only for real slide-specific variation.
- Reuse shared classes and emit no explanatory prose around the `prepare_deck_build` call.
- Each `html_body` is markup inside the service-owned 1920x1080 document shell. Do not include html, head, body, or style tags.
- Style the `main` canvas with an opaque background in the shared stylesheet.
- Keep non-bleed geometry inside the 1920x1080 canvas. Absolutely positioned descendants inside a positioned parent use parent-local `left`/`top`; never repeat the parent's slide-global offset on a nested child.
- PPTX typography is Office-safe only: use Cambria for headings and Calibri or Arial for body and utility text. Never use Aptos, Georgia, remote fonts, or custom webfonts; renderer substitution changes metrics and can break layout.
- Give every large headline and metric an explicit width and height with enough room for its intended line count. Do not rely on browser-tight auto-sized text geometry because PowerPoint and LibreOffice reflow independently.
- No scripts, external URLs, remote fonts, data URIs, iframes, objects, embeds, or inline event handlers.
- Use PPTX-safe layout, fills, borders, radii, gradients, tables, local planned images, and native text.
- Avoid fragile effects that disappear or compile poorly: filters, blend modes, custom webfonts, box shadows, animations, and negative letter spacing.
- Every required headline, body group, diagram node, connector, table, evidence panel, image container, and closing synthesis object needs a unique `data-deck-id`, `data-deck-role`, and `data-deck-required="true"`.
