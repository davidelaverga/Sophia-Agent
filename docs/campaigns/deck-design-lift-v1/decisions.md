# DQ-2 Decisions

## DQ2-001 — Freeze the production prompt before implementation

The prompt in `mission.md` is the canonical PSI request. It includes every required factual and narrative element while leaving visual design to Sophia. Production attempts may add only the transport marker needed to select the presentation builder; they may not alter the brief.

## DQ2-002 — Use one exact internal canary identity

The currently authenticated production Sophia account is the sole campaign identity. Render stores its exact Better Auth user ID on both gateway and LangGraph. Evidence and reports use only the SHA-256 fingerprint unless a secure operational check requires the raw value.

## DQ2-003 — Reuse the existing OpenAI credential through a DQ-only alias

The operator explicitly authorized use of the already configured production OpenAI API key. LangGraph therefore maps that credential into `SOPHIA_DECK_QUALITY_OPENAI_API_KEY`; gateway never receives it. Code must still require the DQ-specific environment name, exact-canary admission, locked route capability, call/cost limits, and no fallback. Equality with the baseline credential is permitted only through an explicit production authorization switch; it is not the default configuration.

This deliberately relaxes DQ-1's credential-value inequality check without relaxing route, scope, privacy, or call-budget isolation.

## DQ2-004 — Keep evidence per experiment

All required evidence lives below `evidence/<experiment-id>/`. Immutable artifacts, manifests, judgments, comparisons, production indexes, self-audit, and `SHA256SUMS` share the experiment root.

## DQ2-005 — Prefer `satisfied` for first success

The first successful production target must prefer a blind second verdict of `satisfied`. `needs_user_review` is eligible only when its critical-floor and strong-improvement conditions are explicitly frozen and proven; ambiguity is not treated as approval.

## DQ2-006 — Improve the procedure, never the fixture manually

The supplied PPTX is a diagnostic negative anchor only. Campaign success must start with a fresh normal-builder artifact from `sophia-ei.com`; no fixture seeding, screenshot-backed slide, or manual artifact edit can satisfy the mission.
