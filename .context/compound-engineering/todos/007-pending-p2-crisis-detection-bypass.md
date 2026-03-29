---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, security, safety]
dependencies: []
---

# Crisis Detection Trivially Bypassed — Safety-of-Life Concern

## Problem Statement

Crisis detection uses exact substring matching against 10 phrases. Easily bypassed by typos ("kms"), Unicode substitution, indirect expression ("everyone would be better off without me"), coded language ("ctb"), or spacing changes. For a voice companion handling vulnerable users, this is a safety-of-life concern.

## Findings

- **Security agent (CRITICAL-3):** The application's safety net depends on this middleware. Failure means vulnerable users don't receive crisis resources.

**Location:** `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/crisis_check.py`, lines 14-25

## Proposed Solutions

### Option A: Expand signal list + normalize text (Recommended for MVP)
Add 40+ indirect patterns, normalize Unicode to ASCII, collapse whitespace before matching.
- Effort: Medium
- Risk: Low (false positives are safer than false negatives here)

### Option B: Lightweight classifier
Use Claude Haiku with a focused crisis classification prompt.
- Pros: Catches indirect language
- Cons: Adds latency (~200ms), API dependency
- Effort: Medium

## Recommended Action

Option A for MVP, plan Option B for production.

## Acceptance Criteria

- [ ] Signal list expanded to 50+ patterns including indirect expressions
- [ ] Text normalization applied before matching
- [ ] Tests cover indirect and obfuscated crisis language
