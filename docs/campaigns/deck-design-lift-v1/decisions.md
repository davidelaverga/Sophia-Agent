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

## DQ2-007 — A consumed run is terminal; iteration uses a fresh experiment

The failed production run `dq2-campaign-20260719t102932z` consumed its sole repair call and is permanently ineligible for retry. Its transaction was rolled back with the original manifest unchanged. The campaign specification scopes “no retry” to that campaign run while directing the coding agent to repeat fresh production attempts until success. Further work therefore uses a new normal-app deck and new campaign, experiment, operation, and transaction identities, with one repair maximum in that new loop.

## DQ2-008 — Persist the repair result before terminal trace completion

A successful provider response must be canonicalized, stored immutably, and exact-read back before the pre-admitted LangSmith run is terminalized. Candidate materialization remains blocked until the terminal trace is proven exact. A trace completion exception leaves the transaction prepared so recovery can reopen only the deterministic existing trace and reuse only the persisted result; it can never call the provider again.

## DQ2-009 — Seal trace-admission failures even when generation was never called

Experiment `dq2-psi-agent-architecture-20260719t142956z` wrote its invoke-once intent and passed the exact 25,238-token cost preflight, then failed while validating the LangSmith project before repair generation. Although the generation count is zero, the transaction and operation are terminal: an intent without a canonical result cannot be reused safely. Iteration must use a new normal-app deck and wholly new campaign identities.

## DQ2-010 — Gate the next fresh experiment on exact LangSmith read health

Generic metadata-ingestion HTTP 204 responses do not prove that DQ-2's project/run API is usable. Before exposing another fresh deck to DQ-2, require a read-only `read_project` identity check against the exact EU endpoint, workspace, project name, and project UUID, followed by a deterministic run read. No write probe or synthetic trace may substitute for this check.

## DQ2-011 — Resolve an ambiguous invocation only from provider-side per-call logs

Experiment `dq2-psi-agent-architecture-20260719t173509z` created its deterministic LangSmith root but failed closed during immediate readback. Render and storage could prove only an upper bound of one repair generation. The authenticated OpenAI Platform Logs UI was therefore used as the authoritative per-call audit surface: project `Sophia`, source `Responses`, model `gpt-5.6-sol`, the exact 1.11-second hard window, and a widened five-minute window all contained zero matching generation records. Prompt and response content were not opened. That evidence releases the campaign to a new experiment; timing inference alone never may.

## DQ2-012 — Treat compiler contracts as repair-author contracts

Experiment `dq2-psi-agent-architecture-20260720t092819z` completed exactly one repair generation, terminalized the exact LangSmith EU trace, and persisted the canonical structured result. Candidate materialization then failed because the model-authored slide-2 CSS exceeded the compact-v2 1024-byte limit; a read-only relaxed-limit diagnostic also found three slide-2 native alignment residues. The operation is consumed and terminal. Before another generation, every non-schema compiler constraint needed for successful materialization must be serialized into the sealed author prompt and structured repair constraints, then locally regression-tested.

## DQ2-013 — Preserve visible content by normalized token sequence

Experiment `dq2-psi-agent-architecture-20260720t101520z` satisfied the new compact CSS and geometry contract, rebuilt a native five-slide deck, and passed mechanics, retention, contrast, native inventory, unchanged-render collateral, and editability checks. The authoritative content proof then rejected one additional visible Unicode symbol on slide 2. The operation is consumed and terminal. Future body updates must preserve the exact normalized visible HTML token sequence: markup may be restructured, but visible glyphs, symbols, labels, and words may not be added, removed, rewritten, split, merged, or reordered. A raw text-node comparison is deliberately rejected because valid slide-5 restructuring changed node boundaries without changing the rendered token sequence.

## DQ2-014 — Abandon a mechanically exhausted baseline without app-level retry

Experiment `dq2-psi-agent-architecture-20260730t082351z` submitted the frozen brief exactly once through a wholly fresh authenticated production session. The first authoring pass failed mechanics because a non-text shape extended off-slide and native alignment regressed. The bounded service-quality repair removed those defects but left three material overlaps, so the builder failed closed before artifact publication or DQ-1. The app-level `try again` action was not used. Because the same deployed commit previously produced a mechanically valid five-slide baseline, this single failure does not justify a broad runtime change. Continue with a wholly fresh session and new baseline identity; if the same mechanical family recurs, stop and patch the authoring or lint contract before another production attempt.

## DQ2-015 — Prevent repair collateral without expanding the one-repair budget

Experiment `dq2-psi-agent-architecture-20260730t084230z` used a wholly fresh normal-app session and again failed closed before artifact publication. Its first call violated the strict slide-1 repair-anchor contract. The sole bounded repair corrected the IR and produced exactly five native/editable slides, but one reciprocal text-shape collision pair remained on slide 2 and failed mechanics.

The repeated overlap family is authoring collateral, not a reason to relax gates or expand retry count. D2.1.1 continues to permit exactly one shared input-repair retry. Harden the first-pass and repair prompts instead: use existing content containers as anchors, never add duplicate overlay text, keep unrelated visible text-bearing rectangles at least 16px apart in canvas-global space, permit containment only in non-text backgrounds, and preserve connector/background edge touching. Deploy that contract before another production attempt.

## DQ2-016 — Complete only a unique unused anchor-invariant carrier

Experiment `dq2-psi-agent-architecture-20260730t092401z` ran on the exact deployed authoring-contract patch and failed safely before publication. Its initial five-slide source had ten eligible direct-child repair anchors and safe standalone literal-pixel geometry, but the mandatory `position:absolute`, `box-sizing:border-box`, and `margin:0` constants lived only in one unique simple class rule that matched no slide element. The strict validator correctly rejected the incomplete per-anchor contract. The sole shared repair changed the stylesheet and `html_body` on slides 1 and 3, but the `#hero` and `#why` rules and their opening anchor tags remained identical and still lacked the same three invariants. The full prior arguments and repair instruction were present, so attribution to the same strict predicate is proven rather than inferred from truncated context.

Fresh authoring may complete this one mechanically unambiguous contract before strict validation. Completion is allowed only when every declared anchor is eligible, every anchor has exactly one standalone `#id` rule containing only complete safe literal-pixel `left`, `top`, `width`, and `height`, exactly one unused simple class rule contains only the three exact mandatory constants, and no other selector can apply protected geometry or invariant declarations to an anchor. The normalizer copies only those constants into the existing `#id` rules, changes no HTML, remains within the stylesheet byte bound, and then runs the unchanged strict validator.

This completion is fresh-only: candidate compilation remains ineligible. A missing, used, malformed, or non-unique carrier, unsafe or incomplete geometry, duplicate selector, competing protected declaration, invalid anchor, or size overflow fails closed. No-op cases retain the existing generic one-repair path. The D2.1.1 budget remains exactly one shared input-repair retry; no retry or gate expansion is authorized.
