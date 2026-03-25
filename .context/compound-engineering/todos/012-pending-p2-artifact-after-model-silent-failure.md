---
status: pending
priority: p2
issue_id: "012"
tags: [code-review, correctness]
dependencies: []
---

# ArtifactMiddleware.after_model Silently Fails on Tool Result Messages

## Problem Statement

In `after_model`, the reverse message scan hits tool result messages (type="tool", name="emit_artifact") first and breaks WITHOUT setting `artifact_data`. The actual data is in the AI message's tool_calls args, but the scan never reaches it. Artifact capture fails silently on multi-step agent loops.

## Findings

- **Correctness agent (MEDIUM, 0.80 confidence):** The tool result branch (lines 73-79) executes break without capturing data.

**Location:** `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/artifact.py`, lines 70-89

## Acceptance Criteria

- [ ] Remove the tool message branch or fix it to not prevent AI message scanning
- [ ] Test with both tool results and AI messages present in history
