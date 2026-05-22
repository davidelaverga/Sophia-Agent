# Sophia Artifact Traces Architecture

**Version:** 1.0 · May 2026
**Author:** Davide (architecture) · Claude (documentation)
**Status:** Design Complete — ready for implementation
**Scope:** Unified trace substrate for introspection, cross-agent coordination, and self-improvement signal across Sophia (voice companion) and the builder (async subagent)
**Read alongside:** `sophia_gpt_realtime_experiment_spec_v1.3.md` (voice runtime, paired revision), `sophia_memory_upgrades_spec_v2.1.md` (Mem0 integration that consumes extracted traces), `Subagents_async_tools_plan.md` (existing async lifecycle coordination)
**Supersedes:** `sophia_session_log_spec.md` v1.0 and v1.0.1 (entirely; the session log substrate is retired in favor of artifact extension — see §1.2)

---

## 1. Purpose and Scope

This spec defines how structured, model-authored traces are produced across both Sophia and the builder, by extending the existing per-turn artifact mechanism rather than introducing a parallel logging substrate. The trace surface serves four purposes simultaneously, with no new infrastructure layer:

1. **Operational state for the runtime** — Sophia's voice delivery layer continues to consume artifact fields (tone band, voice emotion) for TTS shaping. Builder gains intra-build coherence by reading its own previous artifact each step.
2. **Cross-agent coordination visibility** — `check_async_task` returns a summary of the builder's latest artifact, giving Sophia a structured view of the in-flight build that she translates into user-facing acknowledgements.
3. **Introspective record for the model itself** — fields capturing predictions, the previous step's reflection on those predictions, lessons distilled, and diagnoses on failure. The model reads its own trail and adapts.
4. **Training signal for the self-improvement loop** — every artifact is a labeled record (predicted outcome / actual outcome / agent's own assessment) that GEPA or any future optimizer consumes as supervision.

The principle that anchors the whole design: **the harness controls flow and structural metadata; the model controls semantic content.** Emission gates, step numbering, timestamps, error-state detection, and stuck-loop detection are deterministic harness responsibilities. Every field's content is the model's, written in its own voice.

### 1.1 What this is

A specification for:
- Extending Sophia's existing artifact schema (13 → 15 fields) with two introspective fields
- Defining a new per-step builder artifact schema (12 fields, parallel block structure)
- Specifying the middleware that enforces builder artifact emission and gates the diagnosis field on error states
- Specifying the stuck-detection middleware that injects course-correction prompts
- Enriching `check_async_task` to return artifact summary for Sophia's user-facing translation
- Defining trail persistence, offline pipeline extraction, and frontend rendering implications
- Phasing the rollout across voice spec phases

### 1.2 What this supersedes and why

The session log spec (`sophia_session_log_spec.md` v1.0 and v1.0.1) is retired by this document. The architectural shift came from recognizing three things during design review.

First, the existing artifact mechanism already carries most of what the session log was going to record. Sophia's tone observation, decision rationale, prediction, and continuity threads are already in her 13-field artifact. The "introspection" use case needed only two added fields (reflection and lesson), not a new file substrate.

Second, the `BuilderMidstreamCheckMiddleware` pattern from the session log spec was solving a problem the existing async lifecycle already solves. User signals arriving during an active build propagate via `update_async_task` with `multitask_strategy="interrupt"` — the builder is interrupted, picks up the new instructions on the same thread, integrates them. The session log's read-the-log-at-phase-transition path was duplicating work that deepagents native interrupts handle better.

Third, the dual-writer ambiguity (model writes some entries, middleware auto-writes others with a synthesized body) was a real cost. Mixed authorship makes the trail hard to reason about and limits its usefulness as training data. Artifact-per-step with middleware-enforced emission, but model-authored content, eliminates the ambiguity without losing reliability — the model writes everything; the harness guarantees a write happens at the right moments.

What was valuable in the session log spec — the gated-write pattern for failure diagnoses, the harness/model boundary clarification, the cross-agent coordination question — is fully preserved in this spec, just located in a different substrate. The session log spec stays in the repository as historical context with a "SUPERSEDED" header pointing to this document. Nothing in the conversation that produced it is lost; only the implementation path changed.

### 1.3 What this is NOT (deliberately deferred)

| Capability | Treatment | Reason |
|---|---|---|
| Cross-session operational knowledge store | Reserved | Type B lessons (matplotlib fails on this runtime) stay in-session only in v1. Cross-session operational learning deserves its own substrate design, with its own privacy/decay/curation considerations. Not a category extension to Mem0. See §9.3. |
| Phase markers as separate log entries | Cut | The `current_phase` field on each builder artifact captures phase context without a separate marker substrate. No middleware auto-writes phase entries. |
| Subagent artifact ownership | Deferred | When builder spawns subagents (research, drafting), the subagent's work surfaces in the parent builder's artifact, not in a subagent-owned trail. Subagent-level trails are future work. |
| Live artifact querying from within the model | Out of scope | The model reads its trail via standard state access (`state["async_tasks"][task_id].artifact_trail`). No separate query tool. |
| Webhook/streaming of artifact events to external consumers | Reserved | Internal SSE events emit artifacts per turn; external consumers (analytics, GEPA pipeline) read from the persisted trace JSON. |
| Artifact schema evolution / versioning policy | Deferred | v1 ships fixed schemas for Sophia and builder. Schema iteration is expected during the 2-week validation period; formal versioning policy is future work. |

### 1.4 Success criteria

| Metric | Target | Measurement |
|---|---|---|
| Builder artifact emission compliance | 100% of completion cycles produce an artifact | Middleware audit log |
| Diagnosis field populated on error | 100% of post-error steps have `last_diagnosis` non-null | Test cases + production audit |
| Sophia ack quality after `check_async_task` | ≥ 4/5 manual scenarios produce natural user-facing translation | Manual audit |
| Mid-build update propagation unchanged | Existing `update_async_task` flow continues working | Regression tests |
| Field quality after 2-week audit | ≥ 80% of `turn_goal` / `action_hypothesis` / `lesson` entries are specific and actionable | Manual sample review |
| Latency cost per builder step | ≤ 200ms added vs no-artifact baseline | Step timing telemetry |

---

## 2. Architectural Principle

### 2.1 Harness controls flow and structural metadata; model controls semantic content

This is the contract that determines what belongs in middleware vs what belongs in prompts.

**Harness responsibilities** (deterministic, mechanically observable, automated):
- Enforcing that an artifact is emitted on every completion cycle (builder) or response turn (Sophia)
- Auto-populating step numbers, timestamps, task_id linkage, and other structural metadata
- Detecting error states from tool call results and gating the next artifact's `last_diagnosis` field to be required
- Detecting stuck patterns (consecutive same-tool calls, repeated near-identical queries, time-since-progress thresholds) and injecting course-correction prompts
- Persisting the artifact trail to state and the trace JSON
- Emitting SSE events to the frontend

**Model responsibilities** (semantic, intent-revealing, content-bearing):
- All field content: predictions, hypotheses, reflections, lessons, diagnoses, goals
- Choosing when optional fields are null vs populated (model decides if there's something distillable worth saying)
- Self-assessment in confidence scores
- Course-correction reasoning in response to harness signals

The asymmetry between deterministic and inferential is the dividing line. The harness never writes content that ends up in a model-authored field. The model never bypasses the harness's enforcement gates.

### 2.2 Runtime asymmetry

Voice Sophia and builder run in different environments with different enforcement affordances. The contract is the same in spirit; the mechanism differs.

**Voice Sophia (OpenAI Realtime API via Vision Agents):**
- Cannot be middleware-gated mid-utterance — the Realtime API does not suspend audio output for harness decisions
- Enforcement mechanism: prompt discipline + the existing `emit_artifact` tool requirement
- The system prompt teaches the artifact schema; the runtime requires `emit_artifact` to fire on every response turn (except crisis)
- Missing fields are detected post-hoc via trace audit, not blocked at emission time

**Builder (LangGraph in-process):**
- Each step is a completion cycle with natural boundaries the harness can observe
- Enforcement mechanism: `BuilderArtifactMiddleware` after each completion, gating the next step on emission
- Error states detected from tool results; subsequent artifact's `last_diagnosis` field gated to require population
- Stuck detection runs alongside, injecting synthetic prompts when triggered

Match the mechanism to the runtime. The contract — model writes content, harness ensures structural integrity — is honored in both.

### 2.3 Field shape conventions

Some conventions apply across both schemas to keep the trail consistent and trainable:

- **Optional fields default to null**, not to empty string or placeholder. Null carries the meaning "no signal worth recording." Empty string carries "I had to fill this and couldn't." The model is taught to leave optional fields null when honest, not to perform.
- **Bounded length per field**. Each field has an explicit character limit. This protects against rambling, keeps the artifact compact, and forces the model to distill.
- **Categorical fields use closed enums**. `current_phase`, `progress_toward_session_goal`, etc. use predefined values that the harness can validate and downstream consumers (Sophia's translation layer, GEPA, side panel) can branch on.
- **Forward and backward fields are explicitly separated**. Predictions about future state and reflections on past state live in different blocks. Conflating them costs the labeled training signal.

---

## 3. Sophia Artifact Extensions

### 3.1 Current shape (per v1.2.1 voice spec)

Sophia's artifact has 13 fields in 4 blocks:

| Block | Fields |
|---|---|
| OBSERVATION | tone_estimate, active_tone_band, user_emotional_reading |
| APPROACH | skill_loaded, target_tone, response_register |
| PREDICTION | predicted_user_trajectory, recommended_register_next_turn, predicted_skill_transition, prediction_confidence |
| CONTINUITY | session_goal, active_goal, takeaway |

Emission contract: `emit_artifact` is required exactly once per response turn (except crisis turns), enforced by `ArtifactMiddleware` and reinforced by the system prompt. The companion model emits the artifact in the commentary channel before the final user-facing response.

### 3.2 Two new fields

| Block | Field | Type | When populated | When null |
|---|---|---|---|---|
| OBSERVATION | `previous_turn_reflection` | optional str, ≤ 200 chars | When the previous turn made a substantive prediction AND something about the actual outcome differed from or sharpened it | First turn of session; routine turns where prediction matched without comment |
| CONTINUITY | `lesson` | optional str, ≤ 150 chars | When the turn produced a distillable insight worth carrying forward — a pattern noticed, an approach that worked unexpectedly well, a misread that taught something | Most turns; populated when there is something honestly worth keeping |

The artifact moves from 13 to 15 fields. Existing fields and emission contract are unchanged.

### 3.3 `previous_turn_reflection`

This field implements the retrospective half of the prediction loop. The current artifact predicts forward (`predicted_user_trajectory`, `predicted_skill_transition`, `prediction_confidence`). The reflection field on turn N+1 looks back at turn N's prediction and labels how it played out.

Format: a brief sentence comparing the previous turn's prediction with the actual user response, plus the affective signal of the gap if there is one.

**Examples of good content:**

```
"Predicted the user would soften with self-compassion framing, but they
deflected harder — surprised by the depth of the protective armor."
```

```
"Predicted skill transition to grief_holding; the user surfaced anger
instead. Adjusted approach mid-turn."
```

```
"Prediction held: user grounded around the breathing pause as expected."
```

**Examples of bad content (would be flagged in audit):**

```
"The user spoke."                          ← no comparison to prediction
"My prediction was good."                  ← no specificity
"User engaged with what I said."           ← generic, applies to anything
```

The affective signal — "surprised," "expected," "concerned," "encouraged" — is part of what makes this field trainable. It gives GEPA a labeled signal of where the model's calibration was off, ranked by the model's own sense of how much the gap mattered. Don't perform feelings; only name them when they're real.

Null is correct when the previous turn's prediction was unremarkable and the actual response matched without comment. Filling this field on every turn produces noise; filling it when something honestly happened produces signal.

### 3.4 `lesson`

This field is what makes the trail useful for cross-session pattern memory. Usually null. Populated when the turn taught the model something it would want to carry forward.

Format: one sentence, declarative, specific.

**Examples of good content:**

```
"When this user uses humor about their work, they're usually masking
exhaustion — don't take the deflection at face value."
```

```
"The 'I'm fine' that comes after a long pause means the opposite of
the 'I'm fine' that comes immediately."
```

```
"Vulnerability_holding lands better with this user when entered slowly
rather than directly named."
```

**Examples of bad content:**

```
"Be more careful with this user."          ← not actionable, no specificity
"Listening is important."                  ← platitude
"User has emotions."                       ← trivially true
```

Null is the default. Performative lessons that read like wisdom but aren't actionable are worse than no lesson — they pollute the training signal and the cross-session memory pipeline.

The offline pipeline extracts populated `lesson` fields into Mem0 as `pattern` or `lesson` category memories (per §9.1). This is how cross-session learning compounds — not through general impressions, but through specific distillations the model itself flagged as worth keeping.

### 3.5 Prompt instructions for the new fields

The voice spec (v1.3) carries the prompt text. In summary, the section taught in the system prompt explains:

- `previous_turn_reflection` is null on turn 1 and null on routine turns; populated when the previous prediction was substantive AND the actual outcome was worth labeling.
- The reflection is in the model's voice, includes an affective signal if real, and is concrete about what was predicted vs what happened.
- `lesson` is null on most turns; populated when there is something specific and actionable distilled.
- Performative entries are worse than null. Audit will surface them; the prompt will tighten in response.

---

## 4. Builder Artifact Schema

### 4.1 Overview

Builder currently emits one structured artifact at the end of a build (`emit_builder_artifact` with path, type, sources, summary). Internally each step is a tool call plus a model completion, but there is no per-step structured record — builder's state is just the message history.

This spec adds a per-step artifact: one structured emission per completion cycle, capturing the model's intent, prediction, and reflection at each step. The trail is the record of how the build progressed, and the substrate for intra-build coherence, coordination visibility, and training signal.

### 4.2 Schema

Twelve fields in four blocks, mirroring Sophia's structure for symmetry.

```python
from dataclasses import dataclass
from typing import Literal, Optional


@dataclass(frozen=True)
class BuilderArtifact:
    # --- OBSERVATION (state right now) ---
    session_goal: str            # ≤ 300 chars; the build's overall objective, restated
    current_phase: Literal[
        "planning", "research", "drafting",
        "asset_generation", "review", "finalization"
    ]
    previous_step_reflection: Optional[str]  # ≤ 200 chars; null on step 1 or routine

    # --- APPROACH (what I'm doing this step) ---
    turn_goal: str               # ≤ 150 chars; this step's specific contribution
    action_hypothesis: str       # ≤ 200 chars; "doing X because I predict Y"
    expected_outcome: str        # ≤ 150 chars; what success looks like for this step
    assumption_made: Optional[str]  # ≤ 150 chars; usually null

    # --- PREDICTION (forward-looking) ---
    predicted_next_step: str     # ≤ 150 chars; what I plan to do after this
    progress_toward_session_goal: Literal["early", "mid", "late", "near_complete"]
    confidence: float            # 0.0 - 1.0

    # --- CONTINUITY (diagnostic and learning) ---
    last_diagnosis: Optional[str]   # ≤ 300 chars; null unless prev step errored
    lesson: Optional[str]           # ≤ 150 chars; null on routine
```

### 4.3 Field-by-field definitions

#### OBSERVATION block

**`session_goal`** (required, ≤ 300 chars)

The build's overall objective, restated by the model at each step. This is deliberately repeated rather than stored once because keeping it loaded into context anchors the model across long builds. A 60-step build may drift without this anchor; restating the goal at every step is cheap insurance against drift.

The session_goal should match the original task description the model received from Sophia via `switch_to_builder`. If the goal evolves mid-build (e.g., user issued an `update_async_task`), the session_goal reflects the current understanding, not the original.

Good example: `"Generate a 5-slide PowerPoint deck on Q3 sales performance, with a chart of revenue by region and a summary of top accounts, suitable for executive briefing."`

Bad example: `"Make the deck."` — too vague to anchor anything.

**`current_phase`** (required, enum)

Categorical tag identifying which phase of the build this step belongs to. Used by:
- Sophia's translation layer for user-facing acks ("she's still doing research" vs "she's drafting now")
- GEPA for clustering traces by phase type
- Frontend side panel for visual grouping

Six phases cover the common build shapes:
- `planning` — decomposing the task into substeps, choosing tools, sequencing
- `research` — gathering information via web search, document fetch, memory lookup
- `drafting` — generating content (text, code, structure)
- `asset_generation` — producing charts, images, embedded media
- `review` — checking the output against requirements
- `finalization` — assembling the final artifact, ensuring deliverable shape

A step may legitimately straddle phases (e.g., drafting that involves a quick research detour). The model picks the dominant phase for the step. Phase boundaries are not enforced — there is no required transition order. The model can revisit phases as needed.

**`previous_step_reflection`** (optional, ≤ 200 chars)

Looking back at the previous step's `action_hypothesis` and `expected_outcome`, what actually happened. Null on step 1 of a build. Null on routine steps where the previous step's hypothesis was confirmed without comment.

Good examples:

```
"Predicted matplotlib would render the bar chart; ImportError — the
sandbox doesn't have matplotlib. Switching to plotly."
```

```
"Predicted the search would return academic papers; got mostly blog
posts. Refining query to target site:arxiv.org and site:ssrn.com."
```

```
"Hypothesis confirmed — the chart embeds cleanly. Proceeding to slide 4."
```

Bad examples:

```
"The previous step happened."              ← no content
"Worked as planned."                       ← when consistently used as filler
```

This field is the keystone of the training signal. It labels each step's hypothesis-vs-outcome gap in the model's own assessment. GEPA preferentially weights traces where reflection is populated AND substantive.

#### APPROACH block

**`turn_goal`** (required, ≤ 150 chars)

What this specific step is trying to achieve. Distinct from `session_goal` (the overall build) and from `current_phase` (the categorical bucket). The turn_goal is the concrete sub-objective the model is pursuing right now.

Good example: `"Find 3 credible sources on AI-augmented onboarding to cite in the introduction section."`

Bad example: `"Make progress on the build."` — too vague; could describe any step.

**`action_hypothesis`** (required, ≤ 200 chars)

The model's stated reasoning for the action it's about to take, framed as a prediction. "I'm doing X because I predict Y." This is the forward claim that the next step's `previous_step_reflection` will evaluate.

Good example: `"Searching arxiv.org for 'human-AI relationship building 2024' because the paper most likely to ground this section is in the recent ML literature, not industry blogs."`

Bad example: `"Searching for information."` — no hypothesis, no testable claim.

**`expected_outcome`** (required, ≤ 150 chars)

What success looks like for this specific action. Concrete enough that the next step can label the result against it.

Good example: `"3-5 papers from 2023-2024, peer-reviewed or strong preprint, with abstract content matching the section's needs."`

Bad example: `"Useful results."` — not measurable.

**`assumption_made`** (optional, ≤ 150 chars)

What the model is taking for granted without verifying. Usually null. Populated when the model notices it's making an assumption that could be wrong.

Good example: `"Assuming the user wants academic sources, not industry blogs — they didn't say which."`

Good example: `"Assuming the sandbox runtime has Python 3.11; haven't checked."`

This field is diagnostic — it surfaces hidden premises that, in retrospect, may have caused a failure. If a step errors and the assumption proves wrong, the next step's `last_diagnosis` cites the assumption.

Default null. Populating this on every step produces noise; populating it when the model has a real notice-of-uncertainty produces signal.

#### PREDICTION block

**`predicted_next_step`** (required, ≤ 150 chars)

What the model plans to do after this step. Stating it explicitly makes deviation visible — if the next step diverges from the predicted plan, that's a signal worth investigating.

Good example: `"After this search completes, draft the intro paragraph using the top 2-3 papers as anchors."`

Bad example: `"Continue working."` — no commitment, no plan.

**`progress_toward_session_goal`** (required, enum)

Categorical estimate of how close the build is to completion. Four values:

- `early` — task is just starting; significant work remains across multiple phases
- `mid` — substantive progress made; phase-level work still pending
- `late` — most work done; finalization remaining
- `near_complete` — close to delivering the final artifact

Deliberately coarse. A float 0.0-1.0 would invite false precision; categorical values are honest about the uncertainty.

Used by Sophia's translation layer to produce user-facing progress descriptions.

**`confidence`** (required, float 0.0-1.0)

The model's self-assessment of whether its approach is right. Not confidence in the final artifact's quality — confidence in the current step's hypothesis and direction.

Used for:
- Detecting confidence collapse over time (declining confidence is a stuck signal)
- GEPA training signal (calibrating confidence against actual outcomes)
- Future: triggering escalation or human-in-the-loop when confidence drops below a threshold

Models are not always well-calibrated here. The audit period should track whether confidence correlates with actual step success.

#### CONTINUITY block

**`last_diagnosis`** (optional, ≤ 300 chars)

Null unless the previous step's tool call errored. Middleware-gated to be required when error state is detected.

Format: three labeled fragments concatenated.

```
what_failed: <one line — what didn't work>
why_i_think: <model's hypothesis about the cause>
what_to_try: <retry / alternate approach / escalate to Sophia>
```

Good example:

```
"what_failed: matplotlib import; why_i_think: the sandbox doesn't have
matplotlib installed and there's no apt access; what_to_try: switch to
plotly which is usually preinstalled, fall back to inline SVG if not."
```

Good example:

```
"what_failed: Tavily returned no academic sources for 'AI onboarding
2024'; why_i_think: the query is too broad and Tavily favors current
blog content; what_to_try: narrow with site:arxiv.org and add
'large language model' as a discriminator."
```

This field is the most valuable single artifact field for cross-session pattern memory. The offline pipeline extracts populated diagnoses as `pattern` category memories in Mem0, scoped to the user when user-specific (e.g., their company's PDF templates) or filtered out when operationally-shaped (matplotlib failing on a runtime is not user-specific). See §9 for the extraction branching.

**`lesson`** (optional, ≤ 150 chars)

Null on routine steps. Populated when something distillable was learned worth carrying forward.

Distinct from `last_diagnosis` — diagnosis is "what failed and why"; lesson is "what I want to remember for next time, even if nothing failed."

Good example:

```
"This user's slides always use Helvetica; matching the font family
made the chart embed look native."
```

Good example:

```
"Searching arxiv.org first, then industry sources, is faster than the
reverse for AI-research topics."
```

Bad example:

```
"Try harder next time."                    ← not actionable
"Builds are complex."                      ← not specific
```

### 4.4 Why builder's session_goal lives in OBSERVATION (not CONTINUITY)

This is the one notable asymmetry between Sophia's and builder's schemas.

Sophia's `session_goal` lives in CONTINUITY because it is emergent and evolves with the conversation — it represents Sophia's working understanding of what the user is trying to accomplish in this session, which may shift as the conversation unfolds.

Builder's `session_goal` lives in OBSERVATION because it is the immutable anchor of the build — the task brief that Sophia handed off, which doesn't change unless `update_async_task` explicitly modifies it. Loading it as observation context at each step keeps the model anchored to the original brief and resistant to drift.

The categorization is honest about the different temporal stability of the field in the two contexts. It is not a contradiction in the cross-spec schema.

### 4.5 Worked example: a 5-step build excerpt

Step 17 of a build that's generating a research report on AI onboarding patterns:

```json
{
  "session_goal": "Write a 2000-word research report on AI-augmented employee onboarding, citing 8-12 academic sources, with an executive summary and three actionable recommendations.",
  "current_phase": "research",
  "previous_step_reflection": "Predicted arxiv would have strong coverage; got 12 candidate papers, 4 directly relevant. Hypothesis confirmed.",
  "turn_goal": "Identify 2 papers specifically on AI-augmented onboarding outcomes (retention, time-to-productivity) to ground the recommendations section.",
  "action_hypothesis": "Searching Google Scholar with 'AI onboarding retention' and 'time to productivity machine learning' because outcome-focused papers cluster around HR-tech and L&D venues.",
  "expected_outcome": "2-4 papers with empirical results on onboarding outcomes attributable to AI augmentation; ideally a meta-analysis.",
  "assumption_made": null,
  "predicted_next_step": "After this search, draft the recommendations section anchored on the top 2 outcome studies plus the 4 already-collected method papers.",
  "progress_toward_session_goal": "mid",
  "confidence": 0.78,
  "last_diagnosis": null,
  "lesson": null
}
```

Step 18, immediately after the search returned weak results:

```json
{
  "session_goal": "Write a 2000-word research report on AI-augmented employee onboarding, citing 8-12 academic sources, with an executive summary and three actionable recommendations.",
  "current_phase": "research",
  "previous_step_reflection": "Predicted Google Scholar would surface outcome-focused papers; the top 10 results were mostly conceptual frameworks, no empirical retention data. Hypothesis partially refuted.",
  "turn_goal": "Find at least one paper with empirical onboarding outcome data.",
  "action_hypothesis": "Trying HR-tech industry sources (Bersin, Josh Bersin Academy, SHRM) because the outcome data may exist in practitioner research rather than academic literature.",
  "expected_outcome": "1-2 industry reports with quantitative outcomes; lower citation prestige but real data.",
  "assumption_made": "Assuming a mix of academic and industry sources is acceptable for this report; the user did not specify.",
  "predicted_next_step": "If industry sources yield 1+ datasets, draft recommendations. If still empty, escalate to Sophia for clarification on source acceptability.",
  "progress_toward_session_goal": "mid",
  "confidence": 0.62,
  "last_diagnosis": null,
  "lesson": "For AI-onboarding outcome data, industry HR-tech sources are likely more productive than academic search; reverse the search order next time."
}
```

Step 19, after the industry search also returned weak results:

```json
{
  "session_goal": "Write a 2000-word research report on AI-augmented employee onboarding, citing 8-12 academic sources, with an executive summary and three actionable recommendations.",
  "current_phase": "research",
  "previous_step_reflection": "Predicted industry sources would yield datasets; found mostly vendor case studies without methodology. Both academic and industry paths produced weaker outcome evidence than expected.",
  "turn_goal": "Decide whether to proceed with framework-level recommendations (no empirical anchor) or escalate to Sophia for scope adjustment.",
  "action_hypothesis": "Composing an escalation to Sophia via builder_handoff explaining that outcome data is sparse and asking whether to widen the source criteria or narrow the recommendation strength.",
  "expected_outcome": "User-facing clarification routed through Sophia; pause this step pending response.",
  "assumption_made": "Assuming the user prefers grounded recommendations over speculative ones; if they wanted speculation, I'd proceed.",
  "predicted_next_step": "Wait for Sophia's response; resume with adjusted scope on next turn.",
  "progress_toward_session_goal": "mid",
  "confidence": 0.55,
  "last_diagnosis": null,
  "lesson": "Empirical evidence for emerging AI applications is often thin; flagging this early to the user is better than producing weakly-grounded output."
}
```

Three steps, three artifacts, full reasoning visible. The trail is now interpretable by GEPA, by a human reviewer auditing the build, by Sophia translating progress to the user, and by builder itself on a hypothetical retry.

---

## 5. `BuilderArtifactMiddleware`

### 5.1 Purpose

Enforce that builder emits an artifact on every completion cycle and that the artifact's `last_diagnosis` field is populated when the previous step errored. The middleware is the harness side of the contract — it gates emission and gates the error field, but never writes content.

### 5.2 Position in the builder chain

Per the existing builder chain (from the backend map):

```
Builder chain (after this spec):

1. ThreadData
2. SandboxRuntime (existing build_subagent_runtime_middlewares)
3. ToolErrorHandling (existing)
4. FileInjection (soul.md, agents.md)
5. UserIdentity
6. BuilderTask
7. BuilderResearchPolicy
8. Todo (existing)
9. BuilderArtifact (existing — final artifact)
10. BuilderArtifactMiddleware   ← NEW: per-step artifact enforcement
11. StuckDetectionMiddleware    ← NEW: stuck-loop detection (§6)
12. PromptAssembly
```

`BuilderArtifactMiddleware` runs after the existing `BuilderArtifact` (which handles the build's final emitted artifact, separate from per-step traces). `StuckDetectionMiddleware` runs after `BuilderArtifactMiddleware` so it can read the latest artifact's fields when computing stuck signals.

### 5.3 Interface and behavior

```python
class BuilderArtifactMiddleware(AgentMiddleware):
    """Enforces per-step builder artifact emission.

    Responsibilities:
    - Gate each completion cycle on emission of a structured artifact
    - Auto-populate step_number, timestamp, task_id (harness metadata)
    - Detect error state from previous step's tool result; gate
      last_diagnosis to be required on the next artifact
    - Append the validated artifact to state["async_tasks"][task_id].artifact_trail
    - Emit `sophia.builder.artifact_emitted` SSE event
    """

    async def before_step(self, state: BuilderState) -> StepGate:
        # Detect if previous step errored
        if self._previous_step_errored(state):
            # Inject a gate marker into state so the model's next emission
            # is checked for last_diagnosis presence
            state["_diagnosis_required"] = True
        else:
            state["_diagnosis_required"] = False
        return StepGate.proceed()

    async def after_completion(
        self,
        state: BuilderState,
        completion: ModelCompletion,
    ) -> EmissionGate:
        artifact_dict = self._extract_artifact_emission(completion)

        # Hard gate: artifact must be emitted
        if artifact_dict is None:
            return EmissionGate.reject(
                reason="No artifact emission found in this step. "
                       "You must call emit_builder_artifact with the "
                       "full schema before any other tool call."
            )

        # Hard gate: last_diagnosis required on post-error steps
        if state.get("_diagnosis_required") and not artifact_dict.get("last_diagnosis"):
            return EmissionGate.reject(
                reason="Previous step errored. This artifact's "
                       "last_diagnosis field must be populated with "
                       "what_failed / why_i_think / what_to_try."
            )

        # Validate schema (closed enums, length limits, required fields)
        validation = self._validate_schema(artifact_dict)
        if not validation.ok:
            return EmissionGate.reject(reason=validation.error_message)

        # Auto-populate harness metadata
        artifact = BuilderArtifact(
            **artifact_dict,
            _step_number=self._next_step_number(state),
            _timestamp=time.time(),
            _task_id=state["task_id"],
        )

        # Persist to trail
        state.setdefault("async_tasks", {}) \
            .setdefault(state["task_id"], {}) \
            .setdefault("artifact_trail", []) \
            .append(artifact)

        # Emit SSE event
        await self._emit_sse(state, "sophia.builder.artifact_emitted", artifact)

        return EmissionGate.accept()
```

### 5.4 Rejection and retry semantics

When the middleware rejects an emission (missing artifact, missing diagnosis on post-error step, schema violation), the rejection message is returned to the model as a tool feedback. The model then re-attempts the artifact emission with the corrected content. The completion cycle does not advance to the next step until a valid artifact is emitted.

This is the gating pattern: harness refuses to let the model skip the step. The content is the model's; the gate is the harness's.

There is a retry bound — after 3 consecutive emission rejections within a single step, the middleware escalates by injecting a more directive prompt ("You have failed to emit a valid artifact 3 times. Re-read the schema in your system prompt and emit exactly the required structure. The build cannot proceed."). After 5 consecutive rejections, the step is marked as terminally stuck and the entire builder task is failed with a `builder_artifact_emission_failure` reason. This is a safety valve, not the expected path.

### 5.5 Error state detection

The middleware detects an errored previous step by inspecting the previous completion's tool results:

- Any tool call that returned an exception or error result
- Any tool call where the result includes an error indicator (e.g., `{"error": "..."}` or a known error sentinel)
- Builder-specific tool errors (web_fetch timeout, bash command non-zero exit, file operation failure)

False positives (step "errored" by harness detection but model considers it expected) are acceptable in v1 — the model can write a brief diagnosis explaining it was an expected non-error condition. False negatives (step actually failed but harness didn't detect) are more concerning — the model should still write a diagnosis voluntarily via the `lesson` field, but the gate doesn't fire.

The 2-week audit period should track both rates and refine the detection logic.

### 5.6 Performance considerations

Adding artifact emission per step adds latency. Each artifact is ~12 fields of structured JSON, roughly 200-500 tokens. Emission time:

- Token generation cost: ~300-800ms (depends on model)
- Validation cost: <10ms (harness-side schema check)
- Trail append cost: <5ms

Total added latency per step: ~300-800ms. For a 60-step build, total added cost: 18-48 seconds spread across the entire build. This is acceptable for the value gained.

Optimization opportunities (deferred to a future iteration if needed):
- Structured output via response format constraints reduces generation tokens
- Schema validation could be moved to a streaming validator if latency becomes a problem

---

## 6. `StuckDetectionMiddleware`

### 6.1 Purpose

Detect when builder is in a non-productive loop and inject a course-correction prompt. The detection is deterministic harness logic; the response is model-authored in the next artifact.

### 6.2 Trigger conditions

The middleware tracks rolling state across the artifact trail and fires when any of the following conditions is met:

**Tool repetition without progress signal**
- Same tool name called ≥ 4 times consecutively, AND
- `progress_toward_session_goal` field has not advanced (no transition from `early` → `mid` → `late` → `near_complete`), AND
- `current_phase` has not transitioned

**Near-identical query repetition**
- Same tool name called ≥ 3 times with semantically similar inputs (cosine similarity above threshold on the input arguments), AND
- No `previous_step_reflection` indicating learning between the calls

**Time-since-progress threshold**
- ≥ 10 minutes since `progress_toward_session_goal` advanced, AND
- ≥ 5 steps since last advance

**Confidence collapse**
- `confidence` field has declined by ≥ 0.3 over the last 5 steps (e.g., from 0.8 to 0.45), AND
- No `last_diagnosis` was populated in the same window (model is losing confidence without articulating why)

### 6.3 Injection mechanism

When a trigger fires, the middleware injects a system message into the model's next completion context:

```
HARNESS SIGNAL — STUCK DETECTION

You have made <N> consecutive <tool_name> calls without advancing
progress_toward_session_goal. Pattern detected: <specific pattern>.

Possible responses:
- If you have new information to act on, proceed but explain in your
  next action_hypothesis why this call differs from the previous attempts.
- If you are stuck and need a different approach, change tools or
  strategy. Document the shift in your next lesson field.
- If you are stuck and the user's input is needed, route to Sophia
  via builder_handoff with a clear question.

This signal is informational; you are not blocked. Acknowledge it in
your next artifact (action_hypothesis or lesson field).
```

The message is injected once per trigger event. The middleware then resets the trigger state and watches for the next condition.

### 6.4 What the model does with the signal

The next artifact's `action_hypothesis` or `lesson` field is expected to reference the stuck-detection signal:

- If continuing the same approach: explain why the current attempt is different (new information, different parameters)
- If changing approach: explain the shift in `action_hypothesis`, record the realization in `lesson`
- If escalating: call `builder_handoff` to Sophia with a clarifying question

The harness does not enforce that the model address the signal. The audit period tracks whether the model's response is substantive or perfunctory.

### 6.5 Tunable thresholds

All thresholds (consecutive count, time windows, confidence decline) are configurable. Defaults are conservative — better to miss some stuck patterns than to fire spurious signals that desensitize the model. The audit period iterates on the thresholds.

---

## 7. `check_async_task` Enrichment

### 7.1 Current shape

Currently `check_async_task` returns:

```json
{
  "task_id": "abc-123...",
  "status": "running" | "completed" | "failed" | "cancelled",
  "result": "..."  // only when status is "completed"
}
```

This gives Sophia status but no structured visibility into what builder is currently doing. Sophia's user-facing ack defaults to generic ("still running") because there's no richer signal.

### 7.2 Enriched shape

```json
{
  "task_id": "abc-123...",
  "status": "running",
  "result": null,
  "latest_artifact_summary": {
    "step_number": 18,
    "current_phase": "research",
    "turn_goal": "Find 2 papers with empirical onboarding outcome data",
    "progress_toward_session_goal": "mid",
    "confidence": 0.62,
    "last_diagnosis": null,
    "minutes_elapsed": 7.3
  }
}
```

The summary contains six fields drawn from the latest artifact:

- `step_number` — useful for showing progress in the side panel
- `current_phase` — Sophia translates to user-facing phase descriptions
- `turn_goal` — Sophia translates to "she's working on X right now"
- `progress_toward_session_goal` — Sophia translates to rough completion language
- `confidence` — flagging if confidence is low (Sophia can hedge appropriately)
- `last_diagnosis` — populated only if an error just occurred; Sophia surfaces this to the user
- `minutes_elapsed` — wall-clock since task started

The full artifact is not returned by default to keep Sophia's context budget compact. A summary is enough for the ack translation.

### 7.3 Optional full-artifact flag

For cases where Sophia needs the full context (e.g., the user asks a specific question about the build's reasoning), an optional flag returns the complete latest artifact:

```python
check_async_task(task_id="abc-123", include_full_artifact=True)
```

Returns the full 12-field artifact in addition to the summary. This is used sparingly — Sophia's prompt teaches her that the summary covers ~95% of cases and the full artifact is for rare deep questions.

### 7.4 Trail history flag

A second optional flag returns the last N artifacts as a trail:

```python
check_async_task(task_id="abc-123", artifact_history_limit=5)
```

Returns the last 5 artifact summaries (not full artifacts) ordered chronologically. Used when Sophia needs to describe the arc of the build, not just the current state ("she ran into a chart library issue but worked around it; now she's drafting the recommendations").

### 7.5 Implications for Sophia's translation

Sophia's system prompt section on builder coordination (in the voice spec v1.3) teaches her how to translate these structured fields to natural language:

| Field value | Sophia's natural language |
|---|---|
| `current_phase: "research"` | "she's still gathering information" or "she's looking into [topic]" |
| `current_phase: "drafting"` | "she's writing it now" |
| `current_phase: "asset_generation"` | "she's working on the chart/image" |
| `progress_toward_session_goal: "early"` | "just getting started" |
| `progress_toward_session_goal: "mid"` | "about halfway" |
| `progress_toward_session_goal: "late"` | "almost done" |
| `progress_toward_session_goal: "near_complete"` | "wrapping up" |
| `last_diagnosis` populated | "ran into a snag with X but trying Y" — translate the diagnosis to user-friendly language |
| `confidence < 0.5` and stable | hedge: "working through it" rather than confident progress language |

The translation is taught by example in the prompt, not enforced. The audit period checks whether Sophia's acks feel natural rather than mechanical.

---

## 8. Persistence and Trail Management

### 8.1 In-session storage

The artifact trail lives in builder's runtime state:

```python
state["async_tasks"][task_id] = {
    "task_id": "abc-123",
    "status": "running",
    "started_at": 1716148800,
    "artifact_trail": [
        BuilderArtifact(...),  # step 1
        BuilderArtifact(...),  # step 2
        ...
    ],
    "metadata": {...},
}
```

The trail grows monotonically during the build. No pruning during the build — the model reads its own trail as needed for intra-build coherence.

### 8.2 Read access patterns

Builder reads its own trail via standard state access. No new tool. Common access patterns:

- **Reading the previous step's artifact** for reflection: builder accesses `state["async_tasks"][task_id]["artifact_trail"][-2]` (the trail's penultimate entry, since the current step's artifact hasn't been emitted yet).
- **Reading the full trail** for course correction: builder iterates `state["async_tasks"][task_id]["artifact_trail"]` when stuck or when starting a new phase.
- **Reading by phase**: builder filters by `current_phase` when consolidating phase output.

The trail is bounded by step count (typically 50-200 steps for long builds) and per-artifact size (~500 tokens). A 100-step build produces ~50K tokens of trail — large but within model context budgets.

### 8.3 Persistence to disk

At session end, builder's trail is persisted to the session's trace JSON:

```
backend/.deer-flow/users/{user_id}/sessions/{session_id}/builder_traces/{task_id}.json
```

This is the substrate the offline pipeline reads for extraction. The file is JSON, schema-validated, with one record per build task.

Sophia's per-turn artifact trail follows the existing trace path (per current trace_logger.py) — no new persistence path for Sophia.

### 8.4 Cross-session retention

Per the supersession of the session log spec and the Mem0 architecture, trails are NOT retained as queryable substrate across sessions. The offline pipeline extracts user-relevant content (Type A in §9) into Mem0 with appropriate categories. Operationally-shaped content (Type B in §9) is aggregated in the session trace JSON for future analysis but does not flow to Mem0.

Old session traces remain accessible on disk for audit and debugging but are not loaded into agents' contexts on subsequent sessions.

---

## 9. Offline Pipeline Integration

### 9.1 Two extraction shapes

The offline pipeline (step 2 of the existing 7-step pipeline) gains a branch for builder traces. When a session ends, the pipeline:

1. **Extracts from Sophia's artifact trail** (existing path, unchanged) — produces user-relevant memory candidates from conversation observations.
2. **Extracts from builder's artifact trail** (new path, this spec) — produces Type A (user-relevant) candidates and discards Type B (operational) content.

Both paths feed the same `CandidateValidator` middleware (per memory upgrades spec v2.1 §3.6) and the same `add_memories()` write path with `agent_name` distinguishing provenance.

### 9.2 Type A vs Type B distinction

The branching happens at extraction time, based on content shape:

**Type A (user-relevant)** — extracted to Mem0 with `agent_name="builder"`:
- User preferences discovered during the build ("user prefers dense formatting in slides")
- User-specific facts ("user's company is at example.com")
- Patterns about the user's domain ("user's industry uses these specific terms")
- Diagnostic patterns specific to the user ("user's PDFs always need Helvetica")

These flow to existing Mem0 categories (`preference`, `fact`, `pattern`) with provenance tagged.

**Type B (operational)** — aggregated to session trace, NOT to Mem0:
- Runtime failures ("matplotlib unavailable on this sandbox")
- Tool reliability observations ("Tavily weak for academic sources")
- System constraints ("WebRTC times out at 60s")

These are aggregated to a session-level `operational_observations.json` file in the session directory. They are available for future operational learning store work (deferred, §9.3) but do not enter the user-keyed memory system.

### 9.3 Cross-session operational learning (reserved)

If/when operational learning becomes valuable enough to want across sessions, it gets its own substrate spec. The shape might be:

- A separate operational knowledge store, not user-keyed
- Possibly shared across all builds in the Sophia deployment, or scoped per-deployment
- With its own retention rules (technical facts decay differently from user facts), its own access patterns (read at builder activation, write at session end), and its own privacy considerations (operational facts are not personal data but may still need access controls)

This is genuinely a different beast from Mem0 and deserves its own design conversation. Reserved as future work; not in v1 scope.

### 9.4 Extraction prompt branch

The existing `mem0_extraction.md` prompt continues to handle Sophia's trace. A new `builder_trace_extraction.md` prompt handles builder traces, branching by Type A vs Type B as described above.

The new extraction prompt teaches:
- How to identify Type A content (anything user-specific, role-specific, or domain-specific that isn't about the runtime)
- How to identify Type B content (anything about libraries, tools, sandbox capabilities, transport-level constraints)
- How to format Type A candidates with appropriate categories
- How to skip Type B content during extraction (or route to operational aggregation)

The CandidateValidator's existing rubric (specificity, behavioral language, importance calibration) applies to Type A candidates without modification.

---

## 10. Frontend Implications

### 10.1 Side panel: builder artifact stream

The frontend plan already provides a side panel for builder tasks. This spec extends the panel's content with per-step artifact rendering.

Each builder step renders as a card showing:
- Step number, phase, elapsed time
- `turn_goal` as the card's primary text
- `progress_toward_session_goal` as a progress indicator
- `confidence` as a subtle color/intensity signal
- `last_diagnosis` (if populated) prominently — typically with a warning color
- `lesson` (if populated) as a subtle footer
- Tool calls made during the step (if relevant)

The cards stack chronologically. The latest is at the top with auto-scroll; older cards collapse with a click-to-expand pattern.

### 10.2 Chat: `check_async_task` results

When Sophia calls `check_async_task` during a conversation, the chat surface renders a brief progress chip:

```
[Builder progress · about halfway · researching outcome data]
```

The chip's text comes from Sophia's translation of the summary fields. It's small, non-intrusive, and disappears after the turn. The full state lives in the side panel for users who want detail.

### 10.3 Failure handling

When `last_diagnosis` is populated, the side panel surfaces it prominently. The chat surface shows Sophia's natural-language translation:

```
"She ran into trouble with the chart library — switching to plotly."
```

The user can click through to see the structured diagnosis if they want detail. Default is the natural translation; structured detail is one click away.

### 10.4 No separate session log rendering

The session log substrate is retired. There is no separate "session log" panel in the frontend. Everything that would have rendered from the log now renders from artifact trails: Sophia's introspection in her artifact's reflection/lesson fields (not separately surfaced — these are model-internal), and builder's coordination in the side panel.

---

## 11. Phased Implementation

### 11.1 Phase A — Builder artifact + middleware

**Duration:** ~5-7 working days implementation + 1 week staging

**Deliverables:**
- `BuilderArtifact` dataclass + JSON schema
- `BuilderArtifactMiddleware` with full test coverage (emission gate, error-state diagnosis gate, schema validation, trail append, SSE emission)
- Builder system prompt section teaching the schema and emission discipline
- `emit_builder_artifact` tool updated to validate against the schema
- Persistence path for trail to session trace JSON
- Regression tests for existing builder flow (no regression in `start_builder_task`, `update_async_task`, `check_async_task`, etc.)

**Acceptance:**
- Builder emits a valid artifact on every completion cycle in test scenarios
- Post-error step's artifact has `last_diagnosis` populated (gate enforced)
- Trail persists to disk with correct schema
- SSE events fire correctly

### 11.2 Phase B — `check_async_task` enrichment + Sophia translation

**Duration:** ~3-5 working days implementation + 1 week staging

**Deliverables:**
- `check_async_task` returns enriched response with `latest_artifact_summary`
- Optional flags for `include_full_artifact` and `artifact_history_limit`
- Sophia voice spec v1.3 carries the translation guidance in her system prompt (paired with this spec)
- Frontend chip rendering for the chat-surface progress indicator

**Acceptance:**
- 5 manual scenarios show Sophia translating structured summary to natural language naturally
- Side panel updates as builder emits new artifacts
- Optional flags work correctly with no default-shape regression

### 11.3 Phase C — Sophia artifact extensions

**Duration:** ~2-3 working days implementation + 2 weeks audit

**Deliverables:**
- `previous_turn_reflection` and `lesson` fields added to Sophia's artifact schema
- Voice spec v1.3 carries the prompt guidance
- Audit dashboard for field quality during the 2-week period

**Acceptance:**
- Fields appear in the artifact stream
- During audit, ≥ 80% of populated entries are specific and substantive (not performative)
- GEPA pipeline ingests the new fields without errors

### 11.4 Phase D — Stuck detection

**Duration:** ~3-5 working days implementation + 1 week staging

**Deliverables:**
- `StuckDetectionMiddleware` with all four trigger conditions
- Synthetic prompt injection mechanism
- Tunable thresholds via configuration
- Telemetry for trigger events

**Acceptance:**
- All four triggers fire correctly in synthetic test scenarios
- False-positive rate ≤ 5% in production sampling
- Model responses to triggers are substantive in ≥ 70% of audited cases

### 11.5 Phase E — Offline pipeline integration

**Duration:** ~3-4 working days implementation + 1 week staging

**Deliverables:**
- `builder_trace_extraction.md` prompt
- Pipeline branch for builder traces (Type A → Mem0, Type B → operational aggregation)
- CandidateValidator integration unchanged (rubric handles Type A naturally)
- Operational aggregation file format defined

**Acceptance:**
- Builder-sourced memory candidates appear in Mem0 with `agent_name="builder"` and correct categories
- Operational observations aggregate to per-session JSON file
- No Type B content leaks into user-keyed Mem0

### 11.6 Sequencing relative to voice spec phases

The voice spec v1.3 stages Phase 1 (basic voice + 10 tools), Phase 2 (artifact + time awareness), Phase 3 (Sophia artifact extensions for prediction reflection).

This spec's phases map approximately:
- Phase A (Builder artifact) — independent of voice phases, can ship in parallel to voice Phase 1 or 2
- Phase B (`check_async_task` enrichment + translation) — depends on voice Phase 1 (basic tool surface)
- Phase C (Sophia artifact extensions) — ships as voice Phase 3
- Phase D (Stuck detection) — independent; can ship anytime after Phase A
- Phase E (Offline pipeline) — depends on Phase A; ships after Phase A is stable

Total scope across all phases: ~16-24 working days plus staging windows.

---

## 12. Validation

### 12.1 The 2-week audit period

After each phase ships, a 2-week audit period validates field quality, middleware behavior, and translation naturalness. The audit reads production trails and labels:

**Sophia artifact extensions:**
- `previous_turn_reflection` quality: specific comparison + affective signal (good) vs generic or absent when warranted (bad)
- `lesson` quality: actionable and specific (good) vs platitude or performative (bad)
- Null rate: are these fields being left null when honest, or filled with noise?

**Builder artifacts:**
- `turn_goal` specificity: concrete sub-objective (good) vs vague restatement of session_goal (bad)
- `action_hypothesis` reasoning: testable forward claim (good) vs untestable assertion (bad)
- `previous_step_reflection` substance: real comparison (good) vs filler (bad)
- `last_diagnosis` quality on error steps: structured what/why/try (good) vs missing fields (bad)
- `lesson` rate: populated when warranted; null on routine steps

**Translation naturalness:**
- Does Sophia's ack from `check_async_task` results sound natural?
- Does she handle the diagnosis surfacing gracefully?

### 12.2 Iteration triggers

If the audit reveals:
- A field is consistently filled with noise → tighten prompt with negative examples
- A field is consistently null when it should have content → tighten prompt with positive examples and emphasis
- A middleware gate fires too often → refine detection logic
- A translation is consistently awkward → refine the translation guidance in Sophia's prompt

The schema itself is not changed during the audit period unless a fundamental issue surfaces (e.g., a field that no one can meaningfully fill).

### 12.3 GEPA signal

After the audit, GEPA (or whatever optimizer is in place) consumes the artifact trails as labeled training data. The signal shape:

- **Calibration training**: `prediction_confidence` and `confidence` vs actual outcome rate
- **Reflection training**: `previous_turn_reflection` and `previous_step_reflection` quality + how often the prediction matched
- **Pattern training**: `lesson` field aggregated across sessions → recurring patterns become candidates for prompt-level updates
- **Failure training**: `last_diagnosis` aggregated → recurring failure modes become candidates for harness-level interventions or tool selection improvements

---

## 13. Risks and Open Questions

### 13.1 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Field bloat: too many fields produce filler | Medium | Schema is fixed at 12 + 2; audit-driven prompt tightening; resist adding fields without strong evidence |
| Performative content: `lesson` filled with platitudes | Medium-High | Negative examples in prompt; audit; willing to revise prompt iteratively |
| Latency cost: per-step artifact adds noticeable build duration | Medium | Measured target: ≤ 200ms per step; optimization available if exceeded |
| Stuck detection false positives: model gets desensitized to spurious signals | Medium | Conservative defaults; tunable thresholds; audit |
| Schema drift: implementation diverges from spec over time | Low | Schema validation in middleware; tests on schema shape |
| Sophia translation feels mechanical | Medium | Translation taught by example; audit reads naturalness |

### 13.2 Open questions

These are deliberately left open in v1 and revisited based on audit findings:

**Q1: Should planning steps emit artifacts in the same shape?**
A planning step's `turn_goal` is often "decompose this task into substeps" which is structurally different from later steps. The schema works but feels stretched. v1 ships with the same schema; iteration may add a `planning` variant if the stretch becomes a problem.

**Q2: How do subagent steps surface in the parent artifact trail?**
When builder spawns subagents (research, drafting), the subagent's work is currently invisible at the parent trail level. v1 makes the subagent's tool calls visible in the parent step's tool record but does not give subagents their own artifact emission. Subagent artifact ownership is future work.

**Q3: Should `assumption_made` be required when the model could reasonably notice an assumption?**
v1 makes it optional and trusts the model to populate when honest. If audit shows the field is consistently null when assumptions are clearly being made, the prompt tightens with positive examples.

**Q4: What's the right rate for `lesson` population?**
Too rare and we lose signal; too frequent and we get noise. v1 has no quota — model decides. Audit measures the rate and informs prompt guidance.

**Q5: How does `progress_toward_session_goal` handle non-linear builds?**
Some builds revisit phases (e.g., back to research after drafting reveals a gap). The categorical progression assumes monotonic forward motion. v1 accepts that "late" can become "mid" again temporarily; the categorical labels are honest about uncertainty.

**Q6: Should `check_async_task` always include a small trail history by default?**
Currently the default is summary-of-latest only. If Sophia consistently needs more context for translation, the default may shift to include the last 2-3 artifacts. Audit decides.

---

## 14. Acceptance Checklist and Assumptions

### 14.1 Acceptance checklist

**Phase A — Builder artifact + middleware:**
- [ ] `BuilderArtifact` dataclass implemented with all 12 fields and validators
- [ ] `BuilderArtifactMiddleware` registered in builder chain at position 10
- [ ] Emission gate verified: artifact required on every completion cycle
- [ ] Error state detection verified: post-error step's artifact gates `last_diagnosis`
- [ ] Schema validation verified: closed enums, length limits, required fields all enforced
- [ ] Trail persistence to `state["async_tasks"][task_id].artifact_trail` verified
- [ ] SSE event `sophia.builder.artifact_emitted` emitted per step
- [ ] Builder system prompt section deployed teaching schema and discipline
- [ ] Regression tests pass: existing builder flow unchanged

**Phase B — `check_async_task` enrichment:**
- [ ] `check_async_task` returns `latest_artifact_summary` with 7 fields
- [ ] Optional flags `include_full_artifact` and `artifact_history_limit` work correctly
- [ ] Sophia voice spec v1.3 translation guidance deployed in prompt
- [ ] Frontend progress chip rendering deployed
- [ ] 5 manual scenarios pass: Sophia's ack feels natural

**Phase C — Sophia artifact extensions:**
- [ ] `previous_turn_reflection` and `lesson` fields added to Sophia's artifact schema
- [ ] Voice spec v1.3 prompt guidance deployed
- [ ] Audit dashboard captures field quality during 2-week period
- [ ] GEPA pipeline ingests new fields without errors

**Phase D — Stuck detection:**
- [ ] All four trigger conditions implemented and tested
- [ ] Synthetic prompt injection mechanism verified
- [ ] Thresholds configurable via environment variables
- [ ] Telemetry events `sophia.builder.stuck_detected` fire on triggers
- [ ] False-positive rate measured in staging: ≤ 5%

**Phase E — Offline pipeline integration:**
- [ ] `builder_trace_extraction.md` prompt deployed
- [ ] Pipeline branch for builder traces implemented
- [ ] Type A content flows to Mem0 with `agent_name="builder"` and correct categories
- [ ] Type B content aggregates to `operational_observations.json` per session
- [ ] CandidateValidator handles Type A candidates without modification

**Feature flags:**
- [ ] `BUILDER_ARTIFACT_ENABLED` flag defaults `False`, staged rollout in place
- [ ] `STUCK_DETECTION_ENABLED` flag with independent rollback
- [ ] `BUILDER_TRACE_EXTRACTION_ENABLED` flag for the offline pipeline branch
- [ ] All flags can be flipped independently for staged rollout

**Staging and rollout:**
- [ ] Each phase ships behind its flag; flag defaults to off
- [ ] 1-2 week staging soak per phase before production
- [ ] Production rollout completes without errors
- [ ] Audit period (2 weeks) follows each phase
- [ ] v1 code paths remain stable for one release cycle before refinement

### 14.2 Assumptions

1. Builder runs in LangGraph with middleware chain support; middleware can gate completion cycles and inject prompts.
2. Sophia runs in OpenAI Realtime API; mid-utterance middleware gating is not available, so prompt discipline is the enforcement mechanism for her artifact extensions.
3. The existing artifact mechanism (`emit_artifact` for Sophia, `emit_builder_artifact` for builder's final artifact) is the foundation; this spec extends rather than replaces it.
4. Mem0 v3 platform (per memory upgrades spec v2.1) supports the `agent_name` metadata field and the dual-write pattern of Upgrade C.
5. The offline pipeline's 7-step structure is unchanged; step 2 (memory extraction) gains a branch for builder traces.
6. The existing CandidateValidator handles Type A builder candidates without modification — its rubric applies generically.
7. GEPA or another self-improvement loop will eventually consume the artifact trails; the schema is designed to be trainable.
8. The 2-week audit period per phase is a real discipline, not a checkpoint that gets skipped under deadline pressure.

---

## 15. Migration Notes

### 15.1 From session log spec

The session log spec v1.0 and v1.0.1 are superseded. The migration path:

1. **No code from session log spec was implemented.** The spec was design-complete but not built. There is nothing to migrate at the code level.
2. **The supersession is bookkeeping only.** Add a `**Status: SUPERSEDED**` header to the session log spec files pointing to this document. The original specs remain in the repository as historical context.
3. **The concepts carried forward**: the harness/model boundary, the gated-write pattern for failure diagnoses, the cross-agent coordination question, the agents.md teaching path for discipline. All preserved, just relocated to artifact substrate.
4. **The concepts retired**: the markdown log file substrate, the `write_log` and `read_log` tools, `BuilderPhaseLoggingMiddleware`, `BuilderMidstreamCheckMiddleware`, the midstream_signal entry type, phase markers as separate log entries.

### 15.2 From voice spec v1.2.1

The voice spec needs revision (paired deliverable v1.3) to align with this spec. The changes in v1.3:

- Session log section (§10) removed entirely
- `write_log` and `read_log` tool specifications (§7.8, §7.9) removed
- §6.4 in-process integration paragraph loses its log-tool mentions
- Frontend contract events (§11.2) lose `sophia.tool.write_log`, `sophia.tool.read_log`, `sophia.session.log.appended`
- §14 phasing's Phase 3 changes to "Sophia artifact extensions" (the two new fields)
- §17 risks table loses log-related rows
- New section added: builder coordination via artifact summary translation
- Changelog gains a "What changed in v1.3 vs v1.2.1" section explaining the architectural shift

### 15.3 From frontend plan

Minimal updates:

- §3.1 companion stream events list updated (no `write_log` / `read_log` events; add `sophia.builder.artifact_emitted`)
- §4.1 visibility table updated (no log tool rows)
- New §4.4 added: Builder artifact rendering in the side panel
- §8.7 stays as web tool result rendering, unchanged

### 15.4 What stays the same

- Mem0 architecture (memory upgrades spec v2.1 unchanged)
- Existing async lifecycle tools (`start_builder_task`, `update_async_task`, `check_async_task`, `cancel_async_task`, `list_async_tasks`) work as designed in the subagents async tools plan
- `emit_artifact` requirement for Sophia (existing contract, schema extended)
- `emit_builder_artifact` for builder's final artifact (separate from per-step traces)
- Offline pipeline 7-step structure
- Mem0 9-category classification

---

## End of Spec v1.0
