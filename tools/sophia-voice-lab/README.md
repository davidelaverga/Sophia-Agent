# Sophia Voice Lab

Sophia Voice Lab is the isolated VT00 execution and evidence plane. It exposes a private Streamable HTTP MCP endpoint and runs browser work in a separate Playwright worker. It drives the ordinary deployed Sophia UI, injects governed synthetic media before application code loads, and stores the run ledger, leases, operations, events, manifests, and bounded evidence bytes in Postgres. It does not duplicate the Sophia voice runtime and never calls Gemini directly.

The canonical campaign contracts live in [`docs/campaigns/vt00-voice-lab/`](../../docs/campaigns/vt00-voice-lab/). In particular, see the [runbook](../../docs/campaigns/vt00-voice-lab/runbook.md), [scenario catalog](../../docs/campaigns/vt00-voice-lab/scenario-manifest.md), [threat model](../../docs/campaigns/vt00-voice-lab/threat-model.md), and [deployment gates](../../docs/campaigns/vt00-voice-lab/deployment-gates.yaml). This package's executable catalog is [`scenarios/manifest.json`](scenarios/manifest.json), version `vt00.scenarios.v1`.

## Processes and durability

- `web` serves `/mcp`, `/healthz`, `/readyz`, `/version`, and durable evidence resources. It is stateless apart from Postgres.
- `worker` owns browser leases, executes queued operations, drains the generation-aware product capture cursor, refreshes short-lived run context, finalizes through the ordinary product boundary, and performs idempotent out-of-band recovery.
- `migrate` applies the centralized SQL under a Postgres advisory lock. It is safe to run before either process starts and safe to run repeatedly.
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
web:    node dist/bin/migrate.js && node dist/bin/web.js
worker: node dist/bin/migrate.js && node dist/bin/worker.js
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
