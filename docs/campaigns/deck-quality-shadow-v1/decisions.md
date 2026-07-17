# Campaign DQ-1 Decisions

## 2026-07-15 — Authority and supersession

Campaign DQ-1 is the execution contract. P-2, D3, and D3.2 retain their stated
ownership. `specs/sophia_spec_D3_deck_evaluation_rubric_loop.md` is retained as
historical provenance and is not implemented where it conflicts with D3.2 or
DQ-1. In particular, DQ-1 does not grant an LLM acceptance authority, combine
mechanical evidence into blind Assessment A, emit replacement HTML, inject
generic transcript feedback, or run automatic repair.

## 2026-07-15 — Baseline freeze

The campaign baseline and production rollback SHA is
`f05efb3adce121fb0af009407b7fc53ba6e98312` for both Render services. The fixed
PSI canary completed through the real app before quality code. The downloaded
PPTX and contact-sheet hashes are recorded in `state.md` and
`experiments.jsonl`. The exact LangSmith builder trace, build ID, operation ID,
durable event journal, and artifact registry version were retrieved and
correlated. No DQ-1 span or stored quality prefix existed at baseline.

## 2026-07-15 — Assessment ownership

Assessment A owns blind rendered observation and receives only the brief,
explicit request constraints, rendered evidence, visible-text evidence, stable
selectors, and its rubric projection. Assessment B is deterministic mechanical
truth and is projected only after A is persisted. Assessment C is a separate
fresh request that owns plan realization. Only deterministic adjudication can
produce the shadow result.

## 2026-07-15 — Rubric source classification

`skills/public/sophia/deck_rubric.yaml` is the canonical rubric. Every tracked
source rule has one explicit classification. Mechanical rules remain mechanical
gates; controller invariants do not become judge taste; repair guidance remains
future-only; and brand/minimal/table-led exceptions are exclusions that prevent
anti-default heuristics from overriding an explicit request.

## 2026-07-15 — Provisional adjudication thresholds

Stage 1 begins with a critical score floor of `3` and a minimum weighted score
of `3.5` on a 1–5 scale. These thresholds are provisional instruments, not
evidence of calibration. Any threshold change requires a rubric/version change,
a dated experiment, and rerunning the complete available anchor corpus.

## 2026-07-15 — Fixture-label integrity

Appendix B's PSI expectation is recorded as `supplied_by_campaign_spec`, not as
an independently collected human label. The campaign currently has zero
confirmed labels toward the 12-human-label completion gate. Labels will never be
placed in model messages or changed to improve agreement.

## 2026-07-15 — Deep Agents boundary

Deep Agents rubric middleware remains a reference pattern only. Generic
`RubricMiddleware` will not be placed in Sophia's builder chain. DQ-1 requires an
artifact-centered, image-aware, independently traced quality graph.

## 2026-07-15 — Lossless high-detail image transport (superseded)

The current OpenAI Responses image-input contract exposes `low`, `high`, and
`auto`; it does not expose the spec's requested `original` detail literal. DQ-1
therefore sends the original lossless PNG bytes with `detail=high`, records
image hashes and dimensions, and treats this as a non-load-bearing API wording
amendment. It does not downsample or silently substitute JPEG evidence.

This decision was based on the pinned SDK/LangChain type declarations rather
than the current provider contract and is superseded by the decision below.

## 2026-07-16 — Original-fidelity individual-slide transport

The current official OpenAI image-input contract explicitly supports
`detail=original` for GPT-5.6 and states that it preserves input dimensions.
The pinned LangChain Responses adapter forwards the detail literal unchanged
even though its static `ImageURL` type declaration has not yet added that
literal. DQ-1 therefore sends the bounded contact sheet with `detail=high` and
every lossless individual PNG with `detail=original`, as locked by the campaign
specification. This model-input change advances the evidence preprocessor from
`deck-evidence-v2` to `deck-evidence-v3` and requires a complete new calibration
run; no result produced by v2 is relabeled or overwritten.

The v3 route also sends the rest of the locked GPT-5.6 profile explicitly:
`reasoning={effort: high, mode: standard, context: current_turn}`, Responses API,
strict structured output, `store=false`, and no `previous_response_id`. The two
deck assessments are independent calls, so neither provider response nor prior
reasoning is reused across assessments or artifacts.

## 2026-07-15 — Private judge payloads never use automatic tracing

Assessment messages contain base64 images and, for C, raw creative/design-plan
bodies. They are built and invoked only with factory tracing disabled, model
callback/tag/metadata state cleared, an explicit empty Runnable callback config,
and a LangSmith `enabled=False` context. Provider and parser exceptions are
converted to controlled error codes without retaining a raw cause. Production
observability will use a separate manually emitted trace containing only typed
identifier, hash, count, timing, usage, verdict, and controlled-code fields.

## 2026-07-15 — Offline SDK transport diagnosis

The first Sol smoke failed before response headers. An authenticated model GET
succeeded with both `urllib` and a custom `httpx` client, while the pinned
OpenAI SDK's default client disconnected from this workstation. The isolated
smoke harness now owns and closes an explicit async `httpx` client. The locked
route still uses zero automatic retries so provider failures remain visible;
this workstation-specific transport accommodation is not a production model
migration or builder/companion change.

## 2026-07-15 — Current-brief memory sanitization

The downloaded baseline brief contained appended prior-memory blocks that were
not current-request evidence. The fixture materializer now removes only the
recognized appended-memory sections before constructing the blind brief, and
tests fail if those markers or known prior-memory phrases survive. The fixture
was rematerialized with sanitized canonical brief hash
`03bd27085bfbb8d641202ec9a52596d286bd5dc2c44b65ba95111a70921d3e1b`.
This prevents both privacy leakage and label/context contamination; it does not
rewrite current user constraints.

## 2026-07-15 — Human-label fields remain human-only

The Appendix B PSI anchor retains only fields explicitly supplied by the
campaign specification. Critical floors, ranked top failures, rationale, and
confidence are rejected on non-human records. A record marked `human` must
provide those fields. The current readiness count remains one complete bundle
and zero human labels; model output and campaign-agent visual inspection will
not be promoted into human labels.

## 2026-07-15 — Strict structured output and safe diagnostics

Assessment schemas use a provider-neutral, recursively normalized strict JSON
Schema dictionary and local Pydantic validation. The normalizer is tested
against the pinned OpenAI SDK's strict schema representation without importing
the provider SDK into the quality module. Controlled invocation failures retain
only an error code, provider error type/status, and schema field path/type; raw
responses, exception messages, causes, request bodies, and provider response IDs
are discarded.

The first 4,000-token strict response truncated before required fields. The
versioned judge profile therefore uses a 6,000-token completion ceiling and a
`$0.60` hard per-run cost cap for the offline smoke. The first complete run used
`$0.388175`; this is observed evidence, not a production traffic approval.

## 2026-07-15 — Stable safety identifier

A live provider validation response established a 64-character maximum for
`safety_identifier`. DQ-1 now sends `dq1-` plus 60 hexadecimal characters (240
bits), derived without exposing the canary user identifier. Tests require the
exact bound and forbid raw user IDs in request kwargs.

## 2026-07-15 — Typed uncertainty is not a score escape hatch

The assessment schema separates `material_taste`, `nonmaterial_taste`, and
`evidence_limit`. Only `material_taste` can cause `needs_user_review`, and only
after deterministic coverage, mechanics, critical floors, and weighted score
all pass. Native editability, exact font size, and numerical contrast are
evidence limits and cannot trigger review. A prompt revision must further state
that an observable deficiency already resolved by a rubric anchor is
nonmaterial; `material_taste` is reserved for a genuinely unresolved
verdict-straddling choice.

## 2026-07-15 — First complete live Sol smoke is a calibration failure

`dq1-sol-smoke-v7` proved full five-slide, multi-image, high-detail lossless PNG
transport; strict A/B/C output; usage accounting; bounded cost; and
deterministic adjudication. Its `needs_user_review` result does not agree with
the locked PSI `needs_revision` expectation. The instrument correctly found
default-look, mechanism, signature, fingerprint, and spatial-tension failures,
but awarded 5 to narrative and sequence rhythm and 4 to subject specificity.

The provisional critical floor of 3 allows a critical score of 3 to pass even
though every critical rubric anchor at 3 describes a visible deficiency. A
versioned experiment may test floor 4 together with general anti-halo prompt
semantics. The change cannot be called calibrated or promotable until it is
rerun against the available anchor and later against the required known-strong
and human-labeled corpus.

## 2026-07-15 — Assessment v4 makes uncertainty policy-deterministic

Assessment A and C cannot know the complete policy vector or one another's
scores, so they no longer label taste as verdict-changing. V4 permits only an
adjacent `taste_score_range` for one applicable criterion or an
`evidence_limit`. The emitted score must fall inside the adjacent range;
unknown/non-applicable criteria, duplicate ranges, invalid bounds, and ranges
that exclude the emitted score fail validation.

Adjudication first applies current-score critical and weighted gates. Only if
they pass does it lower every taste range to its plausible minimum and recompute
the gates. A conservative-vector crossing yields `needs_user_review`; otherwise
the ambiguity is nonmaterial and the result remains `satisfied`. Evidence
limits never affect the verdict. This preserves deterministic policy ownership
and prevents ordinary preference over an anchor-resolved defect from becoming
an escape hatch.

## 2026-07-15 — Rubric v2 candidate critical floor

The critical floor is versioned from 3 to 4, with the minimum weighted score
unchanged at 3.5. Every score-3 anchor on a critical criterion describes a
material visible deficiency; allowing 3 to pass was inconsistent with marking
those criteria critical. The `< floor` comparison remains unchanged. A replay
of exact v7 assessments changed only the policy and produced
`needs_revision` through `signature_realization=3` without a model call.

This floor remains provisional. One negative supplied anchor cannot measure
known-strong or exception false rejects, and the campaign still has zero
independent human labels.

## 2026-07-15 — V8 keeps the negative-anchor instrument provisionally

The fresh v4/v2 live Sol run returned `needs_revision`, mechanical `passed`, and
complete five-slide coverage at `$0.49138`. It grounded the critical failure in
narrative closing synthesis, subject specificity, and signature realization,
and matched four of five supplied required failure codes. No spurious taste
range changed the result.

The missing `low_sequence_rhythm` remains a calibration hypothesis: the current
anchor language lets surface format changes dominate cadence, density, and
energy. It will not be hidden or relabeled. Because the primary negative-anchor
verdict and at least three expected high-level findings now agree, the
instrument can proceed to canary-shadow runtime engineering, but it cannot be
called corpus-calibrated or promotion-ready.

The observed v8 cost supports a provisional `$0.60` hard ceiling only for the
dedicated synthetic production canary. It does not approve ordinary-user scope,
a higher ceiling, or broader traffic.

## 2026-07-16 — Dimension-stable evidence and exact cost admission

The historical PSI deck is physically 20 × 11.25 inches. A fixed raster DPI is
therefore not a stable quality or cost boundary: 192 DPI would produce
3840 × 2160 images and exceed the direct-path pixel lock. DQ-1 now renders each
PDF page with `pdftoppm -scale-to 2200`, bounds the contact sheet to 2048px,
sends the contact sheet as `detail=high`, and sends all five lossless individual
slides as `detail=original`. This changes the measurement pipeline from
`deck-evidence-v3` to `deck-evidence-v4`; v3 and the historical v8 bundle remain
immutable evidence and are not reinterpreted.

The official Responses input-token endpoint counted the complete v4 PSI
payloads at 22,633 tokens for A and 23,671 for C. At the locked Sol list prices
and 6,000 maximum output tokens per call, the worst case is `$0.591520`, leaving
`$0.008480` under the immutable `$0.60` cap. 2304px was measured at `$0.607170`
and is rejected. 2200px is a fixed maximum profile, not a guarantee that every
text payload fits; every run must pass exact admission. A rejected real canary
is recorded fail-closed and is never silently downsampled. Any later 2048px
profile would require another preprocessor version and complete recalibration.

## 2026-07-16 — One canonical request proves count/generation parity

`deck-judge-invoker-v4` prepares one canonical, memory-only Responses request
containing exactly the locked eight fields: model, stream, safety extra body,
reasoning, store, maximum output, input, and strict text schema. The request is
hashed in full; raw bytes are never logged, persisted, or represented. The
count endpoint receives the exact token-bearing projection, and direct
generation reuses the same decoded canonical request through the provider
client created by the model route. Added, missing, or changed request fields,
payload-hash drift, count failure, cost rejection, input-usage mismatch, or
model/pricing/output-cap drift all fail before inference or prevent the second
call. Both A and C are counted and admitted before either inference, and the
payload hash is bound into the durable provider-call intent.

## 2026-07-16 — V9 retains the v4 instrument after exact-request calibration

The first fresh run through `deck-evidence-v4` and
`deck-judge-invoker-v4` returned `needs_revision`, mechanical `passed`, and
complete five-slide coverage. The exact count endpoint reported 22,633 A input
tokens and 23,671 C input tokens, matching the earlier count-only evidence and
their full canonical payload hashes byte-for-byte. The locked worst case was
`$0.591520`; actual cost was `$0.456280` with no adaptive downsampling,
partial-response resume, provider storage, or private-payload tracing.

The result again matched four of the five supplied required failure codes:
`default_look_gravity`, `weak_subject_specificity`,
`weak_signature_realization`, and `weak_closing_synthesis`.
`low_sequence_rhythm` remains an explicit miss. The stable negative-anchor
verdict supports proceeding to production-canary reliability evidence, but one
synthetic supplied label still cannot establish corpus agreement, false-reject
risk, or promotion readiness.

## 2026-07-16 — Durable builder-event premise is invalidated

The mandatory predeploy audit found that the repository has no existing
durable builder-completion event path suitable for DQ-1. Terminal delivery is
posted from a daemon thread with process-local deduplication, the gateway event
worker is in-memory, and the candidate starts DQ admission only after baseline
delivery succeeds. Local-only source inputs are captured only after admission
is acknowledged. Process death can therefore either lose the publication
entirely or strand an `awaiting_inputs` row without recoverable source data.

This is the load-bearing premise named in DQ-1 section 8.3, not an ordinary
implementation defect. Longer retries or replaying the second POST do not make
the producer durable. The campaign is terminated as `PREMISE_INVALIDATED` and
the candidate is not deployed. Amendment 001 defines the required successor
architecture: canary-only immutable source mirroring, a durable producer
outbox before detached delivery, independent delivery/DQ reconciliation,
durable `shadow_dispatch_unavailable`, and explicit degraded DQ readiness.

The locked prohibitions remain unchanged: no enforcement, repair, Advisor,
ordinary-user OpenAI processing, or builder/companion migration is authorized.

## 2026-07-16 — Amendment 002 reopens DQ-1 on a durable producer boundary

The user explicitly authorized continued pursuit of DQ-1 using the supplied
context bundle and required the implementation, deployment, full production
test, artifact, and terminal proof. Amendment 001's historical
`PREMISE_INVALIDATED` result remains correct for the archived candidate, but
is superseded as the current campaign state.

The successor makes the exact canary's already-required primary PPTX upload
create-only and version/hash bound, persists the private source pack first,
and writes a small identity/reference-only outbox last before detached
delivery. The gateway validates scope before reference reads, rehashes source
and PPTX, atomically converges the row, archives the marker, and retires the
inbox. Durable failure/rejection evidence degrades DQ readiness. Large
conflicting objects are represented by hashes and byte counts rather than
copied into quarantine.

The shipped 2026-07-16 migration stays immutable. Successor convergence is an
ordered forward-only chain: 2026-07-17 atomic publication convergence,
2026-07-18 durable producer-failure signals, and 2026-07-19 dispatch-intent
fencing. Each delta carries exact schema/function/owner/ACL fingerprints,
existing-state guards, and an independent exact postflight. Pre-existing
builder OpenAI and fallback behavior is preserved; the separate DQ credential
is admitted only for the exact synthetic canary. Enforcement, repair, Advisor,
ordinary-user DQ processing, and builder/companion migration remain forbidden.

## 2026-07-17 — DQ-1 terminates BLOCKED at production admission

The Amendment 002 implementation is fixed at
`e6e28aafa5101350057047de5235f8f6bd547a58`; its exact reviewed release
candidate, including bounded production-image package transactions, is
`d306f07892a9666559bf75ead8ca5924baa80df3`. Integrated backend, frontend,
migration, isolation, image, runtime, and adversarial verification is green.
The exact-HEAD backend result is 4,343 passed / 149 skipped / zero failed. The
production image digest is
`sha256:ac60ef7dcc8d16431d33d5903ea5deb693c09fc1806b315b03f490b1d1d6daab`;
39/39 in-image root-runtime tests and real PPTX-to-PDF-to-PNG conversion pass.
The final audit found no open P0/P1/P2 issue. This is predeployment clearance,
not production or promotion evidence.

Read-only Render preflight found the required exact-canary and builder-event
HMAC variable names absent from both services and the DQ-only provider variable
name absent from LangGraph. Values were not inspected. Because startup requires
the complete matching canary/HMAC proof and a DQ credential distinct from
baseline builder authority, any partial configuration, migration, or deploy
would violate the locked fail-closed contract. No deployment was attempted and
production remains on `f05efb3adce121fb0af009407b7fc53ba6e98312`.

Section 22 classifies an unresolved provider, credential, deployment, or
database dependency that cannot be resolved within authorized scope as
`BLOCKED`. That is the current
explicit terminal. It is not `ACHIEVED` and not `HUMAN_JUDGMENT_REQUIRED`,
because no operational candidate exists for human promotion judgment. The user
also prohibited API-key changes; no API key was created, rotated, revoked,
edited, revealed, substituted, or value-inspected.

The smallest authorized unblock is an operator supplying the already-authorized
distinct DQ credential on LangGraph only plus matching exact-canary and HMAC
configuration on the required services, without exposing values. Only after
that prerequisite may the ordered July 15 through July 19 migration chain and
release candidate `d306f07892a9666559bf75ead8ca5924baa80df3` enter a controlled
gateway-first/LangGraph-second deployment and real-app canary sequence. The
required 12 independent labels, six complete bundles, known-strong and
explicit-brand controls, false-reject/top-failure gates, and repeatability
evidence remain separate unmet achievement gates; they are not the cause of
the current `BLOCKED` admission terminal.
