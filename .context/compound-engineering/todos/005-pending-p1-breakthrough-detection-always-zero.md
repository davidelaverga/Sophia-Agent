---
status: pending
priority: p1
issue_id: "005"
tags: [code-review, correctness]
dependencies: []
---

# Breakthrough Detection Can Never Trigger — tone_delta Always 0

## Problem Statement

In `_select_skill`, both `tone` (line 86) and `prev_tone` (line 115) read from the same `previous_artifact` dict. They always return the same value, making `tone_delta` always 0. The `celebrating_breakthrough` skill can never be selected. This is a dead code path that silently fails.

## Findings

- **Correctness agent (HIGH, 0.95 confidence):** Both variables read the same field from the same dict. The intent was to compare current vs previous tone, but there is no current tone before the model responds.

**Location:** `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/skill_router.py`, lines 86, 115-119

## Proposed Solutions

### Option A: Compare across turns via state (Recommended)
Store the prior turn's tone_estimate in skill_session_data. On the next turn, compare new previous_artifact.tone_estimate against stored value.
- Pros: Correctly detects tone spikes across turns
- Effort: Small
- Risk: Low

### Option B: Move breakthrough detection to after_model
Check in after_model after the artifact is emitted, comparing current_artifact vs previous_artifact.
- Pros: Has access to both tones
- Cons: After model is too late to influence skill selection for the current turn
- Effort: Medium

## Recommended Action

Option A — track last_tone in skill_session_data.

## Acceptance Criteria

- [ ] Tone spike >= 1.0 with insight language triggers celebrating_breakthrough
- [ ] Test verifies breakthrough detection with proper tone delta setup
