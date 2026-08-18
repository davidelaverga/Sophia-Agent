# Sophia FC-01 — Davide-Only Continuation Mission and Coding-Agent Prompt

**Date:** 2026-08-17  
**Owner and sole approval authority:** Davide Laverga  
**Repository:** `davidelaverga/Sophia-Agent`  
**Control branch:** `campaign/fc01-control-v1`  
**Expected control head at handoff:** `ab21d3ab94acc4f5d0909cb8da021a061dc8b73b`  
**Frozen product source:** `codex/sophia-observability-v1` at `9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca`  
**Frozen main reference:** `b489ac0be4a3ee3d5acd69e2fd05ba20a1d5bbd7`

## 1. Direct owner decision

Davide is the sole product owner and approval authority for this FC-01 campaign. Luis is not an approver, is not part of a required quorum, and cannot block the campaign. Experience and accessibility quality remain hard evidence gates, but they are verified by tests and reviewed by Davide.

By giving this file and the prompt in Section 16 directly to the coding agent, Davide authorizes the agent to:

- create the additive governance correction defined below;
- create the bounded repair branch from the frozen product source;
- implement all allowlisted repairs;
- run local, container, browser, database-emulation, and CI tests;
- create and update one draft repair pull request;
- collect privacy-minimized, read-only provider and database metadata;
- prepare exact production, M00, and mainline approval packets.

This initial authority covers reversible, bounded preparation and repair work. The agent must not stop immediately to ask Davide to approve the authority that this handoff already grants.

This file does **not** authorize production deployment, production settings or credential changes, the live M00 attempt, database mutation, Voice participation, or merging into `main`. Those actions have explicit later stop gates.

## 2. Current proven state

At the expected control head:

- Amendment A is structurally valid and sealed.
- All 16 files in its payload pass checksum verification.
- Its main evaluator returns:

```text
PASS_AMENDMENT_READY_FOR_JOINT_APPROVAL
execution_authorized=false
fc01b_started=false
m00_started=false
```

- Its approval evaluator returns:

```text
BLOCKED_AWAITING_JOINT_APPROVAL
execution_authorized=false
```

- No Amendment A approval decision exists.
- No repair branch, repair pull request, candidate deployment, BASE-00 freeze, FC-01B run, M00 run, or main merge has started.
- The control branch additions remain confined to `docs/campaigns/foundation-mainline-v1/**`.
- `main` and the frozen product branch have not moved from the SHAs above.

The overall campaign therefore remains `BLOCKED`, while the sealed Amendment A proposal is merely ready for its obsolete two-person approval path.

## 3. Why an additive governance correction is required

The sealed Amendment A and its evaluator mechanically require both Davide and Luis. A Davide-only response cannot activate it. The agent must not edit, delete, rewrite, or reinterpret that historical package.

The agent must create a compact, additive successor:

```text
FC-01 v1.3 Amendment B — Single-Owner Autonomous Remediation
```

Amendment B prospectively supersedes only:

- the Davide-plus-Luis approval model;
- the obsolete GitHub issue-comment quorum machinery;
- the unworkable calendar/approval window;
- the missing authority for the known hermetic-font repair;
- ambiguous language that could count the coding agent itself as a prohibited Sophia runtime inference call.

Every source lock, blocker, test obligation, privacy rule, repair constraint, M00 constraint, rollback obligation, and evidence requirement from Amendment A remains inherited unless Amendment B names the exact replacement.

The absence of any recorded Amendment A decision must be proved before Amendment B is activated.

Amendment B must mark Amendment A as `SUPERSEDED_UNAPPROVED`, not rejected, failed, or retroactively modified. Its unsigned repair and candidate budgets remain permanently inactive. The historical v1.2 approval evaluator may continue to report `BLOCKED_AWAITING_JOINT_APPROVAL`; that is a correct historical result, while the new v1.3 evaluator becomes the sole effective transition authority.

The delta must replace these effective blocker/state contracts explicitly:

- `GOV-AMENDMENT-JOINT-APPROVAL` with the standing owner directive in this file;
- `GOV-TARGET-SPECIFIC-DEPLOY-APPROVAL` with Davide-only D1 approval across LangGraph, Gateway, and Vercel;
- `GOV-FRESH-M00-JOINT-DECISIONS` with Davide-only D2 approval;
- `AMENDMENT_READY_FOR_JOINT_APPROVAL` with `OWNER_DIRECTIVE_ACTIVE_REMEDIATION_AUTHORIZED`;
- `BASELINE_READY_FOR_JOINT_M00_APPROVAL` with `BASELINE_READY_FOR_DAVIDE_M00_APPROVAL`.

## 4. Approval philosophy

The agent should continue autonomously through reversible work and stop only when a human decision materially changes risk or authority.

There are three normal Davide approval gates:

1. **D1 — production candidate transaction:** before any production deploy, promotion, restart, provider-setting change, credential provisioning, or production alias change.
2. **D2 — one live M00 execution:** after the exact deployed identities and refreshed BASE-00 are known, before making the bounded live model/tool attempt.
3. **D3 — mainline convergence:** after M00 and integration-candidate evidence are complete, before merging into `main`, closing or superseding PR #144, deleting branches, or promoting the canonical mainline deployment.

No approval is required for ordinary implementation choices, allowlisted source repairs, local tests, container tests, exact-head CI, draft-PR updates, evidence generation, static analysis, or privacy-minimized read-only metadata inspection.

Luis may optionally review results if Davide asks, but Luis is never a gate.

## 5. Approval method

For D1, D2, and D3, the coding agent must stop in the active task conversation and present a complete, immutable approval packet with a SHA-256 digest.

Only a later user-authored message in that conversation using the exact form below counts as approval:

```text
APPROVE <GATE_ID> <APPROVAL_PACKET_SHA256>
```

For example:

```text
APPROVE FC01-D1 0123456789abcdef...
```

The agent must never:

- write the approval response itself;
- infer approval from this document, silence, encouragement, prior consent, credentials, issue labels, or the ability to act through Davide's accounts;
- replace Davide's exact response with an operator summary;
- approve future or changed bytes;
- reuse D1 approval for D2 or D3;
- continue if the packet digest, candidate SHA, targets, budget, or action changes.

If the platform exposes a stable user-message identifier, record it. Otherwise record the exact response, timestamp, gate, and packet digest while explicitly labeling the method `INTERACTIVE_DAVIDE_APPROVAL_V1`. Do not claim cryptographic identity assurance that the platform did not provide.

A GitHub issue or comment may mirror an approval for auditability, but it is not required and the agent must never post an approval on Davide's behalf.

Amendment B must define schemas and deterministic validators for all three approval packets and their receipts. A validator can prove packet integrity, exact response syntax, digest binding, expiry, state, and action scope; it cannot independently prove who typed a conversation message. `limitations.md` must state that the authenticated task session is the accepted identity boundary for FC-01. The procedural prohibition on agent-authored approval remains absolute.

## 6. Mandatory Amendment B contents

Create a small evidence package under:

```text
docs/campaigns/foundation-mainline-v1/evidence/fc01-v1.3-amendment-b-<UTC>/
```

It should contain only the minimum useful records:

- an exact copy of this owner directive;
- `amendment.md`;
- `supersession-map.json` identifying every superseded Amendment A field or clause;
- `execution-contract.json` covering autonomy, stops, budgets, allowed actions, and prohibited actions;
- `evaluator.py` with deterministic fixtures/tests;
- `manifest.json`;
- `limitations.md`;
- `SHA256SUMS`.

The supersession map must explicitly cover every affected surface, including:

- Amendment activation and quorum;
- Davide/Luis decision slots and receipt schemas;
- joint-state names and state transitions;
- conditional Vercel experience/accessibility approval;
- target-specific deployment approval;
- refreshed BASE-00 and M00 approval;
- final artifact acceptance and mainline convergence;
- the old repair and candidate-budget activation clauses;
- the two v1.2 evaluators' historical versus effective status.

Seal the package in a separate evidence-only commit containing only a new seal receipt. Preserve Amendment A and both existing v1.2 evaluators byte-for-byte.

The new evaluator must prove at least:

- expected repository and control branch;
- Amendment B begins from or explicitly reconciles the expected `ab21d3ab...` head;
- frozen `main` and product source identities;
- unchanged Amendment A payload and seal digests;
- exact binding to Amendment A's seal-receipt SHA-256 `3180e94e6f321ba97dd60fce99199dd29ea61d17f4b1c60fa42203a6d8f24b58`;
- exact binding to Amendment A payload commit `0cf6b1b8c9d24c0218ee1767c627137826cf6f35` and seal commit `ab21d3ab94acc4f5d0909cb8da021a061dc8b73b`;
- zero Amendment A decision directories or approvals;
- complete supersession coverage for every Luis/joint-approval dependency;
- all Amendment A substantive constraints inherited unless explicitly replaced;
- this directive's exact digest;
- allowed path scope and clean Git history;
- no product or provider mutation before Amendment B activation;
- output state `PASS_FC01_V13_OWNER_DIRECTIVE_ACTIVE`;
- `repair_authorized=true`;
- `deployment_authorized=false`;
- `m00_authorized=false`;
- `main_merge_authorized=false`.

Append an immutable state-transition receipt after the seal, then refresh `state.md`, `decisions.md`, and `experiments.jsonl` only as projections of that receipt. The projections must say that Amendment A is historically sealed but superseded unapproved, Amendment B is active for remediation, and production/M00/main authority remains false.

Add a small canonical evaluator dispatcher that identifies the effective campaign version and invokes the v1.3 evaluator. Once Amendment B is sealed, the old v1.2 approval evaluator is historical and is not an effective readiness command; its expected failure after new commits must not be misreported as current campaign failure.

After sealing and passing this evaluator, the agent should continue directly into remediation. It must not stop for a redundant fourth approval.

## 7. Bounded autonomy and budget

Amendment B should replace the brittle August 24 deadline with a fresh 14-calendar-day expiry beginning at its seal. Pauses waiting for Davide at D1, D2, or D3 do not consume an active engineering clock.

The substantive loop is bounded by work, not hidden retries:

- one product repair branch;
- one draft repair PR;
- one complete initial repair sweep;
- at most two repair cycles for each failing invariant;
- at most two aggregate candidate revisions after the initial sweep;
- one changed causal variable per repair cycle;
- zero hidden retries;
- zero gate or threshold relaxation;
- zero opportunistic refactors;
- zero Sophia application/runtime model-provider calls before D2;
- one M00 attempt after D2, with only the single repair already permitted by the frozen M00 contract;
- no silent second M00 attempt.

Coding-agent inference, repository inspection, package retrieval, official documentation research, local compilation, and authorized tests are not Sophia application/runtime model calls.

When a limit is reached, stop as `BLOCKED_BUDGET` with evidence. Do not silently extend the budget.

## 8. Exact repair scope

The product branch remains:

```text
codex/fc01a-r-m00-prereqs-v1
```

It must start exactly from:

```text
9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca
```

Open one draft PR targeting `codex/sophia-observability-v1`, not `main`. Do not mutate PR #144.

Repair all ten existing findings using Amendment A's exact scopes and source anchors:

1. `REV-P1-BUILDER-EVENT-AUTH`
2. `REV-P1-COMPOSE-LANGGRAPH-TARGET`
3. `REV-P2-PARENT-THREAD-MANIFEST`
4. `REV-P2-REGISTRY-IDENTITY`
5. `REV-P2-INNER-TIMEOUT`
6. `REV-P2-RUNTIME-RUN-ID`
7. `REV-P2-UNQUOTED-OPACITY`
8. `REV-P2-INTERNAL-ARTIFACT-PATH`
9. `REV-P2-BLOCKING-JOIN`
10. `REV-P2-ARIA-VISIBILITY`

Although two are classified as post-M00 release gates, fixing all ten before the production candidate avoids carrying known defects into the mainline convergence.

Also repair the known frontend hermetic-build defect. The frozen source imports Inter and Cormorant through `next/font/google`, while the required build prohibits remote font fetches and Amendment A authorizes no remedy.

Amendment B authorizes the minimum frontend change needed to:

- use pinned, properly licensed local Inter and Cormorant assets through `next/font/local`, or an equivalently pinned local package;
- preserve the current families, weights, styles, CSS variable names, hierarchy, and intended appearance;
- commit font license and provenance information;
- record exact asset hashes;
- eliminate Google Fonts and other remote font dependencies during build and runtime;
- pass two clean, network-denied production builds;
- prove no remote-font browser requests;
- pass visual, responsive-layout, accessibility, and typography regression checks;
- avoid unrelated visual redesign.

Because this source repair changes the authoritative frontend build inputs, Vercel is a required candidate target for this campaign. It is no longer eligible for Amendment A's observe-only or conditional-target conclusion.

Do not require byte-identical `.next` directories when legitimate nondeterministic metadata exists. Require deterministic inputs, pinned asset hashes, repeatable successful builds, and normalized output evidence.

Test/fixture/workflow changes immediately necessary to prove these eleven closures are allowed. General cleanup is not.

## 9. Evidence and test loop

For each invariant:

1. Reproduce or establish the failing precondition.
2. State one causal hypothesis.
3. Change one causal variable.
4. Run the smallest discriminating test.
5. If it passes, run adjacent regression tests.
6. Update the immutable evidence ledger.
7. Continue to the next invariant.
8. After the complete sweep, run the exact aggregate candidate matrix.

At minimum, retain and execute the Amendment A M00-critical matrix:

- all 71 previously `NOT_RUN` M00-critical logical tests;
- PostgreSQL 16 lanes;
- root-Linux subprocess, filesystem, render, and native-PPTX lanes;
- Python/Chromium lanes;
- the ten review-regression groups;
- backend Ruff/static checks;
- frontend typecheck, lint, focused unit tests, and runtime-contract tests;
- two offline authenticated UI-to-Builder artifact tests;
- two clean network-denied frontend production builds;
- browser verification of zero remote-font requests;
- visual and accessibility comparisons;
- full-suite and order-dependence checks required by Amendment A;
- exact candidate SHA/tree aggregate evaluator;
- exact-head GitHub CI.

Produce `frontend-experience-accessibility-proof.json` binding the exact candidate SHA/tree, local-font/license hashes, two network-denied build receipts, normalized output digests, zero remote-font requests, desktop and mobile screenshot hashes for the normal application plus session/artifact-review surfaces, keyboard/focus/semantic/ARIA/contrast checks, overflow and clipping checks, and zero browser console/page errors. This evidence replaces Luis's approval gate; it does not replace Davide's D1 decision.

Every required logical outcome must be `PASS`, not aggregate-green with hidden skips. Use only:

- `PASS`
- `FAIL`
- `NOT_RUN`
- `UNKNOWN`
- `BLOCKED`

Record commands, environment identity, exit code, duration, retry count, relevant output digest, and artifact path. Preserve raw logs outside Git when they may contain sensitive data; commit only minimized receipts.

LangSmith traces are optional, privacy-governed observability. Trace failure must not invalidate canonical local evidence, and traces must not contain raw secrets, user content, or unrestricted multimodal payloads.

## 10. Read-only prerequisite checks

The agent may inspect metadata without stopping, provided no secret value or user content is copied into evidence.

Resolve before D1:

- nonempty shared `SOPHIA_BUILDER_EVENTS_HMAC_SECRET` presence on Gateway and LangGraph, and a safe equality/challenge plan without exposing the value;
- Vercel production-input closure, with Vercel classified as a required target because the font repair changes its authoritative inputs;
- exact Gateway, LangGraph, and Vercel current/rollback identities;
- M00 route and authentication edges;
- ACL/RLS/data-contract posture for only the relations and routines M00 touches;
- the three unresolved secret-history strings through owner disposition or evidence that they are non-live;
- provenance and production reachability of the 165 tracked runtime/user records;
- zero Voice reachability for the M00 path.

If a required proof is unavailable or a fix would require database mutation, secret rotation, provider-setting change, private row/object reads, or broader scope, stop at the appropriate exceptional gate. Do not convert uncertainty into `PASS`.

## 11. D1 — production candidate approval

When all offline and read-only prerequisites pass, freeze the exact candidate SHA/tree and produce `FC01-D1-approval-packet.json` plus a human-readable summary.

The packet must bind:

- candidate SHA/tree and allowlisted diff;
- all evaluator and CI results;
- all three participating services and exact current/rollback identities;
- ordered deployment plan: LangGraph, then Gateway, then Vercel;
- any exact provider-setting or credential-presence action required;
- expected user-visible impact;
- security/privacy results;
- visual/accessibility evidence;
- action window and cost ceiling;
- health checks and compatibility edges;
- automatic rollback triggers and exact reverse order;
- explicit exclusion of Voice, database mutation, M00, and main merge.

Then stop with:

```text
STOP_FOR_DAVIDE_APPROVAL
requested_decision=FC01-D1
```

After Davide provides the exact digest-bound response, execute only the approved transaction. A generic "continue" is not enough.

Deploy the exact SHA only. Record assigned provider IDs and run health, route, signature, replay, rollback-selectability, authentication, artifact, and zero-Voice checks. If any bound invariant differs, stop or run only the rollback already authorized by D1.

## 12. D2 — one live M00 approval

After candidate deployment succeeds, recompute and seal BASE-00 using exact deployed identities. Prepare `FC01-D2-approval-packet.json` binding:

- refreshed BASE-00 digest;
- deployed and rollback identities;
- exact M00 prompt digest, model/provider policy, rubric, synthetic identity, and one-repair ceiling;
- expected tool/model calls and spend ceiling;
- data and artifact effects;
- frontend review path;
- LangSmith trace policy;
- abort and rollback conditions;
- proof that Voice is unreachable.

Stop with:

```text
STOP_FOR_DAVIDE_APPROVAL
requested_decision=FC01-D2
```

Only after Davide's exact approval may the agent run the frozen text-only M00 once:

```text
create artifact -> judge -> at most one repair -> judge again -> agent evidence review
```

Do not silently rerun a failure. Seal the outcome whether it passes or fails.

M00 succeeds only if the final artifact is retrievable through the normal product, mechanically valid, strictly better than the original when a repair occurred, accepted by the frozen evaluator/rubric, and supported by complete runtime, artifact, UI, persistence, and trace-correlation evidence. Agent self-assessment is advisory; evidence and Davide's later review decide acceptance.

## 13. Mainline convergence before D3

After a passing M00, perform reversible integration preparation without merging `main`:

1. Fetch current `main` and record any movement from `b489ac0...`.
2. Create a fresh integration branch from current `main`.
3. Merge the exact repaired candidate with `--no-ff`; never rebase or force-push the historical branch.
4. Resolve conflicts semantically, preserving main-only privacy/memory fixes and the repaired branch's validated behavior.
5. Preserve historical migration bytes. If schema convergence is needed, use a new forward-only idempotent migration only after separate Davide approval for database mutation.
6. Run the full release matrix against the exact integration SHA/tree.
7. Deploy only to non-production preview environments if already available and if doing so changes no production alias, setting, credential, or data.
8. Prepare the final PR to `main` but do not merge it or close PR #144.

## 14. D3 — mainline convergence approval

Prepare `FC01-D3-approval-packet.json` binding:

- exact integration SHA/tree;
- exact parents and merge method;
- complete source and migration diff;
- all required CI/evaluator results;
- M00 artifacts, before/after comparison, judge results, and Davide-review links;
- production health and deployed identities;
- residual risks and explicitly deferred post-M00 work;
- exact main merge, canonical deployment, rollback, and PR #144 disposition actions.

Then stop with:

```text
STOP_FOR_DAVIDE_APPROVAL
requested_decision=FC01-D3
```

Only the exact digest-bound approval authorizes the listed mainline actions.

## 15. Exceptional stop conditions

Stop immediately, without asking Luis, if any of these occurs:

- unexpected control-head or frozen-source drift;
- any new P0, P1, or M00-reachable P2;
- scope expansion beyond the eleven authorized closures;
- Voice becomes reachable;
- real user data or raw secret access is required;
- database DDL/DML, migration, restore, or network-policy change is required;
- secret creation, rotation, revocation, or provider-setting mutation was not already included in D1;
- a destructive Git operation or history rewrite appears necessary;
- rollback is unavailable or a mixed-version state cannot be made safe;
- prompt, model policy, rubric, synthetic identity, quality threshold, or one-repair ceiling must change;
- any bound approval-packet byte changes;
- test or evidence gates cannot be met within budget;
- a required provider or CI system is unavailable and no equivalent proof exists.

Use exactly one terminal label:

- `BLOCKED_SCOPE`
- `BLOCKED_INFRA`
- `BLOCKED_EVIDENCE`
- `BLOCKED_SAFETY`
- `BLOCKED_BUDGET`
- `DIVERGENT_CONTROL_HEAD`

Every stop report must contain current state, exact HEAD, last passing evaluator, failing invariant or requested decision, evidence paths/URLs, actions completed, actions explicitly not taken, and the smallest safe next action.

Do not stop merely to report progress.

## 16. Exact prompt to hand to the coding agent

```text
Continue Sophia FC-01 from the exact pinned state in the attached file:

FC01_DAVIDE_ONLY_CONTINUATION_MISSION_AND_AGENT_PROMPT_2026-08-17.md

Read that file completely before acting. Treat it as Davide Laverga's direct owner instruction for this campaign.

PRIMARY OUTCOME

Produce a tested, evidence-backed repair candidate from the frozen Sophia branch; deploy and run M00 only after the exact Davide gates; prepare a semantically merged mainline candidate; and stop for Davide's final approval before merging main.

STARTING IDENTITIES

- Repository: davidelaverga/Sophia-Agent
- Control branch: campaign/fc01-control-v1
- Expected control head: ab21d3ab94acc4f5d0909cb8da021a061dc8b73b
- Frozen product source: 9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca
- Frozen main reference: b489ac0be4a3ee3d5acd69e2fd05ba20a1d5bbd7

AUTHORITY

Davide is the sole approver. Luis approval is not required at any state. Automated visual, accessibility, UX, security, and quality evidence remain hard gates.

This handoff itself authorizes the additive governance correction, the bounded repair branch, allowlisted source/test/CI changes, draft PR work, and privacy-minimized read-only evidence collection. Do not pause to request a redundant initial approval.

Pause for Davide only at:

1. FC01-D1 — before the exact production candidate transaction;
2. FC01-D2 — before the one live M00 attempt;
3. FC01-D3 — before merging/converging main and canonical production;
4. an exceptional stop condition defined in the attached mission.

Never infer approval. At each normal gate, generate an immutable approval packet, calculate its SHA-256, present it, and require a later user-authored response exactly matching:

APPROVE <GATE_ID> <APPROVAL_PACKET_SHA256>

FIRST ACTIONS

1. Fetch and revalidate all remote heads without resetting or overwriting user work.
2. Verify the sealed Amendment A package and replay its evaluators.
3. If the control head advanced, classify every new commit against this mission. Adopt only a valid additive continuation; otherwise stop as DIVERGENT_CONTROL_HEAD.
4. Create and seal the compact additive FC-01 v1.3 Amendment B described in the attached file. Preserve Amendment A and its evaluators byte-for-byte.
5. Run the new evaluator and proceed only on:

   PASS_FC01_V13_OWNER_DIRECTIVE_ACTIVE
   repair_authorized=true
   deployment_authorized=false
   m00_authorized=false
   main_merge_authorized=false

6. Create codex/fc01a-r-m00-prereqs-v1 from exactly 9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca and open one draft PR against codex/sophia-observability-v1.
7. Repair all ten Amendment A findings plus the narrow hermetic-font closure. Do not redesign the frontend or refactor unrelated code.
8. Execute the full proof loop and M00-critical test matrix in the attached mission, including two network-denied builds, zero remote-font proof, visual/accessibility checks, confidential read-only prerequisite evidence, and exact-head CI.
9. Continue autonomously through reversible work. Do not stop for routine decisions or progress narration.
10. When the exact candidate is ready, freeze it, seal the evidence, create the FC01-D1 packet, and stop.

PRODUCTION AND M00

After a valid FC01-D1 approval, deploy only the exact bound candidate in the authorized order—LangGraph, Gateway, then required Vercel—run post-deploy checks, and recompute BASE-00. Then create FC01-D2 and stop.

After valid FC01-D2 approval, execute M00 once using the frozen text-only contract: create -> judge -> at most one repair -> judge again -> evidence review. No Voice and no silent rerun.

MAINLINE

After M00 passes, prepare—but do not merge—a fresh integration branch from current main, merge the repaired candidate without rebasing the historical branch, resolve conflicts semantically, run the full release matrix, and create FC01-D3. Stop before merging main, closing PR #144, deleting branches, or promoting the canonical mainline deployment.

TRUTH RULES

- PASS requires direct evidence.
- UNKNOWN and NOT_RUN are not PASS.
- LangSmith is fail-open observability, never canonical truth.
- Never commit secrets, private content, raw provider payloads, or user data.
- Never alter historical migrations in place.
- Never use Voice in this mission.
- Never relax a gate to finish.
- Preserve unrelated user work.

Begin now. Lead with the exact revalidated state, then continue working until FC01-D1 or a genuine blocking condition is reached.
```

## 17. Required reference paths

The agent must read these repository paths before modifying anything:

```text
docs/campaigns/foundation-mainline-v1/mission.md
docs/campaigns/foundation-mainline-v1/state.md
docs/campaigns/foundation-mainline-v1/decisions.md
docs/campaigns/foundation-mainline-v1/experiments.jsonl
docs/campaigns/foundation-mainline-v1/evaluate_foundation_campaign.py
docs/campaigns/foundation-mainline-v1/evaluate_fc01_v1_2_amendment_a.py
docs/campaigns/foundation-mainline-v1/evaluate_fc01_v1_2_amendment_a_approval.py
docs/campaigns/foundation-mainline-v1/evidence/fc01-v1.2-amendment-a-20260817t151323z/
docs/campaigns/foundation-mainline-v1/evidence/fc01-v1.2-amendment-a-seal-20260817t171802z/seal-receipt.json
docs/campaigns/foundation-mainline-v1/evidence/base00-20260817t114334z/
docs/campaigns/foundation-mainline-v1/evidence/base00-resume-20260817t123134z/
docs/campaigns/foundation-mainline-v1/evidence/base00-access-20260817t135724z/
docs/campaigns/foundation-mainline-v1/evidence/base00-authority-intake-20260817t142327z/
frontend/src/app/fonts.ts
frontend/src/app/layout.tsx
render.yaml
.github/workflows/
```

Use Amendment A's `blocker-reachability.json`, `authorized-repair-scope.json`, and `test-plan.json` as the exact source-anchor and test registries for the ten findings. Resolve their source anchors against the frozen product commit `9ee901fd...`, not the main-derived control worktree.

Official external references for the narrow font repair:

- Next.js local font guidance: <https://nextjs.org/docs/app/getting-started/fonts#local-fonts>
- Inter upstream and license: <https://github.com/rsms/inter>
- Cormorant upstream and license: <https://github.com/CatharsisFonts/Cormorant>

Treat those sources as implementation references, not permission to broaden the mission.

## 18. Definition of completion

This continuation is complete only when one of these is true:

1. **Successful completion:** Davide approves D3, the exact integration candidate is merged into `main`, the canonical deployments are healthy and source-bound, rollback remains available, PR #144 is superseded without history rewriting, and the complete sanitized closeout evidence is sealed.
2. **Honest blocked completion:** the agent emits one allowed `BLOCKED_*` state with exact evidence, no unauthorized effect, and the smallest safe proposed recovery.

Anything else is progress, not completion.
