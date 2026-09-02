# VT00 scenario manifest

Status: `DRAFT — EXECUTION PENDING`

Manifest version: `vt00.scenarios.v1`

V-P01 composition is governed by `p01-erratum-v2.md`. Its v1 proof path is
superseded and no official signed V-P01 is authorized until the erratum's
implementation and execution unlocks are green on one exact closed deployment.

Every scenario uses the dedicated synthetic principal, the ordinary deployed Sophia UI, exact deployment identities, and a unique run-scoped idempotency key. Harness and product expectations are evaluated independently.

Scenarios run sequentially. The current Gateway active-session map is keyed by the single dedicated principal, so concurrent suite children are not authorized.

## Common evidence requirements

- Test run, operation, utterance, canonical session, thread, provider epoch/session, trace status, turn, task, and UI identifiers are joined or carry a typed unavailable reason.
- Input scheduled, actual start/PCM emission, transcription, and product acceptance are separate.
- Output transcription, provider audio received, playback scheduled, actual playback started, natural completion, flush, drop, and captured output are separate.
- Capture cursor/generation/capacity/oldest/latest/produced/dropped/gap metadata is durable.
- Explicit end or governed expiry is followed by product finalization, evidence export, and zero-orphan cleanup.

## Certification scenarios

| ID | Purpose and action | Harness expectation | Product expectation | Result |
|---|---|---|---|---|
| `V-A01` | Neutral greeting and five adaptive utterances | One page scheduling receipt per `speak`; no unintended overlap; every utterance independently correlated | Correct transcription and concise, non-stacked responses | `PENDING` |
| `V-A02` | Short command, long brief, silence, trailing pause, and noisy fixture | Every versioned fixture is attributable and replayable; silence creates no fabricated user turn | Semantic transcription thresholds by fixture class; safety-critical command slots preserved | `PENDING` |
| `V-A03` | Retry identical `speak` after an MCP response timeout | The same idempotency key resolves to one durable operation, one page injection, and one receipt | Exactly one user turn and no duplicate model or tool effect | `PENDING` |
| `V-O01` | Normal Sophia output realization | Provider chunks, playback scheduling/start/completion, and captured output dimensions agree without inference | No duplicate realization; output audio matches the intended response | `PENDING` |
| `V-O02` | Flush or disconnect during output | The exact last scheduled/played realization and terminal flush/drop state are observable | No stale audio after invalidation | `PENDING` |
| `V-B01` | Explicit HTML Builder request | Utterance, transcript, tool ledger, task/run state, UI, trace status, and cleanup are joinable | One Builder intent, dispatch, task, and truthful UI state | `PENDING` |
| `V-B02` | Three unrelated or status turns while the build runs | Original task correlation remains stable through speech and observation; no duplicate dispatch | Same task continues and status speech is grounded | `PENDING` |
| `V-B03` | Builder update or add-topic request | Current behavior is captured without claiming a future M04 steer primitive | Current update contract is reported truthfully | `PENDING` |
| `V-B04` | Cancel the active build | Request, task/run transitions, UI state, and authoritative zero-orphan cleanup are captured | Exactly one terminal cancellation and no post-cancel publication | `PENDING` |
| `V-I01` | Barge in after cited playback start | Injection is scheduled relative to that realization; interruption and flush latency correlate by epoch/generation | Fast flush, no stale output, and new input retained | `PENDING` |
| `V-I02` | Barge in near a tool boundary | Speech/tool ordering and settlements remain inspectable and at most once | No duplicated side effect or unsupported spoken promise | `PENDING` |
| `V-N01` | Rotate the provider socket after setup | Fault occurs in the requested epoch; prior/new epoch and restored/degraded state are durable | Continuity without duplicated speech or tool work | `PENDING` |
| `V-N02` | Rotate during output or tool work | Last committed event and recovery mode are unambiguous | Exactly-once side effects across reconnect | `PENDING` |
| `V-F01` | Explicitly end through the ordinary UI | Transcript, finalization attempt/receipt, final cursors, package state, and authoritative cleanup are observable | Unified durable finalization succeeds or exposes a retryable failure | `PENDING` |
| `V-F02` | Accelerated idle expiry and same-logical-session resume | Governed product clock/TTL triggers the watcher and proves resume, or execution is typed unsupported when the owning primitive is absent | Same finalizer as explicit end; voice modality and brief survive | `PENDING` |
| `V-S01` | Missing, expired, wrong-audience, ordinary-user, and wrong-fault grants | Rejected and content-free audited before browser/provider-bearing resource creation | No ordinary product impact | `PENDING` |
| `V-S02` | Malformed or oversized audio and unsupported target | Typed rejection before page/provider work; no crash or resource leak | No user-facing impact | `PENDING` |
| `V-D01` | Produce and incrementally drain more than 500 browser events | Monotonic, generation-aware, deduplicated persistence with zero sequence gap, or explicit `invalid_test` | Not applicable | `PENDING` |
| `V-D02` | Restart the MCP API or browser worker at the declared boundary | API restart reattaches through the ledger without duplicate injection; browser-worker loss is truthfully terminal and fully reaped | Product state is unchanged by observer restart | `PENDING` |
| `V-L01` | Disable or make LangSmith unavailable | Typed `trace_unavailable`; canonical evidence remains complete and exportable | Local Sophia behavior/state does not diverge because tracing failed | `PENDING` |
| `V-P01` | Fresh-agent installed-plugin flow under `p01-erratum-v2.md` | Exact ten-call semantic spine plus bounded audited read-only polling; truthful submission/settlement, a service-minted run-bound adaptive receipt, and three ordinal domains; no raw JS, credentials, or manual takeover | Not applicable | `PENDING — V2 IMPLEMENTATION GATED` |

`V-F02` is currently catalogued as `typed_unsupported` with reason
`governed_product_clock_not_available`. This is an honest owning-product boundary,
not a harness pass or a silent waiver. Reclassify it only after the deployed
product exposes a governed test clock/TTL and the same scenario version is rerun.

## Input manifest per utterance

Each input record must include:

```yaml
test_run_id: PENDING
scenario_id: PENDING
scenario_version: vt00.scenarios.v1
operation_id: PENDING
idempotency_key_hash: PENDING
utterance_id: PENDING
source:
  kind: fixture-or-tts
  fixture_id: PENDING
  fixture_version: PENDING
  source_text_status: PENDING
  source_text_sha256: PENDING
synthesis:
  engine: PENDING
  voice: PENDING
  rate: PENDING
wav:
  sha256: PENDING
  sample_rate: PENDING
  channels: PENDING
  duration_ms: PENDING
  byte_length: PENDING
timing:
  requested_at: PENDING
  scheduled_at: PENDING
  started_at: PENDING
  completed_or_interrupted_at: PENDING
barge_target:
  output_event_seq: PENDING
  realization_id: PENDING
  provider_epoch: PENDING
```

## Stop conditions

Stop and preserve evidence on deployment drift, unauthorized principal/resource creation, capture gap, two terminal receipts for one input, false playback attribution, missing mandatory join, secret/raw-data exposure, cost bound breach, finalization uncertainty beyond the bound, or any orphan resource. A scenario is never promoted from `PENDING` by documentation alone.
