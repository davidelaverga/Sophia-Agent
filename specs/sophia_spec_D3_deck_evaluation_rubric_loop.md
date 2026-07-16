> [!WARNING]
> **Historical / superseded draft.** Retained for provenance only. Do not
> implement this draft verbatim where it conflicts with D3.2 Rendered Taste
> Judge or Campaign DQ-1. The technical body below is intentionally unchanged.

# Spec D3 — Deck Evaluation Loop: deterministic gates + rubric judge + repair

Status: draft, implementation-ready  
Sprint stage: Deck quality loop  
Depends on: D1 native substrate, D2 composition + asset policy  
Connects to: Spec 7 LoopRun, Spec 8 Rubric Evaluator, Spec 10 Recipe refinement, future Spec 11 taste learning

---

## 0. The one decision this spec encodes

> `DeckBuildService` cannot emit a deck merely because it compiled. It must pass deterministic native/rendered/narrative gates and a bounded deck rubric judge, then either repair selected slides, route to user review, or fail honestly.

This spec is the deck-specific implementation of the rubric-loop idea. It borrows the loop shape from DeepAgents rubric middleware, but does not copy it directly: this evaluator is artifact-centered, slide-aware, and native-PPTX-aware.

---

## 1. Current reality

The current `DeckEvaluator` checks slide count, visual completeness, missing slide HTML, missing assets, missing PPTX, compile overflow, and several regex design rules. That catches mechanics but misses:

- native editability
- oversized images
- weak slide hierarchy
- bad light/dark mismatch
- image-baked text density
- narrative incoherence
- closing-slide dangling references
- user taste fit
- professional visual quality

The latest successful decks prove the gap: they can compile and pass deterministic checks while looking visually weak or narratively incoherent.

---

## 2. Add modules

```text
backend/packages/harness/deerflow/sophia/deck_build/narrative_gate.py
backend/packages/harness/deerflow/sophia/deck_build/native_gate.py
backend/packages/harness/deerflow/sophia/deck_build/rendered_gate.py
backend/packages/harness/deerflow/sophia/deck_build/antislop_gate.py
backend/packages/harness/deerflow/sophia/deck_build/rubric.py
backend/packages/harness/deerflow/sophia/deck_build/repair_loop.py
backend/packages/harness/deerflow/sophia/deck_build/judges/
  deck_create_judge.md
  deck_edit_judge.md
```

---

## 3. Evaluation model

Extend `models.py`:

```python
DeckEvaluationResult = Literal[
    "satisfied",
    "needs_revision",
    "needs_user_review",
    "failed",
]

@dataclass
class DeckGateResult:
    gate_id: str
    result: str
    hard_failures: list[DeckQualityIssue]
    soft_warnings: list[DeckQualityIssue]
    failing_selectors: list[str]
    repair_route: str | None

@dataclass
class DeckRubricVerdict:
    result: str
    score: float
    criteria: list[dict[str, Any]]
    failing_selectors: list[str]
    repair_brief: str | None
    taste_signal_candidates: list[dict[str, Any]]
    builder_lesson_candidates: list[dict[str, Any]]
```

Extend `DeckEvaluation`:

```python
gate_results: list[DeckGateResult]
rubric_verdict: DeckRubricVerdict | None
repair_count: int
max_repair_count: int
```

---

## 4. Deterministic gates

### 4.1 `DeckStoryGate`

Hard failures:

- slide count mismatch
- missing deck thesis
- missing slide claim
- closing references nonexistent principles/concepts
- “these N principles” count mismatch
- generic title without claim
- repeated title/narrative across slides

### 4.2 `NativeDeckGate`

Inputs: `DeckNativeService.inspect`, shape inventory, compile mode.

Hard failures:

- native route selected but `native_editability_score < 0.60`
- slide title is not native text
- slide narrative/body is not native text when present
- screenshot-only deck in native mode
- missing shape inventory for a successful native slide

Soft warnings:

- too many picture shapes relative to native shapes
- native text exists but all slide meaning is still in image

### 4.3 `RenderedGate`

Inputs: rendered slide images from `DeckNativeService.render`.

Deterministic checks:

- visual area > allowed ratio for layout
- high dark panel ratio inside light contract, or vice versa
- large unused whitespace without role
- title/body contrast below threshold
- image-baked text density above threshold
- visual slot clipping/crop evidence
- title/body font size below floor

Use pixel heuristics first. Do not run OCR as a general dependency. Only use OCR-like text detection if already available and bounded; otherwise use image-density/glyph heuristics.

### 4.4 `AntiSlopGate`

Use `deck_antislop_rules.md` as the source of rule IDs.

Hard failures:

- fake metrics/testimonials/logos
- fake browser/IDE chrome unless explicit screenshot context
- text baked into generated images when label policy is native
- full-slide screenshot fallback without explicit fallback permission

Soft warnings:

- repeated card grid
- generic SaaS copy
- repeated eyebrow/kicker scaffolding
- emoji-as-icons in professional/executive decks
- default AI gradient / neon / glassmorphism pattern
- overly dense dashboard/card layout

---

## 5. Rubric judge

### 5.1 Judge dimensions

Create judge prompt files based on hands-on-deck eval dimensions:

```text
visual craft
typography and consistency
narrative arc and pacing
audience fit
asset use/integration
mechanical polish
memorability / “can’t stop flipping”
user taste fit
```

For edit/revise runs, add:

```text
preservation fidelity
collateral damage
new-slide integration
re-theme completeness when relevant
```

### 5.2 Inputs

The rubric judge receives only compact data:

```text
DeckStory summary
DeckDesignContract enum fields
contact sheet or rendered slide image refs when model supports vision
native shape inventory summary
Deterministic gate results
User taste hints, if available
Builder lesson hints, if available
```

Do not include raw user memory content or full deck source.

### 5.3 Output schema

The judge must output JSON:

```json
{
  "result": "satisfied|needs_revision|needs_user_review|failed",
  "score": 0.0,
  "failing_selectors": ["slide:5"],
  "criteria": [
    {"name": "narrative_arc", "score": 2, "reason": "closing references five principles but only three are named"}
  ],
  "repair_brief": "Rewrite slide 5 closing to name the actual three principles and reduce visual density.",
  "taste_signal_candidates": [],
  "builder_lesson_candidates": []
}
```

---

## 6. Repair loop

Add `repair_loop.py`.

Algorithm:

```python
MAX_DETERMINISTIC_REPAIRS = 1
MAX_RUBRIC_REPAIRS = 1

compile_native_deck()
eval = evaluate_all_gates()

if eval.has_hard_failures and deterministic_repairs_remaining:
    repair_selected_slides(eval.repair_brief)
    recompile_and_reevaluate()

if eval.passes_hard_gates:
    verdict = rubric_judge()
    if verdict.result == "needs_revision" and rubric_repairs_remaining:
        repair_selected_slides(verdict.repair_brief)
        recompile_and_reevaluate_once()
    elif verdict.result == "needs_user_review":
        emit_with_review_warning()
    elif verdict.result == "satisfied":
        emit_success()
    else:
        fail_honestly()
```

Repairs must be slide-scoped. Whole-deck regeneration is allowed only if `DeckStoryGate` fails before asset generation or if the user explicitly asks to rework the entire deck.

---

## 7. Integration point in DeckBuildService

Replace current final sequence:

```python
self._compile_pptx(deck, runtime)
self._evaluate(deck, runtime)
deck.status = "evaluated"
return success
```

with:

```python
self._compile_pptx(deck, runtime)
self._evaluate_and_repair(deck, runtime)
if not deck.evaluation.passed:
    raise DeckBuildFailure(...)
deck.status = "evaluated"
return success
```

`_evaluate_and_repair` owns deterministic gates, rubric judge, and bounded repair.

---

## 8. LangSmith traces and feedback

Add spans:

```text
deck.evaluate.story_gate
deck.evaluate.native_gate
deck.evaluate.rendered_gate
deck.evaluate.antislop_gate
deck.evaluate.rubric_judge
deck.repair.route
deck.repair.apply
```

Attach LangSmith feedback:

- `deck_rubric_score` on `deck.evaluate.rubric_judge`.
- `native_editability_score` on `deck.native.inspect` when final result succeeds.
- `deck_user_acceptance` later from Spec 11.

Trace cleanup:

- Do not create one trace per rule. Gate spans aggregate failures.
- Do not include rendered slide OCR text, full screenshot paths, or full judge prompt.
- Store criteria names, numeric scores, failing selectors, and repair route only.

---

## 9. Tests

Add:

```text
backend/tests/test_deck_story_gate.py
backend/tests/test_deck_native_gate.py
backend/tests/test_deck_rendered_gate.py
backend/tests/test_deck_antislop_gate.py
backend/tests/test_deck_rubric_loop.py
backend/tests/test_deck_repair_loop.py
backend/tests/test_deck_evaluation_traces.py
```

Minimum cases:

1. Closing “these five principles” fails when five concepts are absent.
2. Screenshot-only PPTX fails native gate in native mode.
3. Oversized image in visual slot triggers rendered gate.
4. Text baked into generated image triggers hard anti-slop gate when label policy is native.
5. Rubric `needs_revision` triggers one slide-scoped repair and no second unbounded loop.
6. `needs_user_review` emits artifact with review warning but no automatic second repair.
7. LangSmith child span names and metadata match Appendix contract.

---

## 10. Acceptance

A D3 deck passes when:

- Compiled native PPTX is not sufficient by itself.
- Deterministic gates run before rubric judge.
- Rubric judge runs only after hard gates pass or are repaired.
- Repair is bounded and slide-scoped.
- Terminal failure is honest when gates fail after repair budget.
- Trace tree shows evaluator spans nested under `Sophia Builder`.
