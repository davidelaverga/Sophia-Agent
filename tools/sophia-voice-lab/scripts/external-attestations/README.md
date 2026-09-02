# VT00 offline external-attestation controllers

These controllers produce the source-owned evidence that the Voice Lab MCP
service cannot truthfully create for itself:

- `external_mcp_client` owns V-A03 HTTP response loss and retry.
- `deployment_control` owns V-D02 Render restart and worker-loss facts.
- `platform_plugin` owns V-P01 registered-app install and fresh-task facts.

The production server imports only the three public Ed25519 keys. The three
PKCS8 private-key files and the Render/platform credentials remain offline.
None of these scripts is built into the web or worker image.

The executable contracts are in [`contracts.ts`](contracts.ts). Signing imports
the production `ExternalAttestationSchema` directly, so a claim with an extra,
missing, renamed, or wrong-source field is rejected before a private key is
used. Request and response contents never enter an attestation. Exact hashes,
statuses, operation/effect joins, and timestamps do.

## Runtime and invocation

Use Node 22 and the package-pinned pnpm/tsx. All file flags must be absolute.
Every input containing a credential, private key, utterance, platform record,
or raw provider identifier must already be a regular mode-0600 file. Every
output is atomically created mode 0600 and an existing path is never replaced.

```text
pnpm exec tsx scripts/external-attestations/cli.ts help
```

Credentials are accepted only from secure files shaped as:

```json
{"bearer_token":"at-least-32-bytes"}
```

Never place a bearer, API key, or private-key byte in a CLI argument, shell
variable, log, plugin file, evidence manifest, or support transcript.

## One-time key and transport-token generation

Choose five new absolute paths in a restricted operator directory and three
unique rotation-aware key IDs:

```text
pnpm exec tsx scripts/external-attestations/cli.ts init \
  --public-config /secure/vt00/attestation-public-keys.json \
  --transport-tokens /secure/vt00/attestation-transport-tokens.json \
  --external-key /secure/vt00/external-mcp-client.pk8 \
  --deployment-key /secure/vt00/deployment-control.pk8 \
  --platform-key /secure/vt00/platform-plugin.pk8 \
  --external-key-id external-mcp-client-2026-08-v1 \
  --deployment-key-id deployment-control-2026-08-v1 \
  --platform-key-id platform-plugin-2026-08-v1
```

The command prints only public fingerprints. Install the exact public JSON as
`SOPHIA_VOICE_LAB_ATTESTATION_PUBLIC_KEYS_JSON` on web and worker. Install the
exact transport-token JSON as
`SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON` on web only. Distribute
each private key and only its corresponding transport token to its independent
controller. Do not give one controller another authority's private key.

To rotate, generate new files and key IDs, deploy the public/token config, and
finish every live run signed by the old key before removing it. This v1 server
accepts one active key per source, so an in-flight rotation is a deployment
gate rather than a best-effort fallback.

## Signing, POST, and revision verification

An unsigned claim is the exact server envelope without `signature`. It must
already contain `attestation_id == jti`, a fresh random nonce, a maximum
15-minute issued/expiry interval, the exact run/deployment hashes, the fixed
audience `sophia-voice-lab-attestation`, and one source-specific evidence
object. There is no generic signing command. A03, both D02 actions, and P01 can
only be signed by their source-specific collectors after the owning
observations have been validated. This prevents an operator-authored JSON
object from becoming evidence merely because the deployment key signed it.

```text
pnpm exec tsx scripts/external-attestations/cli.ts post \
  --public-config /secure/vt00/attestation-public-keys.json \
  --transport-tokens /secure/vt00/attestation-transport-tokens.json \
  --base-url https://voice-lab.example.com \
  --claim /secure/vt00/source-controller-claim.json \
  --receipt-out /secure/vt00/source-controller-post-receipt.json
```

`post` sends the exact claim twice. The first call claims the immutable
run/kind slot; the second must return `replay: true` with the same event
sequence and content hash. It writes a content-free receipt and never prints
the selected transport token.

After the worker publishes the later evidence resource, verify that the
current pointer advanced append-only and that the new manifest projects this
exact signed claim and POST receipt:

```text
pnpm exec tsx scripts/external-attestations/cli.ts verify-manifest \
  --claim /secure/vt00/a03-signed.json \
  --receipt /secure/vt00/a03-post-receipt.json \
  --prior-manifest /secure/vt00/a03-manifest-before.json \
  --manifest /secure/vt00/a03-manifest-after.json \
  --manifest-sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

This check binds run, test-run hash, cleanup-obligation hash, scenario,
deployment, authority, issuer, key ID, JTI hash, request hash, attestation
content hash, event sequence, and manifest revision. A POST receipt alone is
`pending_evaluator_cross_join`; it is never described as scenario
certification.

## V-A03: independent public MCP lost-response controller

Prerequisite: a live ready V-A03 run with one exact `speak` request prepared by
the independent client. The secure controller input is:

```json
{
  "schema": "sophia_voice_lab_a03_controller_input_v1",
  "mcp_url": "https://voice-lab.example.com/mcp",
  "run": {
    "run_id": "UUIDv4",
    "test_run_id_sha256": "64 lowercase hex",
    "cleanup_obligation_id_sha256": "64 lowercase hex",
    "scenario_id": "V-A03",
    "scenario_version": "vt00.scenarios.v1",
    "environment": "production",
    "expected_deployment": {"frontend": "40 hex", "backend": "40 hex", "voice": "40 hex"}
  },
  "speak_arguments": {
    "run_id": "same UUIDv4",
    "text": "governed test utterance",
    "idempotency_key": "one stable key"
  }
}
```

Execute the real public `/mcp` boundary:

```text
pnpm exec tsx scripts/external-attestations/cli.ts a03-execute \
  --input /secure/vt00/a03-input.json \
  --mcp-token /secure/vt00/mcp-oauth-or-direct-token.json \
  --out /secure/vt00/a03-client-record.json
```

The controller waits for the first response body boundary, discards the bytes
without parsing or retaining them, closes that response, and retries the same
`speak` arguments/idempotency key under a distinct UUIDv4
`x-sophia-voice-lab-client-request-id`. It requires the retry to return the
same succeeded operation with `replay: true`. The record contains only hashes,
HTTP statuses, operation ID, page scheduling timestamp, and loss/retry times.

Then end/export the run normally and save the pre-attestation immutable
manifest. Build the claim only after the controller joins its record to:

- exactly two server-authored `mcp.tool_response` audits on the canonical
  public speak-argument hash;
- the original and retry client-request hashes;
- one augmented durable operation hash and one operation ID;
- the retry's exact structured-response hash and replay flag; and
- monotonic operation/scheduling/audit/loss/retry times.

```text
pnpm exec tsx scripts/external-attestations/cli.ts a03-build-claim \
  --record /secure/vt00/a03-client-record.json \
  --manifest /secure/vt00/a03-manifest-before.json \
  --public-config /secure/vt00/attestation-public-keys.json \
  --private-key /secure/vt00/external-mcp-client.pk8 \
  --out /secure/vt00/a03-signed.json
```

The external client cannot author Sophia's user-turn, assistant-response, or
tool-effect lineage. The record therefore says
`requires_product_authored_operation_lineage`; product A03 remains typed
unavailable unless the owning product receipts prove it. Never turn the
single-injection harness proof into a product-effect pass.

## V-D02: one-shot Render MCP-service restart

The D02 controller is the only command here that mutates infrastructure. It
uses the official Render `POST /v1/services/{serviceId}/restart` endpoint
exactly once. It then polls only official read endpoints (`Retrieve service`,
`List deploys`, and `List instances`) plus Voice Lab `/version`. Render defines
a restart as a special zero-downtime deploy of the same commit/configuration.
Sources retrieved 2026-08-24:

- <https://api-docs.render.com/reference/restart-service>
- <https://api-docs.render.com/reference/retrieve-service>
- <https://api-docs.render.com/reference/list-deploys>
- <https://api-docs.render.com/reference/list-instances>
- <https://render.com/docs/deploys#restarting-a-service>

Prepare one secure `sophia_voice_lab_d02_render_controller_input_v1` value.
The executable schema is authoritative; its important bindings are:

- exact Voice Lab origin and exact `srv-…` service ID;
- `authorization.service_id_sha256 == SHA256(render_service_id)`, literal
  `one_shot`, literal mutation authorization, and the exact confirmation text;
- live V-D02 run/deployment hashes;
- exact input operation ID/type, public argument hash, augmented durable
  request hash, idempotency-key hash, durable operation-receipt hash, and exact
  replay arguments;
- browser worker hash/lease epoch; and
- canonical session/thread/provider hashes and provider epoch.

Use `hash-json` for any exact JSON hash without printing its content:

```text
pnpm exec tsx scripts/external-attestations/cli.ts hash-json \
  --input /secure/vt00/exact-replay-arguments.json
```

The durable receipt hash is the server canonical hash of
`{operation_id, operation_type, request_hash, state, result}` from the owning
immutable operation projection. It is not an MCP response hash.

Run only with a new empty absolute bundle directory:

```text
pnpm exec tsx scripts/external-attestations/cli.ts d02-render-restart \
  --input /secure/vt00/d02-input.json \
  --public-config /secure/vt00/attestation-public-keys.json \
  --transport-tokens /secure/vt00/attestation-transport-tokens.json \
  --deployment-key /secure/vt00/deployment-control.pk8 \
  --render-token /secure/vt00/render-api-token.json \
  --mcp-token /secure/vt00/mcp-oauth-or-direct-token.json \
  --bundle-dir /secure/vt00/d02-one-shot-001
```

The bundle is an immutable journal:

```text
00-one-shot-intent.json
01-command-claim.json
02-command-receipt.json
03-render-accepted.json
04-render-controller-receipt.json
05-final-claim.json
06-final-receipt.json
07-summary.json
```

The controller refuses to reuse a bundle path. It signs and attaches the
one-shot command before calling Render; checkpoints Render acceptance before
polling; requires a distinct live deploy, disjoint instance set, new service
boot/instance, unchanged candidate SHA, and exact MCP operation replay. It
then polls the authenticated read-only Voice Lab browser-continuity surface
until the server derives one current, unexpired lease heartbeat strictly after
both the new boot and replay, for the unchanged worker/epoch and with no loss
or replacement. That owning proof is embedded in the separately signed local
Render-controller receipt and final server claim. No retry loop ever surrounds
`POST /restart`; all provider polling after it is GET-only.

If the process stops after `00` or any later checkpoint, do not rerun the
command. Inspect the immutable bundle, Voice Lab attestation event, and Render
deploy/instance history to determine whether the one provider mutation was
accepted. Resume by a reviewed recovery procedure; never guess and submit a
second restart.

Independently verify the signed local provider-action receipt before archive:

```text
pnpm exec tsx scripts/external-attestations/cli.ts verify-d02-local-receipt \
  --public-config /secure/vt00/attestation-public-keys.json \
  --receipt /secure/vt00/d02-one-shot-001/04-render-controller-receipt.json
```

### Source-specific Render browser-worker termination

The browser-worker-loss action has a separate controller because the target is
the `sophia-voice-lab-worker` Render `background_worker`, not the MCP web
service. It uses the same official [restart
endpoint](https://api-docs.render.com/reference/restart-service) exactly once,
then polls only [List
deploys](https://api-docs.render.com/reference/list-deploys) and [List
instances](https://api-docs.render.com/reference/list-instances). No Render
action is executed by repository tests or packaging.

Prepare one strict `sophia_voice_lab_d02_render_worker_termination_input_v1`.
It binds:

- the live V-D02 run, test-run, cleanup obligation, environment, and exact
  three-component deployment;
- the exact authorized `srv-…` worker service and literal one-shot confirmation;
- provider session and admission hashes, current provider connection epoch,
  and a unique strictly ascending frozen epoch set containing that epoch; and
- browser logical-worker hash, lease epoch, and context hash.

Run only with a new absolute bundle directory:

```text
pnpm exec tsx scripts/external-attestations/cli.ts d02-render-worker-loss \
  --input /secure/vt00/d02-worker-input.json \
  --public-config /secure/vt00/attestation-public-keys.json \
  --transport-tokens /secure/vt00/attestation-transport-tokens.json \
  --deployment-key /secure/vt00/deployment-control.pk8 \
  --render-token /secure/vt00/render-api-token.json \
  --bundle-dir /secure/vt00/d02-worker-one-shot-001
```

The immutable journal is:

```text
00-one-shot-worker-intent.json
01-render-worker-preflight.json
02-worker-command-claim.json
03-worker-command-response.json
04-worker-command-replay-response.json
05-worker-command-receipt.json
06-render-worker-dispatch-intent.json
07-render-worker-accepted.json
08-render-worker-controller-receipt.json
09-worker-loss-claim.json
10-worker-loss-response.json
11-worker-loss-replay-response.json
12-worker-loss-receipt.json
13-worker-loss-summary.json
```

Every mode-0600 phase entry contains the controller-input hash, previous-entry
hash, its own canonical hash, and a domain-separated HMAC under the deployment
custody key. The controller checkpoints the stable
termination ID and preflight, signed command, each attach response, and verified
command receipt before persisting a Render dispatch intent. Only the invocation
that creates that intent may request the product-owned global dispatch claim.
The Voice Lab service atomically consumes one claim per run/termination/action
after rejoining the canonical command and durable Gateway freeze. The controller
may issue the one Render POST only from the fresh, non-replay response in that
same invocation; an ambiguous response, an exact replay, a second attempt, or a
copied authenticated journal stops without mutation. The fresh claim response
is deliberately not a resumable local capability. After acceptance, the
controller never retries that mutation. It waits for every old
Render worker instance to disappear, a live service with a wholly replacement
instance set to appear, and the Voice Lab evidence plane to derive the
exact durable lost-lease/`aborted_driver_restart` observation. The signed local
receipt and final action claim bind the request, accepted-response, and settled
snapshot hashes plus the complete run/cleanup/provider/admission/browser/lease/
context/frozen-epoch envelope.

Crucially, the local pre-final receipt does not contain or trust
`provider_session_absent`, `browser_context_absent`, Builder-zero, or other
product cleanup assertions. Attaching the exact signed final loss claim invokes
the product-authenticated Gateway settlement boundary. Voice Lab commits the
final attestation only after it verifies the exact-bound Gateway receipt and
appends the separate product settlement event. The CLI summary therefore reports
`product_authenticated_settlement_committed`; certification remains
`pending_evaluator_cross_join` until the evaluator joins that product event to
the command, Render action, and durable loss observation.

The internal-only
`POST /internal/voice-lab/d02/browser-worker-termination-settlements` endpoint is
authenticated by a one-time, key-separated Gateway recovery capability. Its
strict request must contain only:

```text
schema = sophia_voice_lab_gateway_browser_worker_termination_settlement_request_v1
termination_request_id
voice_lab_run_id_sha256
test_run_id
cleanup_obligation_id
provider_session_id
provider_admission_id_sha256
provider_connection_epoch
frozen_provider_connection_epochs
browser_worker_id_sha256
browser_lease_epoch
browser_context_id_sha256
render_action_request_sha256
render_action_accepted_response_sha256
render_action_settled_snapshot_sha256
loss_event_seq
loss_observed_at
```

The Gateway must use raw IDs only for its locked product lookup, hash them in
the response, and independently re-read the cleanup obligation, canonical
session provider subdocument, provider-admission ledger, Gateway relay, and
Voice provider-manager terminal receipts. The caller's hashes are
preconditions, never absence assertions. The response must be an immutable,
deterministically replayable Ed25519 receipt with this exact evidence payload:

```text
schema = sophia_voice_lab_gateway_browser_worker_termination_settlement_v1
receipt_id
termination_request_id_sha256
voice_lab_run_id_sha256
test_run_id_sha256
cleanup_obligation_id_sha256
principal_id_hmac
scenario_id = V-D02
scenario_version
environment
expected_deployment
provider_session_id_sha256
provider_admission_id_sha256
provider_connection_epoch
frozen_provider_connection_epochs
browser_worker_id_sha256
browser_lease_epoch
browser_context_id_sha256
render_action_request_sha256
render_action_accepted_response_sha256
render_action_settled_snapshot_sha256
loss_event_seq
loss_observed_at
voice_terminal_receipts_sha256
provider_settlement_sha256
cleanup_obligation_state = closed | complete
canonical_provider_state = closed
canonical_pending_epoch = null
all_frozen_provider_epochs_terminal = true
provider_admission_absent = true
voice_provider_session_absent = true
gateway_browser_relay_absent = true
database_observed_at
issuer = sophia-gateway
audience = sophia-voice-lab-d02-gateway-settlement
authority_key_id
jti
nonce
issued_at
expires_at
signature_algorithm = ed25519-sha256-canonical-request-v1
signature
```

The Gateway persists the receipt under the unique pair
`(cleanup_obligation_id, termination_request_id_sha256)` in the same advisory-
locked transition that stores `provider_settlement_sha256`; an exact retry must
return the same receipt after session/admission deletion, while any changed
field is a conflict. Voice Lab may ingest it only through a product-authenticated
internal boundary and appends one exact-bound product event. The D02 evaluator
passes `d02.browser_worker_loss_abort_recovery` only when exactly one such event
joins the command, Render action, and durable loss observation field-for-field
and verifies the Gateway signature, audience, key, time, JTI, and replay
identity.

Verify the separate source receipt without printing its signature:

```text
pnpm exec tsx scripts/external-attestations/cli.ts verify-d02-worker-receipt \
  --public-config /secure/vt00/attestation-public-keys.json \
  --receipt /secure/vt00/d02-worker-one-shot-001/08-render-worker-controller-receipt.json
```

After any interruption, invoke the same command with the same bundle and append
`--resume true`. Resume validates an exact, ungapped journal prefix and unchanged
controller input before network activity. It reuses the persisted signed command
or final claim byte-for-byte. If dispatch intent exists without a durable Render
acceptance response, resume performs GET-only reconciliation and stops with
`D02_RENDER_DISPATCH_MANUAL_REQUIRED`; it never guesses by issuing a second
POST. Copying a journal cannot duplicate the action because only one fresh
server-side dispatch claim exists, and a replayed claim is never mutation
authority. The controller never terminates a worker outside an explicitly armed
V-D02 recipe merely to create evidence.

## V-P01: registered private plugin and fresh task

P01 is authored only from the signed Codex CLI and App Server byte streams. It
is not authored by the Voice Lab service, the implementation task, or an
operator-supplied transcript. The collector input contains only expected
campaign, binary, plugin-package, registered-app, and execution identities; its
strict schema has no `evidence`, `call_observations`, response, task, thread,
run, or operation field.

The source contract is the official [Codex App Server
protocol](https://learn.chatgpt.com/docs/app-server). Plugin layout and the
real registered-app compatibility mapping follow the official [Codex plugin
packaging guide](https://developers.openai.com/plugins/build/plugins). The
collector deliberately does not use the experimental App Server plugin
install/list methods. It invokes the signed CLI's stable local commands
`plugin add ... --json` and `plugin list --json`, whose output implementation
is also public in the official [Codex CLI
source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/plugin_cmd.rs).

The fresh task must have exactly these ten high-level calls:

```text
1 get_capabilities
2 start_voice_run
3 wait_for_turn
4 speak
5 wait_for_turn       (adaptive observation)
6 speak               (adaptive follow-up)
7 wait_for_turn
8 inspect_voice_run
9 end_voice_run
10 export_voice_evidence
```

The ten calls form the semantic spine. When a `speak` or `end_voice_run`
response is durably accepted but not yet succeeded, the task may insert only
audited `wait_for_turn` polls for that exact operation between the mutation and
the next spine call. Each poll has an explicit timeout no greater than ten
seconds; the task stops at the first terminal event and is bounded at ten polls
per operation and twenty polls total. After verifying the pinned binary signature,
version, and complete package tree, the collector records the raw CLI stdout,
stderr, exit status, and package hashes. It then launches `codex app-server
--stdio`, records every raw JSONL frame, and performs this source-owned
sequence:

1. `initialize`, then `initialized`;
2. one persisted, non-ephemeral root `thread/start`;
3. `app/installed` with `forceRefresh: true` and an exact real
   `plugin_asdk_app…` ID;
4. `skills/list` with `forceReload: true` from the exact installed package;
5. one `turn/start` with the exact skill and registered-app mention;
6. the ten semantic `item/started` to `item/completed` MCP lifecycles plus any
   allowed bounded poll lifecycles, each with the
   same plugin ID, app/connector ID, OAuth link, server, action, arguments, and
   completed structured response;
7. one successful `turn/completed`;
8. a direct `mcpServer/resource/read` of the call-10 immutable manifest (not an
   eleventh tool call); and
9. `thread/read` with `includeTurns: true`, which must replay the same semantic
   spine and bounded poll items byte-semantically.

All tool arguments, including schema defaults, must be explicit so their
public hashes equal the durable operation hashes. The manifest must bind the
same fresh run, test run, cleanup obligation, exact deployment, app ID, plugin
version/package hash, and task time window. Reordered, missing, failed,
duplicated, drifted, unjoined, local-runner, raw-JavaScript, prohibited-tool,
approval, or manual-takeover evidence fails before signing.

The secure input has this shape (all paths are absolute real paths):

```json
{
  "schema": "sophia_voice_lab_p01_official_collector_input_v1",
  "campaign": {
    "scenario_id": "V-P01",
    "scenario_version": "vt00.scenarios.v1",
    "environment": "production",
    "expected_deployment": {"frontend": "40 hex", "backend": "40 hex", "voice": "40 hex"}
  },
  "codex": {
    "binary_path": "/Applications/ChatGPT.app/Contents/Resources/codex",
    "binary_sha256": "64 lowercase hex",
    "version": "codex-cli X.Y.Z"
  },
  "plugin": {
    "source_root": "/absolute/final/plugins/sophia-voice-lab",
    "selector": "sophia-voice-lab@personal",
    "plugin_id": "sophia-voice-lab@personal",
    "name": "sophia-voice-lab",
    "marketplace_name": "personal",
    "version": "0.1.0+codex.local-20260824-120000",
    "package_sha256": "64 lowercase hex",
    "skill_name": "sophia-voice-lab:autonomous-voice-dogfood",
    "skill_relative_path": "skills/autonomous-voice-dogfood/SKILL.md"
  },
  "app": {
    "registered_app_id": "plugin_asdk_app_REAL_ID",
    "runtime_name": "REAL_APP_RUNTIME_NAME"
  },
  "execution": {
    "cwd": "/absolute/fresh/task/cwd",
    "model": "PINNED_MODEL",
    "request_timeout_ms": 3600000
  }
}
```

The plugin version is the exact final candidate-B manifest value. It must have
one plugin-creator `+codex.<sanitized-lowercase-token>` suffix; the default
token is the 14-digit UTC timestamp and a sanitized manual token contains only
non-empty lower-case alphanumeric segments separated by single hyphens. A
bootstrap candidate-A version, omitted suffix, uppercase token, extra build
identifier, or malformed/partially copied token is rejected before installation
or signing.

```text
pnpm exec tsx scripts/external-attestations/cli.ts p01-collect-claim \
  --input /secure/vt00/p01-collector-input.json \
  --public-config /secure/vt00/attestation-public-keys.json \
  --private-key /secure/vt00/platform-plugin.pk8 \
  --capture-out /secure/vt00/p01-official-source-capture.json \
  --out /secure/vt00/p01-signed.json
```

The capture output is atomically persisted before the private signing key is
opened. The signed claim's `install_receipt_sha256` binds the source receipt,
which in turn binds all CLI command hashes, package hashes, binary identity,
signature identity, raw-frame chain, and exact response-frame hashes. Post the
claim with the generic `post` command, then use `verify-manifest` after the
append-only product manifest incorporates the resulting receipt.

This command is intentionally inoperable on the repository's current
pre-registration package: `.app.json` and the manifest `apps` mapping are
absent. First perform the manual private developer-mode registration described
in `plugins/sophia-voice-lab/PACKAGING.md`, record the real
`plugin_asdk_app…` ID, finalize and hash the package, and only then run the
collector. No registration or plugin installation is performed during build,
test, or preflight.

## Safe failure rules

- Never sign a generic outcome assertion. All source payloads must satisfy the
  exact production discriminated union.
- Never submit D02 if the live service, candidate SHA, deploy state, browser
  lease, or operation receipt differs from the prepared input.
- Never retry a provider mutation after an ambiguous controller crash.
- Never print an abandoned MCP body, Render response, bearer, raw task/thread
  identifier, utterance, transcript, OAuth link, or provider handle. The one
  exception to hash-only storage is the required mode-0600 P01 official-source
  capture: it retains the raw CLI/App Server frames as the owning receipt, is
  never logged or embedded in the claim/manifest, and must be erased at its
  signed evidence-retention boundary.
- Never claim a scenario pass from the POST response. Certification exists
  only after the evaluator cross-join and append-only manifest revision pass.
- Keep all controller bundles through campaign review, then delete them at the
  signed retention boundary using the operator's governed evidence policy.
