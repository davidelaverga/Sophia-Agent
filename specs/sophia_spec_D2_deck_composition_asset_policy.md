# Spec D2 — Deck Design Plan, Composition Grammar, and Asset Policy

### Backend · Builder · Native PPTX deck composition · Prompt/skill cleanup

**Status:** Ready for implementation
**Scope:** Fresh `.pptx` presentation builds through `prepare_deck_build`
**Depends on:** D0, D1, D1.5, D1.5.1
**Gates:** D3 Deck Evaluation Loop + Rubric Judge, Spec 3 component manifest, Spec 11 deck taste/co-review learning
**Out of scope:** full rendered rubric judge, co-review UI, taste memory persistence, Hydra/project layer, arbitrary model-authored PPTX mechanics

---

## 0. The one decision this spec encodes

> **Fresh Sophia decks must stop using the fixed placeholder slide template as the design engine. DeckBuildService must resolve a deck-level design plan, choose per-slide composition and asset policy, render style-aware HTML/CSS slide sources, and compile them through the hands-on-deck native PPTX substrate. Generated images become optional assets inside native composition, not one required visual per slide.**

D1/D1.5/D1.5.1 moved the deck substrate from screenshot-only success toward native PPTX success. D2 moves the design path from:

```text
Deck IR
→ fixed light template
→ generated image panel per slide
→ native_html2patch
```

to:

```text
Deck IR
→ DeckDesignPlan
→ DeckCompositionSpec per slide
→ DeckAssetPlan per slide
→ designed slide HTML/CSS
→ hands-on-deck html2patch/deck.py native compile
```

The model may propose direction; the harness owns normalization, composition constraints, asset policy, and compilation.

---

## 1. Problem statement

The latest production run proves the native substrate is working but the design route is still not.

Observed successful artifact:

```text
deck_compile_mode = native_html2patch
native_editability_score = 1.0
native_text_shape_count = 12
picture_shape_count = 6
full_slide_picture_count = 1
deck.evaluate passed with zero hard failures and zero soft warnings
```

But the delivered deck is visually poor:

```text
- requested dark, restrained, technical/monospace style
- slide 1 dark and coherent
- slides 2–6 mostly light/default canvas
- every slide has two text shapes plus one picture
- almost no native visual system: no rules, labels, counters, motifs, dividers, hierarchy, or slide-specific treatment
- several visuals are cropped by object-fit: cover
```

Root cause:

```text
style_profile affects image prompt payloads,
but not the slide substrate.
```

The current `templates.py` hard-codes:

```text
#f7f9fc background
#1f2a37 text
Helvetica/Arial
title block + visual block + narrative block
object-fit: cover
```

That turns dark technical requests into dark images pasted inside a light generic shell.

---

## 2. Current code reality

## 2.1 Current slide renderer is the bug

File:

```text
backend/packages/harness/deerflow/sophia/deck_build/templates.py
```

Current behavior:

```python
html, body background = #f7f9fc
.slide background = #f7f9fc
color = #1f2a37
font-family = Helvetica Neue, Arial
.title absolute at top
.visual absolute in middle
.visual img width/height 100%, object-fit: cover
.narrative absolute at bottom
```

This file must no longer be the default creative source of fresh deck slides.

## 2.2 Current service writes style only to image prompts

File:

```text
backend/packages/harness/deerflow/sophia/deck_build/service.py
```

Current `_write_prompt_files` shape:

```python
style = {
  "register": deck.register,
  "visual_style": "clean_flat_vector",
  "aesthetic": "restrained_professional_technical",
}
style.update(deck.style_profile or {})
payload = {
  "prompt": slide.visual_prompt,
  "style": style,
  "composition": _composition_for_layout(slide.layout_kind),
  "constraints": [...],
  "technical": {"aspect_ratio": "16:9", "quality": "high", "slide_visual": True},
}
```

This is not enough. `style_profile` must become a normalized `DeckDesignPlan` that controls slide substrate, typography, palette, grid, composition, image-fit, and motif.

## 2.3 Current IR validation assumes one visual prompt per normal slide

Current validation:

```python
if visual_policy == "required":
    if not visual_prompt:
        raise invalid_deck_ir
```

This must change. In D2, normal decks do **not** require one generated visual per slide.

## 2.4 Current prompt files are partly cleaned but still too old

Current prompt/skill surfaces already say `prepare_deck_build` owns native compilation and lower-level deck tools are forbidden. Keep that.

But they still imply too much of the old P-1 model:

```text
- "visual_prompt" is listed as a required slide intent field for normal decks.
- image-generation deck references still discuss "Deck visuals" more than "optional assets".
- ppt-generation still says visual_prompt is required for normal decks.
- no skill file yet describes DeckDesignPlan / subject-derived design plan / asset modes.
```

---

## 3. Design principles imported from hands-on-deck

D2 imports the **deck-making discipline**, not only the CLI substrate.

### 3.1 HTML is the design/measuring surface, not the final artifact

hands-on-deck’s `html2patch.py` compiles slide HTML into a `deck.py` patch. Chromium is only a measuring engine; `deck.py` is the single PPTX writer. This lets agents design in HTML/CSS while the result remains native, inspectable, lintable, fixable, renderable, and diffable.

D2 keeps that model.

### 3.2 Start from the subject, not from external style

Deck design should derive from:

```text
subject
audience
goal
materials / metaphors / diagrams / vocabulary of the subject
```

not from a generic “professional light template” or a hardcoded Sophia brand.

### 3.3 Plan tokens before writing HTML

Every deck needs a compact design plan before slide HTML is rendered:

```text
palette
type
grid
signature/motif
rhythm
```

These become real harness objects, not free-form prose.

### 3.4 A slide is not a webpage

D2 renderer rules:

```text
one idea per slide
projection-scale type
fixed 16:9 canvas
rhythm through slide sequence
copy as design material
```

### 3.5 The model gets bounded creative authorship

The builder/model may propose:

```text
deck story
design plan hints
style lane
slide role/layout
visual prompt where useful
```

The harness owns:

```text
validation
normalization
safe fonts/colors
asset mode
composition constraints
native compilation
diagnostics
failure policy
```

---

## 4. New architecture

## 4.1 New high-level flow

Replace current P-1 flow:

```text
validate IR
→ write prompt file for every slide
→ generate one visual per slide
→ write fixed slide HTML
→ native compile
```

with D2 flow:

```text
validate deck intent
→ resolve DeckDesignPlan
→ resolve DeckAssetPolicy
→ resolve DeckCompositionSpec per slide
→ write prompt files only for image_gen_required slides
→ generate selected assets only
→ render designed slide HTML
→ native compile through DeckNativeService
→ D1.5.1 substrate gate
→ emit or fail
```

D3 later adds full rendered/rubric quality gates. D2 adds only minimal smoke checks proving design plan application.

---

# 5. Data model changes

## 5.1 Change `backend/packages/harness/deerflow/sophia/deck_build/models.py`

### Add enum-like literals

```python
DeckVisualMode = Literal[
    "native_html",
    "generated_asset",
    "hybrid",
    "text_only",
]

DeckAssetRole = Literal[
    "none",
    "hero_background",
    "section_texture",
    "inset_illustration",
    "subject_photo",
    "conceptual_metaphor",
    "supporting_texture",
]

DeckImageFit = Literal[
    "none",
    "contain",
    "cover",
    "crop_safe_cover",
    "full_bleed",
]

DeckStyleLane = Literal[
    "subject_derived",
    "calm_technical",
    "executive_editorial",
    "technical_blueprint",
    "warm_founder",
    "analytical_minimal",
    "expressive_keynote",
]
```

### Add dataclasses

```python
@dataclass
class DeckColorToken:
    name: str
    hex: str
    role: str  # background, surface, ink, muted, accent, support

@dataclass
class DeckTypographyPlan:
    display: str
    body: str
    utility: str | None = None
    display_weight: int | None = None
    body_weight: int | None = None

@dataclass
class DeckGridPlan:
    slide_width_px: int = 1280
    slide_height_px: int = 720
    margin_x_px: int = 72
    margin_y_px: int = 54
    title_y_px: int = 54
    footer_policy: str = "none"
    eyebrow_policy: str = "only_when_meaningful"

@dataclass
class DeckDesignPlan:
    source: Literal["model", "derived", "fallback"]
    subject: str
    audience: str | None
    goal: str | None
    style_lane: str
    palette: list[DeckColorToken]
    typography: DeckTypographyPlan
    grid: DeckGridPlan
    signature: str
    rhythm: list[str]
    anti_slop_profile: list[str]
    requested_style_terms: list[str]
    normalized_from_style_profile: dict[str, Any] = field(default_factory=dict)

@dataclass
class DeckAssetPlan:
    visual_mode: DeckVisualMode
    image_gen_required: bool
    asset_role: DeckAssetRole = "none"
    fit: DeckImageFit = "none"
    aspect_ratio: str | None = None
    allow_full_bleed: bool = False
    prompt: str | None = None
    reason: str | None = None

@dataclass
class DeckCompositionSpec:
    layout_family: str
    title_slot: dict[str, Any]
    narrative_slot: dict[str, Any]
    visual_slot: dict[str, Any] | None
    support_slots: list[dict[str, Any]] = field(default_factory=list)
    max_words: int | None = None
    min_title_px: int = 36
    min_body_px: int = 18
```

### Extend `DeckSlideSpec`

Add:

```python
asset_plan: DeckAssetPlan | None = None
composition: DeckCompositionSpec | None = None
```

Optionally add:

```python
claim: str | None = None
```

Do not require model to supply `claim` yet; derive from title/narrative when absent.

### Extend `DeckBuild`

Add:

```python
design_plan: DeckDesignPlan | None = None
design_plan_path: str | None = None
asset_policy_path: str | None = None
style_warnings: list[str] = field(default_factory=list)
```

Keep old fields for compatibility:

```python
register
visual_policy
style_profile
```

but D2 changes how they are interpreted.

---

# 6. New modules to add

## 6.1 `design_plan.py`

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/design_plan.py
```

Responsibilities:

```text
- normalize model/user style input
- derive a DeckDesignPlan when none is supplied
- prevent Sophia brand default injection
- enforce safe fonts/color values
- identify dark/light/technical/editorial style intent
```

Public functions:

```python
def resolve_deck_design_plan(
    *,
    deck_title: str,
    slides: list[DeckSlideSpec],
    register: str,
    style_profile: dict[str, Any] | None,
    design_plan: dict[str, Any] | None,
    user_request: str | None,
) -> DeckDesignPlan:
    ...

def write_design_plan(plan: DeckDesignPlan, host_path: Path) -> None:
    ...
```

Rules:

```text
current explicit request > supplied design_plan > style_profile > register default
```

No user taste memory yet. Spec 11 owns taste memory.

### Style defaults

If no style is supplied:

```text
style_lane = subject_derived
background = choose light or dark based on subject/register, not Sophia palette
typography = Georgia/Arial/Courier New or safe equivalents
palette = 4–6 subject-derived neutral/accent tokens
```

Do not use `skills/public/sophia/brand/tokens.md` unless the user explicitly requests Sophia-branded styling. D2 default must be vendor-neutral.

### Dark-mode rule

If current request/style_profile implies:

```text
dark
charcoal
near-black
monospace
technical
blueprint
terminal
```

then `DeckDesignPlan.palette` must set:

```text
background/surface dark
ink light
muted light-gray/blue-gray
accent sparing
```

The slide substrate must be dark, not only the generated images.

---

## 6.2 `asset_policy.py`

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/asset_policy.py
```

Responsibilities:

```text
- decide per slide whether image generation is needed
- map slide role/layout/design plan to visual_mode
- compute expected_visual_count
- validate visual_prompt only when an image is required
```

Public functions:

```python
def resolve_slide_asset_plan(
    *,
    slide: DeckSlideSpec,
    deck_index: int,
    slide_count: int,
    design_plan: DeckDesignPlan,
    visual_policy: str,
    user_request: str | None,
) -> DeckAssetPlan:
    ...

def expected_generated_asset_count(slides: list[DeckSlideSpec]) -> int:
    ...
```

### Required policy

```text
cover:
  hybrid or generated_asset when visual_prompt is provided or imagery_appetite != none
  native_html if no image prompt and no image-led request

architecture / process / timeline / comparison / evidence:
  native_html by default
  generated_asset only if the prompt describes subject/mood/texture, not labels/diagram text

section_break:
  generated_asset or hybrid allowed

closing:
  native_html by default
  generated_asset only for explicit metaphor/image-led close

text_only:
  only when user explicitly asks no visuals/plain/text-only
```

### Required validation change

Do **not** reject normal slides for missing `visual_prompt`.

Reject only when:

```text
asset_plan.image_gen_required == True
and asset_plan.prompt is empty
```

Even then, prefer deterministic downgrading to `native_html` unless the current user request explicitly requires generated imagery.

### Expected visual count

Replace:

```python
expected_visual_count = len(slides) if visual_policy == "required" else 0
```

with:

```python
expected_visual_count = expected_generated_asset_count(slides)
```

---

## 6.3 `composition.py`

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/composition.py
```

Responsibilities:

```text
- choose layout family per slide
- define deterministic slots and safe margins
- keep sequence rhythm
```

Public functions:

```python
def resolve_slide_composition(
    *,
    slide: DeckSlideSpec,
    deck_index: int,
    slide_count: int,
    design_plan: DeckDesignPlan,
    asset_plan: DeckAssetPlan,
) -> DeckCompositionSpec:
    ...
```

### Layout families

Implement at least:

```text
cover_statement
cover_hero_image
principle_big_number
split_claim_visual
system_diagram
process_flow
comparison_matrix
evidence_callout
closing_synthesis
```

Map existing legacy `layout_kind` values:

```text
cover_hero → cover_hero_image or cover_statement
single_visual_focus → split_claim_visual or system_diagram
visual_left_text_right → split_claim_visual
text_left_visual_right → split_claim_visual
comparison_two_column → comparison_matrix
timeline_flow → process_flow
closing_summary → closing_synthesis
```

### Composition rules

```text
- no single title/image/narrative skeleton for every slide
- all slides share grid tokens from DeckDesignPlan
- layout varies by slide role
- body text min 18px equivalent
- title min 40px equivalent except dense utility slides
- images are contain/crop-safe unless role is hero_background/full_bleed
- support elements are native CSS/PPTX shapes: rules, counters, labels, dividers, motif marks
```

---

## 6.4 `html_design_renderer.py`

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/html_design_renderer.py
```

Responsibilities:

```text
- render style-aware 1280x720 slide HTML/CSS for html2patch
- use the design plan and composition spec
- produce native-convertible DOM structure
- keep all semantic text in native text elements
```

Public functions:

```python
def render_designed_slide_html(
    *,
    deck: DeckBuild,
    slide: DeckSlideSpec,
    design_plan: DeckDesignPlan,
) -> str:
    ...

def write_designed_slide_html(slide: DeckSlideSpec, deck: DeckBuild, host_path: Path) -> None:
    ...
```

### Replace current renderer

Current call:

```python
write_slide_html(slide, deck, host)
```

must become:

```python
write_designed_slide_html(slide, deck, host)
```

### HTML requirements

hands-on-deck `html2patch` expects:

```text
body = slide canvas
1280px × 720px for 16:9
text in h1-h6, p, ul/ol, table, etc.
divs with background/border become native shapes
img becomes native picture
linear gradients, borders, radii, tables, object-fit survive
```

Renderer must output:

```html
<body class="deck-slide ...">
  <main class="slide-root">
    ...
  </main>
</body>
```

with:

```css
html, body {
  margin: 0;
  width: 1280px;
  height: 720px;
  background: var(--deck-bg);
}
```

### Do not use unsupported/fragile CSS

Avoid:

```text
box-shadow
filters
blend modes
animations
custom webfonts
text gradients
letter-spacing-dependent layout
```

### Native text rules

All semantic text must be in actual text tags:

```text
h1/h2/p/ul/table/figcaption
```

No title/narrative/axis/label text in generated images.

### Visual placement rules

```text
native_html:
  render CSS/SVG/HTML diagram or native shapes; no generated image required

generated_asset:
  use <img> with asset fit and crop policy; add native text/callouts separately

hybrid:
  use generated image as background/texture/hero, with native title/narrative/callouts over it

text_only:
  no image tag
```

### Visual fit rules

Default for technical diagrams:

```text
object-fit: contain
```

Use `cover` only for:

```text
hero_background
section_texture
subject_photo
supporting_texture
```

Never use `cover` for architecture/process/comparison diagrams unless explicitly full-bleed and crop-safe.

---

## 6.5 `image_prompting.py`

Add or refactor existing prompt-writing code into:

```text
backend/packages/harness/deerflow/sophia/deck_build/image_prompting.py
```

Responsibilities:

```text
- create image prompt payloads only for slides whose asset_plan.image_gen_required is true
- convert DeckDesignPlan into image style constraints
- keep prompt as asset-only
```

Public function:

```python
def build_deck_asset_prompt_payload(
    *,
    deck: DeckBuild,
    slide: DeckSlideSpec,
    design_plan: DeckDesignPlan,
) -> dict[str, Any]:
    ...
```

Required payload constraints:

```text
This is a visual asset inside a native PowerPoint slide, not a full slide.
No title.
No narrative paragraph.
No footer.
No page chrome.
No ordinary labels, axis labels, formulas, captions, annotations, or readable diagram text.
All semantic text will be added as native PowerPoint text/shapes.
Follow the deck design plan palette and mood; do not introduce a separate visual language.
```

Image aspect ratio must come from `asset_plan.aspect_ratio`, not hardcoded `16:9` for every asset.

---

## 6.6 Optional helper: `hands_on_deck_design.py`

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/hands_on_deck_design.py
```

Purpose:

```text
- centralize constant excerpts/rules derived from vendored hands-on-deck designing-slides.md
- do NOT dump the entire file into the model prompt
- expose small structured rules for design plan validation
```

Examples:

```python
SAFE_PPTX_FONTS = ["Arial", "Helvetica", "Georgia", "Palatino", "Verdana", "Trebuchet MS", "Courier New", "Impact"]
FORBIDDEN_DEFAULT_LOOKS = ["generic blue header bar", "neon black three-card grid", "cream terracotta default"]
```

---

# 7. Service changes

## 7.1 Change `prepare_deck_build.py`

Current signature:

```python
def prepare_deck_build(..., style_profile: dict[str, Any] | None = None)
```

Change to:

```python
def prepare_deck_build(
    runtime: ToolRuntime,
    deck_title: str,
    slides: list[dict[str, Any]],
    output_path: str,
    register: str = "professional_technical",
    visual_policy: str = "auto",
    style_profile: dict[str, Any] | None = None,
    design_plan: dict[str, Any] | None = None,
) -> str:
```

Backcompat:

```text
visual_policy="required" maps to "auto_with_images_allowed"
visual_policy="text_only" remains explicit no-image
visual_policy="auto" is default
```

Docstring must say:

```text
visual_prompt is optional and should be supplied only when a generated asset is useful.
Design plan is optional; if omitted, DeckBuildService derives one.
```

## 7.2 Change `DeckBuildService.prepare_and_build`

Add step order:

```python
deck = self._create_deck(...)
slides = self._build_slide_specs(...)
deck.design_plan = resolve_deck_design_plan(...)
self._resolve_asset_and_composition(deck, runtime)
self._write_prompt_files(deck, runtime)  # only generated assets
self._prepare_manifest(deck, runtime)    # only generated assets
self._run_image_batch_if_needed(deck, runtime)
self._verify_visuals(deck, runtime)
self._render_slide_html(deck, runtime)   # designed renderer
self._compile_pptx(deck, runtime)
self._evaluate(deck, runtime)
```

If `expected_visual_count == 0`, skip image manifest/batch entirely and set:

```text
image_generation_status = "not_required"
primary_image_batch_status = "not_required"
```

Do not mark image generation failed when no images were required.

## 7.3 Change `_build_slide_specs`

Current visual prompt validation must change.

Remove:

```python
if visual_policy == "required":
    if not visual_prompt:
        raise invalid_deck_ir
```

New behavior:

```text
- title required <= 90 chars
- narrative required <= 280 chars
- visual_prompt optional
- run image-baked text/unrequested style validation only if visual_prompt exists
- if visual_prompt is invalid but salvageable, sanitize it or downgrade slide to native_html
- only return invalid_deck_ir when semantic intent is impossible to preserve safely
```

If `visual_prompt` requests baked labels, strip the labels and store:

```text
slide.gate_results["visual_prompt_sanitized"] = true
```

or create `style_warnings`.

Do not make this model-mediated if deterministic rewrite is easy.

## 7.4 Change `_write_prompt_files`

Only iterate slides with:

```python
slide.asset_plan.image_gen_required
```

Write prompt files to:

```text
/mnt/user-data/outputs/deck_build/prompts/
```

or keep current prompt path if existing tests expect it, but these files are internal support artifacts.

Update prompt payload fields:

```json
{
  "prompt": "...",
  "style": {
    "style_lane": "...",
    "palette": [...],
    "mood": "...",
    "asset_role": "..."
  },
  "composition": {
    "asset_role": "...",
    "fit": "contain|cover|full_bleed",
    "used_as": "background|inset|texture|hero"
  },
  "constraints": [
    "This is not a complete slide.",
    "No readable text or labels.",
    "All semantic text is native PPTX text."
  ],
  "technical": {
    "aspect_ratio": "...",
    "quality": "high",
    "slide_visual": false,
    "deck_asset": true
  }
}
```

Do **not** call everything `slide_visual=True`.

## 7.5 Change `_prepare_manifest`

Current manifest likely assumes one prompt file per slide.

Change:

```python
prompt_files = [slide.visual_prompt_path for slide in deck.slides if slide.asset_plan.image_gen_required]
```

If no prompt files:

```text
skip manifest creation
deck.status = "asset_generation_not_required"
```

## 7.6 Change `_verify_visuals`

Required assets are only those with `image_gen_required=True`.

For slides with `native_html` or `text_only`:

```text
visual_status = "not_required"
missing visual does not fail
```

For `generated_asset` / `hybrid`:

```text
missing visual fails unless deterministic downgrade to native_html is allowed by policy
```

## 7.7 Change `_render_slide_html`

Replace:

```python
write_slide_html(slide, deck, host)
```

with:

```python
write_designed_slide_html(slide, deck, host)
```

Trace:

```text
deck.html_design.render
```

Inputs metadata only:

```json
{
  "slide_count": 6,
  "design_plan_source": "model|derived|fallback",
  "style_lane": "technical_blueprint",
  "asset_modes": {"native_html": 3, "hybrid": 2, "generated_asset": 1}
}
```

Do not log full HTML body.

## 7.8 Change `_composition_for_layout`

Remove or stop using it for image prompts as the main layout driver.

If kept, it should be compatibility-only and call into `composition.py`.

## 7.9 Change evaluator minimally

D3 owns full evaluation. D2 should add only smoke checks to prevent the exact regression:

```text
- design_plan exists
- each slide has asset_plan and composition
- style_lane applied to HTML tokens
- if style request is dark, generated HTML for non-cover slides includes dark background token
- no slide uses old fixed template class names only
```

Do **not** build full taste judge here.

---

# 8. Remove / quarantine

## 8.1 Quarantine `templates.py`

Do not delete immediately if tests import it, but remove it from production fresh-deck path.

Options:

```text
Option A:
  rename to legacy_templates.py
  update imports/tests

Option B:
  keep templates.py but mark debug-only and add test that DeckBuildService does not call write_slide_html in production path

Preferred:
  rename to legacy_templates.py after D2 tests are updated
```

Required:

```text
No fresh deck through prepare_deck_build may call render_slide_html/write_slide_html from old templates.py.
```

## 8.2 Remove hardcoded old-template CSS from production path

Delete from production renderer:

```text
#f7f9fc hardcoded background
#1f2a37 hardcoded text as universal default
Helvetica/Arial universal-only typography
object-fit: cover as universal image policy
title/visual/narrative skeleton as universal layout
```

These may exist in a fallback `fallback_minimal` style pack only for tests, but not as the default for all decks.

## 8.3 Do not remove hands-on-deck

D2 assumes D1/D1.5 vendor/wrapper remains. Do not replace `DeckNativeService`.

---

# 9. Prompt and skill instruction changes

## 9.1 `skills/public/sophia/visual_composition.md`

### Change Presentation Invariants

Current lines say generated slide images are visual-area assets and DeckBuildService owns assets/native compilation, which is good. Add/replace with:

```md
- Fresh presentations are native DeckBuildService decks built from a deck design plan plus per-slide composition. The builder supplies slide intent; the harness derives or normalizes the design plan and compiles native PPTX.
- Do not assume every slide needs a generated image. Generated images are optional assets selected by DeckBuildService.
- Visual prompts are optional and should be supplied only when an image asset is genuinely useful: hero, texture, metaphor, subject image, or atmospheric support.
- Technical/process/architecture/comparison/evidence slides should default to native HTML/SVG/PPTX shapes unless the brief explicitly needs generated imagery.
- Deck style must follow the current user request and subject. Do not default to Sophia brand colors or a generic light template.
- All semantic text remains native slide text/shapes. Generated images never contain titles, narratives, labels, axes, formulas, or annotations.
```

Remove/avoid:

```text
visual_prompt required
one image per slide
fixed template
Sophia brand default
```

## 9.2 `skills/public/sophia/builder_obligations.md`

### Change Presentation Rules

Current lines 36–38 say provide slide intent including `visual_prompt`. Change to:

```md
- Fresh presentations are built through `prepare_deck_build`. Provide complete
  slide intent: title, narrative, role, layout_kind, optional visual_prompt,
  and speaker_notes. Keep every narrative concise and <= 280 characters.
```

Add:

```md
- Do not add a visual_prompt just to satisfy a slot. Use visual_prompt only for
  generated assets that should exist as pictures: hero backgrounds, subject
  textures, conceptual illustrations, section art, or atmospheric support.
- Architecture, process, comparison, evidence, timeline, and closing slides
  usually rely on native slide composition: HTML/SVG/PPTX shapes and real text.
- The harness owns the deck design plan, asset policy, native HTML rendering,
  native PowerPoint compilation, inspection, validation, and terminal failure.
- If the user asks for a dark/technical/editorial/other style, preserve that
  style as deck-level intent. Do not put style only into image prompts.
```

Change lines 47–50 equivalent:

```md
- Normal decks may use generated visual-only assets as DeckBuildService decides.
  Generated images are optional assets, not one required image per slide.
```

## 9.3 `skills/public/ppt-generation/SKILL.md`

### Change "Building A Deck"

Current step 1 says `visual_prompt: required for normal decks`. Replace with:

```md
- visual_prompt: optional; use only when the slide needs a generated image asset
  such as a hero background, conceptual metaphor, subject texture, or
  atmospheric illustration. Leave empty for native HTML/SVG/PPTX-shaped diagrams,
  process flows, timelines, comparisons, evidence slides, and most closings.
```

Add:

```md
- Optional design_plan: when supplied by the tool schema, include a compact plan:
  subject, audience, goal, palette roles, typography roles, grid, signature motif,
  and rhythm. The plan should be derived from the subject, not Sophia branding.
```

Change hard rules:

```md
- Generated images are optional. Do not assume one image per slide.
- DeckBuildService decides the asset policy and may build many slides as native
  HTML/SVG/PPTX shapes with no generated image.
- Do not use Sophia brand palette by default. Use subject-derived design unless
  the user explicitly asks for Sophia branding.
```

## 9.4 `skills/public/image-generation/SKILL.md`

Current deck section is already mostly correct. Add/adjust:

```md
- For decks, this script creates optional assets requested by DeckBuildService.
  It does not create a complete slide and it is not called once per slide by default.
- The asset role may be hero_background, subject_texture, inset_illustration,
  conceptual_metaphor, or supporting_texture. Respect the role and aspect ratio.
- Do not invent a separate palette or style. Match the DeckDesignPlan payload.
- Never include labels, axis text, formulas, annotations, callouts, captions,
  title text, or narrative text inside the image.
```

Remove/avoid any text implying:

```text
choose one visual_style for the whole deck and use it in every slide prompt
every deck slide visual has a generated image
image prompt supplies the exact structure of technical diagrams
```

If the reference library remains, mark it as:

```text
Only for optional generated assets; not the deck composition source.
```

## 9.5 `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py`

Find PPTX briefing text.

Replace any version of:

```text
visual_prompt required
one visual per slide
generated visual for each slide
```

with:

```text
For PPTX decks, call prepare_deck_build with slide intent and, optionally, a compact design_plan if the tool schema exposes it.
Every slide needs title, narrative, role, and layout_kind.
visual_prompt is optional; include it only when a generated image asset is useful.
Do not decide image count. DeckBuildService owns asset policy.
Do not call lower-level deck tools.
Do not hand-author slides/*.html for fresh decks.
```

## 9.6 `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py`

Find correction strings that discuss visual design/PPTX.

Ensure fresh deck corrections say:

```text
Use prepare_deck_build.
Repair Deck IR once if retryable.
Do not hand-write slides/*.html.
Do not call build_deck_from_slides.
Do not call image-generation directly.
visual_prompt is optional and asset-specific.
```

Do **not** direct the builder to read `visual-design` or `frontend-design` as the deck design source. DeckBuildService/Hallmark/hands-on-deck rules are harness-side.

## 9.7 `skills/public/sophia/brand/tokens.md`

Do not delete.

Add if not present:

```md
## Deck usage

These tokens are not injected into default fresh PPTX deck generation.
Use them for decks only when the user explicitly asks for Sophia-branded styling.
Default deck design is subject-derived via DeckDesignPlan.
```

## 9.8 `skills/public/frontend-design/SKILL.md`

No direct edit required if it is excluded from deck routing.

Add a test or prompt contract assertion:

```text
Fresh PPTX prompts must not include frontend-design as the deck design source.
```

---

# 10. Image generation changes

## 10.1 Change `skills/public/image-generation/scripts/generate.py` only if needed

D2 does not require major image script rewrites if prompt payloads are fixed in DeckBuildService.

But if constants still inject Sophia deck palette or "slide visual" assumptions, change them:

```text
_SOPHIA_SLIDE_STYLE → _DECK_ASSET_STYLE_BASE
_SOPHIA_SLIDE_ZONE_CONTRACT → _DECK_ASSET_CONTRACT
```

Remove hardcoded Sophia colors from deck asset prompt assembly.

## 10.2 Aspect ratio

Stop hardcoding all deck images as:

```text
16:9 slide_visual
```

Aspect ratio comes from `DeckAssetPlan`:

```text
hero_background/full_bleed: 16:9
inset_illustration: 4:3 or 1:1
subject_texture: 16:9 or 4:3
conceptual_metaphor: 4:3 or 1:1
```

`_run_image_single_subprocess` currently passes:

```python
"--aspect-ratio", "16:9", "--slide-visual"
```

Change it to:

```python
"--aspect-ratio", slide.asset_plan.aspect_ratio or "16:9"
```

and only pass `--slide-visual` if the image-generation script still uses it to apply asset-only deck constraints. Prefer a new flag later:

```text
--deck-asset
```

but do not block D2 on CLI flag churn.

---

# 11. Tests to add/update

## 11.1 Unit tests

Add:

```text
backend/tests/test_deck_design_plan.py
backend/tests/test_deck_asset_policy.py
backend/tests/test_deck_composition.py
backend/tests/test_deck_html_design_renderer.py
backend/tests/test_deck_prompt_contract.py
```

### `test_deck_design_plan.py`

Cases:

```text
dark technical style_profile → dark background, light ink, utility/mono font role
no style_profile → subject_derived plan, no Sophia brand palette
invalid colors/fonts → normalized to safe values
design_plan supplied → normalized and preserved
explicit current request overrides style_profile
```

### `test_deck_asset_policy.py`

Cases:

```text
cover with visual_prompt → hybrid, image_gen_required=True
architecture with no prompt → native_html, image_gen_required=False
process/timeline/comparison/evidence → native_html by default
closing with no prompt → native_html
explicit text_only request → text_only, expected_visual_count=0
normal 6-slide technical deck → expected_visual_count < slide_count
```

### `test_deck_composition.py`

Cases:

```text
legacy layout_kind maps to richer layout family
slide sequence does not all use same layout family
technical diagram slide uses contain/crop-safe visual policy
cover can use full_bleed
```

### `test_deck_html_design_renderer.py`

Cases:

```text
dark design plan produces dark html/body/slide-root background
light design plan produces light background
semantic title/narrative are in h/p text elements
generated image is absent for native_html slides
generated image uses contain for technical diagrams
no universal object-fit: cover
HTML body size is 1280x720
CSS avoids unsupported features
```

### `test_deck_prompt_contract.py`

Assertions:

```text
builder prompt says visual_prompt optional
builder prompt does not say one image per slide
ppt-generation skill says generated images optional
visual_composition says subject-derived design plan
frontend-design absent from fresh PPTX routing prompt
Sophia brand tokens not default deck path
```

## 11.2 Integration tests

Update:

```text
backend/tests/test_deck_build_service_native_route.py
```

Add cases:

```text
6-slide dark technical deck with only cover visual_prompt:
  expected_visual_count <= 2
  native compile succeeds
  native_text_shape_count > 0
  design_plan_path exists
  build.json records design_plan.style_lane
  slides 2–6 HTML contain dark substrate tokens
  deck_compile_mode=native_html2patch

6-slide architecture deck with no visual_prompt:
  image generation skipped/not_required
  native compile still succeeds
  no invalid_deck_ir for missing visual_prompt
```

## 11.3 Optional smoke visual test

Render the designed slide HTML to PNG before native compile or render the final deck after native compile.

For dark request:

```text
content slides should not be majority light because of hardcoded template
```

Keep this as D2 smoke only. D3 owns robust rendered evaluator.

---

# 12. Traces

Add spans:

```text
deck.design_plan.resolve
deck.asset_policy.resolve
deck.composition.resolve
deck.image_prompt.write
deck.html_design.render
```

## 12.1 `deck.design_plan.resolve`

Inputs:

```json
{
  "register": "professional_technical",
  "style_profile_keys": ["background", "typography", "aesthetic"],
  "design_plan_supplied": true,
  "slide_count": 6
}
```

Outputs:

```json
{
  "source": "model|derived|fallback",
  "style_lane": "technical_blueprint",
  "palette_count": 5,
  "typography_display": "Georgia",
  "typography_body": "Arial",
  "background_is_dark": true,
  "warnings": []
}
```

Do not log full request text.

## 12.2 `deck.asset_policy.resolve`

Outputs:

```json
{
  "slide_count": 6,
  "expected_visual_count": 2,
  "modes": {
    "native_html": 4,
    "hybrid": 1,
    "generated_asset": 1,
    "text_only": 0
  }
}
```

## 12.3 `deck.html_design.render`

Outputs:

```json
{
  "slide_count": 6,
  "style_lane": "technical_blueprint",
  "layout_families": ["cover_hero_image", "system_diagram", "..."],
  "html_files_written": 6
}
```

No full HTML bodies in traces.

---

# 13. Acceptance gates

## 13.1 Engineering

- Fresh `.pptx` uses `prepare_deck_build` and native compile.
- Old fixed `templates.py` is not called in the production fresh-deck path.
- A deck can succeed without generated images when the asset policy resolves slides to `native_html`.
- A normal six-slide technical deck does not automatically request six generated images.
- `design_plan_path` and `asset_policy_path` are written under `outputs/deck_build/`.
- Dark style request produces dark substrate tokens in slide HTML for non-cover slides.
- Native compile still produces editable text/shapes.
- All new tests in §11 pass.

## 13.2 Product

Run the latest failing prompt class again:

```text
"Build a 6-slide technical presentation on leadership principles / agentic harnesses with a dark restrained technical style."
```

Expected:

```text
- slides 2–6 are not generic light shell
- deck has visible native design system beyond images
- layouts vary across the deck
- generated images, if used, are not cropped diagrams
- native text is editable
- no screenshot fallback
```

The deck does not need to be perfect yet. D3 handles rendered quality/rubric rejection. D2 passes if the hardcoded template failure class is gone.

## 13.3 UX

No new UI required.

The artifact preview should still render as before. The important user-visible change is that the deck should look intentionally designed, not like a placeholder template.

## 13.4 Observability

LangSmith / local traces should show:

```text
deck.design_plan.resolve
deck.asset_policy.resolve
deck.composition.resolve
deck.html_design.render
deck.native.html2patch
deck.native.patch_apply
deck.native.inspect
deck.native.render
deck.emit.decision
```

---

# 14. Rollback policy

Allowed rollback:

```text
disable individual style lanes
fallback to a conservative derived design plan
reduce image generation usage to zero while debugging
```

Forbidden rollback:

```text
return to screenshot-backed deck success
return to fixed light template as default
require one generated image per slide
inject Sophia brand palette as default
treat missing visual_prompt as invalid for every normal slide
call lower-level deck tools from the model-facing route
```

---

# 15. Sequencing

Implement D2 after D1.5.1.

Then:

```text
D3 — deterministic rendered gates + rubric judge
D4 — remaining prompt cleanup if drift remains
Spec 11 — taste memory + co-review learning
Spec 3/4/6 — component manifest, revise, co-review
```

D2 is successful when Sophia has a native, style-aware deck composition path. D3 is responsible for judging whether the rendered result is good enough.
