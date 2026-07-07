# Spec D1 — Native Deck Substrate: import/wrap hands-on-deck

Status: draft, implementation-ready  
Sprint stage: Deck native substrate  
Depends on: current P-1 `DeckBuildService`, existing builder tracing, Spec 0 durable state for later resume/co-review  
Gates: D2 composition policy, D3 evaluator loop, Spec 3 deck manifest enrichment

---

## 0. The one decision this spec encodes

> Sophia vendors the EveryInc `hands-on-deck` repository as the native PowerPoint substrate and wraps it behind a Sophia-owned `DeckNativeService`. The model never calls `deck.py` or `html2patch.py` directly. `prepare_deck_build` remains the only model-facing fresh-deck tool.

The goal is to move from screenshot decks to native editable PPTX while preserving the working P-1 orchestration shape.

---

## 1. Current reality in Sophia

The current deck route is mechanically stronger than prior attempts: `DeckBuildService.prepare_and_build` validates IR, writes prompt files, prepares an image manifest, runs the batch, verifies visuals, renders slide HTML, compiles PPTX, evaluates, saves, and returns a structured result.

However, the compile substrate is still HTML screenshot based. `templates.py` renders a full 1920×1080 HTML slide with fixed title/narrative/visual regions; `build_deck_from_slides` screenshots that slide and wraps it in PPTX. The result is a valid `.pptx`, but one picture per slide and no native text/shape structure.

That prevents robust co-review:

```text
User: “make the last principle clearer”
Current deck substrate: one slide screenshot; no native title/body/shape ids
Target substrate: slide:6/title and slide:6/body are native PPTX text shapes
```

---

## 2. What to import verbatim

Add this subtree, preserving upstream code as much as possible:

```text
third_party/hands_on_deck/
  README.md
  LICENSE
  docs/html2patch-spec.md
  skills/hands-on-deck/SKILL.md
  skills/hands-on-deck/designing-slides.md
  skills/hands-on-deck/scripts/deck.py
  skills/hands-on-deck/scripts/html2patch.py
  skills/hands-on-deck/scripts/**
  evals/judges/create-judge.md
  evals/judges/edit-judge.md
```

Rules:

- Keep the imported files as upstream-like as possible.
- Do not edit imported files for Sophia-specific behavior unless a compatibility patch is unavoidable.
- Put Sophia behavior in wrapper code under `deerflow.sophia.deck_native`.
- Add an `UPSTREAM.md` note containing source repo URL, imported commit SHA, import date, and local patches.

---

## 3. Add Sophia-owned wrapper

Add:

```text
backend/packages/harness/deerflow/sophia/deck_native/
  __init__.py
  service.py
  models.py
  paths.py
  errors.py
```

### `models.py`

```python
@dataclass
class NativeDeckInspectResult:
    success: bool
    slide_count: int
    shape_count: int
    native_text_shape_count: int
    picture_shape_count: int
    full_slide_picture_count: int
    native_editability_score: float
    shape_inventory_path: str | None
    raw_json_path: str | None
    errors: list[str]

@dataclass
class NativeDeckPatchResult:
    success: bool
    output_pptx_path: str | None
    patch_path: str | None
    patch_op_count: int
    validation_error_count: int
    errors: list[str]

@dataclass
class NativeDeckRenderResult:
    success: bool
    render_dir: str | None
    rendered_slide_count: int
    errors: list[str]

@dataclass
class NativeDeckLintFixResult:
    success: bool
    lint_issue_count_before: int
    fix_applied_count: int
    residue_count: int
    touched_slide_count: int
    residue: list[dict]
```

### `service.py`

Expose exactly these methods:

```python
class DeckNativeService:
    def inspect(self, pptx_path: str, *, slide: int | None = None) -> NativeDeckInspectResult: ...
    def html_to_patch(self, *, html_paths: list[str], base_deck_path: str, output_patch_path: str) -> NativeDeckPatchResult: ...
    def apply_patch(self, *, base_deck_path: str, patch_path: str, output_path: str, fix: bool = True) -> NativeDeckPatchResult: ...
    def lint_fix(self, *, pptx_path: str, touched_slides: list[int] | None = None) -> NativeDeckLintFixResult: ...
    def render(self, *, pptx_path: str, output_dir: str, slides: list[int] | None = None) -> NativeDeckRenderResult: ...
    def diff(self, *, before_path: str, after_path: str) -> dict[str, Any]: ...
```

All methods call the vendored CLI through sanitized subprocess arguments. No shell strings.

---

## 4. Change DeckBuildService compile path

Current path:

```text
_render_slide_html(deck)
→ _compile_pptx(deck) using build_deck_from_slides
→ _evaluate(deck)
```

New feature-flagged path:

```text
_render_slide_html(deck)
→ DeckNativeService.html_to_patch(...)
→ DeckNativeService.apply_patch(..., fix=True)
→ DeckNativeService.inspect(...)
→ DeckNativeService.lint_fix(...)
→ DeckNativeService.render(...)
→ _evaluate(deck)
```

Add env flag:

```text
SOPHIA_DECK_NATIVE_SERVICE_ENABLED=true|false
```

Default for first PR: `false` in production, `true` in tests / staging smoke.  
Default after D1 acceptance: `true` for PPTX deck builds.

Do not expose a new model-facing tool. `prepare_deck_build` continues to call `DeckBuildService.prepare_and_build`.

---

## 5. Fallback policy

Keep the old HTML screenshot compiler as an emergency fallback for one sprint, but mark it explicitly.

If fallback runs:

```python
deck.compile_mode = "html_screenshot_fallback"
deck.native_editability_score = 0.0
deck.quality_warning = "screenshot_deck_fallback"
```

Fallback is allowed only when:

- `SOPHIA_DECK_NATIVE_SERVICE_ENABLED=false`, or
- native service startup fails before any deck mutation, and `SOPHIA_DECK_ALLOW_SCREENSHOT_FALLBACK=true`.

Fallback is **not** allowed silently after a native patch partially applies.

---

## 6. Native editability score

Compute after `inspect`:

```python
score = min(1.0, (
    0.45 * has_native_titles
  + 0.25 * has_native_body_text
  + 0.20 * has_non_full_slide_shapes
  + 0.10 * has_expected_pictures_not_full_slide_screenshots
))
```

Hard gate for native mode:

```text
native_editability_score >= 0.60 for success
```

If below threshold, D3 may repair once; otherwise terminal failure or explicit fallback warning.

---

## 7. Component manifest enrichment

When Spec 3 component manifest lands, D1 must populate deck components with native shape inventory:

```json
{
  "selector": "slide:4",
  "type": "slide",
  "source_path": "/mnt/user-data/outputs/slides/04-architecture.html",
  "native_slide_index": 3,
  "shape_inventory": {
    "title": "s12",
    "body": "s13",
    "visual": "s20"
  },
  "gate_results": {
    "native_editability_score": 0.81,
    "lint_residue_count": 0
  }
}
```

Before Spec 3 lands, persist this in the deck build JSON under `native_shape_inventory`.

---

## 8. LangSmith traces

Follow `sophia_deck_trace_contract_cleanup_appendix.md`.

Add explicit spans:

```text
deck.native.html2patch
deck.native.patch_apply
deck.native.inspect
deck.native.lint_fix
deck.native.render
deck.native.diff
```

Do not create spans per shape. Aggregate by deck or touched slide set.

Required root metadata updates after D1:

```python
{
  "deck_compile_mode": "native_html2patch|html_screenshot_fallback",
  "native_editability_score": 0.0_to_1.0,
  "native_text_shape_count": n,
  "picture_shape_count": n,
  "full_slide_picture_count": n,
}
```

---

## 9. Tests

Add:

```text
backend/tests/test_deck_native_service.py
backend/tests/test_deck_build_service_native_route.py
backend/tests/test_deck_native_trace_contract.py
```

Minimum tests:

1. One simple HTML slide compiles to a PPTX with native text shapes.
2. `inspect` reports `native_text_shape_count > 0` and `full_slide_picture_count == 0` for the native path.
3. Invalid patch fails atomically and does not write the output PPTX.
4. `lint_fix` returns residue rather than pretending perfect repair.
5. `DeckBuildService` keeps `prepare_deck_build` as the only model-facing tool.
6. When fallback is disabled and native compile fails, result is terminal failure, not screenshot fallback.
7. Trace metadata includes `deck_compile_mode` and `native_editability_score`.

---

## 10. Acceptance

A D1 staging deck is accepted when:

- PPTX opens successfully.
- `deck.py inspect` sees native text shapes on every slide.
- Native route emits no full-slide screenshot-only slide except intentional image-led hero assets.
- LangSmith shows D1 spans nested under `Sophia Builder`.
- No raw slide HTML, image bytes, full patches, or prompt bodies are logged.
