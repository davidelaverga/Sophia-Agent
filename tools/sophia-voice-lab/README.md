# Sophia Voice Lab

Sophia Voice Lab is the isolated VT00 execution and evidence plane. It exposes a private Streamable HTTP MCP endpoint and runs browser work in a separate Playwright worker. It drives the ordinary deployed Sophia UI, injects governed synthetic media before application code loads, and stores the run ledger, leases, operations, events, manifests, and bounded evidence bytes in Postgres. It does not duplicate the Sophia voice runtime and never calls Gemini directly.

The canonical campaign contracts live in [`docs/campaigns/vt00-voice-lab/`](../../docs/campaigns/vt00-voice-lab/). In particular, see the [runbook](../../docs/campaigns/vt00-voice-lab/runbook.md), [scenario catalog](../../docs/campaigns/vt00-voice-lab/scenario-manifest.md), [threat model](../../docs/campaigns/vt00-voice-lab/threat-model.md), and [deployment gates](../../docs/campaigns/vt00-voice-lab/deployment-gates.yaml). This package's executable catalog is [`scenarios/manifest.json`](scenarios/manifest.json), version `vt00.scenarios.v1`.

## Processes and durability

### Read-only historical recovery inventory

After building this package, run `node dist/src/bin/recovery-inventory.js` in
the existing service environment with `DATABASE_URL` and
`SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON` already configured. Do not pass
credentials as command arguments or paste them into logs. This v3-only diagnostic
does not run migration, write a schema seal, start a worker, or open any gate.
It uses a repeatable-read, read-only snapshot and prints counts, hashed identities,
typed reconciliation requirements and a report hash. `upgradeAuthorized` is
always false. Exit 0 means the bounded inventory completed, not that upgrade or
cleanup is approved; exit 2 means enumeration was incomplete; exit 1 is a
sanitized failure. Erased tombstones and unknown allocation histories still need
independent reconciliation. Runtime credentials must retain their existing keys.
The report enumerates up to 1000 erased tombstones separately from retained runs,
using SHA-256 fingerprints of their existing keyed IDs, purge status and retention
timestamps. Truncation makes the overall enumeration incomplete even with zero
raw runs. A confirmed remote purge or expired tombstone is not owner-loss or
resource-settlement proof; every erased entry still requires independent history
reconciliation. No raw keyed lookup ID or reconstructed run content is exported.
Complete inventories also carry `inventorySha256`, a stable content commitment
separate from the timestamped report hash. It binds counts, run assessments and
every projected tombstone field, independent of row ordering. Incomplete reports
carry null; inconsistent counts or duplicate identities fail the read-only audit.
The commitment is neither source authentication nor cleanup/upgrade approval.
It is the binding input for the still-unfinished historical reconciliation path.
`joinHistoricalObligations` can privately match cleanup obligation IDs obtained
from an authorized owning-system read against the committed inventory using the
existing retention key. Its result contains only hashes, lists unmatched rows,
and rejects ambiguous joins. The shared v1 HMAC framing is unchanged for both
ledger implementations. This helper does not authenticate the source read,
recover a run/caller/worker identity, prove settlement, or authorize migration;
all corresponding authority flags remain false. No live operator ingestion path
has been enabled by these helpers.

### Runtime processes

Render source snapshots canonicalize instance IDs together with their creation
timestamps. Duplicate IDs invalidate the source observation and cannot be hidden
by retrying a later subset. An empty transitioning inventory remains unavailable,
not evidence of owner death. These checks do not authorize historical settlement.

- `web` serves `/mcp`, `/healthz`, `/readyz`, `/version`, and durable evidence resources. It is stateless apart from Postgres.
- `worker` owns browser leases, executes queued operations, drains the generation-aware product capture cursor, refreshes short-lived run context, finalizes through the ordinary product boundary, and performs idempotent out-of-band recovery.
- `migrate` composes the checksum-pinned centralized baseline and recovery-control extension into one transaction under a Postgres advisory lock. Schema v4 supports fresh installation and exact attested reruns. Normal startup refuses v3 without mutation. The separately invoked `upgrade-recovery` operator performs the reviewed erased-history upgrade before normal C4 startup; do not deploy C4 over v3 without that explicit closed maintenance step.
- Production requires Postgres. The in-memory ledger is intentionally available only when `NODE_ENV=test`.
- Evidence manifests and compressed event chunks are content-addressed Postgres artifacts. The container filesystem is never an evidence store. Raw audio/video are unavailable until isolated governed object storage exists.

A web-process restart reattaches to the durable ledger. A browser-worker loss is never presented as live-session reattachment: the run becomes `aborted_driver_restart`, pending operations are terminalized, Gateway recovery is attempted by exact `test_run_id`, and evidence records any unresolved orphan separately.

## Local development

Node 22 and pnpm 10.26.2 are required. From this directory:

```bash
corepack enable
corepack prepare pnpm@10.26.2 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Generate and verify the deterministic V-A02 fixture family with:

```bash
node scripts/generate-a02-fixtures.mjs
pnpm test
```

For a dedicated local Postgres database:

```bash
DATABASE_URL=postgresql://... pnpm migrate
DATABASE_URL=postgresql://... pnpm migrate
```

Running migrate twice is the expected idempotency check. `SOPHIA_VOICE_LAB_TEST_DATABASE_URL` enables the destructive, dedicated-database integration suite; never point it at a shared or production database.

## Required production configuration

All credentials below must be distinct and at least 32 bytes. They are secret environment variables and must never appear in MCP results, logs, manifests, or plugin files.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Fresh managed Postgres used by both processes |
| `SOPHIA_VOICE_LAB_BEARER_TOKEN` | Base private MCP read/run credential |
| `SOPHIA_VOICE_LAB_FAULT_BEARER_TOKEN` | Optional stronger read/run/fault credential |
| `SOPHIA_VOICE_LAB_GRANT_SECRET` | Frontend-audience grant HMAC domain |
| `SOPHIA_VOICE_LAB_CAPABILITY_SECRET` | Gateway/Voice/recovery capability HMAC domain |
| `SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET` | Independent Gateway recovery transport secret |
| `SOPHIA_VOICE_LAB_D02_GATEWAY_CAPABILITY_SECRET` | Web/product-service-only, key-separated HMAC authority for exact D02 Gateway freeze/settlement requests; forbidden on the worker/controller |
| `SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64` | Web/product-service-only Ed25519 SPKI public key used to verify Gateway-authored D02 settlement receipts; the matching private key remains Gateway-only |
| `SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID` | Exact Gateway D02 receipt verification key identifier |
| `SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON` | Web/product-service-only retained key-id → Ed25519 SPKI map for immutable receipt replay across Gateway signing-key rotation |
| `SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON` | Versioned HMAC key ring for opaque global-audit and rolling-admission caller partitions; shape `{"active_key_id":"k2","keys":{"k2":"...","k1":"..."}}` |
| `SOPHIA_VOICE_LAB_PRINCIPAL_ID` | Pre-provisioned dedicated Better Auth principal |
| `SOPHIA_VOICE_LAB_ATTESTATION_PUBLIC_KEYS_JSON` | Exact three-authority Ed25519 public-key/issuer/subject/key-id map, shared by web and worker |
| `SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON` | Exact three-authority transport-token map mounted on the web service only; worker startup rejects it |
| `SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET` | Strong operator consent/CSRF secret for the registered-app authorization server |
| `SOPHIA_VOICE_LAB_OAUTH_TOKEN_PEPPER` | Independent HMAC key for opaque OAuth grant and token records |
| `SOPHIA_VOICE_LAB_ALLOWED_ORIGINS` | Comma-separated exact bare HTTPS origins |
| `SOPHIA_VOICE_LAB_ENVIRONMENT` | `production` or `staging` |
| `SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL` | Exact frontend origin probed by readiness |
| `SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL` | Exact Gateway origin probed by readiness/recovery |
| `SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL` | Exact LangGraph origin probed as a separate Builder-plane dependency |
| `SOPHIA_VOICE_LAB_TARGET_VOICE_URL` | Exact Voice origin probed by readiness |
| `SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA` | Pinned 40-character frontend candidate SHA |
| `SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA` | Pinned 40-character Gateway candidate SHA |
| `SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA` | Pinned 40-character LangGraph dependency candidate SHA; not added to the strict three-field product capability identity |
| `SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA` | Pinned 40-character Voice candidate SHA |
| `SOPHIA_VOICE_LAB_REPOSITORY_BASE_SHA` | Exact audited base commit |
| `SOPHIA_VOICE_LAB_REPOSITORY_CANDIDATE_SHA` | Exact running candidate commit; must equal `RENDER_GIT_COMMIT` |
| `SOPHIA_VOICE_LAB_REPOSITORY_ROLLBACK_SHA` | Exact approved rollback commit |
| `SOPHIA_VOICE_LAB_PLUGIN_PACKAGE_SHA256` | Before app registration, the exact pre-registration tree hash used only for kill-switched bootstrap; afterward, the exact final installed registered-app package hash |
| `SOPHIA_VOICE_LAB_PLUGIN_VERSION` | Exact plugin manifest SemVer; unregistered candidate A may use the base version, while registered candidate B requires the helper-exact `+codex.<single-sanitized-lowercase-token>` suffix |
| `SOPHIA_VOICE_LAB_REGISTERED_APP_ID` | Real `plugin_asdk_app…` technical identity; blank only during the pre-registration kill-switched deployment |

The registered OAuth lane additionally requires exact issuer, MCP resource, protected-resource metadata URL, ChatGPT client-metadata URL, stable redirect URI, and operator subject. `render.voice-lab.yaml` pins the public values, keeps the consent secret/token pepper distinct, and makes the plugin version/hash/app ID dashboard-managed on both lab services. First deploy committed bootstrap candidate A kill-switched with the pre-registration version/hash and a blank app ID. After registering that endpoint, add the real mapping, run the plugin-creator cachebuster, validate/hash, and commit those bytes as final candidate B. Set the exact final version/hash/app ID and redeploy LangGraph, frontend, Gateway, Voice, MCP, and worker from B before installation or mutation. The three attestation private keys remain offline with their independent controllers and are never mounted on either service.

`SOPHIA_VOICE_LAB_KILL_SWITCH` defaults to `true` outside tests. The Render Blueprint stores independent service-scoped values for web admission and worker execution: open worker first and web second; close web first, drain exact owned resources, then close worker. While engaged it blocks start, speak, barge-in, continuation, faults, and suite child allocation; inspect, end/finalize, recovery, cleanup, export, and readiness stay available. Global and per-caller concurrency are both fixed at one because the dedicated Sophia principal currently owns one Gateway voice session.

Optional bounded limits include `SOPHIA_VOICE_LAB_MAX_RUN_SECONDS`, type-specific operation deadlines, utterance count, cumulative injected duration/bytes, minimum utterance interval, TTS timeout, and retention hours. See [`src/config.ts`](src/config.ts) for validated ranges and route overrides.

Keep the active caller-partition key plus every prior key whose reservations are still inside the configured admission window. New rows use only the active key; lookups and caller quotas span the full ring. Startup and readiness fail closed if any live admission or runless-audit row names a key absent from the ring. After the last row for an old key has expired and been purged, that key may be removed. Global audit and admission tables never store the raw OAuth/static subject.

## Running and container commands

Development processes:

```bash
pnpm dev:web
pnpm dev:worker
```

The production image runs as a non-root user. The intended commands are:

```text
web:    node dist/src/bin/migrate.js && node dist/src/bin/web.js
worker: node dist/src/bin/migrate.js && node dist/src/bin/worker.js
```

The web service owns the public health check. `/readyz` requires Postgres, a live durable worker heartbeat with browser/fixtures ready, exact target build identity plus Gateway/Voice `/ready`, and a signed no-session frontend auth readiness receipt. A 503 is intentional if an execution prerequisite is unavailable.

## MCP client contract

Connect an MCP client to the HTTPS `/mcp` endpoint with `Authorization: Bearer <base-token>`. Use the separate fault token only for `force_socket_rotation`. The eleven tools are:

`get_capabilities`, `start_voice_run`, `speak`, `wait_for_turn`, `inspect_voice_run`, `barge_in`, `force_socket_rotation`, `end_voice_run`, `export_voice_evidence`, `run_regression_suite`, and `get_suite_run`.

Every tool uses a strict schema and the common `sophia.voice-lab.v1` envelope. Mutations require idempotency keys; retries return the same durable operation and scheduling receipt. Resources use `voice-lab://artifact/<id>` and remain resolvable across web/worker restarts until governed retention expires.

## Security boundary

- Browser authentication is an HttpOnly same-origin grant exchange, optionally seeded by encrypted storage state. Authentication is never stored in localStorage or passed as a global browser header.
- Product capture events must carry the original app-authored exact synthetic binding. Runner-added provenance cannot authorize semantic text or canonical joins.
- WebAudio input is hash-verified in the page and has exclusive scheduled/started/completed/interrupted/rejected receipts.
- Origins, deployments, principal, scenario, environment, capability audience/op/TTL, and run identity are fail-closed.
- MCP arguments and auth outcomes are audited by hashes; no tokens, cookies, provider continuation handles, arbitrary browser JavaScript, arbitrary URLs, SQL, or shell are exposed.
- Retention tombstones identifiers and deletes events/artifacts. Cleanup requires authoritative browser/provider/auth/Builder zero-orphan receipts; absence is a failure or typed unavailable fact, never success.

## Deployment, promotion, and rollback

Build the repository-root Dockerfile path `tools/sophia-voice-lab/Dockerfile` so the centralized migration is in context. Provision one web service, one worker service, and one fresh managed Postgres. Both services must pin the same commit and configuration; the worker command overrides the image default with the worker command above.

Promote only with exact frontend/Gateway/Voice SHAs, kill switch initially engaged, green `/readyz`, deterministic contract tests, and the VT00 campaign gates. Open the kill switch only for a bounded certification run and re-engage it immediately afterward. Rollback means re-engaging the switch, allowing cleanup/recovery to finish, then restoring the prior service image and the prior pinned target SHAs. Migrations are additive/idempotent; do not roll back by deleting the Voice Lab schema while retained evidence exists.
## Retained D02 receipt lookup

The local retained D02 recovery client also supports digest-only lookup of an
already committed Gateway settlement receipt. It derives the lookup from the
immutable dispatch journal and independently verified owner-death proof, then
checks the Gateway signature and exact bindings. Authenticated retained service
recovery invokes this lookup when the owner proof exists but the local provider
proof is missing. It audits the lookup and persists independently verified facts
under the ledger's version fence before returning them. Missing receipts remain
unavailable; auth/signature failures cannot become a successful recovery. This
path is not deployed. It cannot create a missing settlement or establish complete
cleanup; those boundaries remain unresolved.

Retained-only service responses bind the exact signed claim by hash. The external
attestation client classifies these as `RETAINED_RECOVERY_ONLY_NOT_CERTIFIED`,
not a malformed normal attestation or a certification receipt. It preserves the
response-byte hash and content-free facts in the typed error; normal attestation
replay/evaluator checks remain unchanged. The controller's existing signed
final-claim checkpoint supports retry without another Render action. The
`final_retained_recovery` terminal branch records response hash and facts in the
existing MAC-bound journal's next final-response slot (10 or 11). Resume checks
the complete phase prefix and exact claim, then returns the same non-certification
outcome without network activity. No certification phases may follow this branch.
These are historical recovery facts, not a fresh zero-resource observation or
complete operational closeout.

Worker maintenance isolates certification listing/per-run deadline failures from
resource recovery. Remote retention listing failure still permits the independent
local hard-deadline purge attempt; a failed local purge remains explicitly
unconfirmed while later resource recovery is attempted. These are logged errors,
not successful purge/cleanup claims. Retained scheduling, expired/terminal-run
listing, evidence listing/publication and suite maintenance failures are isolated
so later live-lease maintenance still executes. A failed terminal-recovery read
does not advance its pagination cursor. Publication errors leave evidence
unconfirmed and preserve orphan-manifest retry behavior. Active-lease checks are
isolated per run: later live leases and expired receipts are visited before the
first active-maintenance error is rethrown. An unavailable ownership read does
not imply loss, release or cleanup; invalid D02 authority still rejects the pass.
Local fault tests cover run lookup, lease lookup and heartbeat failures across
two live leases plus an expired obligation, and next-pass continuation with the
same lease epoch. Deployed qualification, hung-call bounds and raw-run queue
fairness across worker restarts remain outstanding.

Expired browser leases remain durable recovery receipts. The historically named
`reapExpiredBrowserLeases` observes them without deleting them in either adapter;
expiry still forbids heartbeat renewal and never permits replacement allocation.
A failed loss-observation write or interrupted maintenance pass can therefore
read the same exact lease again. Receipt removal remains an explicit cleanup
release/settlement operation, not evidence inferred from elapsed time. Expired
lease batch items are isolated so one failed loss write cannot skip later items.
Both adapters bound observation pages to at most 100 receipts ordered by run UUID;
the worker requests ten per pass and wraps an in-process continuation cursor.
A listing failure leaves the cursor unchanged; loss-write failure does not pin
the page. This bounds returned work, not query wall time or restart fairness.
The runtime PostgreSQL ledger additionally bounds connection/pool acquisition
to five seconds, server statement execution to five seconds, and lock waits to
two seconds. Statement/lock failures are server-side cancellation errors, not
cleanup evidence. Migration clients keep their separate migration bounds. These
settings do not bound a silent network transport or an entire multi-query pass.
Sequential suite scheduling requires every previously recorded child to remain
readable before considering another admission. A missing child leaves scheduling
and evidence unchanged; filtering it out is not proof that its lifecycle settled.
Historical recovery/retention reconciliation is required to resolve that history.
The same child-binding check guards scheduling and suite evidence publication:
expected supported-scenario prefix/order, caller, dedicated principal, environment,
exact target and capture policy must match. Run, test-run and cleanup identities
cannot be reused across children. These checks do not establish a fresh process
or replace the twenty complete-journey qualification evidence.
Suite certification also requires terminal lifecycle state and completed cleanup;
cached harness/evidence passes cannot certify active or pending children. The
scheduling decision shares the aggregate projection. An unsupported-only suite
may finish scheduling but reports `no_supported_children`, not certification.
This closes the expiry-enumeration deletion gap; it does not independently prove
process death or supply missing provider/Builder cleanup authority.

Retained cleanup scheduling now persists its last-selection timestamp separately
from recovery proof/version. PostgreSQL selects the oldest outstanding purged
controls with bounded row locking and updates scheduling before dispatch; worker
restart no longer resets the selection to the smallest run IDs. This is not an
exclusive execution lease or successful-attempt receipt. Auditing, authority,
cleanup joins and quota obligations are unchanged. The unreleased C4 migration
adds the scheduling column/index and is checksum-pinned; do not run this worker
against an older schema or apply runtime DDL. Already-selected retained controls
have a fixed 30-second retry cooldown, enforced with persisted database time;
unattempted controls remain immediately eligible. Restart does not reset this
interval. It does not extend provider or content TTLs. Raw-run queue restart
fairness and clock-rollback handling still require separate qualification.

## Aggregate provider-spend policy

The operator may explicitly set both
`SOPHIA_VOICE_LAB_MAX_ROLLING_PROVIDER_SECONDS` and
`SOPHIA_VOICE_LAB_MAX_ROLLING_PROVIDER_SECONDS_PER_CALLER` to `unlimited`.
Only these aggregate provider-time caps are disabled. Capabilities and remaining
allowance report JSON `null` for unlimited, not an invented numeric balance.
Reservations and replay accounting remain durable; restoring a finite cap counts
the existing rolling-window usage. Per-run deadlines, run-start/audio/suite caps,
single-run concurrency, cleanup, authentication, and deployment gates remain enforced.
The Blueprint selects this policy by the operator's explicit request. It requires
the matching new service code and the ordinary closed-gate release verification;
never apply `unlimited` to an older deployment that accepts integers only.

### Generic worker owner-loss source controller (C4, not yet deployed)

The external-attestation CLI command `generic-render-worker-loss` accepts
`--input`, `--public-config`, `--transport-tokens`, `--deployment-key`,
`--render-token`, and `--bundle-dir` absolute file/directory paths. Input JSON
contains only `runId`, stable `requestId`, `workerServiceId`, `voiceLabOrigin`,
`expectedLabSha`, and `expectedLangGraphSha`. Use the existing source-authority
credential file formats; never put token values in command arguments.

The bundle directory must be an empty real private directory (0700). After an
interruption use the same inputs, custody and directory with `--resume true`.
Numbered mode-0600 entries are atomically published, hash-chained and HMAC-bound
to the exact controller inputs and deployment authority. Existing entries are
never overwritten. A failed append requires a new invocation; do not delete or
edit phases to retry. Tampered, gapped or differently scoped bundles reject.
Pre-consumption readiness observations may append a new prepared phase; after
consumption no second restart POST is permitted, including a lost response.

Execution requires the separately configured authenticated generic recovery
endpoint, closed exact-release gates, one active run, one verified original
worker and a fresh verified replacement. Exit 0 means a signed owner-loss
receipt was verified and its ledger acknowledgement cross-checked, **not** that
resource cleanup or VT00 passed. The controller durably checkpoints the signed
receipt before authenticated publication. A lost publication response requires
the same bundle's resume, which replays the receipt without another restart.
Exit 2 means
unconfirmed; preserve the bundle for source reconciliation. Independent
provider/auth/Builder settlement and owner-batch recovery remain separate obligations.
Do not run this command as a substitute for installed-plugin voice testing or
before the runbook's source-recovery prerequisites are satisfied.

### Erased-history quarantine upgrade (local C4, not deployed)

The dedicated command, from the built package directory, is
`node dist/src/bin/upgrade-recovery.js`. It accepts no positional arguments or
alternate migration paths and does not run at normal service startup. Both
immutable migration checksums must match before a database connection is used.
The operator derives v3/v4 catalog expectations in rolled-back reference-schema
transactions, then invokes the existing locked, inventory-bound upgrade.

Before invocation, independently verify all live gates closed, stop the old Lab
worker and web maintenance processes, and record their exact deployment states.
Use the isolated Lab database environment from the exact release image, never
the product/Supabase database. Require these explicit environment settings:

- `SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_APPROVED=YES`;
- `SOPHIA_VOICE_LAB_KILL_SWITCH=true`;
- `SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_EXPECTED_COMMIT` equal to the exact
  `RENDER_GIT_COMMIT` (or local immutable-checkout `COMMIT_SHA`);
- `SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_INVENTORY_SHA256` from the fresh complete
  read-only historical inventory;
- optionally `SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_AUTHORIZATION_SHA256` for the
  explicitly accepted historical inventory, matching the Gateway authorization;
- existing `DATABASE_URL` and production caller-partition key ring, never printed.

Configuration records operator intent, not external gate or source attestation.
The transactional primitive independently rejects recent worker heartbeats,
pending operations, source/catalog drift, non-erased runs/leases or inventory
drift. Omitting the authorization retains the database quarantine admission
block. The command never writes a host schema seal, opens gates or certifies
historical cleanup. Remove the one-time approval settings after use; normal
startup then independently attests v4 and writes its own exact release seal.
If the command fails or its response is lost, treat the outcome as unconfirmed:
read schema metadata and historical inventory before retrying. Do not infer
rollback from a disconnected client or rerun an upgrade over an observed v4.

After a reviewed quarantine upgrade, the existing read-only inventory command
supports `SOPHIA_VOICE_LAB_RECOVERY_INVENTORY_MODE=quarantine`. This mode uses
`DATABASE_URL`, not caller partition keys, and reads the durable quarantine
instead of expired source tombstones. It emits bounded hashed locators, original
inventory commitments and retention dates; it never grants admission or certifies
cleanup. Exit 2 means enumeration is incomplete. Default `historical` mode
continues to require the exact v3 schema and the configured partition key ring.

`upgradeHistoricalRecovery` retains its default refusal of any v3 tombstone.
Its explicit optional `{ expectedInventorySha256 }` quarantine lane accepts
only an exact, complete erased-only inventory: zero raw runs, zero browser
leases, no live worker heartbeats or pending operations, and 1–10,000 retained
tombstones. The source and target catalogs, migration bytes, inventory hash,
and quiescence are verified under the existing schema/table locks. The
historical inventory hash is a drift check, **not** a cleanup attestation.

The transaction preserves every opaque locator and its original purge status
in `historical_quarantine`. Both confirmed and unconfirmed remote purges remain
unresolved. The quarantine has no expiry, no run-content foreign key, and no
runtime update/delete/truncate path. Database triggers reject new runs,
suites, browser leases, and non-End operations while any quarantine row lacks
an exact per-row historical admission exception. Normal startup can attest the
schema; unexcepted history reports `historical-recovery-quarantined`.
No host seal or external gate is changed by
the upgrade primitive itself.

This is not permission to apply production DDL or open gates. The runbook's
exact-release, D02 membership, closed-gate and quiescence prerequisites remain.
There is deliberately no invented caller, lease, owner, or successful settlement.
Following explicit operator authorization, the same locked upgrade may receive
`admissionExceptionAuthorizationSha256`, the hash of the recorded authorization.
It appends immutable per-row `historical_admission_exceptions` for that exact
inventory. This is risk acceptance, not a signature, verified closure, or
discharge: quarantine, original statuses and `historicalCleanupProven:false`
remain. The inventory reports `operator_accepted_unverified_history` separately.
Future quarantine identities and ordinary new-run cleanup constraints are not
exempted. Without this explicit option, the original blocking behavior remains.
