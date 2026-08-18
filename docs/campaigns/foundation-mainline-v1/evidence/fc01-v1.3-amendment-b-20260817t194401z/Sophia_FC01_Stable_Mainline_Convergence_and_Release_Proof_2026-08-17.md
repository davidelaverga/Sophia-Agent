# Sophia FC-01 — Stable Mainline Convergence and Release Proof

**Spec ID:** `FC-01-STABLE-MAINLINE-CONVERGENCE`  
**Version:** `1.1`  
**Date:** 2026-08-17  
**Status:** ready for implementation review  
**Program gate:** `C0 / H0`  
**Repository:** `davidelaverga/Sophia-Agent`  
**Source campaign branch:** `codex/sophia-observability-v1`  
**Target branch:** `main`  
**Rollout state at start:** `OFF`  
**Operational/semantic approver:** Davide  
**Experience/accessibility approver:** Luis  
**Implementation owner:** coding agent  

---

## 0. The decision

FC-01 has one job:

> Close the current production campaign, reconcile the long-lived Sophia branch with current `main`, produce one exact and reversible release candidate, prove the current product through its real surfaces, merge only after human review, and leave one truthful `main` from which M01 can begin.

FC-01 is **not** M01. It does not implement the new runtime foundation, durable input admission, Builder compaction, tool-output budgeting, safe replacement, Companion/Gemini tracing, or the vNext package firewall. Those begin in FC-02/M01 after this campaign has produced a stable canonical mainline.

That order matters:

```text
BASE-00 truth
→ M00 closeout on the exact current campaign lineage
→ refreshed post-M00 deployment/rollback baseline
→ reviewed mainline convergence
→ MEM-00 privacy gate on the composed tree
→ exact-SHA release proof and rollback
→ human promotion
→ stable main
→ FC-02 / M01
```

Trying to merge 592 files and implement all of M01 in the same candidate would make the release boundary unreviewable and could delay `main` again. Conversely, merging PR #144 directly would promote a tree that has no usable merge-ref CI, unresolved semantic conflicts, rewritten historical migrations, and multiple production lineages.

FC-01 therefore has four resumable phases with a persisted receipt and human gate between them:

1. **FC-01A / BASE-00:** re-resolve source/deployment truth and freeze acceptance budgets.
2. **FC-01B / M00:** close the current campaign on its exact lineage, then freeze a new signed deployment/rollback baseline reflecting the accepted post-M00 production state.
3. **FC-01C / CONVERGE + MEM-00:** create a clean integration candidate from `main`, semantically merge both histories, prove the narrow memory-visibility gate on that composed tree, repair only release blockers, and obtain a clean PR.
4. **FC-01D / RELEASE:** prove, roll back, re-promote, request human approval, merge, and prove the actual `main` merge SHA.

The campaign has two successful states:

- `READY_TO_MERGE`: the reviewed candidate and evidence archive satisfy every pre-merge gate. The coding agent stops for Davide and Luis.
- `CAMPAIGN_COMPLETE`: both humans approve, the protected merge is complete, the exact resulting `main` SHA is deployed, and the post-merge acceptance pack passes.

Other honest terminal states are `BLOCKED`, `FAILED_SAFELY`, and `ROLLED_BACK`.

“The product does not crash” cannot be proven universally. The allowed claim is:

> The exact released SHA completed the frozen FC-01 product and rollback envelope with no unresolved P0/P1, no unexpected process crash or crash loop, and no unexplained 5xx, data loss, cross-user leak, false completion, orphaned work, or duplicate publication during the declared observation window.

---

## 1. Exact inspected starting point

These facts were refreshed on 2026-08-17. FC-01A must query them again and write any drift before any edit or deployment.

| Fact | Inspected value |
|---|---|
| `origin/main` | `b489ac0be4a3ee3d5acd69e2fd05ba20a1d5bbd7` |
| `origin/codex/sophia-observability-v1` | `9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca` |
| merge base | `5d9a0b301368e5c881207231b3d16e8e09b5817c` |
| divergence | campaign branch 392 commits ahead, 73 commits behind `main` |
| existing PR | [#144](https://github.com/davidelaverga/Sophia-Agent/pull/144), open, non-draft, dirty/unmergeable |
| branch diff | 592 files, `+218,232 / -8,107` |
| observed content conflicts | 4 |

PR #144 cannot currently form a clean merge ref, so its head has no valid PR workflow result. It must not be merged directly.

The four content conflicts observed in a real clean merge dry-run are:

```text
COMPOUND_LOG.md
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_retrieval.py
backend/tests/test_artifacts_router.py
backend/tests/test_sophia_vision_tools.py
```

At the inspected anchors, ten other files changed on both lineages but auto-merge silently. They require the same semantic review as explicit conflicts:

```text
CLAUDE.md
README.md
backend/CLAUDE.md
backend/app/gateway/artifact_registry.py
backend/app/gateway/routers/artifacts.py
backend/packages/harness/deerflow/sophia/tools/start_builder_task.py
backend/tests/test_artifact_registry.py
backend/tests/test_builder_mem0_retrieval.py
backend/tests/test_sophia_middlewares.py
backend/tests/test_start_builder_task.py
```

Other release facts:

- PR #144 has an unresolved current-head P2 in which `aria-hidden` is treated as equivalent to visual hiding.
- PR #139 is an ancestor/superseded predecessor. It is not closed automatically.
- GitHub currently has no immutable Release or release tag for the deployed revisions.
- the latest repository campaign evidence records Render Gateway and LangGraph at `74b4966fe2f7a2e66e3e9b343584c98cbfa2e2ea`; this must be refreshed through Render;
- live `https://sophia-ei.com/api/app-version` reported Vercel build `7092042b13f3edc40468fd614685d7ede3b21f2a` and deployment `dpl_Bv2yaEMssrnz6JnGhQtsxP9RgQjR` during this audit;
- live Vercel has no frontend-file change relative to campaign HEAD, but it differs from current `main` in 43 frontend files, including auth, journal, artifact-library, and related tests;
- campaign HEAD `9ee901f...` is recorded as one commit beyond the latest Render campaign deployment;
- the current G-VIS history contains zero successful workflow runs and 62 failures; the latest failed without provider credentials, so it proves neither artifact quality nor a regression;
- the shared local worktree contains user-owned edits in `backend/tests/test_telegram_link_integration.py` and `voice/tests/test_dogfood_evaluation.py`.

The product is therefore split across three lineages:

1. canonical Git `main`;
2. live Render on the campaign lineage;
3. live Vercel on an older campaign-lineage SHA.

The integrated tree has never run anywhere. It is a new release candidate, not a mechanical continuation of current production.

---

## 2. Authority and evidence order

### 2.1 Target-design authority

Use this order:

1. this FC-01 specification for sequencing, scope, evidence, and promotion;
2. `Sophia_Repository_Strategy_Selective_Refoundation_2026-08-16.md` for the repository decision;
3. `M00_CURRENT_PRODUCTION_CAMPAIGN_CLOSEOUT(1).md` for the existing production campaign;
4. the Final Program Control Map and Evidence Protocol;
5. M01 only to define the next-campaign boundary and required handoff;
6. current source and tests for what the product actually does now.

Old architecture maps, comments, `CLAUDE.md`, and prompt prose do not override the approved plan. Root `CLAUDE.md` is materially stale; FC-01 may add a concise supersession/current-vs-target notice, but it must not pretend legacy behavior is already removed.

### 2.2 Runtime evidence authority

Use this order when deciding what actually happened:

1. Git tree/commit, image/build, migration, and deployment identity;
2. Sophia-owned database records, checkpoints, Builder events, manifests, mutation/publication receipts, artifact hashes, and local feedback;
3. browser-observed state plus service-owned health/version responses;
4. sanitized Render/Vercel logs;
5. LangSmith traces as supplemental timing/topology/debug evidence.

LangSmith may help diagnose a run. It may not decide whether an input was accepted, an artifact published, a session recovered, or the campaign passed. A trace outage must not change product truth.

### 2.3 Human authority

- **Davide** approves operational truth, semantic correctness, source/deployment identity, migrations, rollback, and final merge.
- **Luis** approves comprehension, accessibility, user control, presentation of failures/progress, and the real-product experience.
- The coding agent implements, tests, challenges evidence, and makes a recommendation. It does not promote itself.

---

## 3. Outcome

At `CAMPAIGN_COMPLETE`:

1. M00 is closed on the exact pre-convergence campaign lineage with either an approved artifact or the safe, causal closeout allowed by M00.
2. MEM-00 proves pending/rejected/unapproved inferred memory cannot reach any active runtime prompt/context.
3. every `main`-only commit, every campaign-only decision surface, and every conflict/silent overlap in the recomputed `SourceLock` have an explicit reconciliation disposition; the audited four conflicts and ten overlaps remain a named minimum set unless proven inapplicable by documented source drift;
4. already-applied migration bytes are unchanged, corrective SQL is forward-only, and clean-install plus upgrade-from-live-catalog rehearsals pass;
5. a fresh PR from the integration branch forms a merge ref and runs its release-critical checks;
6. the exact approved candidate tree is deployed and proven through authentication, text, Builder, artifact, journal/library, Gemini Live, cascade fallback, reconnect, memory isolation, observability-off, concurrency, and rollback scenarios;
7. the actual protected `main` merge tree is byte-identical to the approved candidate tree;
8. the exact merge SHA is live on every applicable surface and passes the short post-merge pack;
9. no hard-gate `UNKNOWN` or waiver remains;
10. the FC-02/M01 handoff contains exact current gaps and starts from the new `main` SHA.

---

## 4. Explicit non-goals

FC-01 does not:

- implement M01 tool-output budgeting;
- harden `str_replace` beyond a release-blocking fix already required by an observed FC-01 failure;
- implement Builder compaction;
- create durable input admission;
- create Companion/Gemini LangSmith tracing;
- create the vNext contracts/core/adapters packages;
- implement M02–M10;
- adopt or test another harness/executor;
- rebase on upstream DeerFlow;
- redesign Sophia’s prompts, skills, soul, voice, EI, Tone Scale, rituals, or `emit_artifact` path;
- redesign Builder orchestration or artifact authority;
- create paid infrastructure without approval;
- apply destructive/backward-incompatible migrations;
- rebase, squash, force-push, reset, rewrite history, or delete the historical branch;
- close PR #139 or #144 without explicit release housekeeping approval;
- use real user content, raw audio, or trace payloads as evidence.

Known M01 defects are not silently waived. They are characterized in FC-01 and become blocking FC-02 inputs. If one causes an FC-01 hard-gate failure, stop and decide whether the smallest release repair belongs in FC-01 or whether M01 must precede promotion. Do not absorb M01 opportunistically.

---

## 5. Campaign objects and persisted state

Each phase consumes the signed receipt of the prior phase. Do not rely on one coding-agent context window.

Immutable/versioned objects:

- `CampaignVersion` — digest of this file;
- `SourceLock` — `main`, campaign, merge-base, and tree identities;
- `DeploymentBaseline` — revisioned provider deploy/build/image IDs and rollback coordinates, with explicit `pre_m00` and signed `post_m00` revisions;
- `MigrationBaseline` — repository migration checksums and live catalog state;
- `AcceptanceBudget` — scenarios, numeric thresholds, severity rules, cost/deploy ceilings, approved identity;
- `ScenarioVersion` — exact text, Builder, M00, voice, fallback, and UI scripts;
- `CandidateVersion` — SHA/tree, migration head, images/builds, and policy flags;
- `RunReceipt` — canonical local IDs/outcomes plus supplemental evidence refs;
- `PromotionDecision` — deterministic result plus Davide/Luis decisions.

Persist phase state under:

```text
docs/campaigns/foundation-mainline-v1/
├── mission.md
├── state.md
├── decisions.md
├── experiments.jsonl
├── final-report.md
└── evidence/<experiment-id>/
```

Before the integration candidate exists, persist the sanitized, bounded campaign control record on a dedicated branch:

```text
campaign/fc01-control-v1
```

Create it from the frozen `main` SHA in a separate worktree. Its commits may touch only `docs/campaigns/foundation-mainline-v1/**`; large or access-sensitive provider evidence stays in an approved access-controlled store and is represented here only by immutable ID, digest, audience, retention class, and redacted summary. Record `control_branch_head` separately in each receipt. Evidence-only commits do not mutate or invalidate the product `SourceLock`.

During FC-01C, after creating the integration tree from `main` plus the frozen campaign lineage, import the reviewed control-branch commit range with path verification. Reject the import if any commit touches a path outside the campaign directory. Thereafter, append safe campaign records on the integration branch; if the control branch advances during a human pause, import only the newly reviewed evidence-only commits. The final merge therefore contains the bounded manifests, decisions, and receipts without making either frozen product branch the pre-convergence evidence home.

State machine:

```text
DRAFT
→ BASELINE_READY_FOR_APPROVAL
→ BASELINE_FROZEN
→ M00_RUNNING
→ M00_READY_FOR_REVIEW
→ M00_CLOSED
→ POST_M00_BASELINE_READY_FOR_SIGNATURE
→ POST_M00_BASELINE_FROZEN
→ INTEGRATION_CANDIDATE
→ MEM00_CLOSED
→ RELEASE_CHECKS_PASSED
→ CANDIDATE_PROVEN
→ ROLLBACK_PROVEN
→ READY_TO_MERGE
→ HUMAN_APPROVED
→ MAIN_MERGED
→ MAIN_PROVEN
→ CAMPAIGN_COMPLETE
```

Any phase may end `BLOCKED`, `FAILED_SAFELY`, or `ROLLED_BACK`.

The coding agent may produce a `*_READY_FOR_*` state and request a decision. It may not produce the corresponding `*_FROZEN`, `*_CLOSED`, `HUMAN_APPROVED`, or `CAMPAIGN_COMPLETE` state until the named human decisions are present in a checksum-bound receipt. Specifically:

- Davide and Luis sign the acceptance budget to advance `BASELINE_READY_FOR_APPROVAL → BASELINE_FROZEN`;
- both review the M00 result to advance `M00_READY_FOR_REVIEW → M00_CLOSED`;
- both sign the refreshed deployment/rollback coordinates to advance `POST_M00_BASELINE_READY_FOR_SIGNATURE → POST_M00_BASELINE_FROZEN`;
- both approve the exact promotion receipt before `READY_TO_MERGE → HUMAN_APPROVED`.

---

## 6. Hard invariants

### Repository and merge

- preserve user-owned dirty work by using a separate clean worktree/clone;
- never auto-stash, reset, or overwrite those files;
- review every file changed on both sides in the recomputed merge, including silent auto-merges; the audited four conflicts and ten overlaps are a required named minimum, not a fixed total;
- use no broad `ours`/`theirs` resolution;
- preserve both chronological compound logs;
- preserve mainline security/privacy/data-integrity fixes and campaign product behavior unless an explicit decision rejects one;
- preserve the historical campaign branch;
- if either source branch advances, invalidate the `SourceLock` and recompute;
- the tested/deployed/approved tree is explicit;
- the final merge tree equals the approved candidate tree.

### Migrations

- never alter the bytes of a migration proven applied in a governed persistent environment or bound into recorded release history; disposable local/test databases provide evidence but cannot redefine canonical migration history;
- establish the canonical applied checksum before restoring or changing repository bytes;
- express privilege/schema corrections in a new idempotent forward migration;
- prove clean install and upgrade from a schema-equivalent live fixture;
- all release changes are additive/backward-compatible with the rollback backend;
- code deployment is not treated as evidence that SQL ran;
- database down migration is not the rollback plan.

### Product truth

- no false feedback success;
- no failed Builder candidate becomes current or published;
- one Builder task has one truthful terminal;
- no duplicate artifact/version or orphaned work;
- no cross-user artifact/session exposure;
- no pending/rejected/unapproved inferred memory enters runtime context;
- Gemini Live remains primary and cascade fallback is tested separately;
- a reconnect never duplicates speech, fabricates completion, or leaks internal/tool-schema content;
- LangSmith failure cannot change the product terminal state;
- a service dashboard or health `200` alone is not proof.

### Evidence

- exact versions and SHA-256 bind every artifact;
- `UNKNOWN` blocks promotion;
- hard gates have no waiver;
- missing credentials produce `NOT_RUN`, never `PASS`;
- no raw secret, stable account ID, private memory, signed URL, raw audio, or unnecessary user content enters Git or LangSmith;
- large external evidence has an immutable ID, digest, retention class, and access policy.

---

## 7. FC-01A / BASE-00 — freeze truth and budgets

This phase is read-only except for campaign evidence files and a clean worktree. It must complete before code changes.

### 7.1 Required reconnaissance

1. Read every authority/instruction file in Section 20.
2. Refresh GitHub heads, merge base, divergence, PR #144/#139 state, reviews, workflows, branch protection, and deployment-trigger mappings.
3. Query current Render Gateway, LangGraph, and fallback Voice service deploy IDs, source SHAs, images/builds, status, branch, auto-deploy, health/readiness, and rollback candidates.
4. Query current Vercel production alias, build/source SHA, deployment ID, preview policy, auto-promotion behavior, and rollback candidate.
5. Query current migration/catalog state and backup/PITR readiness without printing secrets or database coordinates.
6. Verify the actual production checkpointer/store kinds. This is characterization only; M01 owns remediation unless current production is already falsely claiming durability.
7. Record LangSmith endpoint/project/routing key names and current Builder tracing behavior without exporting raw trace content.
8. Run the clean baseline release-critical suites and classify every failure as product, regression, pre-existing noncritical debt, missing credential, or test-infrastructure failure.
9. Inventory tracked `users/`, `backend/users/`, session/recap/trace files, secret-scan results, and Git-ignore coverage.
10. Record one exact rollback target for each production surface.

### 7.2 Service identity receipt

Normalize provider/application evidence into:

```text
service
commit_sha_or_provider_source_identity
deployment_id
build_or_image_digest nullable
boot_or_connection_epoch nullable
runtime_path
durable_store_kind nullable
status
not_applicable_reasons
observed_at
```

Fields unavailable or meaningless for Vercel/browser Gemini must be null with a reason, never fabricated.

### 7.3 Acceptance budget

Before any live candidate experiment, write `acceptance-budget.json` and obtain Davide’s operational approval plus Luis’s experience/accessibility approval.

Required frozen defaults:

- maximum two live release-candidate deployments;
- maximum one M00 runtime repair per artifact;
- maximum two engineering repair cycles for one release invariant;
- maximum three concurrent ordinary Builder tasks in the concurrency scenario;
- 20 consecutive low-risk synthetic text turns;
- two clean rolling boot/replacement cycles;
- 30-minute observation after the final scenario;
- three consecutive readiness successes at least 10 seconds apart;
- Render new deploy must become healthy inside Render’s documented 15-minute deployment window;
- zero unexpected 5xx, process crash/boot loop, uncaught browser exception, cross-user leak, orphaned task, duplicate terminal, or duplicate publication;
- zero unresolved P0/P1;
- zero mission-scope P2;
- a provider-spend ceiling and maintenance window explicitly entered and approved before execution;
- one named synthetic/internal identity; evidence stores only a campaign-specific salted fingerprint.

Severity rubric:

- `P0`: security/privacy breach, secret exposure, cross-user data, irreversible corruption, destructive migration, artifact/data loss, false publication/completion, unavailable rollback.
- `P1`: reproducible failure of auth, text, ordinary Builder, artifact retrieval, primary voice, fallback, startup/readiness, or an unexpected crash/5xx in the frozen envelope.
- `P2`: non-core but material UX, accessibility, control, observability, or fidelity defect inside the frozen envelope.
- `P3`: cosmetic or explicitly out-of-scope debt with no effect on the frozen envelope.

Only Davide and Luis may accept a pre-existing P3. It needs an issue, owner, expiry, affected path, and proof it is outside the release scenarios. No P0–P2 waiver exists.

### Gate G0 — baseline truth is complete

Pass only if:

- source/deployment/migration identities and rollback targets are known;
- the dirty worktree is isolated;
- evidence contains no secret/PII;
- acceptance budget and severity rubric are signed;
- every baseline failure has a classification;
- the next M00 action targets one exact campaign SHA/deployment.

---

## 8. FC-01B / M00 — close the existing campaign first

M00 must close before merging `main` or changing the Builder runtime it evaluates.

### 8.1 Establish the exact M00 lineage

- Reconcile current Render truth with the last recorded `74b4966...` deployment and campaign HEAD `9ee901f...`.
- If the approved M00 candidate is not deployed, run its local/release-critical gates, identify its exact rollback deployment, and request targeted deployment approval before changing production.
- Freeze the full PSI prompt from `docs/campaigns/deck-design-lift-v1/mission.md` and record its digest.
- Use one wholly fresh authenticated synthetic session.

### 8.2 Frozen M00 loop

```text
fresh native PPTX
→ mechanical gates
→ blind rendered judgment
→ at most one frozen manifest-addressed repair
→ mechanical recheck
→ fresh blind judgment
→ deterministic comparison
→ CAS commit or rollback
→ coding-agent self-review
→ Davide/Luis review
```

No hidden app retry is allowed.

### 8.3 M00 closure states

M00 closes in one of two ways allowed by its authority:

- `APPROVED_ARTIFACT`: the complete quality/publication/evidence contract passes.
- `FAILED_SAFELY_CAUSAL`: no failed candidate published, the repair ceiling held, immutable evidence identifies the actual boundary, rollback/current artifact truth is intact, and both human reviewers accept the closeout as a limitation rather than a successful product result.

A generic Builder crash, false “ready,” duplicate publication, missing exact SHA, incomplete evidence, or unexplained failure does not close M00.

### Gate G1 — M00 is closed

Pass only when M00’s mechanical/deterministic acceptance checks, complete evidence archive, coding-agent self-review, and the two human reviews are complete. Archive an observability-gap fixture, but do not add Companion/Gemini tracing here.

### 8.4 Refresh the release and rollback baseline

M00 can change what is actually deployed. Immediately after M00 closes, re-query every live surface and persist a signed `post_m00` `DeploymentBaseline` containing the active deployment/build/image identities, exact source SHA, schema/migration head, platform settings, and approved rollback coordinates.

- If M00 promoted and accepted `9ee901f...` or another exact campaign SHA, that accepted deployment becomes the default rollback baseline for the later convergence candidate.
- If M00 ended in an approved safe failure and production was restored, the restored exact deployment becomes the baseline.
- The earlier `pre_m00` baseline remains evidence and an emergency coordinate; it is not silently reused as the release rollback target.
- FC-01C cannot begin until Davide and Luis sign the post-M00 baseline and its evidence checksums.

---

## 9. MEM-00 — narrow memory visibility gate inside FC-01C

This is a privacy/correctness gate, not the M09 memory redesign. BASE-00 may characterize the two source lineages independently, but no MEM-00 implementation or closure occurs before convergence: the required behavior depends on composing main’s contamination protections with the campaign branch’s task-aware filtering. Implement and prove it only after the integration merge exists in FC-01C.

Required behavior:

- pending, rejected, discarded, and unapproved inferred memory cannot enter text Companion retrieval, Gemini setup/dynamic voice context, Builder context, smart openers, handoffs, or identity updates;
- explicit user utterance, approved durable fact, project context, and explicit preference remain distinguishable and available under policy;
- the mainline memory-contamination fix and campaign task/query-aware style filtering are composed rather than choosing one side;
- Builder receives only authorized work context, not relational/vulnerable content.

Required regression:

1. execute or replay the established OpenClaw task fixture;
2. start the unrelated Hermes task fixture;
3. prove no stale task history/style contaminates Hermes;
4. prove approved durable facts/project/preferences remain available;
5. prove pending/rejected hypotheses remain absent in text, voice, Builder, opener, handoff, and identity projections.

### Gate G2 — memory visibility is safe

Pass only on the composed integration tree, when leak count is zero and retention of allowed facts/preferences is proven. No broad Mem0 replacement belongs here.

---

## 10. FC-01C / CONVERGE — create the integration candidate

### 10.1 Branch law

- use a separate clean worktree or clone;
- create `integrate/fc01-stable-mainline-v1` from refreshed `origin/main`;
- merge the frozen campaign SHA with `--no-ff` and history preserved;
- do not rebase, squash, force-push, reset, or delete either lineage;
- do not merge PR #144 directly;
- open a new clean PR after reconciliation;
- leave #139/#144 closure to human release housekeeping.

### 10.2 Reconciliation ledger

Every main-only commit, campaign-only judgment surface, conflict, and silent overlap receives:

```text
item_id
commit_or_path
origin: main_only | campaign_only | conflict | silent_overlap
disposition: preserved | already_equivalent | integrated_manually | deferred | rejected
rationale
authority_source
tests_or_evidence
review_status
```

Specific merge rules for the audited minimum set:

- `mem0_retrieval.py`: preserve main’s emotional-noise/stale-task rejection and campaign’s task/query-aware style filtering;
- `COMPOUND_LOG.md`: preserve both chronological histories;
- `test_artifacts_router.py`: preserve authenticated artifact ownership coverage;
- `test_sophia_vision_tools.py`: preserve exact current response-payload validation;
- all audited silent overlaps, plus any newly discovered overlap after refresh: inspect behavior and tests explicitly; Git auto-merge is not approval.

### 10.3 Migration immutability

The campaign branch modifies three historical files:

```text
backend/migrations/2026_04_25_telegram_user_bindings.sql
backend/migrations/2026_05_26_sophia_session_transcripts.sql
backend/migrations/2026_06_12_artifact_registry_records.sql
```

For each governed persistent environment and recorded release, prove which checksum actually ran. Never change those proven-applied/released bytes. Preserve that canonical historical file and move required transaction/privilege/schema-reload convergence into a new idempotent forward-only `2026_08...` migration. Disposable local/test databases are rehearsal evidence only and do not gain authority to freeze divergent migration bytes.

The branch also adds ten July migrations. Rehearse:

1. clean install from empty database;
2. upgrade from a sanitized/schema-equivalent live catalog;
3. repeated idempotent application where designed;
4. old deployed code against the expanded schema;
5. backup/PITR readiness without performing a destructive restore.

### 10.4 Release-blocking truth repairs only

Allowed repairs are limited to:

- merge/conflict integration;
- immutable migration correction;
- the open `aria-hidden`/visual-hiding defect and regression;
- false feedback success (`frontend` must not turn a backend 404 into stored feedback);
- service/deployment identity evidence needed for release proof;
- unit-test isolation from LangSmith/network;
- CI necessary to evaluate the actual merge ref;
- security/privacy/data-integrity defects discovered by frozen gates;
- exact failures in the release scenarios.

Every other finding goes to FC-02 or the backlog.

MEM-00 is the first bounded release repair after semantic reconciliation. Run its regression before freezing the candidate; a failure may receive only the same smallest-reviewable repair discipline as every other FC-01 gate.

### 10.5 CI policy

Release-critical blocking checks:

- backend lint and the full backend unit/contract suite in the declared `uv` environment;
- frontend typecheck, production build, and all unit/E2E tests covering FC-01 scenarios;
- Voice tests covering Gemini primary/fallback, reconnect, normalization, and visibility;
- migration checksum/order/clean-install/upgrade tests;
- production Docker builds plus image boot/readiness smoke for Gateway, LangGraph, and fallback Voice;
- Sentrux on the fresh merge ref;
- secret/privacy/tracked-runtime-data scan;
- all deterministic tests with outbound LangSmith/observability network disabled.

A pre-existing noncritical failure outside this set may remain only as a signed P3 entry under Section 7.3. A missing credential or skipped live evaluator is `NOT_RUN`, never green. G-VIS becomes evidence only after a credentialed lane actually executes.

### Gate G3 — one reviewable candidate

Pass only if:

- the reconciliation ledger has no unclassified item;
- migration gates pass;
- release-critical checks pass;
- no P0–P2 remains in the frozen envelope;
- the fresh PR forms a merge ref and required workflows actually execute;
- candidate SHA/tree and rollback coordinates are frozen;
- there is no unrelated M01–M10 implementation.

---

## 11. FC-01D / RELEASE — exact-SHA product proof

### 11.1 Candidate deployment

Prefer existing preview/staging resources. Do not create paid infrastructure. If no isolated production-shaped environment exists, prepare the exact maintenance-window plan and obtain Davide’s approval before changing live aliases.

Deployment order is derived from a frozen N/N-1 compatibility matrix. Use expand-only migrations and deploy one dependency surface at a time. Do not blindly assume Gateway-first or LangGraph-first. Record the order and reverse rollback order before acting.

Render/Vercel must identify an exact candidate, not a floating branch name. Where a runtime lacks a content-free commit endpoint, provider deployment metadata is the identity authority.

### 11.2 Frozen product scenarios

Run through `sophia-ei.com` or the exact production candidate alias with one approved synthetic identity.

#### S01 — surface, auth, and main-only UI

- verify frontend/Gateway/LangGraph/fallback-Voice identity and readiness;
- load signed-out surface;
- login, create session, refresh, logout/login;
- exercise journal and artifact-library surfaces introduced/changed on `main`;
- zero unexpected browser exception, auth loop, cross-user result, or unexplained 5xx.

#### S02 — text continuity and reconnect

Frozen input:

> I have thirty minutes before my next meeting. Help me choose one small, realistic thing to finish.

After reload:

> What did we decide was the smallest next step?

Required: one visible response per input, coherent reload, no duplicate message, no stack trace, and UI/canonical session agreement under the current architecture. This does not claim M01 admitted-input crash durability.

#### S03 — ordinary Builder completion

Frozen prompt:

> Create a downloadable Markdown artifact titled “Foundation Smoke Test.” Include exactly three sections: Goal, Constraints, and Next Step. Keep each section to one short paragraph.

Required: one task, one truthful terminal, one current artifact/version, correct format/content, reload/download success, and no duplicate terminal/publication.

#### S04 — artifact ownership and continuity

- reopen S03 through the library/canvas route;
- verify owner access and another synthetic principal’s denial;
- refresh/reconnect during one active ordinary build;
- recover honest status without duplicate phase, terminal, or artifact.

#### S05 — M00 non-regression

Run the same frozen M00 PSI prompt once against the integrated candidate under the same one-repair ceiling. It must not regress M00 safety/publication invariants. If the pre-convergence outcome was `FAILED_SAFELY_CAUSAL`, the candidate must fail at the same or better understood boundary without a new failure family; humans decide whether the known limitation remains acceptable.

#### S06 — Gemini Live primary

- connect through the browser-owned Gemini Live path;
- complete two short exchanges;
- barge in once;
- break/restore the provider WebSocket;
- continue the same logical session;
- no duplicate/stale speech, fabricated completion, or internal/tool-schema leakage;
- no raw audio recording/upload.

Suggested script:

1. “Help me decide whether to write for ten minutes or take a short walk first.”
2. Barge in: “Pause—give me just one sentence.”
3. Reconnect: “What did I ask you to keep brief?”

#### S07 — cascade fallback

Use a supported canary flag/route, never broken credentials. Complete one exchange, prove `runtime_path=cascade_fallback`, and report latency/errors separately from Gemini Live.

#### S08 — memory isolation

Repeat the approved MEM-00 OpenClaw→Hermes regression through the candidate application path.

#### S09 — bounded Builder concurrency

Run three distinct ordinary Builder tasks. Each produces one terminal outcome. Orphaned task count, duplicate terminal count, and cross-task artifact association count are all zero.

#### S10 — feedback truth with observability off

Submit one frozen thumbs-up or thumbs-down response through the deployed feedback control while LangSmith is disabled or unavailable.

Required outcome is exactly one of:

- Sophia-owned local persistence succeeds once and is visible after reload through the authorized product path; or
- the control reports feedback unavailable/not saved and stores no false success state.

A frontend proxy that converts backend `404`, transport failure, or missing persistence into success fails this scenario. LangSmith feedback alone is not product persistence proof.

#### S11 — observability-off behavior

Disable or block LangSmith in a candidate environment using supported configuration/fault injection. Repeat one text and one ordinary Builder path. Product outcome class, terminal truth, artifact count, and local records remain valid. This does not add new Companion/Gemini tracing; it proves existing observability is non-authoritative.

#### S12 — 20-turn bounded continuity

Complete 20 consecutive low-risk synthetic text turns across at least two sessions. Require no unexpected 5xx, crash, duplicate/lost visible message, cross-session contamination, or unhandled browser error.

### 11.3 Rolling replacement and soak

Distinguish a provider rolling replacement from abrupt crash recovery. FC-01 requires only current-release rolling replacement:

- two clean backend boot/replacement cycles at the exact candidate;
- three readiness successes 10 seconds apart after each;
- short auth/text/artifact-read smoke after each;
- no in-flight test work at observation start;
- 30-minute final observation;
- no unexpected process restart/boot loop, unexplained 5xx, dangling task, or duplicate publication.

Abrupt post-admission/process-kill recovery, idempotent durable input, unknown external-effect reconciliation, Builder compaction, and oversized tool-output recovery are FC-02/M01 or later gates. FC-01 must not claim them.

### Gate G4 — candidate is proven

Pass only if S01–S12, rolling replacement, and soak satisfy the signed budget at one exact candidate tree; evidence contains zero P0–P2 and no hard-gate `UNKNOWN`.

---

## 12. Actual rollback and re-promotion

Before `READY_TO_MERGE`, and only with the required production authority:

1. record active candidate deploy/build identities and current platform auto-deploy/alias settings;
2. roll Vercel and applicable Render services to the signed post-M00 release baseline (retain the pre-M00 coordinates only as separately approved emergency evidence);
3. verify baseline identities and short health/auth/text/artifact-read smoke;
4. prove the old backend works with the additive schema;
5. re-promote the exact candidate;
6. rerun identity/auth/text/Gemini-connect/cascade/artifact-read smoke;
7. restore and record auto-deploy/production-domain settings.

Render rollback does not roll back disks or arbitrary current configuration. Vercel instant rollback changes production-domain assignment until another deployment is promoted. Database rollback is compatibility, not destructive down migration.

### Gate G5 — rollback is real

Pass only if the prior release and re-promoted candidate are each identified exactly and both short smokes pass without schema/data loss.

---

## 13. Human promotion, merge, and post-merge proof

At G5 the coding agent publishes `READY_TO_MERGE` and stops.

Davide reviews operational/semantic truth. Luis reviews comprehension, accessibility, user control, progress/failure presentation, and artifacts/voice experience. Both decisions are recorded.

After explicit approval:

1. refresh `main`;
2. if it moved, reconcile and rerun affected gates;
3. merge through the protected fresh PR using a merge commit;
4. prove the actual merge commit tree is byte-identical to the approved candidate tree;
5. record exact `main` merge SHA;
6. deploy that SHA to all applicable production surfaces;
7. verify identities;
8. rerun short post-merge pack: S01, one S02 turn/reload, S03 artifact read, S06 connect/reconnect, S07 fallback, S10 feedback truth, and S11 observability-off invariant;
9. observe 30 minutes;
10. publish `CAMPAIGN_COMPLETE` only if the actual merge SHA passes.

On failure: stop traffic where possible, roll provider deployments to the captured baseline, preserve additive migrations, and use a new `git revert -m 1 <merge_sha>` PR if code reversal is needed. Never reset or force-push `main`.

---

## 14. Evidence archive and offline evaluator

Each experiment contains:

```text
README.md
campaign-manifest.json
acceptance-budget.json
source-lock.json
provider-baseline.json
post-m00-provider-baseline.json
migration-baseline.json
baseline-test-classification.json
m00-proof.json
mem00-proof.json
reconciliation-ledger.json
conflict-resolution.md
migration-proof.json
ci-summary.json
deployment-manifest.json
scenario-matrix.json
browser-summary.json
render-vercel-log-summary.json
langsmith-trace-index.json
observability-off-proof.json
rollback-proof.json
privacy-scan.json
limitations.md
promotion-decision.json
SHA256SUMS
```

Gate records contain:

```text
gate_id
requirement
status: PASS | FAIL | UNKNOWN | NOT_RUN | NOT_APPLICABLE
candidate_sha
deployed_sha nullable
command_or_scenario
exit_code_or_result
timestamp
evidence_path
external_evidence_id nullable
waiver
```

Hard gates require `waiver: null`.

Add a deterministic offline evaluator, for example:

```bash
python scripts/evaluate_foundation_campaign.py \
  docs/campaigns/foundation-mainline-v1/evidence/<experiment-id>
```

It runs without network or LangSmith and verifies required files, schemas, checksums, exact identities, no hard `UNKNOWN/NOT_RUN`, zero P0–P2, privacy result, rollback proof, and terminal-state consistency. It does not infer missing evidence or judge prose quality.

---

## 15. Engineering repair loop

For each failure:

```text
observe exact failure
→ bind it to one invariant and candidate
→ state one causal hypothesis
→ make one smallest reviewable repair
→ rerun failed gate
→ rerun regression neighborhood
→ persist result
```

Limits:

- one M00 artifact repair per runtime artifact;
- one production repair between candidate experiments;
- two live candidate deployments maximum;
- two engineering repair cycles for the same invariant maximum;
- one fault/changed variable at a time;
- no opportunistic refactor;
- no hidden application or test retry;
- changed input/model/environment/rubric creates a new version.

Repeated failure stops `BLOCKED`; it does not widen FC-01 into M01.

---

## 16. Privacy and repository hygiene

- one approved synthetic identity; only salted campaign fingerprint in evidence;
- no real conversations, memories, journals, recaps, artifacts, or raw audio as fixtures;
- no credentials, cookies, auth headers, database coordinates, signed URLs, private prompts, full memories, provider payloads, or artifact bodies in Git/LangSmith evidence;
- inspect tracked `users/`, `backend/users/`, session, recap, and trace files;
- replace real content in the candidate with synthetic fixtures and prevent recurrence;
- if real secret or personal data is found in history: stop, rotate/revoke as needed, and request a separate history-remediation plan; do not rewrite history here;
- LangSmith references use only allowlisted metadata and purpose-specific non-identifying tokens;
- browser/public trace/project/tenant claims are not treated as authority;
- abrupt destructive faults are not injected into live production.

---

## 17. External mutation authority

The coding agent may:

- inspect GitHub, Render, Vercel, LangSmith, database metadata, and the Sophia site;
- create a clean worktree, branches, commits, evidence, and a fresh PR;
- run local/container/CI tests and use existing non-production resources within the signed budget.

Davide’s explicit target-specific approval is required before:

- production promotion, intentional rollback, or stateful service restart;
- merging to `main`;
- new paid infrastructure;
- production secret/identity/retention/billing changes;
- destructive/backward-incompatible migration;
- credential rotation;
- history rewrite;
- deletion/closure of branches, PRs, services, data, or evidence.

The approval request names exact targets, candidate/deploy IDs, rollback targets, expected impact, maintenance window, and abort condition.

---

## 18. Stop conditions

Stop `BLOCKED` when:

- any source/deployed SHA or rollback target cannot be proven;
- source heads move after freeze without recomputation;
- applied migration checksum/ownership is ambiguous;
- a migration requires destructive change;
- a conflict/silent overlap lacks a source/test-backed decision;
- real secret/PII appears in current tree/evidence/history;
- M00 cannot close under its own contract;
- pending/rejected memory reaches runtime context;
- auth/session/artifact ownership or ordinary Builder fails;
- LangSmith failure changes product truth;
- candidate and merge trees differ;
- required live evaluator is `NOT_RUN`;
- any P0/P1 or mission-scope P2 remains;
- the same invariant fails after two scoped repairs;
- two live candidates fail;
- success would require M01–M10, a new executor, paid infrastructure, or ungranted destructive authority.

Preserve evidence and roll back any affected candidate. Ask only for the smallest next decision.

---

## 19. Definition of Done and FC-02 handoff

```text
READY_TO_MERGE =
  G0 ∧ G1 ∧ G2 ∧ G3 ∧ G4 ∧ G5
  ∧ offline_evaluator_PASS
  ∧ privacy_PASS
  ∧ P0 = 0
  ∧ P1 = 0
  ∧ mission_scope_P2 = 0
  ∧ hard_UNKNOWN = 0
  ∧ hard_NOT_RUN = 0
  ∧ hard_waiver = 0

CAMPAIGN_COMPLETE =
  READY_TO_MERGE
  ∧ Davide_APPROVED
  ∧ Luis_APPROVED
  ∧ protected_merge
  ∧ approved_tree_equals_merge_tree
  ∧ exact_main_SHA_deployed
  ∧ post_merge_pack_PASS
  ∧ post_merge_observation_PASS
```

FC-01 produces `fc02-m01-handoff.md` tied to the final `main` SHA. It must contain exact source paths, tests, current failures, and acceptance gaps for:

- tool-output budget;
- safe `str_replace`;
- Builder compaction;
- production Postgres fail-closed proof;
- durable input admission;
- Companion/Gemini/Builder observability trust boundary;
- local-first feedback;
- first vNext contracts/core/adapters dependency seam.

No FC-02 implementation is included in the FC-01 merge.

---

## 20. Required reading — exact paths

### 20.1 Planning authority

```text
/workspace/scratch/d7c999162db4/deliverables/Sophia_FC01_Stable_Mainline_Convergence_and_Release_Proof_2026-08-17.md
/workspace/scratch/d7c999162db4/deliverables/Sophia_Repository_Strategy_Selective_Refoundation_2026-08-16.md
/workspace/scratch/d7c999162db4/final_planning_pack/00_Sophia_Final_Program_Control_Map_2026-08-10.md
/workspace/scratch/d7c999162db4/final_planning_pack/07_Sophia_Synthetic_Vertical_Campaign_and_Evidence_Protocol_2026-08-10.md
/workspace/scratch/d7c999162db4/final_planning_pack/09_Sophia_Future_Spec_Authoring_Contract_2026-08-10.md
/workspace/scratch/d7c999162db4/library_missing_specs/Sophia/M00_CURRENT_PRODUCTION_CAMPAIGN_CLOSEOUT(1).md
/workspace/scratch/d7c999162db4/reference_specs/Sophia/M01_RUNTIME_RELIABILITY_AND_DURABLE_INPUT(1).md
```

If missing, ask Davide to attach the exact file. Do not reconstruct it from memory.

### 20.2 Current repository/deployment paths

```text
AGENTS.md
CLAUDE.md
backend/AGENTS.md
backend/CLAUDE.md
frontend/AGENTS.md
frontend/CLAUDE.md
COMPOUND_LOG.md
render.yaml
vercel.json
frontend/vercel.json
backend/pyproject.toml
backend/Makefile
frontend/package.json
voice/requirements.txt
voice/requirements-dev.txt
.github/workflows/backend-unit-tests.yml
.github/workflows/memory-highlights-e2e.yml
.github/workflows/sentrux-gate.yml
.github/workflows/visual-evals.yml
backend/app/gateway/app.py
backend/app/gateway/artifact_registry.py
backend/app/gateway/routers/artifacts.py
backend/packages/harness/deerflow/agents/sophia_agent/agent.py
backend/packages/harness/deerflow/agents/sophia_agent/builder_agent.py
backend/packages/harness/deerflow/agents/sophia_agent/builder_middlewares.py
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_memory.py
backend/packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_retrieval.py
backend/packages/harness/deerflow/sophia/mem0_client.py
backend/packages/harness/deerflow/sophia/offline_pipeline.py
backend/packages/harness/deerflow/sophia/extraction.py
backend/packages/harness/deerflow/sophia/identity.py
backend/packages/harness/deerflow/sophia/tools/start_builder_task.py
backend/packages/harness/deerflow/sophia/build_manifest.py
backend/packages/harness/deerflow/sophia/build_runtime/events.py
backend/packages/harness/deerflow/sophia/build_mutation.py
backend/packages/harness/deerflow/sophia/observability.py
frontend/src/app/api/app-version/route.ts
frontend/src/app/api/health/route.ts
frontend/src/app/api/conversation/feedback/route.ts
frontend/src/app/components/FeedbackStrip.tsx
frontend/src/app/lib/api/feedback.ts
frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts
voice/realtime/gemini_live.py
voice/realtime/gemini_browser_dogfood.py
voice/realtime/gemini_tool_loop.py
voice/realtime/smoke_harness.py
docs/ops/langsmith-traces.md
```

### 20.3 M00, tests, migrations, and next-campaign references

```text
docs/campaigns/deck-design-lift-v1/mission.md
docs/campaigns/deck-design-lift-v1/state.md
docs/campaigns/deck-design-lift-v1/decisions.md
docs/campaigns/deck-design-lift-v1/evidence/dq2-psi-agent-architecture-20260730t092401z/
frontend/tests/e2e/auth-real-login.spec.ts
frontend/tests/e2e/text-voice-text-continuity.spec.ts
frontend/tests/e2e/voice-webrtc.spec.ts
frontend/tests/e2e/builder-live-status.spec.ts
voice/tests/test_server_readiness.py
voice/tests/test_realtime_normalizer.py
voice/tests/test_realtime_dogfood_session.py
voice/tests/test_artifact_visibility_proof.py
backend/migrations/2026_04_25_telegram_user_bindings.sql
backend/migrations/2026_05_26_sophia_session_transcripts.sql
backend/migrations/2026_06_12_artifact_registry_records.sql
/workspace/scratch/d7c999162db4/project_sources/09-sophia_spec_0_durable_build_state_postgres.md
/workspace/scratch/d7c999162db4/project_sources/11-sophia_tool_output_budget_spec.md
/workspace/scratch/d7c999162db4/project_sources/12-sophia_spec_2_builder_compaction.md
/workspace/scratch/d7c999162db4/project_sources/14-sophia_spec_1_harden_str_replace.md
```

The four project-source specs are FC-02 handoff references, not FC-01 implementation authority.

### 20.4 GitHub and official operations references

```text
https://github.com/davidelaverga/Sophia-Agent/tree/main
https://github.com/davidelaverga/Sophia-Agent/tree/codex/sophia-observability-v1
https://github.com/davidelaverga/Sophia-Agent/pull/144
https://github.com/davidelaverga/Sophia-Agent/pull/139
https://github.com/davidelaverga/Sophia-Agent/pull/137
https://render.com/docs/deploys
https://render.com/docs/health-checks
https://render.com/docs/rollbacks
https://vercel.com/docs/git
https://vercel.com/docs/deployments/promoting-a-deployment
https://vercel.com/docs/instant-rollback
https://docs.langchain.com/langsmith/log-traces-to-project
https://docs.langchain.com/langsmith/add-metadata-tags
https://docs.langchain.com/langsmith/distributed-tracing
https://docs.langchain.com/langsmith/access-current-span
https://docs.langchain.com/langsmith/mask-inputs-outputs
https://docs.langchain.com/langsmith/redact-secrets
```

No external harness repository is required for FC-01. The strategic harness research is already incorporated into the repository decision; reopening it would dilute the release mission.

---

## 21. Exact coding-agent prompts

Use one prompt per persisted phase. Attach this specification and the required planning files every time. The first prompt below is the prompt to use now.

### Prompt 1 — start FC-01A / BASE-00

```text
You are the implementation and release agent for Sophia FC-01 — Stable Mainline Convergence and Release Proof.

Execute only FC-01A / BASE-00 in this turn. Do not edit product code, create the integration merge, deploy, restart, roll back, or change production settings yet.

GOAL

Produce a complete, sanitized, versioned SourceLock, DeploymentBaseline, MigrationBaseline, clean test baseline, acceptance-budget draft, and exact M00 execution proposal. Leave the campaign in `BASELINE_READY_FOR_APPROVAL` or `BLOCKED` with evidence sufficient for Davide and Luis to decide whether to sign the budget and advance it to `BASELINE_FROZEN`.

READ COMPLETELY BEFORE ACTING

1. `/workspace/scratch/d7c999162db4/deliverables/Sophia_FC01_Stable_Mainline_Convergence_and_Release_Proof_2026-08-17.md`
2. `/workspace/scratch/d7c999162db4/deliverables/Sophia_Repository_Strategy_Selective_Refoundation_2026-08-16.md`
3. `/workspace/scratch/d7c999162db4/final_planning_pack/00_Sophia_Final_Program_Control_Map_2026-08-10.md`
4. `/workspace/scratch/d7c999162db4/final_planning_pack/07_Sophia_Synthetic_Vertical_Campaign_and_Evidence_Protocol_2026-08-10.md`
5. `/workspace/scratch/d7c999162db4/final_planning_pack/09_Sophia_Future_Spec_Authoring_Contract_2026-08-10.md`
6. `/workspace/scratch/d7c999162db4/library_missing_specs/Sophia/M00_CURRENT_PRODUCTION_CAMPAIGN_CLOSEOUT(1).md`
7. `/workspace/scratch/d7c999162db4/reference_specs/Sophia/M01_RUNTIME_RELIABILITY_AND_DURABLE_INPUT(1).md` only to define what FC-01 must defer and hand off.
8. Every applicable `AGENTS.md` and `CLAUDE.md`, using FC-01’s authority/supersession rule.

If a required planning file is missing, stop and ask for that exact file. Do not recreate it from memory.

STARTING ANCHORS — REFRESH THEM

- `main`: `b489ac0be4a3ee3d5acd69e2fd05ba20a1d5bbd7`
- campaign: `9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca`
- merge base: `5d9a0b301368e5c881207231b3d16e8e09b5817c`
- divergence: campaign 392 ahead / 73 behind
- PR #144 is dirty and is not the merge vehicle
- live Vercel was observed at build `7092042b13f3edc40468fd614685d7ede3b21f2a`, deployment `dpl_Bv2yaEMssrnz6JnGhQtsxP9RgQjR`
- last repository Render evidence points to `74b4966fe2f7a2e66e3e9b343584c98cbfa2e2ea`, but provider truth must be re-queried
- the shared checkout has user-owned changes; do not stash/reset/overwrite them

WORK

1. Read instructions and report source/spec drift.
2. Fetch/read GitHub state and re-resolve heads, merge base, divergence, PRs/reviews/checks, branch protections, and deployment triggers.
3. Inspect Render, Vercel, LangSmith routing, and the Sophia application. Record exact current deployment IDs, source SHAs, build/image IDs when available, service status, branches, auto-deploy settings, and rollback candidates. Never print secrets.
4. Inspect migration files, live catalog/migration state, and backup/PITR readiness without destructive action or credential extraction.
5. Inspect actual production checkpointer/store kinds as characterization only.
6. Create a separate clean worktree/clone for read-only baseline tests. Do not touch the shared dirty files.
7. Run and classify the current release-critical test/lint/build baseline. Deterministic tests must not call LangSmith or external providers. Do not repair failures in this phase.
8. Inventory the four explicit conflicts, ten silent overlaps, three rewritten historical migrations, current P2 review, tracked runtime/user files, and secret/privacy findings.
9. From the frozen `main` SHA, create a separate `campaign/fc01-control-v1` worktree/branch. Create `docs/campaigns/foundation-mainline-v1/` there with mission/state/decisions/experiments and one evidence directory. Commit and push only sanitized files under that directory; record the control-branch commit. Large/sensitive evidence is referenced by approved immutable ID and digest, not committed. Evidence changes only are allowed.
10. Write `source-lock.json`, `provider-baseline.json`, `migration-baseline.json`, `baseline-test-classification.json`, and a draft `acceptance-budget.json` following FC-01.
11. Prepare the exact M00 next action: target SHA/deployment, frozen prompt digest, synthetic identity fingerprint method, provider-spend ceiling proposal, maintenance window, rollback deploy IDs, abort conditions, and any approval required.
12. Run the offline privacy/checksum validation over the evidence you created.

CONSTRAINTS

- No product-code edit.
- No product-lineage merge/rebase/squash/force push/reset/stash. The dedicated evidence-only control branch and its bounded commits are explicitly allowed.
- No deployment, restart, rollback, production alias, secret, billing, retention, identity, or migration mutation.
- No raw user content, audio, secrets, signed URLs, stable account IDs, or raw traces in evidence.
- No external harness research.
- Do not implement M01–M10.
- `UNKNOWN` remains blocking.

FINAL RESPONSE

Return exactly `BASELINE_READY_FOR_APPROVAL` or `BLOCKED`.

Include:

- exact source heads and divergence;
- exact deployment/rollback identities per surface;
- migration/catalog summary and historical-migration checksum risk;
- classified test/CI baseline;
- dirty-worktree isolation proof;
- evidence path and checksum/evaluator result;
- draft acceptance budget and severity table;
- exact M00 action proposed;
- approvals needed from Davide and Luis;
- every unresolved unknown or blocker.

Do not claim `BASELINE_FROZEN` or begin FC-01B until the two human approvals and signed acceptance budget are recorded.
```

### Prompt 2 — resume FC-01B / M00

```text
Resume Sophia FC-01 from the attached human-signed `BASELINE_FROZEN` receipt. Verify its checksums and re-resolve any mutable external state. Execute only the M00 portion of FC-01B exactly as specified on the frozen campaign lineage. Do not create the integration merge, implement MEM-00, refresh/freeze the post-M00 baseline before human M00 review, or implement M01–M10. Respect the M00 one-repair ceiling. Stop at `M00_READY_FOR_REVIEW`, `BLOCKED`, `FAILED_SAFELY`, or `ROLLED_BACK`, with a complete evidence delta and the exact Davide/Luis decisions required. Do not claim `M00_CLOSED` yourself.
```

### Prompt 3 — after M00 review, refresh the baseline

```text
Davide and Luis have completed the attached M00 review and the checksum-bound receipt is `M00_CLOSED`. Re-verify the receipt, active product surfaces, schema/migration head, platform settings, and exact accepted/restored deployment identities. Execute only FC-01B Section 8.4: produce the post-M00 deployment/rollback baseline and request both signatures. Do not create the integration merge, implement MEM-00, deploy, roll back, or implement M01–M10. Stop at `POST_M00_BASELINE_READY_FOR_SIGNATURE` or `BLOCKED`. Do not claim `POST_M00_BASELINE_FROZEN` until both signatures are recorded.
```

### Prompt 4 — resume FC-01C / CONVERGE + MEM-00

```text
Resume Sophia FC-01 from the attached signed `M00_CLOSED` and `POST_M00_BASELINE_FROZEN` receipts. Verify checksums and current branch heads. Execute only FC-01C: create a clean integration branch from current `main`, merge the frozen campaign SHA with history preserved, import the reviewed evidence-only control-branch commits after proving they touch only `docs/campaigns/foundation-mainline-v1/**`, semantically resolve every conflict and review every silent overlap in the recomputed merge, implement and prove MEM-00 on the composed tree, preserve governed applied/released migration bytes and add only forward corrections, fix only FC-01 release blockers, establish the fresh PR and release-critical checks, and freeze one candidate. The audited four conflicts and ten overlaps in Section 1 are a required minimum set, not a hardcoded total. Do not deploy or merge to `main`. Do not implement M01–M10. Stop at `RELEASE_CHECKS_PASSED` or `BLOCKED` with the complete reconciliation/memory/migration/CI evidence.
```

### Prompt 5 — resume FC-01D / RELEASE

```text
Resume Sophia FC-01 from the attached signed `RELEASE_CHECKS_PASSED` receipt and frozen candidate. Verify checksums and external state. Execute FC-01D only within the recorded authority: deploy the exact candidate, run S01–S12, rolling replacement, soak, observability-off proof, actual approved rollback to the signed post-M00 baseline and re-promotion, and the offline evaluator. Stop at `READY_TO_MERGE`, `BLOCKED`, `FAILED_SAFELY`, or `ROLLED_BACK`. Do not merge to `main` until Davide and Luis explicitly approve the exact promotion receipt.
```

### Prompt 6 — after human approval

```text
Davide and Luis have approved the attached Sophia FC-01 promotion receipt. Re-verify their decisions, evidence checksums, branch heads, and candidate tree. If `main` moved, reconcile and rerun affected gates. Merge through the protected fresh PR with history preserved, prove the merge tree equals the approved candidate tree, deploy the exact resulting `main` SHA, run the short post-merge pack and 30-minute observation, and publish either `CAMPAIGN_COMPLETE` or `ROLLED_BACK`. Never reset/force-push main or run a destructive down migration.
```

---

## 22. Honest final reflection

This campaign is still substantial because the current state is not one branch waiting for a button; it is a convergence of Git `main`, a live Render lineage, a different live Vercel lineage, historical database changes, and an unfinished production-quality campaign.

The important restraint is what FC-01 now refuses to do. It does not use the merge as an excuse to begin the new control plane. It produces the one thing the next architecture needs most: a canonical, reversible, evidence-backed `main` whose current limitations are named rather than hidden.

FC-02 can then implement M01 as a clean foundation mission instead of mixing new durability semantics into a 592-file release candidate.
