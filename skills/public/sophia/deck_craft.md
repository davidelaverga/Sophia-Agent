# Sophia Deck Craft

Fresh PPTX decks are designed, not templated.

## Required Planning Order

1. Pin subject, audience, and goal.
2. Create a subject-derived design plan: palette, type, grid, signature motif, and slide rhythm.
3. Create an image asset plan: decide which slides need generated assets and why.
4. Author native-convertible slide HTML/CSS from that plan.
5. Call `prepare_deck_build` with the creative plan and all slide HTML sources.

## Creative Plan Contract

Use canonical selectors and provide one composition for every slide. The
minimum shape is:

```json
{
  "subject": "Agent runtime reliability",
  "audience": "Platform engineers",
  "goal": "Explain the failure controls",
  "story_arc": "Failure signal to deterministic recovery",
  "design_plan": {
    "source": "creative_plan",
    "subject": "Agent runtime reliability",
    "audience": "Platform engineers",
    "goal": "Explain the failure controls",
    "style_lane": "runtime_control_plane",
    "palette": [{"name": "ink", "hex": "#101828", "role": "primary text"}],
    "typography": {"display": "Aptos Display", "body": "Aptos"},
    "grid": {},
    "signature": "control-flow rails",
    "rhythm": "alternate system views with evidence",
    "anti_slop_profile": [],
    "requested_style_terms": []
  },
  "image_strategy": "diagram_native",
  "image_assets": [],
  "slide_compositions": [{
    "selector": "slide:1",
    "slide_role": "cover",
    "headline_intent": "Frame reliability as a runtime property",
    "layout_name": "asymmetric_control_plane_cover",
    "composition_rationale": "A single strong system motif opens the story",
    "native_elements": ["headline", "system rail", "status marker"],
    "image_asset_ids": [],
    "risk_notes": []
  }],
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
- Technical architecture, process, comparison, and evidence slides usually use native HTML/SVG/CSS structures, not bitmap diagrams.

## Anti-Slop Rules

- Structural sameness is the main AI tell.
- Do not reuse the same title/image/narrative skeleton on every slide.
- No generic SaaS card grids, icon tiles, fake chrome, or repeated eyebrows unless they encode real sequence.
- No gradients, glass, neon, pure black, pure white, or system-font-only deck as defaults.
- Make the deck bolder through hierarchy, proportion, pacing, evidence, and one committed visual idea.

## HTML Rules

- Each slide HTML body is a fixed 16:9 canvas: `width: 1920px; height: 1080px`.
- Use an opaque background on the slide canvas.
- No scripts, external URLs, remote fonts, data URIs, iframes, objects, embeds, or inline event handlers.
- Use PPTX-safe layout, fills, borders, radii, gradients, tables, local planned images, and native text.
- Avoid fragile effects that disappear or compile poorly: filters, blend modes, custom webfonts, box shadows, animations, and negative letter spacing.
