# Appendix — Sophia Deck LangSmith Trace Contract + Cleanup

Status: draft for the deck-native migration sprint  
Branch baseline: `davidelaverga/Sophia-Agent@codex/sophia-observability-v1`  
Applies to: Specs D1–D4 and Spec 11

---

## 0. The decision

Every new deck subsystem trace must answer one of four production questions:

1. Did the deck compile as a native editable PPTX or fall back to screenshots?
2. Which layer failed: story, design contract, asset generation, native patching, lint/fix, rendered quality, rubric judge, or co-review revision?
3. Did repair improve the deck without collateral damage?
4. Did user feedback become a safe taste signal or builder lesson?

Do **not** add tracing for ordinary helper functions unless it answers one of those questions. Existing image and deck traces are already noisy; this appendix is also a cleanup directive.

---

## 1. LangSmith directives this appendix follows

Use the current LangSmith SDK patterns already used in the repo:

- Use `tracing_context(metadata=..., tags=...)` to set default metadata for child spans in a scope.
- Use `trace(name=..., run_type=..., inputs=..., metadata=..., tags=...)` for explicit child spans.
- Use `get_current_run_tree()` only to add cheap metadata to the current run, not to create extra spans.
- Propagate `thread_id` or `session_id` to **every child run**, otherwise thread filtering, token counting, and cost aggregation are incomplete.
- Attach feedback to the exact child run when the feedback critiques one step, not only to the root run.

LangSmith fields must be compact: no artifact bodies, prompt bodies, slide HTML bodies, user raw text, image bytes, full patches, or memory contents. Store hashes, counts, selectors, paths, and verdicts.

---

## 2. Base metadata required on every new deck span

Every explicit deck span created by Specs D1–D4 and Spec 11 MUST carry:

```python
base_metadata = {
    "sophia_schema": "deck_trace_v2",
    "thread_id": thread_id,                  # LangSmith thread metadata
    "session_id": session_id,                # when known
    "user_id_hash": user_id_hash,            # never raw user id
    "builder_thread_id": builder_thread_id,
    "builder_task_id": builder_task_id,
    "builder_run_id": builder_run_id,
    "build_id": build_id,
    "artifact_target_ext": ".pptx",
    "deck_route": "native_deck_service",    # or fallback value
    "deck_compile_mode": compile_mode,
    "render_git_commit": render_git_commit,
}
```

If a value is unknown, omit it rather than logging `None` noise, except for acceptance tests that explicitly verify propagation.

---

## 3. Span naming contract

Use this naming tree:

```text
deck.story.plan
deck.design_contract.resolve
deck.asset_policy.resolve
deck.image_manifest.prepare              # only if generated assets selected
deck.image_batch.run                     # existing, keep
deck.native.html2patch
deck.native.patch_apply
deck.native.inspect
deck.native.lint_fix
deck.native.render
deck.native.diff
deck.evaluate.story_gate
deck.evaluate.native_gate
deck.evaluate.rendered_gate
deck.evaluate.antislop_gate
deck.evaluate.rubric_judge
deck.repair.route
deck.repair.apply
deck.terminal
coreview.deck.target_confirm
coreview.deck.revise
coreview.deck.user_feedback
learning.deck.taste_signal
learning.deck.builder_lesson
```

Keep existing `deck.image_batch.run` / image item spans, but stop duplicating equivalent information into root metadata whenever it is already present in the child span. Root metadata should hold summary counters only.

---

## 4. Required outputs by span

### `deck.native.html2patch`

```python
outputs = {
    "success": bool,
    "slide_count": n,
    "html_source_count": n,
    "patch_path_hash": sha16,
    "patch_op_count": n,
    "unsupported_css_count": n,
    "fallback_needed": bool,
}
```

Do not log HTML or patch JSON.

### `deck.native.patch_apply`

```python
outputs = {
    "success": bool,
    "patch_op_count": n,
    "validation_error_count": n,
    "applied_slide_count": n,
    "output_pptx_bytes": n,
}
```

### `deck.native.inspect`

```python
outputs = {
    "slide_count": n,
    "shape_count": n,
    "native_text_shape_count": n,
    "picture_shape_count": n,
    "full_slide_picture_count": n,
    "native_editability_score": float,
}
```

### `deck.native.lint_fix`

```python
outputs = {
    "lint_issue_count_before": n,
    "fix_applied_count": n,
    "residue_count": n,
    "touched_slide_count": n,
}
```

### `deck.evaluate.*`

Each evaluator span returns compact verdict metadata:

```python
outputs = {
    "result": "pass|needs_revision|needs_user_review|fail",
    "hard_failure_count": n,
    "soft_warning_count": n,
    "failing_selectors": ["slide:3", "slide:5"],
    "repair_route": "none|story|composition|asset|native_patch|rubric",
    "judge_version": "deck_rubric_v1",       # judge spans only
}
```

### `coreview.deck.user_feedback`

```python
outputs = {
    "feedback_type": "accepted|rejected|change_requested|taste_positive|taste_negative",
    "selectors": ["slide:4"],
    "taste_signal_candidate_count": n,
    "builder_lesson_candidate_count": n,
}
```

---

## 5. LangSmith feedback policy

Use LangSmith feedback for step-level quality scores, not as Sophia's source of truth.

- Attach `deck_rubric_score` to `deck.evaluate.rubric_judge` child run.
- Attach `native_editability_score` to `deck.native.inspect` child run only when the deck reaches terminal success.
- Attach user acceptance/rejection feedback to `coreview.deck.user_feedback` or the root deck trace, depending on granularity.
- Mirror all user/taste feedback into Sophia-owned `LoopSignal` / `DeckTasteSignal` first; LangSmith feedback is observability, not memory.

---

## 6. Trace cleanup required before D1–D4 merge

### Remove or demote noisy traces

1. Do not create a child span for each native shape. Aggregate at slide/deck level.
2. Do not create one explicit span for every prompt JSON write. Keep `deck.image_manifest.prepare` with prompt hashes and item count.
3. Do not duplicate `IMAGEGEN_BATCH_ITEM` child outputs into the root run except summary counts.
4. Do not store rendered PNG/JPG paths for every slide in root metadata. Store `render_dir_hash`, `rendered_slide_count`, and maybe first/last basenames.
5. Do not include full slide HTML, prompt text, patch JSON, or rendered OCR text in LangSmith.

### Keep / extend existing high-value traces

Keep the current image batch and item traces because prior audits repeatedly needed batch status, per-item error class, timeout, retry, and prompt-hash data. Keep `deck.pptx.compile` as a semantic span, but change its output fields to identify `compile_mode=native_html2patch` versus `compile_mode=html_screenshot_fallback`.

---

## 7. Acceptance tests for trace landing

Add a smoke test / runbook check that verifies:

1. `deck.native.inspect` lands under the `Sophia Builder` root trace, not as an orphan root.
2. Every new explicit child span has `thread_id` and `build_id` metadata.
3. A native deck run can be filtered in LangSmith by `metadata.deck_compile_mode = native_html2patch`.
4. Feedback can be attached to `deck.evaluate.rubric_judge` using `trace_id` + child `run_id`.
5. Root trace summary contains `native_editability_score`, `deck_compile_mode`, and final `deck_quality_status`, but no artifact bodies or full prompts.
