# Sophia Synthetic Vertical Campaign and Evidence Protocol

**Baseline:** `codex/sophia-observability-v1` at `9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca`  
**Owner:** Davide; Luis co-owns experience, accessibility, and taste gates.  
**Status:** planning contract. Each campaign receives its own executable specification in the second pass.

## 1. Purpose

This protocol makes every feature total prove a complete user journey before the next total begins. It prevents the program from accumulating individually plausible subsystems that have never worked together.

The unit of progress is not a merged feature. It is a versioned claim:

> Given these synthetic users, source datasets, product states, environments, models, budgets, faults, and policies, Sophia completes this end-to-end journey within declared limits, preserves every hard invariant, and produces independently reviewable evidence.

Synthetic campaigns prove engineering and product hypotheses under controlled conditions. They do **not** prove real human benefit, relationship quality, or life outcome. Those claims require dogfood, design-partner research, consent, and delayed outcome measurement.

## 2. Campaign object model

Every run is reproducible from immutable identifiers.

| Object | Required contents |
|---|---|
| `CampaignVersion` | mission/horizon, preregistered hypotheses, primary and guardrail metrics, hard gates, owners, baseline/candidate, dataset splits, environment matrix, rollout eligibility |
| `ProductScenarioVersion` | human situation, starting records, allowed knowledge, hidden user state, chronological event script, branch points, acceptance/outcome truth, expected ambiguity |
| `SyntheticUserVersion` | observable behavior policy, hidden goals/constraints, privacy and audience preferences, interruption style, capability/access needs, emotional/context state, error model |
| `DatasetRelease` | documents, artifacts, source spans, ground truth, licenses, sensitivity classes, contamination record, dev/challenge/holdout assignment |
| `EnvironmentImage` | application SHA, migrations, dependencies, provider/model policy, browser/device/assistive-tech profile, clock/timezone/locale, network/storage services |
| `FaultSchedule` | deterministic fault seed and exact injection boundaries |
| `PolicyEpoch` | authority, audience, retention, memory, effect, skill, model, budget, and crisis policies |
| `RunReceipt` | all identifiers above, random seeds, input admission IDs, event/effect/artifact/evidence chains, projection hashes, costs, timing, evaluator decisions, human decisions |
| `PromotionDecision` | evidence bundle hash, unmet limitations, owner signatures, rollout state, expiry/review date, rollback target |

Raw prompts, hidden evaluator labels, and private source material are access-controlled evidence; their hashes and versions remain in the receipt.

## 3. Dataset discipline

### 3.1 Splits

- **Development:** visible to implementers; used for diagnosis and iteration.
- **Challenge:** visible scenarios with adversarial combinations; used for release-candidate stabilization.
- **Sealed holdout:** scenario details and labels hidden from implementation agents. Run only for a promotion decision.
- **Longitudinal holdout:** stateful synthetic worlds retained across days/weeks of simulated time. Never reset mid-journey to rescue a failure.
- **Counterfactual pairs:** identical pre-treatment checkpoints forked into baseline, candidate, and named ablations.

No run moves between splits after results are known. If a holdout is exposed, it is retired, recorded as contaminated, and replaced before a later promotion attempt.

### 3.2 Required corpus families

| Family | Minimum coverage |
|---|---|
| Talk/deck wedge | weak and strong briefs; clean/dirty source decks; contradictory brand instructions; missing fonts/assets; underdesigned and overdesigned examples; native and rendered evidence |
| Reports and mixed artifacts | Markdown, PDF, presentation, images, tables, citations, inaccessible/oversized/corrupt files, stable plus candidate revisions |
| Conversations | ordinary companionship, ambiguity, corrections, refusal, irrelevant talk during work, delayed reply, code-switching, partial transcripts, emotionally difficult and crisis content |
| Research/evidence | authoritative/weak/conflicting/stale/deleted/private sources; no-retrieval turns; shallow/deep retrieval cases; citation and freshness ground truth |
| Memory/continuity | approved, pending, rejected, superseded, corrected, expired, revoked, deleted, wrong-audience, shared/private, and `no memory needed` cases |
| Projects/trajectories | seed goal, unstable goal, abandoned goal, competing commitments, blocked work, approval dependency, delayed outcome, keep/fade/remove/archive decisions |
| Effects/tools | idempotent and non-idempotent providers; status-query capable/incapable; timeout before/after effect; stale lease; revoked capability; ambiguous settlement |
| Skills/learning | successful, repaired, unsafe, incomparable, outdated, contaminated, and held-out episodes; protected-surface change attempts |

Each item needs provenance, license/permission, subject/audience, sensitivity, source revision, expected lifecycle, and ground-truth limitations.

## 4. Synthetic user panel

Use stateful users, not single-turn prompt personas. Their hidden state changes only through scenario rules, never because an implementation performed well.

| Cohort | Hidden state and stressor | What it tests |
|---|---|---|
| Voice-first founder | impatient, mobile, visually busy, needs an investor talk/deck in two weeks | first-input truth, voice/text parity, calm progress, talk/deck wedge |
| Privacy-sensitive professional | strict separation between personal, project, and shared audiences | audience floors, source filtering, Shared World, memory and screenshots |
| Low-attention returning user | leaves mid-build, returns days later on another device | replay, projection convergence, Home Continue, continuity without recap overload |
| Precise expert reviewer | knows exact page/slide/text and rejects fuzzy targeting | Coreview confirmation, stable/candidate lineage, evidence fidelity |
| Novice under ambiguity | changes wording, expresses uncertainty, cannot name system concepts | classification, clarification, lens suggestions, non-coercive control |
| Accessibility user | keyboard-only, screen reader, reduced motion, zoom, high contrast | semantic structure, focus restoration, non-visual proof and controls |
| Unstable-network mobile user | duplicate taps, offline queue, background suspension, clock drift | admission/idempotency, SSE gaps, snapshot/replay, stale actions |
| Emotionally distressed user | productivity goal interrupted by grief, panic, or crisis language | Quiet Canvas, presence suppression, crisis handback, no trajectory pressure |
| Shared-project participant | least-shared audience, conflicting permissions, later revocation | principal/speaker/audience truth, no private memory bleed |
| Longitudinal power user | several projects, corrections, experiments, preferences over simulated months | low-churn Home ranking, project return, governed learning, rollback |

For each cohort, author at least three behavior variants and one adversarial ambiguity variant. Synthetic users may express preference, confusion, or acceptance; they cannot certify real human delight or emotional safety.

## 5. Environment and simulation matrix

### 5.1 Required environments

1. **Deterministic local contract environment:** fake clocks, seeded providers, Postgres, stream bridge, object store, evaluator fixtures, browser, and voice/media simulators.
2. **Production-shaped multi-worker environment:** at least two gateway/workers, real Postgres configuration, production migration path, restart/redeploy, shared stream delivery, object storage, and auth.
3. **Provider sandbox:** real model/media/tool providers on non-sensitive fixtures with capped spend and recorded version/policy.
4. **Frontend device lab:** desktop and mobile viewport families, touch and pointer, keyboard-only, screen reader, reduced motion, high contrast, zoom, background/foreground, multi-tab.
5. **Longitudinal time lab:** deterministic clock advances, expiry, scheduled dependency, delayed outcome, model/provider change, index rebuild, correction/deletion propagation.

### 5.2 Fault injection boundaries

Inject crash, delay, duplication, reordering, truncation, and revocation after each relevant transition:

- before and after first input admission;
- after event append but before outbox publish;
- after publish but before client acknowledgment;
- at snapshot/replay boundary and explicit stream gap;
- before/after checkpointer write and compaction commit;
- before/after capability snapshot and safe steer boundary;
- before effect reservation, after dispatch, after provider application but before receipt, and during status reconciliation;
- during artifact candidate materialization, stable promotion, source-preserving patch, and reopen validation;
- during evaluator request/result, repair, re-evaluation, and human review;
- during remote memory add, local watermark, review, index build, retrieval, correction, revocation, and deletion;
- during projection generation, stale card action, lens change, Home/Canvas transition, and cross-device rejoin;
- during skill/cognitive-program activation, experiment expiry, promotion, and rollback.

Consequential ambiguous effects must enter `EFFECT_AMBIGUOUS`, reconcile if the provider permits, and prohibit blind retry or false success.

## 6. Evaluation stack

### 6.1 Deterministic gates

- schemas, state machines, migrations, N/N-1 compatibility, idempotency, authorization, audience filtering, replay reducers, projection hashes, artifact hashes, selector/revision exactness, effect fences, budget caps, expiry, rollback;
- frontend types, pure reducer tests, component golden states, browser flows, keyboard/focus semantics, accessibility checks, visual regressions, performance ceilings;
- prompt/skill/evaluator version binding; contamination and dataset split checks.

### 6.2 Model or rubric evaluators

Use only for qualities that cannot be reduced to deterministic truth: clarity, usefulness, relevance, design quality, voice cadence, repair quality, and comparative preference. Each evaluator has an immutable version, declared evidence inputs, confidence/abstention path, calibration set, cost cap, and independence rule. It never receives hidden implementation labels that leak the candidate identity unless the study explicitly tests branded perception.

### 6.3 Human review

- **Davide gate:** constitutional fidelity, semantic truth, causal diagnosis, operational safety, architecture coherence, evidence sufficiency.
- **Luis gate:** comprehension, control salience, accessibility, responsive behavior, visual/interaction quality, voice presence, product restraint.
- **Target-user research gate:** after synthetic graduation, users assess usefulness, burden, trust calibration, agency, and later outcomes. The team records disagreement; aggregate preference cannot cancel a truth/privacy failure.

### 6.4 Metrics

Every campaign selects a small preregistered set. Candidate metrics include:

- admission loss/duplication; replay hash mismatch; stale-action application; wrong-audience exposure; unauthorized dispatch; false completion/effect rate;
- time to truthful orientation; time to first useful state; time to resume; control discovery; target-confirmation error; recovery steps;
- stable artifact availability; accepted-quality rate; repair benefit; untouched sibling hash rate; evidence completeness;
- voice interruption latency; duplicate narration; unwanted cue rate; silence precision; crisis suppression;
- source precision/recall by mode; citation correctness/freshness; correction/deletion propagation; memory-review precision;
- task success, delayed outcome, calibrated uncertainty, cost, latency, model calls, evaluator calls, human review time;
- accessibility violations, focus loss, layout shift, mobile completion, comprehension and trust-calibration scores;
- objective integrity, authority violations, experiment regret, rollback completeness, cross-version regression.

Never average a zero-tolerance failure away.

## 7. Runtime caps versus development iteration

“Iterate until satisfactory” means repeat **versioned development campaigns**, not silently extend a failing run.

- Runtime defaults from tactical M07 remain: at most one repair, three evaluator calls, and one Builder retry unless a later approved spec changes them.
- When a run fails, preserve its complete receipt. Diagnose. Change one reviewable implementation/spec/prompt/fixture bundle. Increment versions. Reset environment. Run again.
- Development scenarios may repeat. Challenge scenarios repeat only with transparent versioning. Sealed holdout is run once per promotion candidate.
- No evaluator prompt tuning on held-out failures. No manual artifact replacement. No hidden cleanup of state between longitudinal episodes.
- Satisfactory means hard gates pass, gains are stable across seeds and cohorts, costs fit budgets, human reviewers accept the experience, limitations are written, and rollback is proven.

## 8. Campaign sequence

### C0 — Current production wedge truth

Fresh authenticated PSI deck: build → judge → one repair → re-judge → coding self-review → human review. Add pending/rejected memory probes. Graduate only with an approved artifact or safe, causally understood failure plus zero memory leakage.

### C1 — Nothing disappears or lies

Home text/voice → durable admission → Conversation Canvas → work/presence projection → disconnect/background → replay/rejoin across device. Fault every admission/event/snapshot boundary. Hard gates: zero input loss/duplication, projection convergence, no private leak, no false applied/completed label.

### C2 — A conversation that keeps working

Approved project/deck → build → chat during work → Ask/focus receipt → queue/safe steer → component candidate → reject/repair/hold/stop → leave/return/resume. Hard gates: same work identity, last stable artifact remains usable, unaffected component hashes unchanged, action idempotency.

### C3 — Look, shape, prove

Weak artifact → evaluate → at most one repair → voice/visual handoff → exact Coreview target confirmation → one source-preserving mutation → re-evidence → Done with Proof. Include ambiguous target, stale revision, media failure, barge-in, and crisis. Hard gates: zero wrong-target mutation or duplicate narration; completion bounded by proof.

### C4 — Return with the right context

Multi-session/multi-project users → no/shallow/deep retrieval → Explore/evidence → artifact/project desk → correction/deletion/revocation → leave → Home Continue → exact source-bound return. Hard gates: no audience leak, citation and freshness truth, `no memory needed` path, invalidations everywhere.

### C5 — Question → world → experiment → work

Conversation uncertainty → explicit Explore → bounded experiment/environment → Build → safe steer → delayed result → Home/Shared World return → keep/fade/hide/archive/delete/promote decisions. A separate repeated Builder subcorpus may exercise tactical M10 end to end: comparable episodes → one recipe proposal → shadow/held-out comparison → human promotion → rollback. Hard gates: lens changes do not alter authority; world placement does not alter persistence; removal verbs and learning planes remain distinct; this first rail cannot claim general self-evolution.

### C6 — Adaptive advantage without authority drift

Fork identical checkpoints into static controller, motivated/selective candidate, adaptive-program candidate, and named ablations. Run hidden personas/tasks/faults. Hard gates: no safety/authority regression; preregistered utility and recovery gain; bounded cost; inspectable cause. Non-win means shadow, revise, or retire—not narrative success.

### C7 — Prove she changed safely

Accumulate comparable episodes → form presentation/recipe/skill/control proposal → shadow → held-out comparison → human promotion → later journey → rollback. Required evidence floor for procedural Builder learning: at least 30 comparable runs, 10 accepted artifacts, 5 repaired failures, plus held-out slice unless an approved spec raises it. Hard gates: no protected-surface change; atomic promotion and deterministic restoration.

### C8 — Longitudinal category proof

Weeks of simulated time plus dogfood/design-partner protocol: important talk/deck, research, co-review, rehearsal, one safe guidance, one adaptation, leave/return, delayed real outcome. Optional workbench/computer/shared endeavors remain isolated ablations. Graduate to wider rollout only with synthetic truth plus real human acceptance and an explicit limitations register.

## 9. Evidence bundle and reporting

Every campaign publishes:

1. preregistration and exact hypotheses;
2. branch/tree, migrations, flags, dependency/model/provider pins;
3. scenario/user/dataset/environment/fault versions and contamination statement;
4. canonical event/effect/artifact/evidence receipts and projection hashes;
5. deterministic, rubric, cost, latency, accessibility, and qualitative results;
6. failures and causal classifications, including all zero-tolerance incidents;
7. baseline/candidate/ablation comparison with confidence and practical significance;
8. Davide and Luis review decisions and disagreements;
9. limitations and claims explicitly not supported;
10. rollout/rollback rehearsal and final promote/hold/retire decision.

Evidence is append-only. Corrections add a superseding record; they do not rewrite history.

## 10. Proposed repository seams

These are target locations to validate in each future spec, not permission to add them immediately:

- `backend/tests/synthetic/` — scenario engine, seeded users, fault schedules, campaign runners;
- `backend/tests/fixtures/sophia_campaigns/` — versioned non-sensitive corpus and manifests;
- `backend/packages/harness/deerflow/sophia/evaluation/` — reusable evaluator/receipt contracts only if this avoids duplicating existing `deck_quality` mechanics;
- `frontend/src/testing/semantic-fixtures/` — generated projection fixtures and player;
- `frontend/e2e/campaigns/` or the existing Playwright root discovered by the spec — full journeys across desktop/mobile/accessibility profiles;
- `evidence/sophia/` outside production code or a dedicated governed evidence store — immutable manifests and summaries, never secrets/raw private data in Git.

Before adding any directory, inspect the exact branch and reuse `backend/tests/evals`, `backend/tests/fixtures/deck_quality_shadow`, current frontend test conventions, and current deck-quality evidence services where their semantics conform.

## 11. Exact references used

### Internal authorities

- Exact repository [`9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca`](https://github.com/davidelaverga/Sophia-Agent/commit/9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca).
- `Sophia_Evolved_Product_Constitution_Draft_2026-08-09.md` — laws, nuclear loop, wedge, proof and learning boundaries.
- `Sophia_Living_Shared_World_Canvas_Product_Reflection_2026-08-10.md` — broad end-to-end fixture journey and architecture acceptance scenarios.
- `Sophia_Context_Ledger_v1_2026-08-04.md` v1.23 — campaign order, M10 split, counterfactual/social/computer-use experiment boundaries.
- `Sophia_Streaming_Experience_AG_UI_A2UI_LangChain_Strategy_2026-08-09.md` — `STREAM-01`, `STEER-01`, `SURFACE-01`, `EDGE-01`, `TRANSPORT-01` and projection/effect state distinctions.
- `M00_CURRENT_PRODUCTION_CAMPAIGN_CLOSEOUT(1).md`, `M01_RUNTIME_RELIABILITY_AND_DURABLE_INPUT(1).md`, `M02_SEMANTIC_EVENT_FABRIC(1).md`, `M03_SESSION_STREAM_REPLAY_AND_PROJECTIONS(1).md`, `M04_ASYNC_COOPERATION_AND_NON_DESTRUCTIVE_STEER(1).md`, `M05_INCREMENTAL_ARTIFACT_AND_COMPONENT_ITERATION(1).md`, `M06_VOICE_PRESENCE_CONTROLLER(1).md`, `M07_LOOPRUN_EVALUATOR_AND_REPAIR(1).md`, `M08_COREVIEW_CO_REVIEW(1).md`, `M09_RETRIEVAL_EXPLORATION_AND_KNOWLEDGE(1).md`, and `M10_TASTE_LESSONS_AND_RECIPE_LEARNING(1).md` — the complete tactical campaign spine, including M00 production closeout, M07 caps/repair sequence, M08 target evidence, and M10 evidence thresholds.
- `sophia_emotion_driven_evolutionary_harness_master_mission_plan_v4(1)(1)(1).md` — long-horizon evaluation and integrated-slice intent.
- `Luis_Experience_Master_Plan_v2_Whole_Product(1).md` — fixture-first mission method and one-repair taste gate.

### External laboratories and methods

- [jcode `02439b4`](https://github.com/1jehuang/jcode/commit/02439b492929125e54daff50348de0a8655cb695) — execution graphs, typed completion, steering, closed-system evaluation.
- [grok-build `ed6d543`](https://github.com/xai-org/grok-build/commit/ed6d543643628663873c5de28298e022ed634238) — immutable objectives/procedures, journaled execution, independent reviewers, gap identity, honest partial coverage.
- [Pi `6b461b7`](https://github.com/earendil-works/pi/commit/6b461b75b39b5a19b378dc42fbfbd1655bc446a6) — paired baseline/candidate evaluation and lane continuity.
- [LongHorizon-Harness `24ad75c`](https://github.com/AMAP-ML/LongHorizon-Harness/commit/24ad75c067b7abded492f7e343123e403741c612) — independently checked compact progress frontier across fresh contexts.
- [Browser Harness `f5eaf90`](https://github.com/browser-use/browser-harness/commit/f5eaf904b221dde0118eba1496961c3dc20fda88) — rendered inspection and causal browser evidence, used only inside isolated test/workbench authority.
- [MiroFish `b5b53ac`](https://github.com/666ghj/MiroFish/commit/b5b53acc57189a4a42e44a23e149dc655c98fe82) — social simulation as rehearsal, never outcome authority.
- [Cloudflare Computer `8758b51`](https://github.com/cloudflare/computer/commit/8758b51c8891c211dddd1903d2ee2d12a75ac7ff) and [Qwen-CUA `85923de`](https://github.com/xlang-ai/Qwen-CUA/commit/85923de65a05b7ce0073c021b369a5fc12c76294) — later durable workcell/visual-last-mile environment studies, not controller baselines.
- [DSPy `9bca784`](https://github.com/stanfordnlp/dspy/commit/9bca784d114641d25b6745e79df0c3f533576708) — offline compilation/evaluation pattern; never live autonomous promotion.
- [Parlant `ea73744`](https://github.com/emcie-co/parlant/commit/ea737442b8ae65854a842542e544fbe7e6144bad) — selective guideline resolution experiments with Sophia-owned policy authority.
