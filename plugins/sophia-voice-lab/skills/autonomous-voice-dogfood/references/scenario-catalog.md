# Scenario catalog

Use the exact scenario and fixture versions returned by `get_capabilities`. Never substitute text transport, a direct provider call, an unlisted target, or a locally generated fixture. Run suite children sequentially for the dedicated principal.

## Common protocol

For every product-path scenario:

1. Start with exact frontend, Gateway, and Voice commit identities and raw audio/video disabled unless capabilities explicitly say otherwise.
2. Wait for the start operation to become terminal and require authenticated app provenance, injected microphone acquisition, a live product connection, and a gap-free capture cursor before speaking.
3. Reuse the same idempotency key when retrying a mutation. A new utterance gets a new key.
4. Advance from the returned event cursor. Cite event sequence numbers used as preconditions for barge-in or fault actions.
5. Inspect before assigning verdicts. Require the scenario-specific assertion records below; transcript prose is never a substitute for them.
6. End through `end_voice_run`, wait for bounded cleanup/finalization, and export the durable manifest. A terminal product failure still requires cleanup and evidence.

Classify each assertion independently as harness, product, provider, authorization, or evidence. A missing owning-product primitive is `typed_unsupported`, not pass. A required join, capture range, or product-authored binding that is missing or silently inferred invalidates the harness.

## Adaptive and input scenarios

### V-A01 — neutral greeting plus five adaptive utterances

- Speak one neutral greeting, then wait for an assistant turn and actual output playback.
- Choose utterances two through six only after reading the preceding canonical observation. Each of the five follow-ups should refer to a concrete non-sensitive detail just observed or ask one bounded clarification; do not prewrite the sequence.
- Keep intentional overlap off and wait for the preceding input completion before each next `speak`.
- Harness pass requires six distinct operations (the greeting plus five adaptive follow-ups), utterance manifests, page scheduling/start/completion receipts, downstream input-frame evidence, and independently joined input transcript/accepted-turn chains. It also requires no unintended time overlap and no duplicate injection.
- Product transcription, response relevance, concision, or stacked speech are separate product assertions.

### V-A02 — deterministic fixture classes

- In a fresh run, inject each exact fixture returned for family `vt00-a02`: short command, long brief, silence, trailing pause, and noisy command. Do not recreate their bytes.
- Wait for each non-silence fixture to reach its declared input observation before injecting the next. For silence, wait the bounded fixture window plus product turn-settlement bound without adding speech.
- Harness pass requires the manifest version, fixture class, source-text hash/status, synthesis provenance, audio hash, format, duration, scheduling, PCM, and provider correlation policy for every fixture. The silence fixture must have no input transcript, accepted user turn, or downstream model/tool effect attributable to it.
- Semantic thresholds and safety-critical command-slot preservation are product assertions. Silence/no-fabricated-turn and fixture reproducibility are harness assertions.

### V-A03 — lost-response idempotency

- Start one speech operation with a stable idempotency key and deliberately treat the first MCP response as unavailable at the client boundary; do not cancel the durable operation.
- Retry the exact same request body and key. Then inspect the operation and event range.
- Harness pass requires one durable operation ID, one request hash, one page scheduling receipt, one utterance ID, one injection bridge receipt, and one input audio chain across the retry. Any second injection is a harness failure.
- Exactly one canonical user turn and no duplicate model/tool effect are product assertions.

## Output realization scenarios

### V-O01 — normal audible realization

- Speak one bounded prompt that should receive a spoken response. Wait first for assistant audio and then for assistant turn completion.
- Harness pass requires a single realization chain whose provider chunk IDs/fingerprints, received audio, playback scheduled, actual playback start, natural completion, and final output-monitor digest agree on realization ID, epoch, timing order, and non-silent sampled output. A source hash or output transcript alone is insufficient.
- Duplicate realization and semantic/audio agreement belong to the product verdict.

### V-O02 — flush or disconnect during output

- Wait for a cited `audio.output.started` receipt, then invoke the supported bounded disconnect/rotation fault for that exact provider epoch while the cited realization is still current.
- Harness pass requires the exact last scheduled and last actually started realization, a single terminal playback outcome (`flushed`, `dropped`, or truthful completion), fault timing, prior/new epoch when applicable, and proof that no later start/completion was falsely attributed to the invalidated realization.
- No stale audible output after invalidation is a product assertion.

## Builder lifecycle scenarios

Use a harmless, synthetic-only HTML deliverable. Do not reference or edit an ordinary project. Preserve the same Builder task/run IDs throughout the scenario and require exact principal/test-run/scenario provenance at every Builder boundary.

### V-B01 — explicit HTML request

- Ask Sophia by speech to create a small standalone HTML page for a fictional topic using no external accounts or personal data.
- Wait for the tool call and task state, then inspect the UI projection.
- Harness pass requires one joined chain across utterance, product input transcript, tool call/result/settlement, Builder intent, task/thread/run, UI state, trace status, and hidden synthetic artifact metadata. Missing optional LangSmith data is typed unavailable.
- One intent/dispatch/task and truthful UI state are product assertions.

### V-B02 — conversation while the build runs

- After V-B01 dispatches, speak three sequential turns: one unrelated harmless question, one status question, and one follow-up derived from the returned status.
- Harness pass requires the original Builder task correlation to remain stable across all three voice turns and proves no second dispatch was invented by the runner.
- Continued execution, grounded status, and absence of duplicate dispatch are product assertions.

### V-B03 — update/add-topic request

- While the owned task is active, request one bounded addition to the fictional page. Capture the exact current product response and any task/control receipts.
- Harness pass requires correlation to the owned task and a truthful record of whether the current product accepted, rejected, deferred, or could not support the request.
- Do not require or claim future M04 safe-boundary steer semantics. The observed current update behavior is the product verdict.

### V-B04 — cancellation

- While the owned task is active, ask by speech to cancel it once. Do not issue a second cancel merely because the product response is delayed.
- Harness pass requires the cancel request, tool settlement, all task/run transitions, UI state, and authoritative cleanup discovery to be inspectable and bound to the same task.
- Exactly one terminal cancellation and no later publication are product assertions. Cleanup success requires authoritative zero owned Builder tasks before synthetic artifact purge.

## Interruption scenarios

### V-I01 — barge-in after playback begins

- Speak a prompt likely to produce a multi-sentence response. Wait for a product-authored actual playback-start receipt and capture its sequence, realization ID, and epoch.
- Call `barge_in` relative to that event with the scenario-declared bounded delay. Do not use a guessed wall-clock sleep.
- Harness pass requires target-start time, requested/actual injection time, interruption/flush receipt, flush latency, matching realization/epoch, and retention of the new input chain.
- Fast flush, no stale output, and the new input being handled are product assertions.

### V-I02 — barge-in near a tool boundary

- Trigger one harmless owned tool action, wait for the exact tool call or settlement boundary declared by the run, and barge in relative to a concurrently observed playback start.
- Harness pass requires a total order over speech injection, output interruption, tool call/result/settlement, and any retry, all with at-most-once identifiers.
- At-most-once side effects and no unsupported spoken promise are product assertions.

## Network continuity scenarios

### V-N01 — rotation after setup

- After the run is product-ready and its current provider epoch is proven, call `force_socket_rotation` with that exact epoch.
- Wait for the prior socket boundary, new epoch, and restored or typed degraded state before speaking a continuity check.
- Harness pass requires the fault to occur only in the requested epoch, exact-origin validation, prior/new epoch receipts, and a product-authored restoration/degradation outcome. A runner-owned socket-close receipt alone is insufficient.
- Continuous context with no duplicate speech/tool work is a product assertion.

### V-N02 — rotation during output/tool work

- Start one harmless Builder operation or spoken realization, cite its last committed event and current epoch, and rotate while it is active.
- Harness pass requires an unambiguous commit boundary, prior/new epoch, recovery mode, and joined side-effect IDs before and after reconnect.
- Exactly-once effects and no duplicate realization are product assertions.

## Finalization scenarios

### V-F01 — explicit end

- After at least one completed turn, call `end_voice_run` once. The tool itself must wait for bounded finalization and return the terminal run/evidence state; an accepted-only response is a harness defect, not permission to spend an extra cold-flow call polling.
- Harness pass requires the ordinary product end action, final capture cursor, canonical synthetic finalization receipt, product session/provider disconnect, browser-context close proof, recovery/Builder cleanup receipt, durable evidence manifest, and authoritative zero-orphan audit.
- A pending or failed product finalizer remains a product failure with truthful retryability; it cannot be hardcoded as complete.

### V-F02 — accelerated idle expiry/resume

- Execute only when `get_capabilities` reports a governed product clock/TTL that exercises the same canonical watcher/finalizer as ordinary idle expiry.
- Otherwise record `typed_unsupported` with reason `governed_product_clock_not_available`; do not simulate it in the runner and do not count it as a pass.
- When supported, require the watcher transition, canonical finalization, same-logical-session resume, modality/brief restoration, and cleanup evidence.

## Security, durability, and plugin scenarios

### V-S01 — invalid grants

- Use the independent contract/security client, not a normal authorized browser run, to exercise missing, expired, wrong-audience, wrong-operation, wrong-principal, wrong-run, ordinary-user, and insufficient fault credentials.
- Harness pass requires typed rejection and content-free audit before browser context, product session, provider credential, TTS, or other spend-bearing allocation. Verify counters/factory spies and zero owned resources after every case.

### V-S02 — malformed inputs and target

- Exercise strict-schema unknown fields, malformed IDs/SHAs, overlong text, oversized/duration-exceeding fixture metadata, unsupported fixture/scenario, non-HTTPS or non-allowlisted origin, redirecting target, and invalid capture policy.
- Harness pass requires typed pre-resource rejection, bounded response, no crash, no leaked secret/raw input, and zero resource/ledger orphan. Never send malformed audio bytes to the product.

### V-D01 — capture beyond ring capacity

- Produce more than 500 product capture events in one run while the worker incrementally drains `readAfter` in bounded pages.
- Harness pass requires one stable capture generation; strictly monotonic sequence; no missing, duplicated, or reordered event; reported oldest/latest/produced/dropped/capacity metadata; and durable count/hash reconciliation after browser close. A fallback snapshot or fabricated `gap:false` fails.

### V-D02 — process restart boundaries

- Restart only the stateless MCP web/API process mid-run, reconnect by `test_run_id`, retry any uncertain mutation with its original idempotency key, and prove no duplicate injection or lost evidence.
- Separately test browser-worker loss. It must terminate as `aborted_driver_restart`, run canonical recovery, produce failure evidence, and never claim browser reattachment.

### V-L01 — tracing unavailable

- Use the governed trace-disable/failure seam before the run; do not break canonical persistence.
- Complete a normal speech turn and export evidence. Harness pass requires `trace_unavailable` with a typed reason while app receipts, transcript/session state, output realization, UI evidence, and manifest remain complete. LangSmith must not affect product behavior.

### V-P01 — fresh installed-plugin flow

- From a fresh authorized Codex task, use only installed plugin tools for this ten-call path: `get_capabilities` → `start_voice_run` → wait for product readiness → `speak` → wait for its observation → choose and `speak` one observation-derived follow-up → wait for that observation → `inspect_voice_run` → `end_voice_run` → `export_voice_evidence`.
- Do not use repository-local commands, raw browser JavaScript, credentials in arguments, direct product/provider calls, or manual takeover.
- Harness pass requires discoverability, current contract versions, exact deployment validation, durable evidence after shutdown, zero orphans, and no more than ten high-level MCP calls excluding read-only polling for deliberately long work.
- Call ten may truthfully report `pending_external_evidence` for P01 itself: the independent platform controller must bind the registered app, private install, fresh task, and exact call-ten response hash, then append a new immutable certification-manifest revision. Do not make an eleventh plugin call merely to observe that out-of-band revision, and never describe the call-ten bundle as already P01-certified.

## Promotion minimums

Promotion additionally requires 20/20 deterministic idempotent dynamic-injection trials, 100% pre-resource security rejection, five consecutive fresh deployed smokes with no harness-caused failure, one gap-free >500-event run, MCP API restart/reattach, wrong-SHA hard refusal, LangSmith fail-open proof, zero terminal orphans, evidence availability within 30 seconds, and the installed-plugin cold flow. Preserve every product failure and assign it to its owning mission; never weaken a harness assertion to make the aggregate green.
