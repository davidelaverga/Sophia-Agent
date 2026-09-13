# V-P01 asynchronous observation contract

Use only after the exact candidate, package and installed-app prerequisites pass.
These instructions describe C4 behavior; do not apply them to a mismatched older
deployment or use their presence as certification evidence.

The ten semantic calls are: capabilities, start, start-ready wait, first speak,
first assistant wait, adaptive speak, second assistant wait, inspect, end, export.
Retain every tool envelope. Distinguish semantic ordinal, polling ordinal and
chronological ordinal; never discard a timeout to make the call count look valid.

| Phase | Required observation | Position and completion rule |
| --- | --- | --- |
| Startup | `wait_for_turn`, `condition: operation_terminal`, exact start `operation_id` | Timeout-only waits are polls between calls two and three. The first conclusive successful start wait is semantic call three, even when start already returned success. No speech before readiness. |
| Each speech operation | `operation_terminal`, exact speech `operation_id` | If its mutation response has not succeeded, poll between speak and its assistant wait. Stop on the first conclusive receipt. Do not operation-poll an already-succeeded speech operation. |
| Each assistant observation | `assistant_turn_complete` | Begin only after its speech operation succeeds. Timeout-only waits are polls; retry the exact observation cursor. The first conclusive receipt is semantic call five or seven. |
| Finalization | `finalization_complete`, exact end `operation_id` | Between end and export, require operation success, terminal run state, `cleanup_complete: true` and `evidence_state: available` together. Poll if any are missing, even when end's operation already succeeded. `operation_terminal` is not a substitute. Export the manifest bound by the finalization-ready receipt. |

Every wait supplies explicit `timeout_ms` no greater than 10000. Allow at most
ten polling calls per owning operation and twenty polling calls total. Speech
operation polls and that speech's assistant-observation polls share one ten-poll
allowance. Startup and end each consume their own existing operation allowance;
there is no additional finalization budget. Stop each phase at its first
conclusive result. Never cross a semantic boundary while its required observation
is pending, poll after conclusive completion, or reset limits by issuing a new
idempotency key. Exhaustion or failure preserves the unsuccessful attempt; it
does not authorize advancing toward a passing verdict. Follow bounded cleanup
and evidence handling without representing emergency cleanup as a passing spine.

The first assistant observation must contain exactly one authenticated
`sophia_voice_lab_observation_receipt_v1`. Pass that object unchanged under the
second speak's `adaptive_observation.receipt`; add `followup_intent` separately.
Bind `expected_cursor`, `expected_provider_epoch` and `expected_turn_id` to the
returned current observation. Never invent observation facts or reuse a receipt
from another run/turn.

Call ten may return `pending_external_evidence`: an independent platform
controller must still bind the real app, installation, fresh task and exact
export response hash. Do not make an eleventh semantic call to inspect that later
certification revision or describe the pending export as P01-certified.
