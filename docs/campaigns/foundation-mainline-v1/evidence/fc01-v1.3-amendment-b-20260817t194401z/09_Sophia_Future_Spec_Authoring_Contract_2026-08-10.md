# Sophia Future Specification Authoring Contract

**Baseline:** `codex/sophia-observability-v1` at `9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca`  
**Purpose:** define how the exact sequence in the final plans becomes implementable specifications in the second pass without producing giant, ambiguous files now.

## 1. What this contract prevents

A coding agent must never be asked to infer authority, state, migration, user meaning, failure behavior, or evidence from a goal paragraph. Each future spec is a bounded executable decision packet. It covers one coherent contract and its proof, links to upstream/downstream specs, and identifies every deliberate unknown.

Plans answer **what, why, order, owner, and graduation gate**. Specs answer **exact contracts, exact target changes, exact tests, exact evidence, and exact rollback**. Pull requests implement one approved spec slice. Campaigns prove the vertical total.

## 2. Required status header

Every spec begins with:

```yaml
spec_id: M02-SEMANTIC-EVENT-FABRIC
spec_version: 1
status: draft | approved | implementing | evidence_pending | graduated | superseded | retired
owner: Davide | Luis | shared
integration_owner: name
approvers: [names]
repository: davidelaverga/Sophia-Agent
branch: codex/sophia-observability-v1
exact_head: <40-char SHA refreshed at authoring>
tree_or_diff_scope: <exact base/head or tree hash>
authority_sources: [exact artifact versions]
depends_on: [spec versions and evidence gates]
blocks: [spec IDs]
campaign_gate: C1
rollout_state: OFF
last_verified_at: <timestamp and timezone>
```

If the branch moves during spec review, the owner performs an impact check and records either “no relevant drift” with evidence or increments the spec.

## 3. The 20 mandatory sections

This preserves the completeness contract of the long-horizon Master Mission Plan v4.

1. **One decision and user outcome.** One sentence stating the decision this spec makes, the human scenario, and the observable improvement.
2. **Exact branch reality.** Current behavior, exact files/symbols/routes/tables/flags/tests, known deployments, and contradictions. Separate “exists,” “partial,” “specified,” and “new.”
3. **Mission/campaign coupling.** Horizon, upstream and downstream specs, campaign scenarios, and the exact evidence this spec must enable.
4. **Ownership and handoffs.** Davide/Luis/coding-agent responsibilities; contract producer/consumer; one owner per file; integration reviewer; decision escalation.
5. **Canonical data contracts.** Typed schemas, IDs, subject/principal/audience, sources/revisions, policy epochs, timestamps, expiry, idempotency, hashes, state authority, and error forms.
6. **State machine and invariants.** Legal states/transitions, transition owner, concurrent/duplicate/stale behavior, terminal/partial/ambiguous states, forbidden transitions.
7. **Runtime flow.** Admission through durable append, computation, capability/effect paths, evidence, projection, human decision, recovery, and delayed outcome where applicable.
8. **Exact repository change ledger.** Preserve/adapt/add/retire for each path and symbol; API/database/frontend/config/worker/test/docs boundaries; expected deletions after parity.
9. **Prompt, skill, model, tool, and context ledger.** Exact versions, trust classification, budget, schema, activation, capability scope, and evidence binding. Raw model prose is untrusted data.
10. **Migration and backfill.** Expand/migrate/contract sequence, old/new readers and writers, N/N-1 compatibility, reprocessing, verification, pause/resume, corrupted/partial data, and no-downtime assumptions.
11. **Consent, privacy, audience, and authority.** Principal/subject/speaker/audience; least-shared floor; retention/deletion/correction/revocation; redaction; crisis; protected surfaces; operator and model boundaries.
12. **Effort, latency, and cost.** Runtime/model/evaluator/tool budgets, payload/storage/stream limits, timeouts, concurrency, backpressure, degradation, capacity assumptions, and measurable ceilings.
13. **Observability and causal evidence.** Safe logs, metrics, traces, receipts, correlation IDs, hashes, dashboards/queries, alarms, sampling, redaction, and how to distinguish causes.
14. **Evaluation plan.** Unit/property/integration/migration/security/accessibility/visual tests; synthetic users/datasets/environments/faults; baseline/candidate/ablation; evaluator independence; human gates.
15. **Rollout plan.** `OFF → OBSERVE → SHADOW → ADVISORY → EXACT CANARY → BOUNDED ACTIVE → GENERAL ACTIVE`, eligibility, cohorts, monitoring window, and stop thresholds.
16. **Feature flags, kill switches, and rollback.** Exact owner/default/scope/expiry; data compatibility; compensating actions; effect ambiguity; restoration verification.
17. **Dependencies, supersession, and deletion.** Contracts consumed/produced; predecessor spec clauses retained/superseded; redundant implementations to remove after evidence; drift checks.
18. **Human exit and operations.** What the user sees, control/stop/takeover, support/runbook, manual review, escalation, recovery, and safe failure language.
19. **Non-goals and forbidden shortcuts.** Adjacent capability explicitly excluded, frameworks not promoted, second planes prohibited, unsupported claims, deferred research.
20. **Evidence-based Definition of Done.** Exact commands/environments, required artifacts, hard-zero gates, metric thresholds, Davide/Luis sign-offs, campaign requirement, production or canary proof, limitations.

No section may say “standard,” “appropriate,” “as needed,” “handle errors,” or “add tests” without naming the contract or leaving an explicit decision record.

## 4. Spec sizing and split rules

Split a spec when any of these is true:

- more than one canonical owner or independently rollable authority decision;
- schema/migration and product experience can be versioned independently;
- different hard rollback boundaries;
- more than one campaign gate;
- a coding agent cannot explain the change in one paragraph without “and then another system”;
- the exact repository ledger exceeds what one reviewer can safely verify in one pass.

Do not split merely by backend/frontend directory when the semantic contract would become ambiguous. Use a shared contract spec plus implementation slices, for example `M02-A envelope/store`, `M02-B adapters/reducers`, `M02-C frontend projection integration`, all graduating together in C1.

## 5. Two-pass authoring workflow

### Pass A — decision and contract

1. Refresh branch facts, open decisions, source pins, and predecessor clauses.
2. Write sections 1–7, 10–11, 17, and 19 first.
3. Review the authority/state model with Davide and the consumed experience semantics with Luis.
4. Freeze schemas, transitions, failure language, non-goals, and campaign claim.

### Pass B — repository and proof packet

1. Reinspect the exact branch; resolve target symbols, migrations, flags, tests, and deployment surfaces.
2. Complete sections 8–9 and 12–16, 18, and 20.
3. Generate or validate canonical semantic fixtures before UI/backend integration where possible.
4. Run a spec lint/review checklist; record every unresolved item as a blocking decision.
5. Approve a bounded implementation slice and assign a file owner/integration reviewer.

The user explicitly requested this separation so that current plan files remain usable. The second pass should author specs in the sequence fixed by the program map, not all at once.

## 6. Coding-agent implementation packet

Every assigned coding agent receives only the relevant packet:

- approved spec and exact SHA/diff base;
- applicable constitutional clauses and predecessor decisions;
- exact target-path ledger and files that must not change;
- generated schemas/fixtures and acceptance commands;
- campaign scenario subset and hard gates;
- ownership/overlap notes, flags, migration/rollback rules;
- output contract: changed files, tests/evidence, deviations, remaining risks, and no invented decisions.

The agent must:

1. inspect `git status` and the named paths;
2. report branch drift or conflicting user work before editing;
3. implement the smallest approved vertical slice;
4. preserve unrelated changes;
5. run the exact verification plus relevant neighboring tests;
6. update generated contracts/fixtures/evidence if required;
7. stop on missing authority or destructive ambiguity;
8. hand off a truthful evidence receipt, including tests not run.

## 7. Frontend contract addendum

Every experience spec enumerates:

- human scenario and experience hypothesis;
- semantic source and freshness for every visible element;
- loading, empty, offline, stale, partial, unauthorized, revoked, error, terminal, and recovery states;
- keyboard, focus, screen reader, reduced motion, zoom, contrast, touch, mobile/background, and multi-tab behavior;
- optimistic behavior and reconciliation, if allowed;
- exact language restrictions for receipt/applied/verified/done;
- event fixtures including duplicate, delay, drop, reorder, malformed, private, compacted, and unknown events;
- visual/performance budgets, qualitative/taste gate, and one bounded design repair followed by rerun;
- the rule that lenses, cards, and renderers never create runtime authority.

## 8. Memory and learning addendum

Every memory/learning spec identifies distinct records and never uses “memory” generically:

- canonical fact/source span, candidate, review, correction/supersession, audience and consent;
- deterministic index, semantic projection/BrainBundle, optional native fast state;
- `RecallRun`, authority-aware workspace, focus receipt, and context epoch;
- personal taste versus Builder/procedural lesson versus presentation interaction evidence;
- comparable episode definition, baseline/candidate/holdout, expiry, promotion, rollback, and retirement;
- deletion and revocation propagation through every projection and cache;
- `no memory needed` and `no promotion` as successful terminal outcomes.

Protected Sophia soul, voice, identity, relationship style, crisis behavior, and memory-consent policies cannot enter an automated optimization target.

## 9. Effect and artifact addendum

For each consequential action, define the subset of:

`proposed → authorized → reserved → dispatched → provider acknowledged → settled → observed → verified → accepted → outcome observed`

Do not collapse provider acknowledgment, model assertion, tool return, or process exit into applied/verified. Crash after provider application but before local receipt becomes ambiguous until reconciled.

For each artifact:

`draft → candidate → persisted → reopened → validated → evaluated → promoted/stable → accepted`

Targeted mutation binds artifact, component/selector, occurrence, source revision, stable/candidate parent, sibling hashes, expected preimage, output hash, evaluator evidence, and human decision. Lossy previews are never authority over native source packages.

## 10. Spec review checklist

Before approval, reviewers answer yes/no with citations:

- Is current code clearly separated from specified and target states?
- Is there exactly one canonical owner for every fact/effect and one transition owner?
- Could two clients/workers/providers produce a duplicate or stale result? Is that path specified?
- Are audience, privacy, deletion, correction, revocation, and crisis paths executable?
- Are model prose, retrieval, summaries, cards, renderers, and programs treated as projections/data?
- Does the UI consume named states without inventing success?
- Can old and new versions coexist during rollout? Can rollback restore behavior and data interpretation?
- Are budgets and attempt caps fixed before evaluation?
- Does the campaign traverse a real end-to-end boundary and include faults?
- Are synthetic claims properly limited and human gates named?
- Are every source, pin, adopted pattern, and rejected boundary explicit?
- Is every blank a blocking decision rather than an invitation to improvise?

## 11. Exact sources used

### Internal authorities

- Current repository [`9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca`](https://github.com/davidelaverga/Sophia-Agent/commit/9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca).
- `sophia_emotion_driven_evolutionary_harness_master_mission_plan_v4(1)(1)(1).md` — original 20-part spec completeness contract and long-horizon mission dependencies.
- `Sophia_Context_Ledger_v1_2026-08-04.md` v1.23 — authority hierarchy, decisions, source pins, mission separation, and protected boundaries.
- `Sophia_Evolved_Product_Constitution_Draft_2026-08-09.md` — constitutional product laws, first nuclear loop, and human authority.
- `Sophia_Living_Shared_World_Canvas_Product_Reflection_2026-08-10.md` — projection/Canvas/lens contracts and architecture acceptance scenarios.
- `Sophia_Streaming_Experience_AG_UI_A2UI_LangChain_Strategy_2026-08-09.md` — state distinctions, semantic projection families, transport/renderer boundaries.
- `M00_CURRENT_PRODUCTION_CAMPAIGN_CLOSEOUT(1).md`, `M01_RUNTIME_RELIABILITY_AND_DURABLE_INPUT(1).md`, `M02_SEMANTIC_EVENT_FABRIC(1).md`, `M03_SESSION_STREAM_REPLAY_AND_PROJECTIONS(1).md`, `M04_ASYNC_COOPERATION_AND_NON_DESTRUCTIVE_STEER(1).md`, `M05_INCREMENTAL_ARTIFACT_AND_COMPONENT_ITERATION(1).md`, `M06_VOICE_PRESENCE_CONTROLLER(1).md`, `M07_LOOPRUN_EVALUATOR_AND_REPAIR(1).md`, `M08_COREVIEW_CO_REVIEW(1).md`, `M09_RETRIEVAL_EXPLORATION_AND_KNOWLEDGE(1).md`, and `M10_TASTE_LESSONS_AND_RECIPE_LEARNING(1).md` — the exact tactical handoffs whose goals, constraints, ledgers, rollout and evidence must be reconciled rather than accumulated.
- `sophia_spec_0_durable_build_state_postgres.md`, `sophia_spec_1_harden_str_replace.md`, `sophia_spec_2_builder_compaction.md`, `sophia_spec_3_component_manifest.md`, `sophia_spec_5_buildservice_resume.md`, `sophia_spec_6_coreview_mode.md`, `sophia_spec_7_looprun_deterministic_loop_graph.md`, `sophia_spec_8_rubric_evaluator_repair_gates.md`, `sophia_spec_9_taste_and_builder_lesson_memory.md`, `sophia_spec_10_learning_trace_skillopt_refinement.md`, `sophia_input_promotion_and_steer_spec.md`, `sophia_knowledge_project_layer_hydra_spec_v1.md`, `sophia_spec_C_memory_retrieval_policy_v1.md`, `sophia_coreview_interaction_profile_spec.md`, `Sophia_Builder_Iteration_Spec_Plan.md`, `sophia_tool_output_budget_spec.md`, and `co_review.md` — exact predecessor contracts and examples. No standalone Spec 4 source was supplied; future authors must not invent one.
- `Luis_Experience_Master_Plan_v2_Whole_Product(1).md` — human-scenario/fixture/prototype/integration/dogfood/taste-gate mission pattern.

### External implementation references

- [OpenCode `2f17fc9`](https://github.com/anomalyco/opencode/commit/2f17fc9613771af3de3b5a2715b836037d80c4b1) — durable input, semantic events, context epochs, capability snapshots, schema-first protocol boundaries.
- [grok-build `ed6d543`](https://github.com/xai-org/grok-build/commit/ed6d543643628663873c5de28298e022ed634238) — immutable objectives/procedure snapshots, journaled transitions, gap identity, reviewer separation, honest partial state.
- [Trellis `ca92175`](https://github.com/mindfold-ai/Trellis/commit/ca92175f0b4efd37dfe149c592063954eb306a2e) — repo-native work packets, common source compiled to host projections, explicit manifests and drift-aware upgrades; not Sophia authority.
- [Deep Agents `280e24e`](https://github.com/langchain-ai/deepagents/commit/280e24eda9db718408d458154791d0ae84bb845a) and [DeerFlow `99c926b`](https://github.com/bytedance/deer-flow/commit/99c926b7bbcd0570870bc24ceb13ab934935f49c) — chosen composition/mechanics lineages whose defaults remain subordinate to Sophia contracts.
- [GenOffice `8f52328`](https://github.com/genspark-ai/genoffice/commit/8f523289d6c34f940cd691472ee56b2013d148c8) — native artifact authority, lossy projections, narrow source-preserving patches, format-local validation.
- [AG-UI `68b99d8`](https://github.com/ag-ui-protocol/ag-ui/commit/68b99d8bb8910cc624964818000f6b71cce4d66f), [A2UI `ec97cb0`](https://github.com/a2ui-project/a2ui/commit/ec97cb0d7499932e67003ffe5b709a3db7e7033a), and [JSON Render `9d3dfc8`](https://github.com/vercel-labs/json-render/commit/9d3dfc8917c1c6aa5568acbe0969523f3307376c) — bounded protocol/renderer studies after native semantic fixtures, never an authority shortcut.
