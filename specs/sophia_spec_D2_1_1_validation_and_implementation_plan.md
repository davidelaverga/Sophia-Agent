# D2.1.1 Validation and End-to-End Implementation Plan

**Status:** Validated and implementation-ready with amendments
**Validated:** 2026-07-10
**Target branch:** `codex/sophia-observability-v1`
**Code baseline:** `82c68f2cc6eb00af4c0c038b43debe2e059f2356`
**Source spec:** [`sophia_spec_D2_1_1_deck_craft_contract_mechanical_fidelity.md`](sophia_spec_D2_1_1_deck_craft_contract_mechanical_fidelity.md)
**Production evidence:** [`../docs/audits/sophia-builder-post-redeploy-presentation-failure-and-degraded-success-forensics-2026-07-10.md`](../docs/audits/sophia-builder-post-redeploy-presentation-failure-and-degraded-success-forensics-2026-07-10.md)

## 1. Decision

D2.1.1 is valid in direction and should be implemented. Its central contract is correct:

> The model owns story and design. The harness owns truthful execution and must prove that required semantics survived native compilation before declaring success.

The implementation must not follow the supplied file ledger literally. Validation found several repository and upstream mismatches that would otherwise reintroduce the same production loops or create new model-facing route conflicts. The amendments in this document are authoritative when they differ from the source spec.

### 1.1 Runtime remediation amendment

Production evidence from 2026-07-11 showed that six repeated complete HTML
documents made the 120-second prepare latch unenforceable and left too little
of the eight-minute deadline for native execution. The model still owns CSS,
markup, semantics, and composition, but the model-facing transport is now:

```text
deck_stylesheet
slides[*].html_body
slides[*].slide_css (optional)
```

DeckBuildService contributes only a fixed document shell and does not import
or activate `html_design_renderer.py`. Legacy `html_source` is accepted only
for transitional internal callers and is hidden from the model schema.

### 1.2 July 12 production-remediation amendment

The compact transport is versioned at its provider boundary. New model calls
must submit `authoring_contract=compact_model_html_v2`, use one concise shared
stylesheet, reuse shared classes, and keep the complete serialized tool call
within 48 KiB. Queued/internal v1 calls retain the prior service limits. The
120-second authoring threshold is an absolute cancellation deadline, not an
HTTP inactivity timeout.

Canvas validation must parse exact CSS declarations from author-authored style
blocks. The fixed harness shell is excluded from the authoring requirement;
`text-transform` is not `transform`, and the effective background may be
declared on `main`, `.slide-root`, `main.slide-root`, the slide-canvas
attribute, `body`, `html`, or root inline styles.

Builder lifecycle status uses the persisted/child `builder_result` before the
native LangGraph run status. A clean graph exit without a completed result and
accepted artifact is `builder_terminal_result_missing`, never success. The
build-foundation event table and RPCs are a deployment prerequisite and expose
readiness/circuit-break diagnostics when absent.

## 2. Evidence Reviewed

### Local implementation

- Fresh PPTX tool contract and Pydantic models.
- DeckBuildService creative-plan, sanitizer, native compile, inspect, lint/fix, render, diff, mechanical-gate, evaluator, and finalization paths.
- Builder skill inventory, prompt guidance, prepare state machine, emitted-call diagnostics, artifact visual evidence, gateway propagation, and LangSmith metadata.
- Vendored hands-on-deck source and current Hallmark skill import.
- Existing D1, D2, D2.1, D3, and D4 specifications.

### Production evidence

- Failed run `019f4c8f-c808-7990-a1ad-05657bff08e6`.
- Degraded-success run `019f4c99-8dbe-7373-b068-aab2948e05c6`.
- The exact 38,647-byte production PPTX with missing SVG geometry and black-on-dark SVG text.

### Pinned upstream repositories

| Project | Pinned commit | License | Local state | Import decision |
| --- | --- | --- | --- | --- |
| [EveryInc/hands-on-deck](https://github.com/EveryInc/hands-on-deck) | `1e94c3aa6bbe810708406ede1c248ebfd651bb2a` | MIT | Already vendored exactly at this commit | Keep vendor pin; mirror only deck-safe references behind a Sophia adapter; patch vendor minimally with a patch ledger |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `630fc2682a5bd39b25a8e61f74b6b3f14f2b1e21` | Apache-2.0 | Not present in this repository | Import only five exact references plus `LICENSE` and `NOTICE`; expose through a deck-specific adapter |
| [Nutlope/hallmark](https://github.com/Nutlope/hallmark) | `aeb42fb354ff4efa36ab475773a082315a3af2ce` | MIT | Current imported files match upstream | Keep raw skill unchanged for web work; add provenance metadata and a deck-specific adapter |

The upstream revisions were cloned and inspected directly. No implementation may fetch moving upstream branches during build or runtime. All imports must be repository-local and hash-pinned.

## 3. Code Validation Findings

### 3.1 Confirmed source-spec findings

The following claims are verified against the current branch:

- `deck_craft.md` still recommends native HTML/SVG/CSS even though the compiler does not implement SVG primitives.
- `html_sanitizer.py` accepts SVG and unknown tags that `html2patch.py` can silently ignore.
- `html2patch.py` drops SVG geometry and defaults SVG text to black because it reads CSS `color`, not SVG `fill`.
- `creative_plan.py` synthesizes generic design defaults, including Aptos, `subject-derived visual system`, and `varied slide structures`.
- the builder prompt still contains the generic `restrained professional technical` attractor.
- the current skill inventory omits hands-on-deck and Impeccable and conditionally removes Hallmark.
- the model-facing prompt contains ambiguous creative ownership language.
- malformed `slides` arguments can fail Pydantic before DeckBuildService and before service-result retry accounting.
- mechanical gates use one global `0.025` non-background ratio and have no text-contrast or semantic-retention check.
- native lint residue is returned in a flat report, while the gate reads a nonexistent nested `lint_fix` report.
- native shapes and connectors do not count as visual evidence in the final artifact check.
- the native route still fabricates `pptx_generator_picture_count=slide_count`.
- retry exhaustion replaces the final actionable service failure with a generic control-flow failure.

### 3.2 Existing implementation that must be preserved

- The fresh native route is already service-owned and uses `prepare_deck_build`.
- The prepare state machine already preserves real tool results and bounds service-level repair.
- Direct success finalization after a valid prepare result already exists.
- The shared 12-turn and 480-second presentation budget already exists.
- The native inspect inventory already records per-slide shape IDs, names, types, positions, sizes, and text previews.
- Builder, gateway, and LangSmith completion models already carry prepare counters and terminal metadata.
- Memory behavior is not causal and remains out of scope.

Implementation should extend these mechanisms rather than introduce a parallel deck runtime.

## 4. Authoritative Amendments

### A1. Expose adapters, not raw upstream workflows

The raw hands-on-deck skill instructs the model to run `deck.py`, `html2patch.py`, inspect, apply, render, and XML escape-hatch commands directly. That conflicts with the production requirement that fresh PPTX work use only `prepare_deck_build`.

The raw Hallmark and Impeccable skills are frontend/web workflows with responsive, motion, browser, PRODUCT.md, and component-state requirements that do not apply to slides.

Therefore:

- create a local `hands-on-deck` Sophia adapter as the model-facing `SKILL.md`;
- mirror upstream `designing-slides.md` and `html2patch-spec.md` exactly as references;
- create `deck-impeccable` and `deck-hallmark` adapters containing only deck-applicable routing and exclusions;
- never put raw upstream CLI or web workflows in the PPTX builder skill inventory;
- keep raw Hallmark available for its existing web use cases.

### A2. Sophia's 1920x1080 canvas overrides upstream 1280x720 guidance

Upstream hands-on-deck documents a 1280x720 browser canvas for a 13.333x7.5 inch deck. Sophia currently creates a 20x11.25 inch native base deck and validates a 1920x1080 canvas. The second production run already lost time correcting a canvas mismatch.

D2.1.1 does not migrate deck dimensions. The adapter must state:

```text
For Sophia fresh PPTX builds, the authoritative canvas is 1920x1080 CSS px.
The upstream 1280x720 example is not valid for this route.
```

A future dimension migration must be a separate compatibility change with fixture and rendering review.

### A3. Impeccable requires a real minimal import

The repository does not currently contain `skills/public/impeccable`. Import these exact upstream files from `.agents/skills/impeccable/reference/`:

```text
layout.md
critique.md
polish.md
bolder.md
quieter.md
```

Vendor their source under `third_party/impeccable/`, include Apache-2.0 `LICENSE` and `NOTICE`, record the pinned SHA, and mirror the exact references into `skills/public/deck-impeccable/reference/`. The locally authored adapter must carry a prominent modification/origin notice and exclude web-only instructions.

### A4. Hallmark must be deck-scoped

Do not require the deck model to read the full Hallmark `SKILL.md` or all of `slop-test.md`; they contain web-specific mobile, hero, navigation, motion, SVG, and interaction requirements.

Create `deck-hallmark/SKILL.md` that distills only:

- six-axis pre-emit critique;
- structural variety;
- honest content and no invented metrics;
- token discipline;
- repeated-card, repeated-eyebrow, and template-fingerprint rejection;
- subject-derived specificity and restraint.

The adapter may cite the unchanged upstream references for provenance, but its deck rules are authoritative.

### A5. Keep a typed tool schema and normalize in `mode="before"`

Do not change the public fields to `list | str` and `dict | str`. That would advertise stringified JSON as a valid tool schema and make malformed calls more likely.

Add:

```python
class DeckSlideInput(BaseModel): ...

class PrepareDeckBuildInput(BaseModel):
    slides: list[DeckSlideInput]
    creative_plan: DeckCreativePlanInput

    @model_validator(mode="before")
    def normalize_one_json_layer(cls, value): ...
```

Use this model as the tool's `args_schema`. Parse at most one JSON layer with byte, item-count, string-length, and nesting-depth limits. Keep indexed Pydantic error paths. A successfully normalized string is one emitted call, not a retry.

### A6. Source identity requires both `html2patch.py` and `deck.py` changes

The source spec requires pictures to retain names, but current `deck.py op_add_picture` ignores `name`, and validation does not register named pictures.

The minimal vendor patch must:

- collect `data-deck-id`, `data-deck-role`, and `data-deck-required` in `html2patch.py`;
- reject duplicate source IDs per slide;
- deterministically name every emitted shape for a source element;
- add `name` support and validation for `add-picture` in `deck.py`;
- emit an explicit `--source-map <path>` sidecar rather than relying on an undocumented patch payload extension;
- preserve one-to-many mappings for boxes that emit a face, text, borders, or image;
- record all vendor modifications and tests in `third_party/hands_on_deck/SOPHIA_PATCHES.md`.

Source IDs are unique per slide. Shape names must remain deterministic and collision-safe after PowerPoint naming constraints. Retention matches the sidecar's expected emitted shape names against the final native inventory; it must not infer semantics from text content.

### A7. Lint residue needs a stable taxonomy at the producer

`DeckNativeService` currently counts `residue_kinds` from free-form issue strings, so the source spec's proposed kind allowlist cannot work reliably.

Patch `deck.py fix --json` to add a stable `kind` to each residue record, including at least:

```text
frame_overflow
slide_overflow_text
slide_overflow_non_text
overlap
covered_by_picture
repair_still_failing
```

Mechanical gates must consume these enums. They must not classify free-form English at the gate. Unknown enums remain hard failures. Intentional bleed requires an explicit source role or allow flag, not a string heuristic.

### A8. Contrast must be deterministic or explicitly indeterminate

Native contrast cannot be computed truthfully from the current compact inventory alone. Add a post-lint PPTX analyzer that reads final OOXML/python-pptx shape order, text runs, font sizes, fills, slide background, and containing opaque shapes.

Rules:

- own opaque text-shape fill wins;
- otherwise use the topmost prior opaque containing shape with sufficient overlap;
- otherwise use the slide background;
- gradients, pictures, theme values that cannot be resolved, and transparent/unknown fills produce `indeterminate`, never an invented ratio;
- required semantic text with indeterminate contrast must use a compiler-supported opaque backing panel or fail mechanically;
- body text requires 4.5:1; large text requires 3.0:1 using PowerPoint point sizes after lint/fix.

Run contrast on the final post-fix deck. If lint/fix changed the artifact, refresh the authoritative inventory before source retention and contrast reporting.

### A9. Separate prepare counters and preserve root failure

The existing `prepare_call_count` is useful but insufficient. Add and propagate:

```text
prepare_emitted_call_count
prepare_normalized_call_count
prepare_schema_failure_count
prepare_service_call_count
prepare_service_result_count
prepare_retry_executed
root_failure_code
root_failure_summary
```

Policy:

- at most two emitted outer prepare calls;
- parseable JSON-string arguments normalize inside the same call;
- malformed or semantically invalid input can consume the one outer repair;
- a retryable service mechanical failure can consume the one outer repair;
- no third model-emitted prepare call;
- internal deterministic service repairs are separately counted and remain deadline-bound.

When exhausted, keep `failure_code=deck_prepare_retry_exhausted` as the control-flow reason and preserve the last authoritative failure in `root_failure_code` and `root_failure_summary`.

### A10. Creative critique must prove a completed revision

The source spec allows a score below 3 when `revision_made` is merely nonempty. That permits a declared repair whose result remains unacceptable.

Use initial and final scores:

```python
class DeckPlanCritique:
    initial_scores: DeckCritiqueScores
    weakest_point: str
    revision_made: str
    final_scores: DeckCritiqueScores
```

All final scores must be at least 3. This remains planning evidence, not a substitute for D3.1 rendered taste evaluation.

### A11. Capability lists must distinguish supported, rejected, and lossy behavior

One binary supported/unsupported list is too coarse. Define:

```text
SUPPORTED_TAGS
REJECTED_TAGS
SUPPORTED_CSS_FEATURES
REJECTED_CSS_PROPERTIES
LOSSY_CSS_PROPERTIES
```

The tag allowlist must include the inline tags that html2patch actually preserves, including `a`, `b`, `i`, `u`, and styled `span`. SVG and all namespaced SVG forms are rejected. Lossy features such as shadows, negative letter spacing, alpha, and unsupported transforms must generate explicit validation results; none may be silently stripped from a required semantic element.

### A12. Source retention precedes taste, but does not replace it

Replace the global `0.025` sparse hard gate with:

- an absolute near-blank corruption floor of `0.008`;
- required-element retention;
- deterministic contrast;
- severe residue gates;
- density metrics passed forward to D3.1.

Do not invent new taste thresholds in D2.1.1. A mechanically complete sparse statement slide can be valid; visual quality beyond mechanical completeness remains D3.1's responsibility.

## 5. Final Runtime Contract

### Model-facing deck skills

Fresh `.pptx` tasks receive only:

```text
hands-on-deck          Sophia service-route adapter
deck-impeccable       deck-applicable hierarchy, layout, critique, polish
deck-hallmark         deck-applicable anti-slop and six-axis critique
ppt-generation        exact prepare_deck_build workflow
image-generation      optional non-semantic asset planning
```

`visual-design` and raw web/CLI skill workflows are excluded in presentation mode.

### Authoring order

1. Read Sophia's `deck_craft.md`.
2. Read the Sophia hands-on-deck adapter and its design reference, applying the 1920x1080 override.
3. Establish subject, audience, goal, viewing context, and subject materials.
4. Build a subject-derived design system and image strategy.
5. Critique with deck-hallmark and, when useful, deck-impeccable.
6. Revise the weakest point and record final critique scores.
7. Author only compiler-supported HTML/CSS with required source IDs.
8. Call `prepare_deck_build` once with typed arguments.
9. Perform at most one exact outer repair when the tool returns retryable failure.

### Harness order

1. Count the emitted prepare call.
2. Normalize one JSON layer in the typed args model.
3. Validate creative-plan design evidence and slide linkage.
4. Validate compiler capabilities and required source IDs before writing HTML files.
5. Dispatch only planned non-semantic images.
6. Compile HTML through the pinned hands-on-deck adapter.
7. Apply the patch atomically.
8. Inspect native output.
9. Run deterministic lint/fix.
10. Refresh final inventory when fixes changed the deck.
11. Evaluate source retention and native contrast.
12. Render and run corruption, severe-residue, and mechanical gates.
13. Evaluate current non-taste quality checks.
14. Finalize success only when every mechanical contract passes.
15. Preserve terminal and root-cause truth through gateway and LangSmith.

## 6. End-to-End Implementation Phases

### Phase 1: Upstream provenance and deck adapters

Add pinned import metadata and sync tooling before prompt changes.

Deliverables:

- hands-on-deck adapter plus exact mirrored references and MIT license;
- minimal Impeccable vendor subtree, Apache license/notice, exact mirrored references, and deck adapter;
- Hallmark upstream lock plus deck adapter;
- one sync script with a declarative manifest for all mirrored files;
- hash tests that fail on source/mirror drift or an unrecorded upstream change.

Exit criteria:

- no runtime network dependency;
- all copied files have provenance and matching hashes;
- presentation mode exposes no raw CLI/web workflow.

### Phase 2: Capability and prompt contract

Implement the shared compiler capability module and route every model-facing PPTX surface through it.

Deliverables:

- exact tag/CSS capability classification;
- SVG and namespace rejection before asset/path validation;
- 1920x1080 adapter override;
- consistent ownership and two-call language;
- removal of generic style defaults, SVG claims, and legacy route hints;
- presentation-specific skill inventory.

Exit criteria:

- one contract test scans every PPTX model-facing surface;
- unsupported SVG fixture fails before html2patch with selector and repair hint;
- no prompt tells the model to call deck.py, html2patch.py, legacy tools, or write slide files.

### Phase 3: Typed prepare normalization and bounded accounting

Add `DeckSlideInput` and a typed args schema with safe pre-validation normalization.

Deliverables:

- one-layer JSON normalization with byte/depth/item caps;
- indexed validation errors;
- emitted, normalized, schema-failure, service-call, and service-result counters;
- hard two-emitted-call limit integrated before tool execution;
- reason-specific repair message and root-failure preservation.

Exit criteria:

- the production-shaped stringified `slides` fixture normalizes without another model turn;
- malformed JSON receives one repair opportunity;
- a third emitted prepare call terminalizes before execution;
- no dangling prepare call/result adjacency regression.

### Phase 4: Source identity through native compilation

Patch the pinned vendor minimally and document every deviation.

Deliverables:

- data-attribute extraction and duplicate detection;
- deterministic one-to-many shape naming;
- named pictures in `deck.py`;
- source-map sidecar;
- final inventory refresh;
- source-retention evaluator and report.

Exit criteria:

- every required source ID maps to at least one final native shape;
- deleting or renaming one required native shape causes hard failure;
- decorative elements can remain untracked;
- no geometry, typography, or patch atomicity behavior changes beyond the named patch.

### Phase 5: Mechanical fidelity

Make severe native defects terminal.

Deliverables:

- stable producer-side residue taxonomy;
- flat report schema consumed correctly;
- post-fix contrast analyzer;
- near-blank floor plus retention/contrast/severe-residue gates;
- native visual evidence semantics for shapes, connectors, tables, charts, and planned images.

Exit criteria:

- black text on dark fill hard-fails;
- missing SVG-derived semantics cannot reach compilation because SVG is rejected;
- a required element dropped from native output hard-fails;
- covered text and unresolved overflow hard-fail;
- native diagram-only decks do not emit `visuals_not_embedded`.

### Phase 6: Design evidence and image semantics

Strengthen planning without pretending it is rendered taste evaluation.

Deliverables:

- viewing context, subject materials, image rationale, skill refs, critique, required IDs, and structural fingerprints;
- removal of generic design fallbacks;
- deterministic plan validation and indexed errors;
- image medium policy that keeps factual structure native;
- prompt enforcement for no baked semantic text.

Exit criteria:

- generic or incomplete plans fail retryably;
- all final critique scores are at least 3;
- repeated structural fingerprints fail;
- required IDs exist in matching slide HTML;
- generated assets cannot be the sole carrier of labels, arrows, values, formulas, or exact relationships.

### Phase 7: Terminal truth and observability

Propagate the new contract through builder, gateway, and LangSmith.

Deliverables:

- root failure code/summary;
- new prepare counters;
- capability, retention, contrast, skill, and mechanical spans;
- native visual evidence fields;
- removal of fabricated picture counts;
- safe selector/count/hash-only logs.

Exit criteria:

- builder, gateway, webhook, and LangSmith metadata agree;
- zero values survive propagation via `is not None` checks;
- a clean LangGraph termination is still visibly failed when terminal metadata says failed;
- no HTML, raw prompts, memory text, images, or artifact bodies enter logs/traces.

### Phase 8: Regression, canary, and rollout

Run local gates first, then deploy and canary separately.

Deliverables:

- focused unit/integration tests;
- current AGENTS.md builder/gateway sweep;
- full backend test suite;
- Ruff and Sentrux;
- two production canaries and trace/artifact review.

Exit criteria are defined in section 9.

## 7. Adjusted File Ledger

### Add

```text
skills/public/hands-on-deck/SKILL.md
skills/public/hands-on-deck/designing-slides.md
skills/public/hands-on-deck/docs/html2patch-spec.md
skills/public/hands-on-deck/LICENSE
skills/public/hands-on-deck/UPSTREAM.lock.json

third_party/impeccable/LICENSE
third_party/impeccable/NOTICE.md
third_party/impeccable/UPSTREAM.md
third_party/impeccable/reference/{layout,critique,polish,bolder,quieter}.md
skills/public/deck-impeccable/SKILL.md
skills/public/deck-impeccable/reference/{layout,critique,polish,bolder,quieter}.md
skills/public/deck-impeccable/LICENSE
skills/public/deck-impeccable/NOTICE.md
skills/public/deck-impeccable/UPSTREAM.lock.json

skills/public/deck-hallmark/SKILL.md
skills/public/hallmark/UPSTREAM.lock.json

scripts/sync_deck_design_skills.py
third_party/hands_on_deck/SOPHIA_PATCHES.md

backend/packages/harness/deerflow/sophia/deck_build/compiler_capabilities.py
backend/packages/harness/deerflow/sophia/deck_build/prepare_input.py
backend/packages/harness/deerflow/sophia/deck_build/source_retention.py
backend/packages/harness/deerflow/sophia/deck_build/native_contrast.py

backend/tests/test_deck_design_skill_sync.py
backend/tests/test_deck_compiler_capabilities.py
backend/tests/test_deck_creative_plan_design_evidence.py
backend/tests/test_deck_source_retention.py
backend/tests/test_deck_native_contrast.py
backend/tests/test_deck_prepare_argument_normalization.py
backend/tests/test_deck_skill_inventory.py
backend/tests/test_deck_prompt_contract_d211.py
backend/tests/test_deck_mechanical_fidelity.py
backend/tests/test_deck_terminal_root_failure.py
backend/tests/test_hands_on_deck_sophia_patches.py
```

### Change

```text
third_party/hands_on_deck/skills/hands-on-deck/scripts/html2patch.py
third_party/hands_on_deck/skills/hands-on-deck/scripts/deck.py

backend/packages/harness/deerflow/sophia/deck_build/models.py
backend/packages/harness/deerflow/sophia/deck_build/tool_contract.py
backend/packages/harness/deerflow/sophia/deck_build/creative_plan.py
backend/packages/harness/deerflow/sophia/deck_build/html_sanitizer.py
backend/packages/harness/deerflow/sophia/deck_build/mechanical_gates.py
backend/packages/harness/deerflow/sophia/deck_build/service.py
backend/packages/harness/deerflow/sophia/deck_native/models.py
backend/packages/harness/deerflow/sophia/deck_native/service.py
backend/packages/harness/deerflow/sophia/tools/prepare_deck_build.py

backend/packages/harness/deerflow/agents/sophia_agent/state.py
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_artifact.py
backend/packages/harness/deerflow/agents/sophia_agent/pptx_diagnostics.py

skills/public/sophia/deck_craft.md
skills/public/sophia/visual_composition.md
skills/public/sophia/builder_obligations.md
skills/public/ppt-generation/SKILL.md
skills/public/image-generation/SKILL.md

backend/app/gateway/routers/builder_events.py
backend/packages/harness/deerflow/sophia/builder_events.py
backend/packages/harness/deerflow/sophia/observability.py
```

### Keep unchanged and unreachable in fresh production PPTX prompts

```text
legacy implementation files retained for historical tests
raw Hallmark web skill
raw upstream hands-on-deck CLI skill in third_party
```

## 8. Test Plan

### Focused D2.1.1 suite

```bash
cd backend
PYTHONPATH=. uv run pytest \
  tests/test_deck_design_skill_sync.py \
  tests/test_deck_compiler_capabilities.py \
  tests/test_deck_creative_plan_design_evidence.py \
  tests/test_deck_source_retention.py \
  tests/test_deck_native_contrast.py \
  tests/test_deck_prepare_argument_normalization.py \
  tests/test_deck_skill_inventory.py \
  tests/test_deck_prompt_contract_d211.py \
  tests/test_deck_mechanical_fidelity.py \
  tests/test_deck_terminal_root_failure.py \
  tests/test_hands_on_deck_sophia_patches.py \
  tests/test_deck_build_service_model_html_path.py \
  tests/test_deck_build_service_native_route.py \
  tests/test_deck_native_service.py \
  tests/test_sophia_builder_flow.py \
  -q
```

### Required graph-level regressions

- stringified but valid `slides` normalizes within one emitted call;
- malformed input consumes at most one outer repair;
- service mechanical failure consumes at most one outer repair;
- third emitted prepare call terminates before execution;
- every prepare tool call remains adjacent to a real matching result;
- successful prepare directly finalizes without another model turn;
- terminal root failure survives retry exhaustion.

### Required artifact fixtures

1. SVG circle/line/path source rejected before compilation.
2. Duplicate source IDs rejected with indexed slide path.
3. Missing required native shape fails retention.
4. One source element emitting box plus text retains both mapped shapes.
5. Named generated picture retains source identity.
6. Black text on dark fill fails contrast.
7. Required text on indeterminate image/gradient background fails with a backing-panel repair hint.
8. Covered text, unresolved overflow, and unknown residue kinds fail.
9. Native HTML/CSS diagram with zero pictures succeeds and counts as visual evidence.
10. Hybrid deck with one or two non-semantic images succeeds.

### Repository checks

```bash
cd backend
PYTHONPATH=. uv run pytest \
  tests/test_builder_progress_middleware.py \
  tests/test_builder_progress_endpoint.py \
  tests/test_builder_events_worker.py \
  tests/test_builder_canvas_worker.py \
  tests/test_builder_canvas_routes.py \
  tests/test_gateway_app_mounts.py \
  tests/test_companion_wakeup.py \
  tests/test_gateway_sophia.py \
  tests/test_start_builder_task.py \
  -q

PYTHONPATH=. uv run pytest tests/ -q
uv run ruff check <changed-python-files>

cd ..
sentrux gate .
sentrux check .
```

## 9. Production Acceptance

Deploy only after all local gates pass. Run two fresh six-slide canaries.

### Diagram-native canary

- zero generated images;
- process, architecture, comparison, and timeline content;
- all semantic elements use supported HTML/CSS and required IDs.

### Hybrid canary

- one or two planned non-semantic generated assets;
- all labels, values, arrows, formulas, and relationships remain native.

### Required results

- first prepare by turn 8 or 120 seconds;
- total runtime below 480 seconds;
- at most two emitted prepare calls;
- zero unaccounted or dangling prepare calls;
- zero unsupported tags reaching html2patch;
- 100% required-element retention;
- zero required-text contrast failures or indeterminate backgrounds;
- zero severe lint residue;
- native diagram-only canary does not report missing visuals;
- no fabricated picture counts;
- no raw HTML, prompts, memories, or artifact bodies in logs/traces;
- gateway, builder result, webhook, LangSmith metadata, and feedback agree on status and root failure;
- rendered artifact review confirms the planned semantic diagrams are present and readable.

## 10. Rollback and Delivery Boundaries

Allowed rollback:

- disable one deck adapter;
- tighten the accepted HTML/CSS subset;
- fail a deck cleanly when fidelity cannot be proven;
- revert only the D2.1.1 feature flag while preserving diagnostics.

Forbidden rollback:

- screenshot-backed or template-backed success;
- silent SVG acceptance;
- raw hands-on-deck CLI instructions in the production prompt;
- raw frontend skill workflows in presentation mode;
- soft-passing missing required elements or unreadable text;
- restoring generic design defaults;
- masking root failure behind retry exhaustion.

Memory retrieval, memory prompts, D3.1 taste judging, persistent taste learning, and full SVG compiler support remain outside this implementation.

## 11. Recommended Commit Structure

Implement in reviewable commits on the same branch:

1. `Pin deck design references and add adapters`
2. `Align deck compiler and prompt capabilities`
3. `Normalize and bound prepare deck inputs`
4. `Preserve native deck source identity`
5. `Enforce native deck mechanical fidelity`
6. `Strengthen deck planning evidence`
7. `Propagate deck terminal root causes`
8. `Add D2.1.1 regression and smoke coverage`

Do not combine D3.1 taste evaluation or memory changes into this sequence.
