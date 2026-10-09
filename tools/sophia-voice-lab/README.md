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

The Studio G7 product-shape test (`-t PRODUCT-SHAPE-SQL`, in `test/studio-g7-evaluate.test.ts`) applies the product's own migrations (`SOPHIA_VOICE_LAB_PRODUCT_MIGRATIONS_DIR`, e.g. from `git archive <product commit> db/migrations`) to a disposable database (`SOPHIA_VOICE_LAB_PRODUCT_SHAPE_DATABASE_URL`, named `voice_lab_test_studio_product*`, with `SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED=YES`). Without them it is skipped; set `SOPHIA_VOICE_LAB_REQUIRE_PRODUCT_SHAPE=1` in any receipt run so that a missing variable fails instead of skipping.

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

## Studio LiveKit G7 target (source only, off by default)

`SOPHIA_VOICE_LAB_TARGET_KIND` selects the driver, evaluator, readiness probe and
MCP tool surface. It defaults to `legacy-gemini-browser-v1`, which is unchanged
(same eleven tools, same `/readyz` body). `studio-livekit-g7-v1` drives the Studio
(LiveKit) room against the product contract `sophia.voice-qualification.v1`
(migration 0046 is authoritative where the plan document differs; see
`STUDIO_G7_CONTRACT_DIFFERENCES` in `src/studio-g7/contract.ts`). The adapter
contract is `sophia.studio-g7.v2`, its catalogue `studio-g7-v1` (scenario
`V-G07`; the run binding keeps that version). On this kind every legacy scenario (V-A01 … V-P01) is rejected by
`start_voice_run` as typed `unsupported_for_target`.

| Variable | Purpose |
|---|---|
| `SOPHIA_VOICE_LAB_STUDIO_ORIGIN`, `SOPHIA_VOICE_LAB_STUDIO_API_ORIGIN`, `SOPHIA_VOICE_LAB_STUDIO_SUPABASE_URL` | Bare origins; each must also be in `SOPHIA_VOICE_LAB_ALLOWED_ORIGINS` |
| `SOPHIA_VOICE_LAB_STUDIO_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable (anon) key; not secret, never logged |
| `SOPHIA_VOICE_LAB_STUDIO_PROJECT_ID` | Dedicated synthetic project UUID (room view `/p/<id>/studio`) |
| `SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_EMAIL`, `SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_PASSWORD` | Synthetic principal; secret, environment only. `SOPHIA_VOICE_LAB_PRINCIPAL_ID` must equal its Supabase user id (the product's actor id) |
| `SOPHIA_VOICE_LAB_STUDIO_EXPECTED_STUDIO_SHA`, `..._API_SHA`, `..._BRIDGE_SHA` | Pinned 40-hex commits (Studio meta `sophia-build`, API `/health`, bridge `provider.bridgeCommit`) |
| `SOPHIA_VOICE_LAB_STUDIO_GRANT_WAIT_SECONDS` (5–240, default 120), `..._GRANT_REJOIN_SECONDS` (default 15) | Bounded wait for the grant-bound `mic_published` receipt before an exchange is opened |
| `SOPHIA_VOICE_LAB_STUDIO_OBJECT_STORE_ORIGINS` | Comma list (≤ 8) of the signed-download origins `GET /sources/{id}/content` returns; artifact bytes are downloaded and hashed only from these. Empty: byte checks are typed `unavailable` |
| `SOPHIA_VOICE_LAB_STUDIO_ACCESS_TOKEN_MAX_SECONDS` (60–86400, default 3600) | Upper bound of a Supabase access JWT's lifetime; gates the release of a dead foreign worker's lease (raised automatically to any longer `expires_in` the product issued, up to the hard 24 h bound; a grant above 24 h is refused and fails start closed) |

**MCP tools (Studio kind only).** `start_studio_g7_run` reserves the run and returns
the non-secret run binding. `studio_g7_voice_step` performs one voice step
(`create`, `steer`, `hold`, `resume`, `create_stop_target`, `stop`) as one
`speak` operation labelled `_g7_step`. `studio_g7_action` performs one
non-voice step as one `studio_action` operation: `record_note` (the run's own
note through the member route: always the Lab's fixed synthetic note, so no
caller text is kept in the durable operation; only its hash is recorded),
`leave_and_return`,
`section_revision` (needs `instruction`, optional `sections`), `stale_edit`,
`withdrawal` (optional `entry_id`), or `observe` (`for_step`, optional
`wait_ms`), a read-only outcome read for a voice step. A
step runs at most once per run: the same key replays the same operation, and a
new key for a step that is in flight or was performed is refused
(`STUDIO_G7_STEP_IN_FLIGHT` / `STUDIO_G7_STEP_ALREADY_PERFORMED`). Both ledgers
enforce this in the transaction that inserts the operation (the PostgreSQL run
row lock), so two keys racing for one step cannot both run, and the worker
re-checks it before executing. Every G7 step is therefore a durable, idempotent
operation; none is only a driver method. The legacy input tools (`speak`,
`barge_in`, `force_socket_rotation`) answer `unsupported_for_target` on this
kind, and the worker refuses any unlabelled input operation on a Studio run.

**Episode order.** The G7 episode follows the lifecycle the product supports
(R2, the product's `apps/api/src/voice-episode.db.test.ts`), one operation per
step: `record_note` (the run's own note N; its receipt names the entry and the
note's source S), `create` by voice (a research R drawing on S, whose design D
is then under way on the same goal), `steer` (while R/D are live),
`leave_and_return`, `hold` then `resume` (while D is live, each observed), then
the section revision over HTTP once D published its page (the Lab's own edit
X, left under way), the stale probe, the withdrawal of N while X is live, and
last the Stop sub-episode: `create_stop_target` by voice (a second research on
its own goal, observed pending or running) and `stop` on it (observed). The
product admits no edit while D is live (`not_started:no_html_page`), one design
of a page at a time, and no Stop on a goal that already completed (`invalid_state`),
which is why Stop gets its own sub-episode. Only HTTP revisions are made: a
revision by voice is out of scope.

**Lab schema v7.** `studio_action` is a new value of `operations.type`
(`migrations/007_studio_g7_operations.sql`, an additive CHECK widening; no row
changes). The release bundle is v7 (`VOICE_LAB_MIGRATION_SHA256`
`fcba91c6…`). An existing v6 database must be upgraded first, while quiescent and
kill-switched, with `src/bin/upgrade-studio-g7-operations.ts`
(`SOPHIA_VOICE_LAB_STUDIO_G7_OPERATIONS_UPGRADE_{APPROVED,EXPECTED_COMMIT,INVENTORY_SHA256}`;
inventory from `src/bin/service-fence-inventory.ts`). Until then `migrate.js`
refuses the v6 schema at startup, for the legacy target too.

**Run binding.** The value an operator passes as `run_binding_sha256` to
`sophia.voice_qualification_grant(...)` is the lowercase hex SHA-256 of the UTF-8
bytes of exactly:

```text
{"cleanup_obligation_id":"<uuid>","scenario_id":"V-G07","scenario_version":"studio-g7-v1","schema":"sophia.voice-lab.studio-g7.run-binding.v1","test_run_id":"<uuid>"}
```

(keys in this order, lowercase UUIDs, no whitespace). The start response returns
it under `data.run_binding.run_binding_sha256`; the raw cleanup obligation id never
leaves the Lab. Because a grant never covers an earlier exchange, the driver opens
the exchange ("Speak with Sophia") only after a `mic_published` receipt carrying
this binding and the Lab-issued track arrives; it rejoins periodically to refetch
the room token and fails typed `unavailable` at the wait limit. The Speak intent
and the exchange join are written ahead (durable before the driver acts). The
join is refused when the snapshot names another member as the exchange's floor
holder; when the snapshot reports no holder the join is recorded with
`input_actor_is_principal: null` (unverified), and ownership still rests only on
the evidence proof below.

**Evidence.** Page receipts arrive over the private push binding; bridge and
guard receipts are read with the principal's JWT from
`/api/v1/exchanges/{id}/qualification-evidence` in the 0046 shape (one `grant`,
rows `{source, seq, kind, receivedAt, receipt}`). Both are parsed strictly
(unknown keys and free text rejected) and bound by grant id and run binding, and
are ordered and de-duplicated by `(source, seq)`. Refused member reads are typed
by the product's own convention (A15): a missing object, or one the principal
may not read, answers 422 `{code: "not_found"}` (typed
`not_answered_to_principal` for the evidence, `not_found_for_principal` for
other member reads); a 404 means the route itself is absent (the API runs
without `SOPHIA_VOICE_QUALIFICATION=on`) and is typed `endpoint_not_served`:
unavailable, never "not yours", and never proof of ownership or of an end, so a
run against such a product never requests End. Any other refusal is
`endpoint_unavailable` (401/403: `auth_rejected`). Input is reconciled by window
ordinal and envelope only; the Lab never compares its PCM chain with the
bridge's. WebRTC sender stats are corroboration only. Neither side retains a
transcript or audio: the Lab records counts, envelopes, ids, states and hashes,
and never captures screenshots on this target (captions are speech text).

**Outcomes.** Canonical outcome reads go through the member API as the
principal: snapshot work → native task (ids, kinds, states, phases; instructions
and Markdown dropped) → the design's published version → its HTML rendition's
source → the downloaded bytes' SHA-256, compared with the declared source,
rendition and version digests. A section revision, a stale edit and a withdrawal
are the Lab's own requests, so their outcomes are canonical. A withdrawal
forgets the run's own note (the one its `record_note` receipt names; without
one, the single current note the principal recorded by voice in the run's
exchange; a named `entry_id` must be one of those) and confirms the preview's
whole cascade (every version of the note from the
principal's first, and every decision resting on one of them), so it is sent
only when every previewed entry is the run's own note (its recorded note, or
one bound to its exchange, by the principal) and every previewed decision is the run's own (proposed by
the principal by voice, decided by nobody else, resting only on the run's own
notes; the mission read does not expose a decision's exchange); otherwise
nothing is sent (`withdrawal_cascade_not_own`). The run's report is
resolved only through the product's own chain, every link a member read as the
principal: the run's certified create task (the create step's certification
below, whose `NativeTask.exchangeId` is the run's exchange) → its research's
`designTaskId` → that design, which names the research back (`researchTaskId`)
and no other exchange → its artifact and published version. A section revision
sends that artifact's current version (with a designed page; the version id
binds the request to the run's own artifact, so a later version of it, e.g. a
rendition that keeps the page, is revised too), and a stale edit sends the
newest own version a newer one superseded (the product checks staleness first,
so the probe is refused `409 stale_revision` even while X is under way). A
revision first waits, bounded by the step's settle budget, for the own design
to publish its page; it never waits for X (its state at return is read once).
Without a certified create, a
missing, ambiguous or foreign link, or a design not yet published, nothing is
sent: the step is typed `unavailable` or `uncertain` (`create_step_not_certified`,
`own_design_pending`, `target_not_canonical`), and the chain is re-read right
before the request (a change refuses it, `target_changed`). A design in the
run's time window or by the principal is never a fallback. Only that chain's
versions (the own design's, then the Lab's own edits of that artifact) are
downloaded and judged: another design's bytes, edits or refusals never pass or
fail the run. A voice step is
certified only from the exchange's calls (A15 `GET
/api/v1/exchanges/{id}/calls`: the grant principal's own voice tool calls in an
exchange opened under the grant, each with the command the transaction inserted
for that call, `answeredAt` once the API finished it and anything it admitted
committed, and its `outcome`; each read carries `readAt`, and `?after=<readAt>`
lists only calls whose recording began after that read, so a call already in
flight at it never is). Once the previous step settled (its reply ended and its
own calls answered), the worker reads the calls until every listed one is
answered and makes that read's `readAt` the step's baseline, durable before the
step's write-ahead (a re-executed step keeps its first; `readAt` is passed back
verbatim, never parsed). As soon as the step settles, before the next operation
acts (or at End), it reads `?after=<baseline>` until every listed call is
answered: that read is the step's window. The step passes only if every call in
the window is answered and was made at the input epoch the principal held for
the step (its input window's bridge receipt, joined by ordinal only while the
windows seen are exactly 1..k for the k non-silence inputs so far and, after
`session_closed`, the run is joinable; an extra or missing window leaves every
step's epoch unknown, `step_input_epoch_unknown`). Because an extra window
before a step and a missing one after it keep the count, the join is also
cross-checked: every window must have ended `turn_complete` (a pause, handoff,
barge-in or close splits or cuts an utterance), and each window's turn must
have shown no more tool calls than the step's own calls read lists, and at
least one when that read holds a command-bearing call; otherwise every epoch
is unknown and the per-input envelope assertions are `unavailable`
(`ordinal_join_inconsistent`). Exact equality is not required, because a
normal run can show fewer (a tool continuation generated after the turn
completed is not in its window's count). Not tolerated, a known false
negative: a call refused before it is recorded (by the bridge, or by the API
as `not_declared`) is counted in its turn but never listed, so its window
shows more calls than its read; the Lab cannot tell that from a shifted
window, and a shift displaces every step from an unknown point on, so the
whole join is refused, not only that step's (the bridge and API tool
surfaces agree in a normal G7 flow). Only in the worker's mid-run hand-over
of the certified create (before an action or End, before `session_closed`) is
one window not checked: the highest `windowSeq` seen, while its own
`input_turn` has not arrived and no later input receipt has (the bridge sends
each turn right after its window, in seq order; before an action or a voice
step, not before End, the settlement gate waits for it, bounded at 5 s). An earlier window without its turn lost it and is
checked like any other, mid-run too; a run's own evaluation checks every
window, even when its `session_closed` never came. The residual
is exactly what the bounds accept: a count-preserving shift (an utterance
split into a turn-completed fragment, together with a later utterance that
got no window) stays unseen whenever every displaced window shows a count
within its new step's bounds, from 1 to that step's own listed calls (0 to
them for a step without a command): for example a fragment showing one call
landing on a single-call step, or one call on a step with two (both pinned by
tests). Exactly one call must carry a command:
`native_task` with its task, answered `admitted`, for create (the task naming
the run's ownership-proven exchange in the snapshot, `NativeTask.exchangeId`);
`steer`, `hold`, `resume` on the created task's goal, and `stop` on the Stop
sub-episode's goal, answered `ok`.
The command must not be denied, superseded or of unknown outcome, never
certified by an earlier step; hold, resume and stop (which take a new authority
epoch; a steer does not) must carry an epoch above the previous of those on
their goal, and see the status match in the step's own observation: hold and
resume on a task of the created task's goal (the product holds the design under
way while the research reads `result_ready`: `holding`/`held`, `running`), Stop
on its target (`stopping`/`stopped`). An unsettled read, no new
call, an unanswered call, no command or more than one, another kind, goal, epoch
or outcome, a command a later read no longer lists, or a task or command seen
only elsewhere (another exchange, or the principal's own HTTP request) never
passes; a product that does not serve the calls (404) or refuses them (422)
leaves the steps `unavailable`.

The withdrawal ended the run's own edit X (`step.g7.withdrawal.design_ended`)
only with every join on the note's SOURCE S, the `sourceId` of the run's own
`record_note` receipt (the entry id serves only the routes and the preview's
`expectedAffected`; a match on the entry id alone, or on another source, never
passes): the withdrawal committed, for the run's own note, and its
`withdraw_note` receipt names S; X is canonically the run's own (the task the
Lab's own admitted edit receipt names, on the own design's artifact, and in the
withdrawal's own before-observation an edit whose design names the run's own
research R on that artifact) and was live there (designing or reviewing),
not yet listing S as withdrawn; in the withdrawal's own after-observation X
`failed` for the product's revoke reason (`revoked_source_withdrawn`, only the
class is kept) with S in its `withdrawnSourceIds` (A15/0046, computed live by
the product from X's attempt's consumed closure, so this is also the proof
that X drew on S), and S the only source newly withdrawn from X's closure
between the two observations (another one, e.g. a concurrent foreign
withdrawal, could be the revocation's cause: `concurrent_foreign_withdrawal`);
and nothing else ended it first (no Stop before that observation). `NativeTask.inputSourceIds` is never used for this join: the
product builds it from discussion contributions only (`native_task_view`,
migration 0022), so a note's source is in the research manifest's dependency
graph but never listed there. Anything less is
`uncertain` or `unavailable`, never a pass. Timing risk: if X publishes (or
ends) before the withdrawal reaches it, the end is `uncertain`
(`own_edit_no_longer_live`); the episode withdraws right after the stale probe
to keep that window short.

Stop is credited only on the Stop sub-episode's own live work, never on work
already ended: its own certified create (`create_stop_target`, with its own
baseline, window and command, a `native_task` naming the run's exchange, on a
task and goal distinct from the episode's: `stop_target_not_distinct`), its
target seen live before Stop's baseline (`stop_target_not_observed_before_stop`,
`stop_target_already_ended`), Stop's own command on that goal, then the target
`stopping`/`stopped` in Stop's own observation and its job `cancelled` for the
reason `stopped` (`stop_effect_not_settled`); a target that lists a withdrawn
source or the revoke reason is never Stop's effect
(`stop_target_ended_by_withdrawal`). The sub-episode never borrows the main
create's joins: without its certified create, Stop is `stop_target_not_certified`
and is never credited on the main create's work, and a Stop on the main goal
after the withdrawal (refused by the product, no command) is never a pass. A command that a later answered read shows `denied` fails its
step, and one later of unknown outcome is `uncertain`. End reads every call
of the exchange once (no `after`); a command-bearing call that some read lists
but no step's window holds (made between a step's window read and the next
baseline, or after the last step) makes the run `uncertain`
(`outcome.calls_attributed`: `unattributed_call`). That read of every call is
End's own audit, taken post-quiescence: after the run's exchange was confirmed
ended and the bridge reported its provider session closed (no further voice
call can be recorded), settled (every call answered), and before the global
sign-out revokes the principal's read. It relies on the product's
"fence recording against End" (C5: recording a voice call takes the exchange's
project lock, then the exchange row, and checks its state under both, so End is
a durable recording boundary; reported as 04fac683 on
`sdd-01/voice-lab-g7-r1`, its verification and merge still pending, pin to
follow): a call recorded before End may still be listed unanswered right after
it and answered later, and none is recorded after it. The audit therefore
re-reads until every listed call is answered, bounded; a read that never
settles is `uncertain`, never treated as final. The evaluator proves the order from the
ledger; an audit missing, unsettled, before quiescence or after the sign-out
is `end_calls_audit_unproven`, a refused one `end_calls_read_unavailable`,
never a pass. The calls are read only with
the run's own browser session: without one a read is typed
`no_browser_session`, never made by signing in. With one, the read uses that
session, which is renewed (a password grant) within 60 s of its expiry; the
renewed session replaces the run's own, so End's global sign-out revokes it. A
complete run whose six voice steps are certified, with every other product
assertion (the withdrawal's end of X on S included) passing, can report the
product `pass`;
otherwise it stays `inconclusive` (or `fail` where a step's own command
contradicts it).

**Completion.** A run ends `completed` once its harness assertions and cleanup are
proven. Receipts that arrive after End (the bridge's `session_closed`, the last
reply) are re-read by a bounded evidence completion path before the
certification deadline: a fresh principal session reads the evidence, then only
that session is revoked (`scope=local`, three attempts with backoff). It never
falls back to a global sign-out, because a later run of the same principal may
be live by then. A refresh session that stays unrevoked is recorded and keeps
the cleanup proof incomplete (`cleanup.refresh_session_revoked`), so the run
cannot certify; the worker then signs the principal out globally only once no
other run can hold a live principal session (if the certification deadline
passes first, the failed run holds admission again until that sign-out is
done). A step not performed before End fails the harness at once instead of
waiting for it.

**Global sign-out fence.** Every Studio API-only recovery ends in a global
sign-out of the one synthetic principal. The ledger grants it in one critical
section that admission also takes (the PostgreSQL run-quota advisory lock), and
only when no other run can hold a live principal session: a run that is not
terminal, or still holds a browser lease. A terminal run whose browser is
closed is never waited on; there is nothing of it a sign-out could revoke, and
waiting on it could deadlock. While the sign-out is pending the run holds
admission and a durable marker makes admission refuse with
`STUDIO_GLOBAL_SIGNOUT_PENDING`; the marker is cleared when the sign-out is
confirmed or abandoned, on every path after a granted fence (a throw included).
An abandoned sign-out leaves the run's cleanup incomplete until terminal
recovery retries it. A run that was awaiting external evidence still is: it
never gets a failure-shaped manifest from that recovery or from the generic
evidence revision, and only the Studio evidence path finalizes it from the
ledger once its cleanup is proven again. Markers are matched by id: a worker
clears only its own, and a marker stays outstanding until a clear for that id.
A second recovery of the same run is refused (`sign_out_in_flight`) while the
run has an outstanding marker, so two workers never hold markers for one run at
once, and admission stays closed while any run has an outstanding marker,
whatever its cleanup flag. Only a marker that is provably abandoned is taken
over: on the ledger's clock it is older than the heartbeat staleness plus the
60 s skew margin (90 s), and its owner is dead: no heartbeat under its worker
id, one older than that, or one from another process boot than the one that
wrote the marker (each marker records its owner's random per-process boot id,
which the worker's heartbeat attestation carries, so a container restarted
under the same instance id is not its previous process); the taking-over begin
clears it (`abandoned_owner_dead`). An abandoned marker is held by nobody.
Right before its global logout the holder re-checks in the ledger that its
marker is still outstanding and not abandoned; a holder whose marker was taken
over or abandoned, or that cannot read the fence, signs out only its own
session (scope=local), and that never counts as the principal signed out: only
a confirmed global sign-out does (recovery receipt, cleanup proof and
`cleanup.principal_signed_out`), so the run stays incomplete and recoverable.
A marker never outlives its owner's ability to clear it: maintenance (at most
every 30 s, and at once while a failed clear waits) clears the outstanding
markers carrying the worker's own id that no recovery of its process holds: a
clear of this boot that failed (it is logged, the recovery's evidence is kept,
the retry records the intended outcome, and a marker already cleared meanwhile
counts as done) at once, and one a previous boot left behind
(`abandoned_owner_restarted`) only once the ledger's own rule says it is
abandoned (90 s on its clock, the heartbeat under the id stale or from
another boot). One instance id must belong to one live process: a second live
process under it is never presumed dead (its young marker is left alone and
a warning is logged). No
wait cycle remains: a deferral waits only on a run that is live (not terminal,
or leased), at most one run is live at a time (admission admits one run, and a
run never leaves a terminal state or regains a lease), and a live run's own
recovery never waits on a terminal, lease-free run.

**Cleanup.** The Lab never requests End for an exchange it cannot prove is the
run's own: the exchange joined to this run after its Speak, whose evidence names
this run's binding hash and the grant id of its page receipts. End is requested
only as `POST /api/v1/exchanges/{id}/end` for that proven id; the room UI's End
button is never used, because it acts on whatever exchange the room shows at
click time. Without proof the Lab verifies read-only (one live exchange per
room) that the run's exchange is no longer live, or types the state `uncertain`
/ `unavailable` and re-verifies with backoff until the product guard ends it at
its deadline. A snapshot answer without a well-formed `room.sophia` presence is
typed unknown, never "no live exchange". Once Speak was requested and no
exchange is joined (start still running or not), a room with nothing live stays
`uncertain` until the principal has left the room: only a read-only member-API
observation made after the run's browser close and a confirmed global sign-out
(both durable after Speak; for a dead owner, after its lease was quiesced) that
shows nothing live confirms the end (`no_live_exchange_after_principal_left`).
No time window is used: a window cannot prove an exchange will not open later,
and no clock of one worker is compared with another's. Limit: an open request
the API accepted before the sign-out could still create an exchange after it;
the Lab treats the principal's departure as the end of its ability to open one.
If nothing-live-after-departure is never observed (an exchange stays live), the
run stays not cleanup-complete until the product guard ends it. Each settlement
records what the driver knew when it observed (Speak requested or not, the
joined id, browser closed, signed out), and the cleanup proof counts an end
against that, not against when it reached the ledger: after a Speak intent, a
confirmation made before Speak or without an API read never counts. Leaving the room (the room
UI's "Leave the room") and closing the run-owned Chromium are not
ownership-gated: they act on the principal's own presence and browser, not on an
exchange. The principal is signed out globally and the run-owned Chromium is
closed on every cleanup path.

A dead foreign worker's Studio lease is released by compare-and-delete in one
ledger transaction, after the run is terminal, the lease expired and the owner's
heartbeat is stale by more than 30 s plus a 60 s clock-skew margin (heartbeats
carry each worker's own clock). Every gate is evaluated by the ledger on its own
clock: the releasing worker asks the ledger first (without a verification) and
recovers only when the ledger says a post-expiry sign-out or the fresh
verification is what is missing, never on its own clock. Only this path
recovers a run whose lease a foreign worker holds, and every Studio API-only
recovery (a password grant and a global sign-out) is spaced at least 30 s
apart. Then either:
- the owner's own cleanup for that lease epoch is durable (the browser acquired
  under it proven closed, a confirmed global sign-out, the exchange confirmed
  ended after its join), and the lease is released at once; or
- the releasing worker runs an API-only recovery (never short-circuited by a
  cleanup proof that is not bound to the lease), and releases the lease only
  after a global sign-out confirmed after the lease expired, the access-JWT
  lifetime elapsed since, and a fresh verification that the run's exchange is
  not live. The lifetime is `SOPHIA_VOICE_LAB_STUDIO_ACCESS_TOKEN_MAX_SECONDS`
  raised to any longer `expires_in` the product issued to the run (made durable
  before the browser is seeded with the session), so a wrong setting never
  shortens the wait; a lifetime above the 24 h bound is refused at the grant and
  never becomes the wait. That verification also reads the room as the media
  bridge last saw it (A15 `GET /api/v1/rooms/{id}/live-presence`, the
  principal's own `selfPresent` and counts, nobody's identity): a fresh report
  placing the principal in the room keeps the lease
  (`principal_present_in_room`); a fresh report without the principal is
  recorded as `absent`. No report, a stale one (the product's own `fresh`, older
  than 15 s), a 422 `not_found` or an absent route (404) proves nothing either
  way: it is recorded `unobservable`. The latest decisive verification (present
  or absent) of that owner and lease epoch decides: after a present, a later
  unobservable one does not release; a later fresh absent does. The veto is
  bounded, because the bridge reports only while it is in the room and a fresh
  absent may never come once the exchange ended: a verification that proves the
  run's exchange not live and whose presence read shows the bridge's report
  gone (`not_observed` or `report_stale`; a failed or refused read never
  counts), at least 15 minutes (`STUDIO_PRESENCE_VETO_BOUND_MS`, database
  clock) after the last fresh present, releases the lease, and the release
  records `presence_veto_expired` (the evaluator types
  `cleanup.orphan_room_presence` `uncertain`). Fifteen minutes is far beyond
  the bridge's 15 s report freshness and a participant's disconnect timeout,
  while bounding how long one dead run can hold admission. A report that stays
  fresh `present` (a bridge stuck in the room) holds the lease for at most two
  hours (`STUDIO_PRESENCE_STUCK_CAP_MS`) from the first such present; then the
  release records `presence_veto_capped` and the evaluator fails the orphan's
  presence. This cap was chosen over an operator release (there is none). The
  trade-off, stated: a release past the bound or the cap can happen while the
  orphan browser is still in the room, and the next run joins the same project
  room (the room is per project). The orphan browser process's close is typed
  `unobservable`, not proven.
The PostgreSQL ledger stamps the sign-out and verification events with the
database clock (the clock of the lease expiry), whatever the worker's clock says.

**`/readyz`.** On the Studio kind it answers for the Studio document and its
build meta, the API's `/health` identity and `/ready`, Supabase Auth's public
health (publishable key only), the worker heartbeat and the kill switch; no
credential is used. A published identity that differs from its pin is not ready.

**Limitations (explicit).** The Chromium tests drive a local fake Studio whose
loopback `RTCPeerConnection` stands in for LiveKit: it proves the Lab-issued
track is the published sender track, not packet flow to any SFU or the bridge.
No transcript and no audio is retained by the Lab or the product contract. An
orphan browser's room presence is evidence only from a fresh bridge report (the
bridge reports only while it is in the room), and absence at that report does
not prove the process closed. Voice-step certification needs the API's voice
qualification on; a steer's effect beyond its admitted command, and a goal's
status other than its created task's phase, are not exposed by the member API.
The withdrawal's end of X is proven only through the `withdraw_note`
receipt's `sourceId` and X's own `withdrawnSourceIds` (A15/0046, voice
qualification on); without them it is `unavailable`. Section revisions are made over HTTP only; revising by voice is
out of scope.

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

The web service owns the public health check. `/readyz` requires Postgres, a live durable worker heartbeat with browser/fixtures ready, exact target build identity plus Gateway/Voice `/ready`, and a signed no-session frontend auth readiness receipt (on the Studio kind, the Studio/API/Supabase probes above instead). A 503 is intentional if an execution prerequisite is unavailable.

## MCP client contract

Connect an MCP client to the HTTPS `/mcp` endpoint with `Authorization: Bearer <base-token>`. Use the separate fault token only for `force_socket_rotation`. The eleven tools are:

`get_capabilities`, `start_voice_run`, `speak`, `wait_for_turn`, `inspect_voice_run`, `barge_in`, `force_socket_rotation`, `end_voice_run`, `export_voice_evidence`, `run_regression_suite`, and `get_suite_run`. A `studio-livekit-g7-v1` deployment additionally registers `start_studio_g7_run`, `studio_g7_voice_step` and `studio_g7_action`.

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

## VT00-C5 continuation qualification

The current continuation targets `VOICE_LAB_INTERNAL_USE_READY`: one installed,
authenticated plugin run with two adaptive audio turns, real playback evidence,
supported end, durable export and verified present-run settlement. Full VT00
promotion and advanced scenarios remain separate. See
[the C5-R1 checkpoint](../../docs/campaigns/vt00-voice-lab/c5-r1/current-state.md) for the current qualification
and access status. The new Gateway/receiving-auth session repair requires a
compatible pair; local tests alone do not authorize opening admission or establish
readiness. Preserve per-component pins and the existing closed/suspended posture.
