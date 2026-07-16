# Sophia Deck Quality Rubric — deck-rubric-v2

Canonical SHA-256: `19282085698ad2594ac537ccea36bf72ac3098073674689b498fa162ceb8cabe`

This file is generated from `deck_rubric.yaml`; the YAML is authoritative.

## rendered_readability

Owner: `blind_visual` · Critical: `true` · Weight: `1.0`

- 1: Required text or visual relationships cannot be read at presentation scale on multiple slides.
- 3: Required content is readable, but small type, weak contrast, or crowded grouping creates visible strain.
- 5: Every required message and relationship is immediately legible at presentation scale with comfortable hierarchy.

Failure codes: `rendered_readability_failure`

Sources: `hands-on-deck/designing-slides`, `hands-on-deck/create-judge`, `sophia/deck-craft`

## narrative_arc_and_pacing

Owner: `blind_visual` · Critical: `true` · Weight: `1.0`

- 1: Slides behave as disconnected pages or repeat one beat without a meaningful opening, development, and close.
- 3: The sequence is understandable but transitions or the close are generic and momentum is uneven.
- 5: Each page turn advances a deliberate argument whose opening, escalation, and synthesis are visually apparent.

Failure codes: `weak_narrative_arc`, `weak_closing_synthesis`

Sources: `hands-on-deck/designing-slides`, `hallmark/macrostructures`, `sophia/deck-craft`

## subject_specificity

Owner: `blind_visual` · Critical: `true` · Weight: `1.0`

- 1: The deck could accept an unrelated subject with little meaningful change to structure, motifs, diagrams, or material language.
- 3: Some subject vocabulary or motifs appear, but the main visual system remains generic and transferable.
- 5: Materials, diagram language, motifs, and sequence are inseparable from this subject and audience.

Failure codes: `weak_subject_specificity`

Sources: `hands-on-deck/designing-slides`, `hallmark/custom-craft`, `sophia/deck-craft`

## visual_hierarchy

Owner: `blind_visual` · Critical: `true` · Weight: `1.0`

- 1: Competing elements obscure what to notice first and key relationships are visually ambiguous.
- 3: The intended reading order is recoverable but emphasis is inconsistent or several slides feel flat.
- 5: Scale, placement, contrast, and grouping make the reading order and key relationship immediate on every slide.

Failure codes: `weak_visual_hierarchy`

Sources: `hands-on-deck/create-judge`, `impeccable/layout`, `hallmark/layout-and-space`

## structural_variety_and_sequence_rhythm

Owner: `blind_visual` · Critical: `true` · Weight: `1.0`

- 1: Nearly every slide repeats the same container or card-grid composition regardless of content.
- 3: A few layouts vary, but the sequence still settles into a predictable template rhythm.
- 5: Distinct compositions fit each content beat while maintaining a coherent and intentional sequence rhythm.

Failure codes: `low_sequence_rhythm`, `repetitive_structure`

Sources: `hands-on-deck/designing-slides`, `hallmark/structure`, `sophia/deck-craft`

## signature_realization

Owner: `plan_realization` · Critical: `true` · Weight: `1.0`

- 1: The promised signature is absent or survives only as generic decoration with no memorable function.
- 3: The signature appears, but inconsistently or without shaping the deck's main visual identity.
- 5: The promised signature is unmistakable, functional, and memorable across the sequence without becoming chrome.

Failure codes: `weak_signature_realization`

Sources: `sophia/deck-craft`, `hallmark/custom-craft`, `hands-on-deck/edit-judge`

## typography_and_consistency

Owner: `blind_visual` · Critical: `false` · Weight: `1.0`

- 1: Type choices, sizing, wrapping, or alignment repeatedly impede reading and feel uncontrolled.
- 3: Typography is serviceable and mostly consistent but has visible weak wraps, density, or hierarchy lapses.
- 5: Type scale, measure, wrapping, and alignment are controlled, expressive, and consistent with the content system.

Failure codes: `weak_typography`, `inconsistent_typography`

Sources: `hands-on-deck/create-judge`, `hallmark/typography`, `impeccable/polish`

## composition_and_space

Owner: `blind_visual` · Critical: `false` · Weight: `1.0`

- 1: Elements appear accidentally placed, cramped, stranded, or balanced by empty space with no compositional purpose.
- 3: Layouts are orderly but conservative, with limited tension or uneven use of the canvas.
- 5: Alignment, scale, density, and negative space create deliberate balance and spatial energy appropriate to each beat.

Failure codes: `weak_composition`, `weak_spatial_tension`

Sources: `impeccable/layout`, `hallmark/layout-and-space`, `hands-on-deck/edit-judge`

## visual_medium_choice_and_integration

Owner: `blind_visual` · Critical: `false` · Weight: `1.0`

- 1: Content that needs a diagram, comparison, or evidence view is reduced to prose or generic boxes without explanatory structure.
- 3: The chosen medium communicates the basics but is literal, weakly integrated, or misses a more revealing representation.
- 5: Diagrams, native shapes, imagery, tables, or text-led treatments are chosen per content need and integrated into one visual argument.

Failure codes: `weak_mechanism_visualization`, `mismatched_visual_medium`

Sources: `hands-on-deck/designing-slides`, `hallmark/structure`, `sophia/deck-craft`

## audience_fit

Owner: `blind_visual` · Critical: `false` · Weight: `1.0`

- 1: Density, vocabulary, evidence, or tone visibly conflicts with the stated audience and viewing context.
- 3: The deck is broadly appropriate but could be shown to many audiences with little adjustment.
- 5: Information density, examples, tone, and visual framing are clearly tuned to this audience and use setting.

Failure codes: `weak_audience_fit`

Sources: `hands-on-deck/create-judge`, `sophia/deck-craft`

## restraint_and_anti_slop

Owner: `blind_visual` · Critical: `false` · Weight: `1.0`

- 1: Repeated chrome, decorative effects, icon strips, gratuitous gradients, or dense cards overwhelm the message.
- 3: The deck is mostly restrained but retains a few generic flourishes or unnecessary containers.
- 5: Every visual device earns its place; the deck is controlled without becoming timid, sterile, or style-policed.

Failure codes: `deck_neon_cyber_default`, `decorative_slop`, `dense_card_grid`

Sources: `hallmark/anti-patterns`, `hallmark/slop-test`, `impeccable/quieter`

## memorability_and_forward_momentum

Owner: `blind_visual` · Critical: `false` · Weight: `1.0`

- 1: No slide creates a distinctive mental image and the sequence feels static or interchangeable.
- 3: One or two moments stand out, but much of the deck remains predictable and the close dissipates.
- 5: Distinct visual moments accumulate across page turns and resolve in a concise, memorable final synthesis.

Failure codes: `weak_memorability`, `weak_forward_momentum`

Sources: `hands-on-deck/designing-slides`, `impeccable/bolder`, `hallmark/macrostructures`

## explicit_user_taste_fit

Owner: `blind_visual` · Critical: `false` · Weight: `1.0`

- 1: The visible result materially contradicts explicit current-request brand, style, or format constraints.
- 3: The requested direction is recognizable but applied superficially or inconsistently.
- 5: The result visibly honors the explicit direction while adapting it intelligently to the presentation content.

Failure codes: `explicit_taste_mismatch`

Sources: `hands-on-deck/edit-judge`, `impeccable/critique`, `controller/precedence`

## composition_plan_fidelity

Owner: `plan_realization` · Critical: `false` · Weight: `1.0`

- 1: Promised per-slide fingerprints and composition rationales are absent or collapse into one repeated layout.
- 3: Several planned structures are visible, but important commitments are diluted or inconsistently realized.
- 5: The rendered sequence realizes the promised fingerprints and rationales while remaining visually coherent.

Failure codes: `composition_plan_not_realized`, `weak_fingerprint_realization`

Sources: `sophia/deck-craft`, `hands-on-deck/designing-slides`, `hands-on-deck/edit-judge`

## default_look_gravity

Owner: `blind_visual` · Critical: `false` · Weight: `1.0`

- 1: The deck falls into a generic transferable template despite content or explicit direction that calls for a distinct visual world.
- 3: Some custom choices resist the default, but most slides still rely on familiar editorial or technology-deck patterns.
- 5: The deck has a specific visual world; any minimal, dark, cream, gradient, table-led, or text-led choices are visibly requested or content-justified.

Failure codes: `default_look_gravity`

Sources: `hallmark/custom-craft`, `hallmark/anti-patterns`, `controller/precedence`
