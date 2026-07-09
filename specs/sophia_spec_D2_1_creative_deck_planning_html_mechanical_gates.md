# Spec D2.1 — Creative Deck Planning + Model-authored Slide HTML + Mechanical Gates

### Backend · Builder · Deck generation · Native PPTX · Prompt/skill cleanup

**Status:** Ready for implementation  
**Scope:** Fresh `.pptx` presentation builds through `prepare_deck_build`  
**Depends on:** D0, D1, D1.5, D1.5.1  
**Replaces:** the prior D2 deterministic-template path  
**Gates:** D3.1 Taste/Rubric Evaluator with max retries = 2, Spec 3 component manifest, Spec 4 revise, Spec 11 deck taste/co-review learning  
**Out of scope:** taste/rubric LLM evaluator, co-review UI, taste memory persistence, Hydra, arbitrary direct model access to `deck.py`/`html2patch.py`

---

## 0. The one decision this spec encodes

> **A good deck depends on model creativity in the design/composition layer and harness determinism in the execution/mechanical layer. D2.1 removes the deterministic Sophia slide renderer from production, makes the model author a subject-derived deck creative plan plus per-slide HTML/CSS inside `prepare_deck_build`, plans image generation as part of that creative plan, compiles through hands-on-deck, and blocks emission through hands-on-deck mechanical checks plus deterministic anti-slop checks.**

This spec intentionally combines the old D2.1, D2.2, and D3.0 into one checkpoint because a good deck needs all three together:

```text
creative plan
+ model-authored slide HTML
+ native compile
+ mechanical/deterministic gates
```

The taste/rubric judge comes later as D3.1. It is an optimization and repair loop. This spec builds the substrate the rubric can actually improve.

---

## 1. Why this spec exists

The latest D2 redeploy proved the native substrate works, but the output is still bad.

Observed latest D2 production run:

```text
- prepare_deck_build called once
- style_lane=technical_blueprint
- expected_visual_count=1
- visual modes: hybrid, native_html, native_html, native_html, native_html, native_html
- native_html2patch succeeded
- native_editability_score=1.0
- native_text_shape_count=29
- picture_shape_count=1
- no screenshot fallback
- deck.evaluate passed with hard_failure_count=0 and soft_warning_count=0
```

But the artifact is still poor:

```text
- sparse primitive layouts
- repeated section label/title/narrative structure
- simple boxes, lines, table, and placeholder circle
- weak narrative and visual hierarchy
- renderer-generated diagram text duplicates fragments of the narrative
- lint/fix had issues/residue, but final evaluator still passed
```

The forensics report summarizes the current problem clearly: the builder followed the D2 path, compiled through `native_html2patch`, and produced an editable deck, but the native design renderer and quality gates are not strong enough; the service accepted a deck that satisfied mechanical substrate requirements but not the user’s “dark, heavy-visual, diagram-forward technical deck” request. The same report notes a stale visual compile latch and final diagnostics dropping true image generation status. fileciteturn325file0

The rendered text extract from the latest artifact shows the practical defect: each slide is mostly a section label, title, narrative, and a primitive native object. Example: slide 2 repeats the narrative in a broken diagram phrase (“The J-lens maps internal activations to vocabulary space…”), slide 4 splits the sentence into “Before/After” table fragments, and slide 6 is just title/narrative plus placeholder structure. fileciteturn325file1

Root cause:

```text
We moved determinism into the creative layer.
```

The current D2 code resolves a style preset and renders deterministic HTML; it does not let the model design the deck.

---

## 2. Product principle

### 2.1 What the model owns

The model owns the **creative design surface**:

```text
- deck story arc
- subject-derived design plan
- image generation plan
- slide-by-slide composition plan
- slide HTML/CSS source
- revision of slide HTML when mechanical gates fail
```

### 2.2 What the harness owns

The harness owns deterministic execution and safety:

```text
- schema validation
- prompt/HTML sanitization
- local-path validation
- image generation dispatch
- native PPTX compile through hands-on-deck
- hands-on-deck inspect/lint/fix/render/diff
- screenshot-substrate rejection
- mechanical gate classification
- trace and diagnostics propagation
- bounded retry/repair control
```

### 2.3 What is explicitly not allowed

```text
- model calling deck.py directly
- model calling html2patch.py directly
- model calling build_deck_from_slides
- model writing slides/*.html files itself
- deterministic Sophia template renderer as production fallback
- screenshot-backed PPTX success
- one-image-per-slide as default
- generated images as complete slides
- style only living inside image prompts
```

---

## 3. Reference imports and what to take from each repo

## 3.1 hands-on-deck

Use hands-on-deck for two layers:

### A. Design planning discipline

Import and adapt `skills/hands-on-deck/designing-slides.md`.

Important principles to preserve:

```text
- read before writing create-path HTML
- start from subject, audience, and goal
- mine the subject’s materials, instruments, diagrams, vocabulary, era, texture
- refuse default AI deck looks
- plan palette/type/grid/signature before HTML
- one idea per slide
- projection-scale type
- fixed canvas
- deck rhythm comes from page turns and layout variation
- compile, render, and look at every slide
```

hands-on-deck explicitly says the deck should be designed for the specific subject, not merely “professional,” and that distinctiveness comes from the subject rather than external style. fileciteturn333file0L8-L21 It also requires a compact plan — palette, type, grid, signature — before any HTML is written. fileciteturn333file0L37-L64

### B. Native mechanical substrate

Continue using hands-on-deck for native PPTX mechanics:

```text
- html2patch
- deck.py patch apply
- inspect
- lint/fix
- render
- diff
```

hands-on-deck’s skill states that `deck.py` validates patch ops atomically, addresses shapes by stable ids, lints/fixes touched slides, and requires render/diff verification. fileciteturn334file0L8-L35 It also says scratch slide creation should be HTML/CSS compiled into patch ops, and that `designing-slides.md` must be read before authoring slide HTML. fileciteturn334file0L76-L85

## 3.2 Impeccable

Import concepts, not the whole runtime.

Use for:

```text
- design vocabulary
- hierarchy and layout critique language
- anti-effect discipline
- “bolder means hierarchy/proportion/evidence, not neon/glass”
- spacing/rhythm/squint test
```

Impeccable’s `bolder` guidance rejects the usual AI tricks — neon, glassmorphism, gradients — and defines “bolder” as hierarchy, pacing, proportion, evidence, and one committed visual idea. fileciteturn320file0L3-L12 Its layout guidance says layout problems often come from monotone spacing, weak hierarchy, repeated grids, poor rhythm, and density mismatch; it tells the model to fix structure, not surface. fileciteturn321file0L37-L65

## 3.3 Hallmark

Use Hallmark as a rule library for anti-slop and structural variety.

Current Sophia repo already contains Hallmark 1.1.0, matching Nutlope’s top-level skill. It says Hallmark’s differentiator is **structural variety**, not just visual variety. Two outputs should not share the same rhythm and should feel like different artifacts rather than color-swaps. fileciteturn332file0L9-L16

Nutlope upstream also confirms Hallmark’s role: it picks macrostructure, themes, runs slop-test gates and pre-emit critique, and avoids the LLM default attractors. fileciteturn327file0L15-L16 It also supports a Custom branch when no catalog theme fits, using made-to-measure palette, type, and layout. fileciteturn327file0L77-L92

Important Hallmark rules to adapt for decks:

```text
- structural sameness is the AI fingerprint
- pick a structural fingerprint; no repeated structure
- no centered-everything defaults
- no icon-tile/card-grid defaults
- no repeated eyebrows/section labels unless meaningful
- no fake chrome
- no invented metrics
- locked tokens; no mid-render improvisation
- typography purity
- pre-emit self critique: Philosophy, Hierarchy, Execution, Specificity, Restraint, Variety
```

Hallmark’s structure reference says structural sameness is the AI fingerprint and that repeated heading positions, column counts, and component vocabulary are the tell. fileciteturn329file0L3-L10 Its anti-patterns identify purple-gradient heroes, Inter-everywhere, three-column feature grids, card-in-card, gradient headlines, full-viewport centered heroes, pure black/white bases, repeated macrostructures, and repeated eyebrows as AI tells. fileciteturn331file0L11-L76 fileciteturn331file0L147-L157 Its slop test includes six-axis pre-emit critique, with anything below 3 triggering revision before handoff. fileciteturn330file0L11-L26

---

## 4. High-level new flow

Current D2 path:

```text
model supplies slide intent
→ harness resolves preset design plan
→ harness deterministic renderer writes HTML
→ html2patch/deck.py compile native PPTX
→ mechanical source evaluator passes
```

New D2.1 path:

```text
1. Builder reads deck craft context.
2. Builder creates DeckCreativePlan:
   - story arc
   - subject-derived design plan
   - image generation plan
   - slide composition plan
3. Builder creates slide HTML/CSS source for every slide.
4. Builder calls prepare_deck_build with plan + slide HTML.
5. Harness validates/sanitizes plan + HTML.
6. Harness generates only planned image assets.
7. Harness compiles HTML through hands-on-deck native substrate.
8. Harness runs mechanical/deterministic gates:
   - hands-on-deck inspect/lint/fix/render/diff
   - screenshot-substrate classifier
   - HTML/source anti-slop checks
   - basic rendered smoke checks
9. If mechanical failures are repairable, one targeted mechanical repair retry.
10. Emit native PPTX or fail honestly.
```

D3.1 later adds the LLM taste/rubric evaluator with max retries = 2.

---

## 5. Exact code changes

## 5.1 Add model-facing deck craft context

### Add file

```text
skills/public/sophia/deck_craft.md
```

### Purpose

This is the compact deck-specific planning instruction that the builder must read before creating a fresh deck.

It distills:

```text
hands-on-deck designing-slides.md
+ Sophia image generation planning
+ Hallmark anti-slop and structural variety
+ Impeccable hierarchy/layout discipline
```

Do **not** dump all upstream files into the prompt. This file should be short enough to reliably influence planning.

### Required content outline

```md
# Sophia Deck Craft

Fresh PPTX decks are designed, not templated.

## Required planning order

1. Pin subject, audience, goal.
2. Create a subject-derived design plan:
   - palette: 4–6 named tokens with roles
   - type: display/body/utility, PPTX-safe fonts
   - grid: margins, title line, note/folio policy
   - signature: one memorable motif / diagram language / texture
   - rhythm: slide-by-slide structure variation
3. Create an image generation plan:
   - decide whether the deck is hero-only, sparse-signature, image-led, diagram-native, or hybrid
   - state which slides use generated images and why
   - prefer native HTML/SVG/PPTX shapes for factual/technical diagrams
   - use image generation for atmosphere, subject texture, hero scenes, metaphors, or non-semantic visuals
4. Author slide HTML/CSS from the plan.
5. Call prepare_deck_build with the plan and the HTML sources.

## Image generation rules

- Generated images are assets, not complete slides.
- Never bake title, narrative, labels, axis text, formulas, callouts, or captions into images.
- Use native text/shapes for all semantic information.
- Hero/full-bleed images are allowed only when the slide still has native overlay text.
- Technical architecture/process/comparison slides usually use native HTML/SVG, not generated bitmap diagrams.

## Anti-slop rules

- Structural sameness is the main AI tell.
- Do not reuse the same title/image/narrative skeleton on every slide.
- No generic SaaS/card-grid/icon-tile decks.
- No repeated section-label/eyebrow row unless it encodes a real sequence.
- No fake chrome.
- No pure black/pure white base unless explicitly chosen and justified.
- No Inter/system-font-only deck unless the brief demands it.
- No gradients/glass/neon as default.
- Use hierarchy, proportion, pacing, and one committed visual idea.

## HTML rules

- Each slide HTML body is the 16:9 canvas.
- No scripts, external URLs, remote fonts, or data URIs.
- Use CSS/PPTX-safe features: layout, fills, borders, radii, gradients, tables, local images.
- Avoid unsupported features that disappear: filters, blend modes, custom webfonts, box shadows, animations.
```

### Wire this skill into builder prompt for PPTX

Change:

```text
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py
```

When target is `.pptx`, ensure the builder prompt includes either:

```text
Read /mnt/skills/public/sophia/deck_craft.md before planning a presentation.
```

or inject a bounded excerpt.

Do not require the model to read `frontend-design`. Do not route PPTX decks to the old frontend design skill.

---

## 5.2 Add model-owned creative plan schema

### Change file

```text
backend/packages/harness/deerflow/sophia/deck_build/models.py
```

### Add dataclasses / typed models

```python
DeckCreativeStrategy = Literal[
    "hero_only",
    "sparse_signature",
    "image_led",
    "diagram_native",
    "hybrid",
]

GeneratedAssetIntegration = Literal[
    "full_bleed_background",
    "inset_illustration",
    "masked_panel",
    "texture_layer",
    "subject_photo",
    "none",
]

@dataclass
class DeckImageAssetPlan:
    asset_id: str
    slide_selector: str
    role: Literal[
        "hero_background",
        "section_texture",
        "conceptual_metaphor",
        "inset_illustration",
        "subject_photo",
        "supporting_texture",
    ]
    reason: str
    prompt: str
    aspect_ratio: str
    integration: GeneratedAssetIntegration
    no_baked_text: bool = True

@dataclass
class DeckSlideCompositionPlan:
    selector: str
    slide_role: str
    headline_intent: str
    layout_name: str
    composition_rationale: str
    native_elements: list[str]
    image_asset_ids: list[str]
    risk_notes: list[str] = field(default_factory=list)

@dataclass
class DeckCreativePlan:
    subject: str
    audience: str
    goal: str
    story_arc: str
    design_plan: DeckDesignPlan
    image_strategy: DeckCreativeStrategy
    image_assets: list[DeckImageAssetPlan]
    slide_compositions: list[DeckSlideCompositionPlan]
    anti_slop_commitments: list[str]
```

### Extend `DeckSlideSpec`

```python
html_source: str | None = None
composition_plan: DeckSlideCompositionPlan | None = None
```

### Extend `DeckBuild`

```python
creative_plan: DeckCreativePlan | None = None
creative_plan_path: str | None = None
html_source_validation: dict[str, Any] = field(default_factory=dict)
mechanical_gate_results: dict[str, Any] = field(default_factory=dict)
```

---

## 5.3 Change `prepare_deck_build` schema

### Change file

```text
backend/packages/harness/deerflow/sophia/tools/prepare_deck_build.py
```

### New model-facing signature

```python
def prepare_deck_build(
    runtime: ToolRuntime,
    deck_title: str,
    slides: list[dict[str, Any]],
    output_path: str,
    register: str = "professional_technical",
    visual_policy: str = "auto",
    style_profile: dict[str, Any] | None = None,  # compatibility only
    design_plan: dict[str, Any] | None = None,    # compatibility wrapper
    creative_plan: dict[str, Any] | None = None,
) -> str:
```

Each slide may contain:

```json
{
  "title": "...",
  "narrative": "...",
  "role": "architecture",
  "layout_kind": "custom_native",
  "speaker_notes": "...",
  "html_source": "<!doctype html>...",
  "visual_prompt": null
}
```

### Required docstring update

The tool docstring must say:

```text
For fresh PPTX decks, provide:
- deck_title
- output_path
- creative_plan
- slides with title, narrative, role, layout_kind, speaker_notes, and html_source

Do not write slides/*.html yourself.
Do not call deck.py/html2patch/build_deck_from_slides.
Do not call image generation directly.
Generated images must be declared in creative_plan.image_assets.
```

### Backwards compatibility

If `creative_plan` or any `slide.html_source` is missing:

```text
return success=false
failure_code=deck_creative_plan_required or deck_slide_html_missing
retryable=true
repair_instruction.message = "Create a subject-derived DeckCreativePlan and slide HTML sources, then call prepare_deck_build once more."
```

Do **not** silently fall back to `html_design_renderer.py`.

---

## 5.4 Remove deterministic Sophia renderer from production

### Delete or quarantine files

Remove from production imports:

```text
backend/packages/harness/deerflow/sophia/deck_build/html_design_renderer.py
backend/packages/harness/deerflow/sophia/deck_build/templates.py
```

If tests still need fixture HTML, move minimal helpers under:

```text
backend/tests/fixtures/deck_html/
```

or:

```text
backend/packages/harness/deerflow/sophia/deck_build/test_fixtures.py
```

### Hard rule

No production fresh deck path may call:

```python
write_designed_slide_html(...)
write_slide_html(...)
render_designed_slide_html(...)
```

Add regression test:

```text
backend/tests/test_deck_no_template_renderer.py
```

Assertions:

```text
DeckBuildService does not import html_design_renderer.
DeckBuildService does not import deck_build.templates except maybe slide_html_virtual_path replacement.
prepare_deck_build without slide.html_source returns retryable failure, not rendered fallback.
```

### Replacement

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/html_intake.py
```

Functions:

```python
def validate_and_write_slide_html_sources(deck: DeckBuild, runtime: ToolRuntime) -> None:
    ...
```

This writes the model-provided `html_source` to:

```text
/mnt/user-data/outputs/slides/slide-01.html
...
```

The model does not write these files directly; it passes the source to the tool.

---

## 5.5 Add HTML sanitizer and source validator

### Add file

```text
backend/packages/harness/deerflow/sophia/deck_build/html_sanitizer.py
```

### Required checks

Reject hard:

```text
<script>
<iframe>
<object>
<embed>
<link rel="stylesheet" href=...>
external http/https URLs
data: URLs
inline event handlers (onclick, onload, etc.)
@import
position/fixed overlays outside slide canvas
body/html missing 16:9 canvas dimensions
missing opaque body background
content overflow beyond canvas
image references outside /mnt/user-data/outputs/assets/
references to missing planned assets
```

Warn or sanitize:

```text
box-shadow
filter
mix-blend-mode
backdrop-filter
custom webfonts
animation/keyframes
letter-spacing-dependent layouts
```

For text:

```text
title/narrative must exist as native-convertible text nodes.
No title/narrative only in image.
No duplicate same sentence repeated in h1 + p + diagram nodes.
```

### Add dataclass

```python
@dataclass
class SlideHTMLValidationResult:
    selector: str
    passed: bool
    hard_failures: list[str]
    warnings: list[str]
    sanitized_html: str | None
    source_hash: str
```

### Behavior

If a slide has hard failures:

```text
DeckBuildFailure(
  code="deck_slide_html_invalid",
  summary="Slide 3 HTML contains external URL / script / missing background / ...",
  retryable=True
)
```

If warnings only, write sanitized HTML and store warnings in `slide.gate_results`.

---

## 5.6 Add creative plan validator

### Add file

```text
backend/packages/harness/deerflow/sophia/deck_build/creative_plan.py
```

### Public functions

```python
def parse_creative_plan(raw: dict[str, Any] | None, *, deck_title: str, slides: list[DeckSlideSpec]) -> DeckCreativePlan:
    ...

def validate_creative_plan(plan: DeckCreativePlan, slides: list[DeckSlideSpec]) -> list[DeckQualityIssue]:
    ...

def write_creative_plan(plan: DeckCreativePlan, host_path: Path) -> None:
    ...
```

### Required validation

Hard fail if:

```text
creative_plan missing
subject/audience/goal missing
design_plan missing palette/type/grid/signature/rhythm
no slide_composition for a slide
image_assets reference unknown slide selectors
slide HTML references an undeclared/generated asset
a generated image prompt asks for labels/title/narrative/axis/formula/readable text
design_plan defaults to Sophia brand unless explicitly requested
design_plan uses all slides same layout family
```

Soft warning:

```text
all slides use same structure
signature is generic
palette is generic but not invalid
image_strategy contradicts request
```

Do not use taste memories here yet. Spec 11 owns durable taste memory.

---

## 5.7 Add image generation planning inside creative plan

### Replace harness-only `asset_policy.py`

Current `asset_policy.py` chooses image use by rigid role rules. Replace production use with:

```text
creative_plan.image_assets
```

Keep `asset_policy.py` only as a validation helper or delete it if no longer needed.

### New function

```python
def resolve_image_assets_from_creative_plan(deck: DeckBuild) -> None:
    ...
```

Behavior:

```text
for each DeckImageAssetPlan:
  create prompt JSON
  assign output path
  attach to corresponding slide
  set image_gen_required=True for that slide
```

Slides with no image assets:

```text
visual_status = "not_required"
```

### Prompt payload

Generated prompt payload must include:

```json
{
  "asset_id": "...",
  "slide_selector": "slide:1",
  "role": "hero_background",
  "prompt": "...",
  "style": {
    "derived_from_design_plan": true,
    "palette_roles": [...],
    "mood": "...",
    "integration": "full_bleed_background"
  },
  "constraints": [
    "This is a visual asset inside a native PPTX slide, not a complete slide.",
    "No title, narrative, labels, axis text, formulas, callouts, captions, annotations, footers, or page chrome.",
    "All semantic text will be native PPTX text/shapes."
  ],
  "technical": {
    "aspect_ratio": "...",
    "deck_asset": true,
    "slide_visual": false
  }
}
```

### When to prefer image generation

The prompt/skill context must teach the model:

Use image generation when the slide needs:

```text
- full-bleed hero or cover atmosphere
- subject texture or material world
- conceptual metaphor
- photographic/non-semantic scene
- background/texture layer that PPTX cannot natively express
```

Prefer HTML/native composition when the slide needs:

```text
- architecture diagrams
- process flows
- timelines
- comparison matrices
- evidence/data structures
- safety/technical causal maps
- any slide where labels/arrows/claims carry semantic meaning
```

---

## 5.8 Service flow changes

### Change file

```text
backend/packages/harness/deerflow/sophia/deck_build/service.py
```

### New order

```python
self._validate_inputs(...)
deck.slides = self._build_slide_specs(...)
self._parse_validate_creative_plan(deck, creative_plan)
self._validate_and_write_slide_html_sources(deck, runtime)
self._resolve_image_assets_from_creative_plan(deck)
if deck.expected_visual_count > 0:
    self._write_prompt_files(deck, runtime)
    self._prepare_manifest(deck, runtime)
    self._run_visual_batch(...)
    self._verify_visuals(...)
else:
    image_generation_status = "not_required"
self._compile_pptx(deck, runtime)
self._run_mechanical_gates(deck, runtime)
self._assert_deck_success_allowed(deck, runtime)
```

Remove:

```python
self._resolve_design_and_asset_policy(...)
resolve_deck_design_plan(...)
resolve_asset_policies(...)
resolve_compositions(...)
write_designed_slide_html(...)
```

No deterministic fallback.

### Input failure policy

If missing creative plan or slide HTML:

```text
success=false
failure_code=deck_creative_plan_required | deck_slide_html_missing
retryable=true
repair_instruction present
```

The builder may retry once, not loop.

### Ensure stale visual latch is fixed

When `expected_visual_count` is computed from creative plan image assets:

```text
expected_visual_count = len(creative_plan.image_assets)
```

This must propagate everywhere:

```text
deck.expected_visual_count
terminal diagnostics
gateway builder events
builder artifact diagnostics
LangSmith trace metadata
```

The latest D2 forensics noted a stale generated-visual compile latch still expected six images after D2 selected only one. This spec must close that by removing any slide-count-based visual expectation for D2.1 decks. fileciteturn325file0

---

## 5.9 Mechanical gates

### Add file

```text
backend/packages/harness/deerflow/sophia/deck_build/mechanical_gates.py
```

### Public function

```python
def evaluate_deck_mechanics(
    *,
    deck: DeckBuild,
    native_report: dict[str, Any],
    rendered_slide_paths: list[str],
    slide_html_results: list[SlideHTMLValidationResult],
) -> DeckMechanicalEvaluation:
    ...
```

### Dataclass

```python
@dataclass
class DeckMechanicalEvaluation:
    passed: bool
    hard_failures: list[DeckQualityIssue]
    soft_warnings: list[DeckQualityIssue]
    repairable: bool
    repair_instruction: str | None
```

### Gate categories

#### A. hands-on-deck mechanical hard gates

Use `DeckNativeService` outputs:

```text
html2patch success
patch apply success
native inspect success
native editability score >= 0.60
native text shape count > 0
no screenshot-only substrate
render success
diff success or warning if unavailable
```

#### B. lint/fix residue gates

Do not silently pass residue.

Use hands-on-deck `lint_fix` results:

Hard fail:

```text
text overflow residue
covered_by residue
off-slide text
unreadable/clipped display text
rendered slide count mismatch
```

Soft warning / repairable:

```text
misaligned near-miss
intentional off-slide picture/bleed
minor geometry residue
```

If `residue_count > 0`, classify each residue kind. Unknown residue is hard until explicitly downgraded.

#### C. deterministic source anti-slop gates

Hard fail:

```text
old renderer artifacts:
  "Generated asset, not slide text"
  repeated mechanical section-label format on every slide
  narrative-chunk-generated nodes/tables
  placeholder closing circle without content
  same title/narrative/diagram sentence repeated

script/external:
  script/iframe/external URL/data URI

screenshot substrate:
  one full-slide picture per slide with no native text
```

Soft warning / D3.1 rubric input:

```text
same layout family > 3 slides in a row
same composition fingerprint on every content slide
all slides have section-label/title/narrative with no real native visual system
```

#### D. deterministic rendered smoke checks

No LLM judge yet. Use cheap image metrics:

```text
- rendered slide count matches deck slide count
- content slides not blank / too sparse
- text and background contrast rough check
- if design plan/request says dark, slide background should not be majority light unless slide explicitly says light contrast moment
- if image asset is inset/contain, image bounding region not > 70% of slide unless full_bleed_background
```

These are smoke checks, not final taste judgment.

### Retry policy

If mechanical gates fail due to:

```text
invalid HTML source
html2patch compile failure
overflow/residue
missing local image
```

return retryable failure with a precise repair instruction. Allow one repair retry at D2.1.

Do not build max-2 taste loop here. D3.1 owns max-2 rubric repairs.

---

## 5.10 Remove old deterministic compiler/renderer fallback

The user explicitly wants bad fallback paths removed. This spec must remove them from production, not merely hide them behind flags.

### Delete production route to:

```text
html_design_renderer.py
templates.py
build_deck_from_slides
_compile_screenshot_debug_pptx
HTML_SCREENSHOT_DEBUG_COMPILE_MODE as fresh deck success
```

If `build_deck_from_slides.py` remains in repo for historical tests, fresh PPTX path must have no reference to it.

### Tests must assert:

```text
fresh prepare_deck_build cannot return deck_compile_mode=html_screenshot_debug
fresh prepare_deck_build cannot call build_deck_from_slides
fresh prepare_deck_build without model-authored HTML fails retryably
```

---

# 6. Prompt and skill changes — required in same PR

Prompt cleanup is part of this spec, not a final cleanup pass. Later D4 may do residual cleanup, but D2.1 must align the model-facing contract immediately.

## 6.1 `skills/public/sophia/deck_craft.md`

Add as above.

## 6.2 `skills/public/sophia/visual_composition.md`

Replace presentation section with:

```md
## Presentation Invariants

- Fresh `.pptx` presentations are native DeckBuildService decks built from a model-authored DeckCreativePlan and model-authored slide HTML/CSS sources passed to `prepare_deck_build`.
- The builder does not write slide files directly. It passes HTML sources to `prepare_deck_build`; the harness validates, sanitizes, writes, compiles, inspects, renders, and emits.
- Before building, read `skills/public/sophia/deck_craft.md`.
- Do not assume every slide needs a generated image. Generated images are planned in `creative_plan.image_assets`.
- Prefer native HTML/SVG/PPTX shapes for semantic technical diagrams, timelines, comparisons, evidence, labels, and arrows.
- Use image generation for hero backgrounds, atmosphere, subject texture, conceptual metaphors, and non-semantic assets.
- Generated images are assets, not complete slides. No titles, narratives, labels, axes, formulas, captions, annotations, or page chrome inside images.
- No screenshot-backed PPTX, no deterministic template fallback, no `build_deck_from_slides`.
- All semantic text remains native slide text/shapes.
```

Remove:

```text
“harness-rendered template”
“visual_prompt is normal/required”
“DeckBuildService decides all composition”
```

## 6.3 `skills/public/sophia/builder_obligations.md`

Change Presentation Rules:

```md
- Fresh presentations are built through `prepare_deck_build`.
- Before planning, read `deck_craft.md`.
- Provide:
  - `creative_plan`
  - each slide's title, narrative, role, layout_kind, speaker_notes
  - each slide's `html_source`
- Do not write `slides/*.html` yourself.
- Do not call lower-level deck tools.
- Do not call image generation directly.
- `visual_prompt` is not the primary deck design surface; image prompts live in `creative_plan.image_assets`.
- If `prepare_deck_build` returns retryable failure because plan/html is invalid, repair the exact field and retry once.
```

Remove/replace:

```text
Titles/narratives remain real slide text in the harness-rendered template.
```

with:

```text
Titles/narratives must appear as native-convertible text in the model-authored slide HTML.
```

## 6.4 `skills/public/ppt-generation/SKILL.md`

Rewrite fresh deck section.

Required content:

```md
# Fresh Sophia PPTX decks

Fresh decks use `prepare_deck_build`.

You must provide:
1. DeckCreativePlan
2. image generation plan inside `creative_plan.image_assets`
3. slide-by-slide HTML/CSS sources

Do not call deck.py/html2patch directly.
Do not write files directly.
Do not call build_deck_from_slides.
Do not use deterministic templates.
```

Add:

```md
## Design flow

1. Read `deck_craft.md`.
2. Create subject-derived design plan.
3. Decide image generation strategy.
4. Write slide HTML.
5. Call prepare_deck_build.

## HTML source rules

- body is 16:9 fixed canvas
- no script, iframe, external URLs, remote fonts
- local image refs only for planned generated assets
- use native text for semantic content
- use CSS that survives html2patch
```

Remove:

```text
visual_prompt required for normal decks
harness-rendered template
legacy emergency route
build_deck_from_slides route
```

The legacy emergency route must be deleted, not merely marked debug-only.

## 6.5 `skills/public/image-generation/SKILL.md`

Update deck section:

```md
For decks, image generation is never the deck itself. It creates optional assets declared in `creative_plan.image_assets`.
DeckBuildService calls this script internally after validating the image plan.
Do not call this script directly for deck builds.
Do not create one image per slide unless the creative plan explicitly justifies an image-led deck.
Prefer native HTML/SVG/PPTX shapes for technical diagrams, labels, comparisons, evidence, and process flows.
```

Remove any instruction that says:

```text
choose one visual style for the whole deck and use it in every slide prompt
prompt supplies exact structure of technical diagrams
```

or qualify it:

```text
only for optional generated assets, not for semantic diagram construction.
```

## 6.6 `skills/public/sophia/brand/tokens.md`

Add/keep:

```md
## Deck usage

These tokens are not injected into default fresh PPTX deck generation.
Fresh decks use subject-derived DeckCreativePlan tokens.
Use Sophia brand tokens only when the user explicitly asks for Sophia-branded styling.
```

## 6.7 `skills/public/frontend-design/SKILL.md`

Do not use for decks.

Add prompt test that fresh PPTX prompt does not include `frontend-design` as deck source.

## 6.8 `builder_task.py`

Change PPTX task briefing.

Must say:

```text
Read deck_craft.md.
Call prepare_deck_build with creative_plan and slide html_source.
Do not call lower-level tools.
visual_prompt is not required per slide.
image generation is planned in creative_plan.image_assets.
```

Must not say:

```text
one generated visual per slide
harness-rendered template
write slides/*.html
call build_deck_from_slides
```

## 6.9 `builder_artifact.py`

Change PPTX correction/nudge messages.

Current/old correction paths must not tell the builder:

```text
write HTML files
call build_deck_from_slides
use ppt-generation/scripts/generate.py
one visual per slide
```

New correction:

```text
This is a fresh PPTX deck. Use prepare_deck_build only.
Your next prepare_deck_build call must include:
- creative_plan
- slide html_source for every slide
- image_assets only when needed
If a previous prepare_deck_build result was retryable, repair the exact field and call it once more.
```

---

# 7. Current repo changes to make by file

## Add

```text
skills/public/sophia/deck_craft.md

backend/packages/harness/deerflow/sophia/deck_build/creative_plan.py
backend/packages/harness/deerflow/sophia/deck_build/html_intake.py
backend/packages/harness/deerflow/sophia/deck_build/html_sanitizer.py
backend/packages/harness/deerflow/sophia/deck_build/mechanical_gates.py
backend/packages/harness/deerflow/sophia/deck_build/deck_craft_context.py
backend/packages/harness/deerflow/sophia/deck_build/image_assets.py

backend/tests/test_deck_creative_plan.py
backend/tests/test_deck_html_intake.py
backend/tests/test_deck_html_sanitizer.py
backend/tests/test_deck_image_assets.py
backend/tests/test_deck_mechanical_gates.py
backend/tests/test_deck_no_template_renderer.py
backend/tests/test_deck_prompt_contract.py
backend/tests/test_deck_build_service_model_html_path.py
```

## Change

```text
backend/packages/harness/deerflow/sophia/deck_build/models.py
backend/packages/harness/deerflow/sophia/deck_build/service.py
backend/packages/harness/deerflow/sophia/deck_build/evaluator.py
backend/packages/harness/deerflow/sophia/deck_native/service.py
backend/packages/harness/deerflow/sophia/tools/prepare_deck_build.py
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py
backend/packages/harness/deerflow/agents/sophia_agent/builder_tools.py if tool schema help text lives there

skills/public/sophia/visual_composition.md
skills/public/sophia/builder_obligations.md
skills/public/ppt-generation/SKILL.md
skills/public/image-generation/SKILL.md
skills/public/sophia/brand/tokens.md
```

## Remove from production path

```text
backend/packages/harness/deerflow/sophia/deck_build/html_design_renderer.py
backend/packages/harness/deerflow/sophia/deck_build/templates.py
backend/packages/harness/deerflow/sophia/tools/build_deck_from_slides.py from fresh deck tool/path reachability
DeckBuildService._compile_screenshot_debug_pptx
DeckBuildService._resolve_design_and_asset_policy
DeckBuildService._render_slide_html as deterministic renderer
asset_policy role-only decisioning as production source
```

If physically deleting `build_deck_from_slides.py` is risky for historical tests, leave the file but add a test proving fresh deck path cannot import/call it.

---

# 8. Mechanical traces

Add spans:

```text
deck.creative_plan.validate
deck.slide_html.validate
deck.image_assets.resolve
deck.image_assets.prompt_files.write
deck.mechanical.evaluate
deck.mechanical.residue_classify
deck.mechanical.render_smoke
```

Keep:

```text
deck.native.html2patch
deck.native.patch_apply
deck.native.inspect
deck.native.lint_fix
deck.native.render
deck.native.diff
deck.native.substrate_classify
deck.emit.decision
```

Do not log full HTML, full image prompts, full user text, or artifact bodies. Log:

```text
hashes
counts
selectors
failure codes
style lane
image strategy
asset roles
residue kinds
rendered slide count
mechanical verdict
```

---

# 9. Tests

## 9.1 Unit tests

### `test_deck_creative_plan.py`

Cases:

```text
valid creative plan parses
missing creative_plan fails retryably
image asset references unknown slide selector fails
all slides same layout emits warning/hard depending threshold
Sophia brand default is not used unless explicit
image prompt with labels/title fails
```

### `test_deck_html_sanitizer.py`

Cases:

```text
script tag fails
iframe fails
external URL fails
data URI fails
missing opaque background fails
body not 16:9 fails
local planned asset image allowed
unplanned local image fails
box-shadow warning
semantic title and narrative must exist
```

### `test_deck_image_assets.py`

Cases:

```text
hero asset creates prompt file
native technical slide with no asset skips image generation
expected_visual_count equals len(image_assets)
one-image-per-slide is not implied
image prompt payload says deck_asset true and slide_visual false
```

### `test_deck_no_template_renderer.py`

Cases:

```text
DeckBuildService does not call write_designed_slide_html
prepare_deck_build without html_source returns retryable failure
fresh deck path does not call build_deck_from_slides
```

### `test_deck_mechanical_gates.py`

Cases:

```text
lint residue overflow hard fails
covered_by hard fails
misaligned is warning unless severe
screenshot-only substrate fails
native editable deck passes
old renderer artifacts fail
```

## 9.2 Integration tests

### `test_deck_build_service_model_html_path.py`

Build a 2-slide deck with model-authored HTML:

```text
creative_plan provided
slide html_source provided
no image assets
expected_visual_count=0
image_generation_status=not_required
native_html2patch succeeds
native_text_shape_count > 0
deck_compile_mode=native_html2patch
```

Build a 3-slide hybrid deck:

```text
creative_plan.image_assets has one hero
only one image prompt file written
asset referenced by slide 1 HTML
native compile succeeds
```

## 9.3 Prompt contract tests

Assertions:

```text
fresh PPTX prompt includes deck_craft.md
fresh PPTX prompt requires creative_plan and html_source
fresh PPTX prompt says visual_prompt optional / image_assets planned
fresh PPTX prompt does not mention build_deck_from_slides
fresh PPTX prompt does not mention deterministic template fallback
fresh PPTX prompt does not use frontend-design
fresh PPTX prompt says no Sophia brand default
```

---

# 10. Acceptance gates

## Engineering acceptance

A fresh `.pptx` build:

```text
- cannot succeed without creative_plan
- cannot succeed without slide html_source for every slide
- cannot call or import the deterministic template renderer
- cannot call build_deck_from_slides
- can succeed with zero image assets
- can succeed with selected planned image assets
- compiles through native_html2patch
- preserves native editability
- runs hands-on-deck mechanical checks
- fails on overflow/covered_by/text residue
- records mechanical gate results in build.json and LangSmith
```

## Product acceptance

Run the latest failing prompt class:

```text
"Build a 6-slide dark, diagram-forward technical presentation about Anthropic/J-space/global workspace research."
```

Expected:

```text
- model supplies a subject-derived creative plan
- image strategy explains where image gen is used and where native diagrams are better
- slide HTML is not generated by a fixed skeleton
- slides vary in composition
- no repeated section-label/title/narrative/primitive-box structure
- semantic diagrams are real native text/shapes, not narrative chunks
- deck remains editable/native
- no screenshot fallback
```

The deck does not have to be perfect yet; D3.1 rubric will judge taste. But it must no longer look like the deterministic renderer.

---

# 11. Rollback policy

Allowed rollback:

```text
- fail more often while model learns schema
- reduce image assets to zero while debugging
- temporarily simplify accepted HTML subset
```

Forbidden rollback:

```text
- re-enable screenshot-backed PPTX success
- re-enable deterministic template renderer fallback
- call build_deck_from_slides for fresh decks
- require one image per slide
- silently generate missing slide HTML in harness
- inject Sophia brand as default deck style
```

---

# 12. Sequencing after this spec

After this spec lands and the product smoke test confirms that deterministic template artifacts are gone:

```text
D3.1 — Taste/rubric evaluator with max_retries=2
  - LLM judge over rendered slides
  - hands-on-deck + Hallmark + Impeccable criteria
  - slide-scoped repair briefs
  - max two repair attempts

Spec 3 — Component manifest + addressing model
Spec 4 — BuildService.revise
Spec 11 — Deck taste memory + co-review learning
```

Do not build Spec 11 before decks are worth learning from.
