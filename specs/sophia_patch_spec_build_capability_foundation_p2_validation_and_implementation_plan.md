# P-2 Build Capability Foundation: Validation and Implementation Plan

**Validated:** 2026-07-11
**Branch:** `codex/sophia-observability-v1`
**Grounding commit:** `9da4a77e53e291c5df7cc93b23282055adb40708`
**Source specification:** `specs/sophia_patch_spec_build_capability_foundation_p2.md`

**Implementation status:** Complete on the branch; database migration and
shadow/enforce rollout remain deployment operations.

## 1. Validation conclusion

The P-2 proposal addresses real gaps in the current builder runtime and should
proceed. Its four-slice order is correct: establish deadline and event truth,
then durable identity/version truth, then provider-neutral model routing, and
only then mutation and lifecycle consumers.

The checked-in specification includes an authoritative validation amendment.
The important implementation corrections are:

- generate `build_id` at dispatch instead of in `DeckBuildService`;
- use an async hard cancellation scope outside provider fallback;
- use server-side atomic CAS rather than object-store read/write emulation;
- make manifest CAS the sole current-pointer authority and the registry a
  rebuildable lookup projection;
- store foundation objects under the already protected internal `.builder`
  namespace;
- make the event journal durable and idempotent, with JSONL as a projection;
- emit acceptance through a transactional outbox only after manifest and
  registry alignment;
- keep protocols in the harness and inject app-owned persistence adapters;
- prevent new model metadata from leaking into provider constructor kwargs;
- keep shadow mode observational and split delivery into independently
  reviewable, feature-flagged slices.

## 2. Current-code validation matrix

| Spec concern | Current implementation | Finding | Required action |
|---|---|---|---|
| Stable build identity | `DeckBuildService.prepare_and_build` creates `deck-<uuid>` | Identity begins too late and changes across lifecycle operations | Generate and checkpoint the ID in `start_builder_task`; require it in service input |
| Absolute deadline | Kickoff and deadline are seeded; model kwargs set timeout and zero retries | SDK timeout is not a hard cancellation boundary | Add `anyio.fail_after` around async model invocation and classify local cancellation before fallback |
| Manifest truth | `deck_build/storage.py` unconditionally writes one `build.json` | No immutable versions, CAS, mirror, or recovery | Introduce manifest/version protocols and an atomic Postgres-backed head commit |
| Artifact identity | First identity can be derived from user/thread/path | Rename and thread handoff can change logical identity | Persist first verified logical identity and always resolve future operations by `build_id` |
| Internal storage | Guards recognize `.builder`, `deck_build`, `sources`, and `slides` | Bare `builds/` would be exposed by current filters | Canonicalize all new object keys under `.builder/builds/` and add defense-in-depth tests |
| Prepare counters | Rich counters exist in builder state/diagnostics | Counters are distributed and partly inferred | Emit events at actual seams and derive counters from call-ID sets |
| Provider routing | `ModelConfig.use` selects a class; extra config fields are allowed | New metadata can reach constructors accidentally | Add typed metadata/routes and explicitly strip non-constructor fields in the factory |
| Safe boundary | Dangling-call repair and prompt assembly define adjacency-sensitive ordering | No generic no-op boundary consumer exists | Add a deterministic middleware immediately before prompt assembly after tool settlement |
| Acceptance | Completion, upload, registry, and trace updates are coordinated in middleware | No durable acceptance record/outbox | Commit verified version/head/projection/outbox atomically after object verification |
| Layering | Harness and gateway are guarded by Sentrux rules | Direct harness-to-gateway imports would violate architecture | Inject persistence protocols from app composition; use fakes in harness tests |

## 3. Target architecture

```text
start_builder_task
  -> BuildIdentity + ExecutionEnvelope in trusted checkpoint state
  -> async builder graph
       -> BuildDeadlineMiddleware (outermost local cancellation)
       -> BuilderProviderFallbackMiddleware
       -> existing task/research/artifact/tool middleware
       -> BuildSafeBoundaryMiddleware
  -> DeckBuildService using injected identity/envelope/event sink
  -> immutable internal source/artifact objects
  -> atomic manifest-head commit + registry projection + acceptance outbox
  -> terminal projections (gateway, webhook, LangSmith) from canonical events
```

Persistence is split by responsibility:

```text
Supabase object storage
  .builder/builds/<build_id>/manifest/manifest-r<revision>.json
  .builder/builds/<build_id>/components/.../versions/...
  .builder/builds/<build_id>/artifacts/<artifact_version_id>/...
  .builder/builds/<build_id>/transactions/...

Postgres
  build_registry                 user-scoped lookup projection
  build_manifest_heads          authoritative revision/current pointers
  build_operation_events        idempotent event and sequence authority
  build_acceptance_outbox       durable acceptance delivery
  build_mutation_transactions   lease/state/recovery authority

Local workspace
  deck_build/build.json and existing paths as diagnostics/compatibility aliases
  .builder/builds/.../events.jsonl as a reconstructable projection
```

## 4. Implementation sequence

### Slice A — Deadline safety and event truth

#### A1. Add shared runtime contracts

Create the `build_runtime` package with:

- `identity.py`: validated IDs, UUIDv7/ULID generation, deterministic component
  identity, and operation context;
- `deadline.py`: monotonic `ExecutionEnvelope`, remaining-time calculations,
  child reservations, and typed `BuildDeadlineExceeded`;
- `events.py`: allowlisted `BuildOperationEvent` schemas and event names;
- `metrics.py`: deterministic replay into counters and exact call-ID sets;
- `capabilities.py`: foundation capability flags and startup requirements.

Keep the contracts provider-neutral and free of gateway imports. Add canonical
serialization helpers and reject oversized or unknown event metric fields.

#### A2. Seed identity and one execution envelope

Change `start_builder_task.py` to generate `build_id` and `operation_id` before
graph invocation, require `user_id`/owner thread in enforce mode, and persist:

```text
build_id
operation_id
started_monotonic_ns
deadline_epoch_ms
terminal_reserve_seconds
```

Pass the trusted ID into `prepare_deck_build` through runtime state. Change
`DeckBuildService.prepare_and_build` to require the supplied ID and remove its
UUID generation. Preserve compatibility only behind an explicit test/legacy
adapter, never on the production fresh-build path.

#### A3. Enforce async cancellation

Add `BuildDeadlineMiddleware` before provider fallback in the canonical chain so
its async wrapper is outermost. It must:

- use `anyio.fail_after` with monotonic remaining time;
- reserve terminal-persistence time without extending the envelope;
- translate local cancellation to the existing terminal result path;
- prevent provider fallback for local cancellation;
- reject production startup if a sync builder execution path is selected.

Continue passing remaining time into image generation, compilation, inspection,
rendering, preview, and subprocess wrappers. Remove duplicate local deadline
calculations as they migrate to `ExecutionEnvelope`.

#### A4. Record actual operation seams

Introduce an injected `BuildEventSink` protocol. Record prepare emission,
execution start, result acceptance, service entry, and service return at the
actual code seams with the real tool-call ID. Build diagnostics and completion
counters become projections from event sets; retain old field names as
compatibility aliases.

Initially dual-write events in shadow mode and compare projected counters with
the existing diagnostics. Do not change delivery based on shadow mismatch.

#### A5. Slice A tests and gate

Add focused tests for continuous streaming cancellation, no fallback after local
timeout, one terminal persistence, build-ID propagation, exact retry call IDs,
event replay idempotency, event redaction, and existing compact deck success.
Run the focused deck/runtime suite and the repository builder/gateway sweep.

**Slice A exit:** no presentation execution can exceed the envelope; terminal
reason and prepare counters agree across state, events, gateway, and LangSmith.

### Slice B — Identity, source versions, manifest, and acceptance

#### B1. Add database migrations and atomic RPCs

Create migrations for user-scoped registry records, manifest heads, operation
events, and acceptance outbox. Add unique constraints for:

```text
(user_id, build_id)
(build_id, manifest_revision)
(build_id, event_id)
(build_id, sequence)
(logical_artifact_id, artifact_version_id, manifest_revision)
```

Implement a security-definer RPC or equivalent transaction that checks
`expected_revision`, advances the manifest head, updates the registry projection,
and inserts the pending acceptance outbox record atomically. Enforce user scope
inside the transaction. Never implement enforce-mode CAS as client read/write.

#### B2. Add harness protocols and app adapters

Add harness-domain models and protocols for manifest, versions, sources,
registry lookup, event persistence, and acceptance. Implement Postgres/Supabase
adapters in the application composition layer and inject a typed service bundle
into the builder runtime. Provide deterministic in-memory fakes for unit tests.

The registry is a projection. Reconciliation rebuilds it from the manifest head;
it cannot independently advance current artifact/component pointers.

#### B3. Materialize immutable compact sources

During deck preparation, persist canonical UTF-8 bytes for `deck.css`, each
slide body, optional slide CSS/notes, and assembly metadata under the internal
build namespace. Store shared CSS once and reference it from slide components.
Record source hashes, assembly contract/harness version, and assembled hashes.

Write immutable objects before proposing a manifest. Verify object existence and
hash after upload. Keep assembled HTML derived and reproducible. Continue writing
existing deck paths only as aliases/diagnostics.

#### B4. Commit verified artifact versions

After native/mechanical gates pass:

1. upload the immutable artifact-version object;
2. verify object existence, size/hash, and type integrity;
3. write the immutable manifest revision object;
4. call the atomic head/projection/outbox transaction with expected revision;
5. return terminal success only after the committed IDs are re-read and aligned;
6. deliver the outbox idempotently and mark delivery separately.

A CAS conflict leaves the prior version current and returns
`build_manifest_concurrent_modification`. A projection/outbox mismatch is
reconciled and never reported as accepted success.

#### B5. Compatibility and security

Add explicit, administrator-invoked legacy import/reconciliation. Never trigger
it on GET, list, registry backfill, or signing. Extend all artifact security
tests to prove `.builder/builds` objects cannot be listed, fetched, registered as
deliverables, or signed. Keep the root-level preview exception narrowly scoped.

#### B6. Slice B tests and gate

Cover two-writer CAS, crash points before/after object upload and manifest CAS,
reconciliation, source reproducibility, rename/thread handoff identity,
acceptance outbox idempotency, owner isolation, and internal-path denial.

**Slice B exit:** every enforced fresh deck success has immutable source and
artifact versions, one authoritative manifest head, aligned lookup projection,
and one durable acceptance record.

### Slice C — Provider-neutral routes and resource ledger

#### C1. Extend configuration safely

Add typed deployment metadata, model routes, harness profiles, and foundation
config to `AppConfig`. Keep `ModelConfig.use` as constructor authority. Update
`create_chat_model` to remove all route/provider/capability metadata before
provider construction and validate declared provider against the resolved class.

Update `config.example.yaml` and environment documentation. Disabled future
consumers must not become startup blockers.

#### C2. Add deterministic route resolution

Implement `ModelRouteResolver` that validates required capabilities, selects a
pinned deployment/profile, and emits a canonical plan hash. Provider fallback
remains within one operation ID and is disabled after local deadline
cancellation. No quality or repair module may instantiate provider clients
directly.

#### C3. Add structured invocation and budgets

Implement a provider-neutral structured invoker with schema validation,
deadline propagation, bounded retries, safe error classification, and event
emission. Add a `ResourceBudgetLedger` for token, cost, model-call, wall-clock,
and child reservations. Reservations fail before invocation and usage is
recorded against the pinned operation/route.

#### C4. Slice C tests and gate

Test missing route/deployment/profile/capability failures, deterministic plan
hashes, metadata stripping, provider swap/fallback identity, child budgets,
deadline interaction, and static bans on direct provider constructors.

**Slice C exit:** fake judge/repair consumers can resolve and invoke a model
without provider-specific code or bypassing the shared deadline/budget ledger.

### Slice D — Transactions, recovery, and lifecycle boundaries

#### D1. Add mutation transaction state

Create transaction models/store with explicit states, expected manifest revision,
lease owner/expiry, staged object paths, candidate version IDs, gate evidence,
commit result, and typed failure. Persist transaction authority in Postgres and
mirror diagnostics under the internal build namespace.

Commit ordering is fixed:

```text
acquire lease -> load revision -> stage immutable candidates -> verify/gate
-> manifest CAS -> registry projection alignment -> acceptance outbox
-> release lease -> terminal event
```

Recovery uses persisted transaction state only. It never reconstructs intent
from model messages. A lease cannot override stale CAS.

#### D2. Add deterministic lifecycle hooks

Implement named, immutable, dependency-injected hook registrations for before
summarization, safe boundary, before terminal, after manifest commit, and after
acceptance. Each hook has deterministic ordering, a typed result, a child time
budget, and explicit failure policy.

Place `BuildSafeBoundaryMiddleware` where all tool calls/results are settled and
immediately before the next prompt is assembled. With no consumer it performs
no interrupt, state mutation, or model round-trip. Terminal state always wins.

#### D3. Add capability registry and fake consumers

Publish capabilities only after startup audits pass. Implement fake targeted
repair, quality, and steer consumers to prove they can use the shared identity,
route, budget, transaction, event, and boundary contracts without defining
parallel foundations.

#### D4. Slice D tests and gate

Test staged-file isolation, stale writers, every crash boundary, idempotent
recovery, rollback history, no-op boundaries, pause/resume after tool settlement,
terminal precedence, hook timeouts/order, and fake-consumer architecture rules.

**Slice D exit:** transaction-backed mutation can be enabled selectively without
last-write-wins races, unsafe mid-tool interruption, or model-message recovery.

## 5. Cross-cutting delivery rules

- Keep `prepare_deck_build` model-facing schema and compact HTML doctrine
  unchanged.
- Do not modify Mem0 retrieval, prompts, skills, or co-review behavior.
- Do not expose source bodies, prompts, provider payloads, or credentials in
  events, logs, traces, manifests, or test fixtures.
- Add migrations and rollback procedures before enabling enforce mode.
- Make each slice a focused commit with its own tests and Sentrux result.
- Preserve existing terminal fields and gateway statuses during dual-write;
  introduce new fields additively.
- Do not deploy production as part of implementation. Rollout is a separate
  operational step with canaries and reconciliation monitoring.

## 6. Verification matrix

For every slice:

1. Run the new focused tests through the repository `uv` environment.
2. Run existing deck/runtime and compact-authoring tests.
3. Run the AGENTS.md builder/gateway sweep.
4. Run the complete backend suite before final delivery.
5. Refresh the Sentrux baseline from `origin/main`, then run
   `sentrux gate .` and `sentrux check .`.
6. Inspect the diff for credentials, raw source fixtures, generated artifacts,
   unrelated worktree files, and architecture-boundary violations.

Required end-to-end scenarios:

- fresh compact six-slide success;
- authoring hard timeout with no provider fallback;
- service deadline during image/compile/render stages;
- one retry with exact prepare call/result/service counters;
- concurrent mutation conflict preserving the old current version;
- process restart at each transaction commit boundary;
- artifact rename and thread handoff preserving logical identity;
- internal source/version objects denied by every read/signing surface;
- acceptance outbox replay without duplicate acceptance;
- disabled foundation/route consumers preserving current behavior.

## 7. Rollout strategy

1. Deploy Slice A deadline enforcement and event dual-write; compare projected
   counters without changing delivery.
2. Deploy Slice B in manifest shadow mode; reconcile manifests against current
   successful deck outcomes and measure drift/recovery.
3. Enable manifest enforcement for internal canaries, then a small percentage of
   fresh presentation builds. Keep mutation disabled.
4. Deploy Slice C routes with fake/shadow consumers before any quality or repair
   decision can alter an artifact.
5. Deploy Slice D transactions and safe boundaries with no active consumer,
   then enable selected mutation consumers only after crash/CAS evidence passes.
6. Run two six-slide production canaries. Require completion within the existing
   eight-minute envelope, aligned terminal reason/counters, verified immutable
   objects, zero exposed internal paths, and exactly one acceptance record.

Rollback disables consumers or returns manifest enforcement to shadow. It never
removes hard deadline safety, identity/event corrections, immutable history, or
credential protections.

## 8. Definition of done

P-2 is complete only when:

- a build has one stable ID from dispatch through acceptance and future lookup;
- local cancellation enforces one absolute envelope across model and service;
- source, component, and artifact versions are immutable and reproducible;
- current pointers advance through true server-side CAS only;
- registry state is an aligned projection, not competing truth;
- counters replay exactly from durable events and call-ID sets;
- provider routes and budgets are deterministic and provider-neutral;
- mutation recovery is persisted, idempotent, and race-safe;
- lifecycle hooks are no-op by default and safe at tool boundaries;
- acceptance is durable, verified, idempotent, and never inferred from a model
  claim or file write;
- all focused, builder/gateway, full backend, and Sentrux gates pass.
