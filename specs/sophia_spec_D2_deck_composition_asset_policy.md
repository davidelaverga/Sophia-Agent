# Spec D2 — Deck Composition + Asset Policy

Status: draft, implementation-ready  
Sprint stage: Deck composition/control plane  
Depends on: D1 native substrate wrapper; current P-1 `DeckBuildService`  
Gates: D3 evaluator loop; Spec 3 deck manifest enrichment; Spec 11 taste learning

---

## 0. The one decision this spec encodes

> Decks are built from story IR + design contract + per-slide asset policy. HTML is the authoring/composition surface. Generated images are optional assets inside native PowerPoint composition, not one image per slide and not whole-slide screenshots.

Default design base is:

```text
EveryInc/hands-on-deck deck craft
+ Impeccable register/vocabulary specifics
+ Hallmark anti-slop rules
+ user/project taste memory later
```

Sophia brand styling is **not** used by default in deck generation.

---

## 1. Current reality in Sophia

Current `DeckBuildService` has only deck-level `visual_policy="required"|"text_only"`. If required, it expects one visual for every slide. It writes prompt JSON with `style_profile`, then merges arbitrary `style_profile` keys into the prompt style. The current template has a fixed light background and fixed slots; it forces visual images to fill the visual region with `object-fit: cover`.

This creates three bad outcomes:

1. The model treats every slide as image-led even when native shapes/diagrams would be better.
2. Generated images become oversized or mismatched with the slide shell.
3. Old memories or prompt drift can override current style without a normalized contract.

---

## 2. Add new modules

```text
backend/packages/harness/deerflow/sophia/deck_build/story.py
backend/packages/harness/deerflow/sophia/deck_build/design_contract.py
backend/packages/harness/deerflow/sophia/deck_build/composition.py
backend/packages/harness/deerflow/sophia/deck_build/asset_policy.py
backend/packages/harness/deerflow/sophia/deck_build/html_renderer.py
skills/public/sophia/deck_design_vocabulary.md
skills/public/sophia/deck_antislop_rules.md
```

---

## 3. Change deck models

Extend `backend/packages/harness/deerflow/sophia/deck_build/models.py`.

### Add literals

```python
SlideVisualMode = Literal["native_html", "generated_asset", "hybrid", "text_only"]
AssetRole = Literal[
    "none",
    "hero_background",
    "subject_illustration",
    "texture",
    "metaphor",
    "supporting_visual",
    "screenshot",
]
LabelPolicy = Literal["native_labels_only", "no_labels"]
```

### Add dataclasses

```python
@dataclass
class DeckStory:
    audience: str
    goal: str
    thesis: str
    arc: str
    named_concepts: list[dict[str, Any]] = field(default_factory=list)

@dataclass
class DeckDesignContract:
    design_base: str = "hands_on_deck"
    register: str = "professional_technical"
    style_lane: str = "calm_technical"
    composition_language: str = "native_diagrams_with_sparse_hero_assets"
    density: str = "moderate"
    typography_lane: str = "office_safe_modern"
    palette_strategy: str = "contract_resolved_neutral"
    antislop_profile: list[str] = field(default_factory=list)
    taste_hints_used: list[str] = field(default_factory=list)
    explicit_user_style_overrides: list[str] = field(default_factory=list)

@dataclass
class DeckAssetPlan:
    visual_mode: str
    image_gen_required: bool
    asset_role: str = "none"
    aspect_ratio: str | None = None
    fit_mode: str | None = None
    label_policy: str = "native_labels_only"
    prompt_path: str | None = None
    asset_path: str | None = None
```

Extend `DeckBuild`:

```python
story: DeckStory | None
resolved_design_contract: DeckDesignContract | None
asset_policy_summary: dict[str, Any]
```

Extend `DeckSlideSpec`:

```python
claim: str | None
visual_mode: str
asset_role: str | None
asset_plan: DeckAssetPlan | None
composition_spec: dict[str, Any]
native_shape_ids: dict[str, str]
```

---

## 4. Story IR

`story.py` validates and normalizes narrative structure before visual generation or native composition.

Hard rules:

- Every deck has `audience`, `goal`, and `thesis`.
- Every slide has exactly one `claim`.
- A closing slide cannot say “these five principles” unless five named concepts exist.
- References such as “this framework,” “these principles,” or “the loop” must resolve to a named concept or prior slide claim.
- Slide titles must be specific, not generic labels like “Overview,” “Key Takeaways,” or “Conclusion” unless paired with a precise claim.

Failure is retryable before expensive asset generation.

---

## 5. Design contract

`design_contract.py` resolves style safely.

Priority order:

```text
explicit current user request
> project-specific artifact conventions
> recently accepted deck taste signals
> stable user taste memory
> register defaults
> global defaults
```

Rules:

- Current user instruction always wins over memory. If the user asks for a light background, old dark/deep/cyber preferences cannot override it.
- Unknown `style_profile` keys are dropped and traced, not merged.
- Sophia brand tokens are not used unless the user explicitly asks for “Sophia-branded” or a project convention says so.
- The contract returns a small controlled vocabulary, not arbitrary freeform style.

Replace current loose merge:

```python
style.update(deck.style_profile or {})
```

with:

```python
contract = resolve_deck_design_contract(
    register=deck.register,
    requested_style=deck.style_profile,
    current_user_request=_request_excerpt(runtime),
    project_context=project_context,
    taste_hints=taste_hints,
)
```

---

## 6. Composition grammar

`composition.py` replaces fixed one-size template behavior.

Add layout kinds:

```text
cover_statement
cover_hero_image
principle_big_number
split_claim_visual
system_diagram
process_flow_native
timeline_rhythm
comparison_matrix
evidence_with_callout
closing_synthesis
quote_or_manifesto
```

Each layout defines:

```python
LayoutSpec:
    slots: dict[str, SlotSpec]
    min_title_pt: int
    min_body_pt: int
    max_words: int
    max_visual_area_ratio: float
    allowed_visual_modes: list[str]
    safe_margin_in: float
```

The model may propose a layout, but the harness validates whether that layout is allowed for the slide role and asset plan.

---

## 7. Asset policy: when to use image generation

`asset_policy.py` chooses per slide:

```text
native_html | generated_asset | hybrid | text_only
```

Default policy:

| Slide role | Default mode | Notes |
|---|---|---|
| cover | hybrid | image gen allowed for hero/mood if imagery appetite not `none` |
| problem/context | native_html | use native shapes/copy unless subject imagery is essential |
| architecture/process/timeline | native_html | diagrams should be native shapes/SVG → native PPTX, not bitmap labels |
| comparison/evidence | native_html | native tables/charts/callouts |
| section_break | generated_asset or hybrid | optional visual mood asset |
| closing | native_html | generated metaphor only if useful and not text-heavy |

Image generation is used only when `image_gen_required=True` on the slide asset plan.

Expected visual count changes from:

```python
expected_visual_count = len(slides) if visual_policy == "required" else 0
```

to:

```python
expected_visual_count = sum(1 for slide in deck.slides if slide.asset_plan.image_gen_required)
```

---

## 8. Image-generation prompt payload changes

Prompt files written by DeckBuildService must include:

```json
{
  "prompt": "subject/mood/asset-only prompt",
  "deck_design_contract": {...compact contract...},
  "asset_plan": {
    "asset_role": "hero_background|supporting_visual|texture|metaphor",
    "fit_mode": "full_bleed|inset|crop_safe|contain_safe",
    "aspect_ratio": "16:9|4:3|1:1|3:2",
    "label_policy": "no_labels|native_labels_only"
  },
  "constraints": [
    "This is a visual asset, not a complete slide.",
    "No title, narrative, labels, axis labels, annotations, footer, page chrome, or readable text.",
    "All semantic text will be native PowerPoint text/shapes."
  ]
}
```

Do not put Sophia palette defaults here. The image script follows the deck contract.

---

## 9. Skill files added

### `deck_design_vocabulary.md`

Purpose: operationalize steering words.

Include entries for:

```text
bolder
quieter
warmer
sharper
less corporate
more visual
more executive
more technical
more premium
more narrative
less dense
```

Each entry must define:

- What to change.
- What not to do.
- Register differences.
- Deterministic checks if available.
- Soft rubric criteria.

Example:

```text
Bolder does not mean neon, glassmorphism, gradient text, or more effects. In a deck, bolder means stronger hierarchy, one unmistakable focal point, sharper claim wording, and a more decisive slide rhythm. If every element is louder, the slide is not bolder.
```

### `deck_antislop_rules.md`

Combine deck-relevant Hallmark + Impeccable anti-slop rules:

```text
no fake metrics
no fake chrome
no repeated eyebrow/kicker row
no emoji-as-icons for professional decks
no generic SaaS copy
no repeated 3-card grid
no nested cards
no text baked into generated images
no image-led slide where native structure would be clearer
no default “AI gradient” aesthetic
```

---

## 10. LangSmith traces

Add spans:

```text
deck.story.plan
deck.design_contract.resolve
deck.asset_policy.resolve
deck.slide_html.render
```

Keep `deck.image_manifest.prepare` only when one or more generated assets are selected.

Root metadata summary:

```python
{
  "deck_story_arc": story.arc,
  "deck_register": contract.register,
  "deck_style_lane": contract.style_lane,
  "generated_asset_count": expected_visual_count,
  "native_html_slide_count": n_native,
  "hybrid_slide_count": n_hybrid,
  "text_only_slide_count": n_text,
  "sophia_brand_used": False,
}
```

Trace cleanup:

- Do not log full story text or slide narratives in metadata.
- Do not log full design contract if it includes memory excerpts; log enum values and counts.
- Do not log prompt bodies; log prompt hashes.

---

## 11. Tests

Add:

```text
backend/tests/test_deck_design_contract.py
backend/tests/test_deck_asset_policy.py
backend/tests/test_deck_story_gate.py
backend/tests/test_deck_prompt_payloads.py
```

Minimum tests:

1. Explicit “light background” request suppresses dark/cyber memory hints.
2. Professional technical architecture slides default to `native_html`, not generated image.
3. Cover slide defaults to `hybrid` when imagery appetite is not `none`.
4. Closing “these five principles” fails without five named concepts.
5. Unknown `style_profile` keys are dropped and traced.
6. Prompt payload has no Sophia palette unless explicitly requested.
7. Generated-asset count equals selected asset plans, not slide count.

---

## 12. Acceptance

A D2 deck passes when:

- No default one-image-per-slide invariant remains.
- Slide modes are visible in deck build JSON and trace metadata.
- Story references are coherent before build proceeds.
- Image generation is used only for selected hero/mood/supporting assets.
- Titles, narrative, labels, and callouts are planned as native text/shapes.
