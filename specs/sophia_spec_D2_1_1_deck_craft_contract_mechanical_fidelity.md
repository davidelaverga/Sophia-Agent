# Spec D2.1.1 — Deck Craft Contract, Callable Design Skills, Compiler Alignment, and Mechanical Fidelity

> **Repository validation status (2026-07-10): Valid with amendments.** The
> supplied specification is preserved below for durable reference. Its
> implementation must follow
> [`sophia_spec_D2_1_1_validation_and_implementation_plan.md`](sophia_spec_D2_1_1_validation_and_implementation_plan.md),
> which resolves verified conflicts with the current code and pinned upstream
> repositories. In particular, do not expose raw web/CLI skills to the deck
> builder, do not inherit hands-on-deck's 1280x720 canvas guidance, and do not
> implement the union-string tool signature proposed in section 9.
>
> **Runtime remediation amendment (2026-07-11):** Model ownership remains
> authoritative, but the transport is now compact model-authored HTML. The
> model supplies one shared `deck_stylesheet` plus each slide's `html_body`
> and optional `slide_css`; DeckBuildService assembles only the content-free
> 1920x1080 document shell before applying the existing sanitizer, native
> compiler, source-retention, contrast, and mechanical gates. This is not the
> forbidden deterministic template renderer. Transitional full `html_source`
> intake remains internal and is omitted from the model-facing schema.
>
> **Imported source SHA-256:**
> `efa4b260f30b4260e42c666ffe98d66a2c0f88ffdcca16b2fcb1c649867cd9eb`

### Backend · Builder · Skills · Native PPTX · Prompt contracts

**Status:** Ready for coding-agent implementation
**Scope:** Fresh `.pptx` builds through `prepare_deck_build`
**Branch baseline:** `codex/sophia-observability-v1`, after D2.1 model-authored HTML rollout
**Production evidence baseline:** 2026-07-10 deploy at `82c68f2cc6eb00af4c0c038b43debe2e059f2356`
**Depends on:** D0, D1, D1.5, D1.5.1, D2.1
**Gates:** D3.1 rendered taste evaluator, component manifest/revise, Spec 11 taste/co-review learning
**Out of scope:** LLM taste scoring, two-pass taste repair, persistent taste memory, Coreview UI, Hydra

---

## 0. The one decision this spec encodes

> **The model owns deck design; the harness owns truthful execution. Every design skill and prompt must describe only authoring features that the native compiler can preserve, and every semantically required slide element must be proven present in the native PPTX before success.**

D2.1 moved Sophia to model-authored `DeckCreativePlan` plus model-authored slide HTML. The remaining defect is contract misalignment:

```text
skill says SVG is appropriate
→ sanitizer accepts SVG
→ browser HTML shows SVG
→ html2patch drops SVG primitives
→ mechanical gate sees enough pixels/text and passes
→ user receives a broken deck
```

D2.1.1 eliminates that class of failure and makes the full presentation-design skill set genuinely available to the builder.

The production contract after this spec is:

```text
MODEL
  plans story, design, imagery, composition, and HTML

HARNESS
  validates the plan against compiler capabilities
  compiles through hands-on-deck
  proves source-to-native retention
  blocks mechanical defects
  preserves the real failure cause

JUDGE
  not implemented here; D3.1 owns taste acceptance and creative repair
```

---

## 1. Production evidence and current code reality

### 1.1 Latest artifact failure

The latest successful native deck was editable but visually and functionally defective:

- slides 4 and 6 lost primary diagrams;
- inline SVG `<circle>`, `<line>`, and `<path>` geometry disappeared;
- SVG `<text>` survived as ordinary text with black color on a dark background;
- the final deck passed despite missing diagrams and unreadable labels;
- the finalizer also misreported native diagram content as `visuals_not_embedded`.

The successful run used current code, not a stale deployment.

### 1.2 Current `creative_plan.py` permits nominal design compliance

Current defaults include:

```python
style_lane = "custom_subject_derived"
typography = Aptos Display / Aptos
signature = "subject-derived visual system"
rhythm = "varied slide structures with one idea per slide"
anti_slop_commitments = []
```

Those defaults make the schema valid without proving that a specific design decision occurred.

### 1.3 Current sanitizer does not know compiler capabilities

`html_sanitizer.py` forbids scripts, iframes, remote URLs, data URIs, fragile CSS, and non-opaque canvases. It does not reject SVG primitives or other tags that `html2patch.py` ignores.

### 1.4 Current mechanical gates are too coarse

`mechanical_gates.py` currently:

- checks old renderer marker strings;
- compares declared `layout_name` values;
- fails only **unknown** lint residue kinds;
- uses one global `non_background_ratio < 0.025` sparse threshold;
- checks only deck-level dark-vs-light mismatch.

It does not verify:

- source semantic elements survived compilation;
- text contrast;
- primary diagram completeness;
- declared composition matches rendered/native structure;
- known serious residue such as overflow and covered text.

### 1.5 Current skill inventory is incomplete for PPTX

`BuilderTaskMiddleware._BUILDER_RELEVANT_SKILLS` includes:

```text
visual-design
hallmark
pdf-report
ppt-generation
image-generation
research skills
data-analysis
```

It does not include hands-on-deck or a deck-adapted Impeccable skill. Hallmark is removed unless `_visuals_requested(...)` happens to match a visual keyword, even though every deck is visual work.

### 1.6 Current builder prompt contains contradictory ownership

Current builder guidance says both:

```text
provide creative_plan + slide html_source
```

and:

```text
DeckBuildService owns the design plan, composition, and asset policy
```

It also still says:

```text
Default to restrained professional technical visuals
```

That phrase has become a generic design attractor.

### 1.7 Current tool schema can fail before the service budget sees the call

`prepare_deck_build` accepts a typed `DeckCreativePlanInput`. JSON-string tool arguments can fail Pydantic validation before `DeckBuildService` starts, so they are not counted inside its bounded attempt state. The latest production run emitted more calls than the service recorded.

---

## 2. Locked ownership contract

This table is authoritative. No prompt or skill may redefine these boundaries.

| Layer | Owns |
|---|---|
| Builder model | story, subject-derived design direction, image strategy, slide composition, slide HTML |
| `prepare_deck_build` | argument normalization and typed validation |
| `DeckBuildService` | safe HTML intake, image dispatch, native compile, mechanical gates, terminal result |
| hands-on-deck | HTML measurement, patch generation, atomic patch validation, native inspect/lint/fix/render/diff |
| D3.1 judge | rendered visual/taste acceptance and model repair direction |
| Spec 11 | durable user-taste learning and co-review signals |

Explicitly remove this sentence from every model-facing surface:

```text
DeckBuildService owns the design plan, composition, and asset policy.
```

Replace it with:

```text
The builder owns the creative plan and slide HTML.
DeckBuildService validates, executes, compiles, and mechanically verifies them.
```

---

# 3. Skill system changes

## 3.1 Expose hands-on-deck as a normal runtime skill

The repo already vendors:

```text
third_party/hands_on_deck/
```

Add a runtime mirror:

```text
skills/public/hands-on-deck/
  SKILL.md
  designing-slides.md
  docs/html2patch-spec.md
  UPSTREAM.lock.json
```

### Source mapping

Copy verbatim from:

```text
third_party/hands_on_deck/skills/hands-on-deck/SKILL.md
third_party/hands_on_deck/skills/hands-on-deck/designing-slides.md
third_party/hands_on_deck/docs/html2patch-spec.md
```

Do not edit the copied upstream content manually.

### Add sync script

Add:

```text
scripts/sync_deck_design_skills.py
```

It must:

1. copy the three files above;
2. calculate SHA-256 for source and mirror;
3. write `UPSTREAM.lock.json` containing source path, source SHA, mirror SHA, and sync timestamp;
4. exit non-zero if source and mirror differ after sync.

Add test:

```text
backend/tests/test_hands_on_deck_skill_sync.py
```

The test fails when any mirrored file differs from its vendored source.

## 3.2 Add a deck-specific Impeccable adapter

The repo already contains:

```text
skills/public/impeccable/
```

Do not duplicate or edit its upstream skill.

Add:

```text
skills/public/deck-impeccable/SKILL.md
```

This adapter must point the builder to the existing native references:

```text
/mnt/skills/public/impeccable/reference/layout.md
/mnt/skills/public/impeccable/reference/critique.md
/mnt/skills/public/impeccable/reference/polish.md
/mnt/skills/public/impeccable/reference/bolder.md
/mnt/skills/public/impeccable/reference/quieter.md
```

The adapter must say:

```text
Use from Impeccable:
  hierarchy
  spacing rhythm
  density
  composition
  restraint
  bolder/quieter semantics
  critique and polish language

Do not apply:
  responsive web breakpoints
  browser interaction requirements
  motion
  mobile component states
  PRODUCT.md setup
```

Do not expose the raw top-level Impeccable web workflow as the default deck workflow.

## 3.3 Keep Hallmark upstream skill unchanged

Do not edit `skills/public/hallmark/SKILL.md` or its references to make them deck-specific.

Add a short deck mapping section to `deck_craft.md` that points to:

```text
/mnt/skills/public/hallmark/references/structure.md
/mnt/skills/public/hallmark/references/anti-patterns.md
/mnt/skills/public/hallmark/references/slop-test.md
```

Relevant deck concepts:

```text
structural variety
honest content
token discipline
pre-emit six-axis critique
repeated eyebrow / numbered-scaffold rejection
card-grid and template fingerprint rejection
```

## 3.4 Change BuilderTask skill inventory

Change:

```text
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py
```

### Update `_BUILDER_RELEVANT_SKILLS`

Add:

```python
"hands-on-deck",
"deck-impeccable",
```

Keep:

```python
"hallmark",
"ppt-generation",
"image-generation",
```

For fresh `.pptx` tasks:

- always include `hands-on-deck`;
- always include `deck-impeccable`;
- always include `hallmark`;
- always include `ppt-generation`;
- include `image-generation` because the creative plan may select generated assets;
- exclude `visual-design` to avoid generic frontend guidance competing with deck craft.

Replace `include_visual_design` with an explicit mode:

```python
presentation_design_mode: bool = False
```

Behavior:

```python
if presentation_design_mode:
    include hands-on-deck, deck-impeccable, hallmark, ppt-generation, image-generation
    exclude visual-design
else:
    preserve current behavior for HTML/PDF/non-deck artifacts
```

Call with:

```python
presentation_design_mode = deck_service_enabled and artifact_target_ext == ".pptx"
```

### Required system prompt block for PPTX

Inject before the skill inventory:

```xml
<deck_skill_contract>
Required before the first prepare_deck_build call:
1. Read /mnt/skills/public/sophia/deck_craft.md.
2. Read /mnt/skills/public/hands-on-deck/designing-slides.md.

Use on demand:
- deck-impeccable for hierarchy, space, density, bolder/quieter, critique, polish.
- hallmark for structural variety and anti-slop review.
- image-generation only through creative_plan.image_assets.

Professional and technical are quality constraints, not styles.
Derive visual direction from subject, audience, goal, viewing context, and subject materials.
</deck_skill_contract>
```

Do not inject the full skill bodies into the system prompt.

## 3.5 Skill use evidence

Extend `DeckCreativePlan` with:

```python
skill_refs: list[str]
```

Required value:

```text
hands-on-deck/designing-slides
```

Allowed optional values:

```text
deck-impeccable/layout
deck-impeccable/bolder
deck-impeccable/quieter
deck-impeccable/critique
deck-impeccable/polish
hallmark/structure
hallmark/anti-patterns
hallmark/slop-test
image-generation
```

This is declared evidence, not a security boundary.

Add LangSmith metadata by scanning successful `read_file` tool calls in the builder trace when available:

```text
deck.skills.available
deck.skills.declared
deck.skills.observed_reads
```

Do not block the build only because trace-based read detection is unavailable. Do block when `skill_refs` omits the mandatory hands-on-deck reference.

---

# 4. Replace the primer with one authoritative routing contract

Change:

```text
skills/public/sophia/deck_craft.md
```

Its role is a compact primer, not a substitute for the full skills.

Required sections:

```text
1. Ownership boundaries
2. Required planning order
3. Image-generation medium selection
4. Compiler capability summary
5. Skill routing
```

Required planning order:

```text
1. Read hands-on-deck design guidance.
2. Pin subject, audience, goal, and viewing context.
3. Name subject-specific materials, diagrams, metaphors, vocabulary, and texture.
4. Choose palette, typography, grid, signature, and slide rhythm.
5. Decide image strategy and exact image roles.
6. Critique the plan on Hallmark's six axes.
7. Revise the weakest point.
8. Author slide HTML.
9. Call prepare_deck_build.
```

Remove:

```text
native HTML/SVG/CSS structures
```

Replace with:

```text
native HTML/CSS/PPTX-compatible structures
```

Until SVG is implemented, the primer must explicitly say:

```text
Inline SVG is unsupported by the current native compiler and must not be used.
```

Remove the universal default:

```text
restrained professional technical
```

---

# 5. One compiler-capability source of truth

## 5.1 Add module

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/compiler_capabilities.py
```

Required constants:

```python
SUPPORTED_TAGS = frozenset({
    "html", "head", "meta", "style", "body",
    "main", "section", "article", "div", "figure", "figcaption",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "span", "strong", "em", "small",
    "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td",
    "img", "blockquote", "br",
})

UNSUPPORTED_TAGS = frozenset({
    "svg", "circle", "ellipse", "line", "path",
    "polyline", "polygon", "foreignobject",
    "canvas", "video", "audio",
    "script", "iframe", "object", "embed", "base",
})

SUPPORTED_AUTHORING_FEATURES = (
    "text blocks",
    "lists",
    "tables",
    "div fills",
    "borders",
    "border radii",
    "linear gradients",
    "local images",
    "flex/grid/absolute positioning",
)

UNSUPPORTED_CSS_PROPERTIES = frozenset({
    "filter",
    "backdrop-filter",
    "mix-blend-mode",
    "background-blend-mode",
    "animation",
    "transition",
})
```

Add functions:

```python
def compiler_capability_prompt_excerpt() -> str:
    ...

def unsupported_tags_in_html(source: str) -> list[str]:
    ...

def unsupported_css_in_html(source: str) -> list[str]:
    ...
```

All capability wording in prompts and tools must be generated from this module or match its tests.

## 5.2 Change sanitizer

Change:

```text
backend/packages/harness/deerflow/sophia/deck_build/html_sanitizer.py
```

- import `SUPPORTED_TAGS`, `UNSUPPORTED_TAGS`, and CSS capabilities;
- reject every unsupported tag;
- reject unknown SVG namespace forms and namespaced SVG attributes;
- reject `<svg>` before image/path validation;
- return exact error:

```text
unsupported_native_deck_tag: svg
```

Repair hint:

```text
Replace SVG with styled HTML divs/borders/tables and native text,
or declare a non-semantic generated/local image asset.
```

Add to `HtmlSourceValidation`:

```python
unsupported_tags: list[str]
unsupported_css: list[str]
```

## 5.3 Update tool and skill contracts from the same capability list

Change:

```text
backend/packages/harness/deerflow/sophia/tools/prepare_deck_build.py
skills/public/sophia/deck_craft.md
skills/public/ppt-generation/SKILL.md
skills/public/sophia/visual_composition.md
skills/public/sophia/builder_obligations.md
```

No file may claim inline SVG is supported for native PPTX.

---

# 6. Preserve semantic element identity through html2patch

The current `html2patch.py` generates names such as:

```text
h2p-1-text-1
h2p-1-box-2
```

It does not preserve source element identity.

## 6.1 HTML authoring contract

Every semantically meaningful slide element must have a unique ID:

```html
<div
  data-deck-id="memory-stack"
  data-deck-role="diagram-node"
  data-deck-required="true"
>
```

Required for:

```text
primary diagram nodes
primary connectors
tables
major evidence panels
generated-image containers
headline and body groups
closing synthesis object
```

Decorative background elements may omit it.

IDs must match:

```regex
^[a-z][a-z0-9-]{0,63}$
```

## 6.2 Minimal vendored patch

Modify:

```text
third_party/hands_on_deck/skills/hands-on-deck/scripts/html2patch.py
```

Keep the patch minimal and document it in:

```text
third_party/hands_on_deck/SOPHIA_PATCHES.md
```

Required patch behavior:

1. extractor reads:
   ```javascript
   sourceId = el.getAttribute("data-deck-id")
   sourceRole = el.getAttribute("data-deck-role")
   sourceRequired = el.getAttribute("data-deck-required") === "true"
   ```
2. extracted `text`, `box`, `image`, and `table` items carry those fields;
3. `compile_page(...)` uses source ID in shape names:
   ```text
   h2p-<slide>-<sourceId>-text-1
   h2p-<slide>-<sourceId>-box-1
   h2p-<slide>-<sourceId>-image-1
   ```
4. duplicate source IDs are an `html2patch` hard error;
5. `add-picture` gets a `name` field when a source ID exists;
6. source metadata is emitted into a compact sidecar:
   ```text
   deck_native/source-element-map.json
   ```

Do not change geometry, typography, patch validation, or other upstream behavior.

## 6.3 Add source retention report

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/source_retention.py
```

Dataclass:

```python
@dataclass
class SlideSourceRetention:
    selector: str
    required_source_ids: list[str]
    native_shape_names: list[str]
    retained_required_ids: list[str]
    missing_required_ids: list[str]
    duplicate_source_ids: list[str]
    retention_ratio: float
```

Function:

```python
def evaluate_source_retention(
    *,
    slides: list[DeckSlideSpec],
    native_shape_inventory: dict[str, Any],
) -> list[SlideSourceRetention]:
    ...
```

Hard failure:

```text
any data-deck-required=true element is missing natively
```

Soft warning:

```text
non-required semantic retention ratio < 0.90
```

Store report in:

```text
deck.native_mechanical_report["source_retention"]
```

---

# 7. Strengthen the creative plan into design evidence

## 7.1 Extend models

Change:

```text
backend/packages/harness/deerflow/sophia/deck_build/models.py
backend/packages/harness/deerflow/sophia/deck_build/tool_contract.py
backend/packages/harness/deerflow/sophia/deck_build/creative_plan.py
```

Add:

```python
@dataclass
class DeckPlanCritique:
    philosophy: int
    hierarchy: int
    execution_feasibility: int
    specificity: int
    restraint: int
    variety: int
    weakest_point: str
    revision_made: str

@dataclass
class DeckCreativePlan:
    ...
    viewing_context: str
    subject_materials: list[str]
    image_strategy_rationale: str
    skill_refs: list[str]
    plan_critique: DeckPlanCritique
```

Extend `DeckSlideCompositionPlan`:

```python
required_element_ids: list[str]
structural_fingerprint: str
```

## 7.2 Validation rules

Return retryable `deck_creative_plan_invalid` when:

```text
viewing_context missing
fewer than 3 subject_materials
image_strategy_rationale missing
hands-on-deck/designing-slides absent from skill_refs
signature is blank or one of the generic fallback strings
rhythm is blank or one of the generic fallback strings
all slide structural_fingerprint values are identical
any plan_critique score < 3 and revision_made is blank
any required_element_id is missing from the matching slide HTML
any generated image prompt asks for semantic text
```

Remove generic fallback values from `_coerce_design_plan`.

Do not silently convert absent design evidence into:

```text
Aptos / subject-derived visual system / varied slide structures
```

Use retryable validation failure instead.

Safe defaults may remain only for low-level numeric fields:

```text
grid dimensions
font weights
margins
```

---

# 8. Align image-generation planning

Change:

```text
skills/public/image-generation/SKILL.md
backend/packages/harness/deerflow/sophia/deck_build/image_prompting.py
```

Authoritative medium rule:

### Prefer generated images for

```text
hero atmosphere
subject-world imagery
conceptual metaphor
photographic scene
non-semantic texture/material/depth
```

### Prefer native composition for

```text
architecture
process
timelines
comparisons
causal maps
evidence
labels
arrows
values
formulas
exact relationships
```

Remove or narrowly scope Excalidraw/diagram-style guidance. Generated diagram imagery may be used only as non-semantic aesthetic support. It must not carry factual structure.

Prompt payload must retain:

```text
no title
no narrative
no labels
no axes
no formulas
no annotations
no page chrome
```

---

# 9. Normalize prepare arguments before Pydantic failure

## 9.1 Change model-facing tool signature

Change:

```text
backend/packages/harness/deerflow/sophia/tools/prepare_deck_build.py
```

From:

```python
slides: list[dict[str, Any]]
creative_plan: DeckCreativePlanInput
```

To:

```python
slides: list[dict[str, Any]] | str
creative_plan: dict[str, Any] | str
```

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/prepare_input.py
```

Function:

```python
def normalize_prepare_deck_input(
    *,
    slides: list[dict[str, Any]] | str,
    creative_plan: dict[str, Any] | str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    ...
```

Rules:

```text
valid JSON object/list string → parse once
malformed JSON → retryable deck_prepare_argument_invalid
wrong top-level type → retryable deck_prepare_argument_invalid
payload above size cap → non-retryable deck_prepare_argument_too_large
no nested JSON decoding beyond one layer
```

After normalization, validate using `DeckCreativePlanInput.model_validate(...)`.

## 9.2 Count every emitted call

Add state fields:

```python
builder_prepare_deck_call_count: int
builder_prepare_deck_service_result_count: int
builder_prepare_deck_root_failure_code: str | None
builder_prepare_deck_root_failure_summary: str | None
```

Count model-emitted `prepare_deck_build` tool calls in `BuilderArtifactMiddleware` before tool execution, so schema/pre-service failures count.

Total outer-call policy:

```text
initial call + one input-repair retry = 2 emitted calls maximum
```

D3.1 internal repair calls do not count as outer tool calls.

---

# 10. Mechanical fidelity gates

## 10.1 Change known residue behavior

Change:

```text
backend/packages/harness/deerflow/sophia/deck_build/mechanical_gates.py
```

Hard-fail these known residue kinds:

```text
overflow
covered_by
text_clipped
off_slide_text
unreadable
font_size
severe_overlap
render_mismatch
```

Warn:

```text
minor_alignment
intentional_picture_bleed
minor_overlap
```

Unknown residue remains a hard failure.

Do not keep the current behavior where known residue produces no issue.

## 10.2 Add contrast gate

Add:

```text
backend/packages/harness/deerflow/sophia/deck_build/native_contrast.py
```

Use native shape inventory and PPTX OOXML/python-pptx to determine:

```text
text RGB
own shape fill when present
largest containing opaque native shape
otherwise slide background fill
```

Contrast floors:

```text
body text: 4.5:1
large text >= 18pt or bold >= 14pt: 3.0:1
```

Hard-fail unreadable required text.

Output:

```python
@dataclass
class NativeContrastIssue:
    selector: str
    shape_name: str
    text_excerpt: str
    foreground: str
    background: str
    contrast_ratio: float
    required_ratio: float
```

## 10.3 Replace global sparse threshold

Delete:

```python
non_background_ratio < 0.025 → hard fail
```

Replace with:

```text
near-blank absolute floor < 0.008 → hard fail
```

For other density questions, record metrics as D3.1 rubric input. Do not use one global threshold for every slide role.

## 10.4 Add primary-element completeness

Call `evaluate_source_retention(...)`.

Hard-fail:

```text
missing required source IDs
duplicate required IDs
composition required_element_ids absent from source
```

## 10.5 Visual evidence semantics

Update builder/finalizer diagnostics so these count as deck visuals:

```text
native diagram shapes
tables
lines/connectors
generated images
charts
```

Do not require raster media to say visual evidence exists.

---

# 11. Preserve terminal truth

When retries are exhausted, return:

```json
{
  "failure_code": "deck_prepare_retry_exhausted",
  "root_failure_code": "deck_native_html2patch_failed",
  "root_failure_summary": "Slide 5 overflowed vertically by 19 px."
}
```

Required propagation through:

```text
DeckBuildResult
BuilderArtifactMiddleware
last_builder_artifact
gateway builder events
LangSmith root metadata
```

Zero-valued metrics must use `is not None`, never truthiness.

---

# 12. Prompt and skill contract changes

All changes in this section land in the same PR as the code changes.

## 12.1 `visual_composition.md`

State:

```text
- model authors DeckCreativePlan and slide HTML;
- harness validates/compiles/mechanically verifies;
- inline SVG is unsupported;
- semantic diagrams use compiler-supported HTML/CSS native shapes;
- generated assets are optional and non-semantic;
- no legacy route.
```

## 12.2 `builder_obligations.md`

Remove:

```text
DeckBuildService owns the design plan, composition, asset policy
```

Add:

```text
The builder owns creative plan, image plan, composition, and HTML.
DeckBuildService owns safe execution and mechanical verification.
```

Add mandatory design reads and two outer-call maximum.

## 12.3 `ppt-generation/SKILL.md`

Make this the exact fresh-PPTX workflow:

```text
read deck_craft
read hands-on-deck designing-slides
create plan
self-critique
author compiler-supported HTML
call prepare_deck_build
```

Delete the legacy emergency route and every mention of:

```text
build_deck_from_slides
prepare_pptx_image_manifest
direct deck.py/html2patch calls
inline SVG
```

## 12.4 `image-generation/SKILL.md`

Use only as optional deck asset planning guidance. Remove technical-bitmap diagram instructions from the deck path.

## 12.5 `builder_task.py`

- change skill inventory as specified;
- remove `restrained professional technical` default;
- remove legacy/debug route prose from production prompt;
- remove SVG claims for PPTX;
- make prompt ownership unambiguous.

## 12.6 `builder_artifact.py`

All PPTX correction messages must say:

```text
use prepare_deck_build
repair exact input/mechanical failure once
do not write files directly
do not use SVG
do not use legacy deck tools
```

No correction may mention the old compile route.

## 12.7 Prompt contract tests

Add assertions that every model-facing PPTX surface agrees on:

```text
model owns design/HTML
harness owns execution/mechanics
SVG unsupported
hands-on-deck required
deck-impeccable/hallmark on demand
no generic style default
no legacy route
two outer prepare calls maximum
```

---

# 13. Exact add/change/delete ledger

## Add

```text
skills/public/hands-on-deck/SKILL.md
skills/public/hands-on-deck/designing-slides.md
skills/public/hands-on-deck/docs/html2patch-spec.md
skills/public/hands-on-deck/UPSTREAM.lock.json
skills/public/deck-impeccable/SKILL.md

scripts/sync_deck_design_skills.py

backend/packages/harness/deerflow/sophia/deck_build/compiler_capabilities.py
backend/packages/harness/deerflow/sophia/deck_build/prepare_input.py
backend/packages/harness/deerflow/sophia/deck_build/source_retention.py
backend/packages/harness/deerflow/sophia/deck_build/native_contrast.py

third_party/hands_on_deck/SOPHIA_PATCHES.md

backend/tests/test_hands_on_deck_skill_sync.py
backend/tests/test_deck_compiler_capabilities.py
backend/tests/test_deck_creative_plan_design_evidence.py
backend/tests/test_deck_source_retention.py
backend/tests/test_deck_native_contrast.py
backend/tests/test_deck_prepare_argument_normalization.py
backend/tests/test_deck_skill_inventory.py
backend/tests/test_deck_prompt_contract_d211.py
backend/tests/test_deck_mechanical_fidelity.py
backend/tests/test_deck_terminal_root_failure.py
```

## Change

```text
third_party/hands_on_deck/skills/hands-on-deck/scripts/html2patch.py

backend/packages/harness/deerflow/sophia/deck_build/models.py
backend/packages/harness/deerflow/sophia/deck_build/tool_contract.py
backend/packages/harness/deerflow/sophia/deck_build/creative_plan.py
backend/packages/harness/deerflow/sophia/deck_build/html_sanitizer.py
backend/packages/harness/deerflow/sophia/deck_build/mechanical_gates.py
backend/packages/harness/deerflow/sophia/deck_build/service.py
backend/packages/harness/deerflow/sophia/deck_native/service.py
backend/packages/harness/deerflow/sophia/tools/prepare_deck_build.py

backend/packages/harness/deerflow/agents/sophia_agent/state.py
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py

skills/public/sophia/deck_craft.md
skills/public/sophia/visual_composition.md
skills/public/sophia/builder_obligations.md
skills/public/ppt-generation/SKILL.md
skills/public/image-generation/SKILL.md
skills/public/sophia/brand/tokens.md

backend/app/gateway/routers/builder_events.py
backend/packages/harness/deerflow/sophia/observability.py
```

## Remove from production contract

```text
inline SVG support claim
generic restrained-professional-technical default
legacy emergency PPTX route
build_deck_from_slides prompt references
prepare_pptx_image_manifest prompt references
visual-design as PPTX design source
generic signature/rhythm defaults
global 0.025 sparse-render hard threshold
known severe lint residue soft-pass
raster-only visual evidence semantics
```

## Do not delete yet

```text
legacy implementation files required by historical tests
```

They must remain unreachable and unmentioned for fresh production PPTX builds.

---

# 14. Tracing

Add spans:

```text
deck.skills.contract
deck.compiler_capabilities.validate
deck.creative_plan.design_evidence
deck.prepare_input.normalize
deck.source_retention.evaluate
deck.native.contrast
deck.mechanical.fidelity
deck.failure.root_cause
```

Every child span must carry:

```text
thread_id
session_id when available
task_id
run_id
build_id
deck_route
deck_compile_mode
artifact_target_ext
```

Do not log:

```text
full HTML
full image prompts
raw memory text
base64 images
artifact bodies
```

Log hashes, counts, selectors, rule IDs, and failure codes.

---

# 15. Test and smoke acceptance

## Unit and integration tests

Run at minimum:

```bash
pytest backend/tests/test_hands_on_deck_skill_sync.py
pytest backend/tests/test_deck_compiler_capabilities.py
pytest backend/tests/test_deck_creative_plan_design_evidence.py
pytest backend/tests/test_deck_source_retention.py
pytest backend/tests/test_deck_native_contrast.py
pytest backend/tests/test_deck_prepare_argument_normalization.py
pytest backend/tests/test_deck_skill_inventory.py
pytest backend/tests/test_deck_prompt_contract_d211.py
pytest backend/tests/test_deck_mechanical_fidelity.py
pytest backend/tests/test_deck_terminal_root_failure.py
pytest backend/tests/test_deck_build_service_model_html_path.py
pytest backend/tests/test_deck_build_service_native_route.py
```

Run Ruff on every changed Python file.

## Required regression fixtures

1. **Unsupported SVG fixture**
   - contains `<circle>`, `<line>`, and `<path>`;
   - must fail before `html2patch`;
   - error must name `svg`.

2. **Missing required element fixture**
   - source has `data-deck-required=true`;
   - native inventory lacks the corresponding shape;
   - build must fail.

3. **Low-contrast fixture**
   - black text on dark fill;
   - build must fail with contrast ratio.

4. **Known overflow residue fixture**
   - hands-on-deck reports overflow;
   - build must fail.

5. **Valid native diagram fixture**
   - CSS/HTML nodes and connectors;
   - all required IDs retained;
   - zero generated images;
   - native PPTX succeeds.

6. **Valid hybrid fixture**
   - one planned hero asset;
   - native overlay text;
   - source retention and contrast pass.

## Production smoke gate

Run two fresh decks:

### A. Diagram-native deck

```text
6 slides
0 generated images
technical architecture/process topic
all semantic elements native
```

Required:

```text
deck_compile_mode=native_html2patch
native_editability_score>=0.60
source retention pass
contrast pass
no severe residue
```

### B. Hybrid deck

```text
6 slides
1–2 planned generated assets
native semantic diagrams
```

Required:

```text
generated count equals planned asset count
no baked semantic text
native source retention pass
```

Only after both pass is D3.1 safe to implement.

---

# 16. Rollback policy

Allowed:

```text
tighten accepted HTML subset
disable individual deck skill adapters
fail more builds while contract issues are repaired
```

Forbidden:

```text
re-enable screenshot-backed deck success
re-enable deterministic template renderer
silently accept unsupported SVG
soft-pass missing required diagram elements
restore generic design defaults
restore legacy model-facing route
```
