# Sophia Deck Craft

Fresh PPTX decks are designed, not templated.

## Required Planning Order

1. Pin subject, audience, and goal.
2. Create a subject-derived design plan: palette, type, grid, signature motif, and slide rhythm.
3. Create an image asset plan: decide which slides need generated assets and why.
4. Author native-convertible slide HTML/CSS from that plan.
5. Call `prepare_deck_build` with the creative plan and all slide HTML sources.

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
