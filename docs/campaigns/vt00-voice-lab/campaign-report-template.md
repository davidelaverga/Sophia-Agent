# VT00 campaign report

Status: `TEMPLATE — NOT EXECUTED`

Reconcile this report with `deployment-gates.yaml`. Every quantitative entry in that machine-readable checkpoint begins `unpassed` and requires an evidence reference before its state changes.

## Campaign identity

| Field | Value |
|---|---|
| Campaign ID | `PENDING` |
| Window start/end | `PENDING` |
| Operator / approving owner | `PENDING` |
| Scenario manifest version | `vt00.scenarios.v1` |
| Bootstrap candidate A SHA / plugin version / package hash | `PENDING` |
| Final candidate B SHA | `PENDING` |
| Registered app ID / final helper-exact `+codex.<sanitized-token>` plugin version / package hash | `PENDING` |
| MCP service version / URL | `PENDING` |
| Frontend SHA / deployment | `PENDING` |
| Gateway SHA / deployment | `PENDING` |
| Voice SHA / deployment | `PENDING` |
| Worker bootstrap/final/open/close SHA / deployment IDs | `PENDING` |
| Worker boot / instance / deployment-identity hashes and gate observations | `PENDING` |
| Gateway / Voice product mutation-gate projections | `PENDING` |
| Database instance | `PENDING` |

## Executive outcome

- Overall campaign status: `PENDING`
- Harness verdict: `PENDING`
- Product verdict: `PENDING`
- Security verdict: `PENDING`
- Evidence verdict: `PENDING`
- Cleanup verdict: `PENDING`
- Promotion decision: `PENDING`

State the outcome without combining harness and product failures. A product defect may be handed to its owning mission only when the harness and evidence verdicts are independently complete.

## Scenario results

| Scenario ID | Run ID | Harness verdict | Product verdict | Evidence manifest | Defect/reference |
|---|---|---|---|---|---|
| `V-A01` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-A02` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-A03` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-O01` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-O02` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-B01` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-B02` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-B03` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-B04` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-I01` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-I02` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-N01` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-N02` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-F01` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-F02` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-S01` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-S02` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-D01` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-D02` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-L01` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` |
| `V-P01` | `PENDING — V2 IMPLEMENTATION GATED` | `PENDING` | `PENDING` | `PENDING` | `p01-erratum-v2.md`; historical attempt lower bound `>= 1` |

For each non-pass, record the first failing receipt/cursor, expected behavior, observed behavior, reproducibility, owner, and whether rerun is authorized.

## Cross-layer evidence reconciliation

| Evidence dimension | Status | Reference or typed unavailable reason |
|---|---|---|
| Exact deployment identities before and after run | `PENDING` | `PENDING` |
| Exact worker boot/deploy identity, effective gate, and post-deploy/post-MCP heartbeat | `PENDING` | `PENDING` |
| Gateway/Voice enabled, kill-switch, retention-admission, and mutation-ready projection | `PENDING` | `PENDING` |
| Test run / canonical session / thread joins | `PENDING` | `PENDING` |
| Provider session and connection epochs | `PENDING` | `PENDING` |
| LangSmith trace ID/status | `PENDING` | `PENDING` |
| Utterance manifests and WAV hashes | `PENDING` | `PENDING` |
| Input schedule/start/PCM/transcription/acceptance | `PENDING` | `PENDING` |
| Output transcript/received/playback/flush/drop | `PENDING` | `PENDING` |
| Tool calls and settlement | `PENDING` | `PENDING` |
| Canonical task/session/finalization state | `PENDING` | `PENDING` |
| UI projection/artifact | `PENDING` | `PENDING` |
| Capture cursor/generation/gap audit | `PENDING` | `PENDING` |
| Registered `plugin_asdk_app` identity and private install | `PENDING` | `PENDING` |
| Fresh Codex task identity, OAuth subject, and bounded MCP call audit | `PENDING` | `PENDING` |
| P01 exact semantic spine, audited polls, and three ordinal domains | `PENDING` | `p01-erratum-v2.md` |
| P01 service-minted run-bound adaptive observation receipt | `PENDING` | `p01-erratum-v2.md` |
| Registered-app worst-case `end_voice_run` terminal latency / timeout | `PENDING` | `PENDING` |

## Gate checklist

- [ ] Unauthorized and malformed requests were rejected before provider-bearing resources.
- [ ] Three adaptive turns used real browser audio without `sendText`, direct Gemini substitution, or human microphone.
- [ ] At least one output realization reached actual playback start; transcription alone was not treated as playback.
- [ ] Barge-in was timed from a cited playback realization and flush/interruption were correlated.
- [ ] Forced rotation proved prior/new provider epoch and restored or truthful degraded continuity.
- [ ] Builder lifecycle evidence joined tool, task, UI, and voice dimensions.
- [ ] More than 500 capture events drained without silent loss.
- [ ] LangSmith unavailability, if any, was typed and did not erase canonical evidence.
- [ ] Explicit end/finalization completed or produced a truthful bounded failure.
- [ ] Evidence remained readable after browser shutdown and worker restart.
- [ ] A fresh task discovered the privately installed registered app, completed the exact ten-call adaptive flow without raw JS/shell/manual takeover, and supplied platform-authored task/install provenance; ordinary MCP server audit rows alone were not treated as installation proof.
- [ ] Exact deployments were reverified after the run.
- [ ] Exactly one live worker boot was observed; its effective gate and deployment-identity hash matched each bootstrap/open/close phase and every heartbeat followed the recorded deploy/MCP boot boundary.
- [ ] MCP/API/worker admission independently required exact open Gateway and Voice mutation gates; closed product gates remained bootstrap-safe but could not admit a run.
- [ ] Cleanup and isolation audit found zero owned resources.

Unchecked items remain `PENDING` or `FAIL`; they are not implicitly waived.

## Security, privacy, retention, and cost

| Item | Planned | Actual | Evidence |
|---|---|---|---|
| Maximum runs / duration / audio bytes | `PENDING` | `PENDING` | `PENDING` |
| Raw audio authorization | disabled unless approved | `PENDING` | `PENDING` |
| Retention/purge deadline | `PENDING` | `PENDING` | `PENDING` |
| Credentials rotated after incident, if any | `PENDING` | `PENDING` | `PENDING` |
| Render/provider/storage cost | `PENDING` | `PENDING` | `PENDING` |

## Cleanup audit

| Resource | Expected terminal count | Observed | Receipt |
|---|---:|---:|---|
| Active Voice Lab runs | 0 | `PENDING` | `PENDING` |
| Browser sessions / leases | 0 | `PENDING` | `PENDING` |
| Synthetic Sophia sessions | 0 | `PENDING` | `PENDING` |
| Provider sessions/sockets | 0 | `PENDING` | `PENDING` |
| Owned builder tasks | 0 | `PENDING` | `PENDING` |
| Over-retention candidates | 0 | `PENDING` | `PENDING` |

## Defects and follow-up

| ID | Classification | Severity | Owning mission/component | Evidence | Status |
|---|---|---|---|---|---|
| `PENDING` | harness/product/provider/security/evidence/cleanup | `PENDING` | `PENDING` | `PENDING` | `PENDING` |

## Sign-off

- Campaign operator: `PENDING`
- Security/privacy reviewer: `PENDING`
- Product owner: `PENDING`
- Evidence archive/purge owner: `PENDING`
- Final decision and timestamp: `PENDING`

This template itself is not evidence that any VT00 gate passed.
