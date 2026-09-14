# C4 retained-owner repair: service-wide fence

Status: implementation under verification; no production execution attested.

This lane addresses an already-retired non-D02 worker allocation whose original
termination receipt cannot be collected retrospectively. It does not reconstruct
a missing original-owner observation. A new source-observed service-wide restart,
closed exact-release readiness and bounded overlap evidence produce a distinct
signed receipt. Provider, auth, session and Builder settlement remain independent.
The historical exception does not apply to new failed qualification runs.

## Release and database order

1. Finish current-tree source/script typechecks, signature/controller/publisher
   negatives, secure CLI tests and real PostgreSQL fresh/upgrade/HTTP/settlement
   tests. Review all changed files. Commit and publish the exact reviewed tree;
   record its SHA and migration hashes before production actions. Preserve all
   histories and existing product/memory changes.
2. Attest automatic deployment remains disabled. Close frontend, Gateway and
   Voice product mutation gates and engage both Lab kill switches in the normal
   reverse order. Record exact old deployed identities and every unresolved
   obligation; do not equate content purge or absent run content with closure.
3. Quiesce Lab web and worker processes through the hosting control plane. Record
   their stopped state; the database operator also rejects recent worker
   heartbeats and pending accepted/queued/leased/executing operations. A closed
   kill switch alone is not quiescence. Do not erase operations to pass this gate.
4. From the built Lab directory of the exact new checkout, run
   `node dist/src/bin/service-fence-inventory.js` with protected `DATABASE_URL`
   and `SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_EXPECTED_COMMIT` matching the actual
   `RENDER_GIT_COMMIT`/`COMMIT_SHA`. It reads metadata, native catalog and retained
   inventory in one read-only snapshot, printing only hashes and status. It does
   not grant upgrade authority or attest closure. Source must be exact schema 4 with migration SHA
   `9407b1e0e881e9e497bb97e711067f304b3c323a50bf2b2302293b25561d5932`.
   Do not use the product/Supabase database for this migration.
5. Run `tools/sophia-voice-lab/dist/src/bin/upgrade-service-fence.js` from the
   built Lab directory with protected `DATABASE_URL` and these explicit inputs:
   `SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_APPROVED=YES`,
   `SOPHIA_VOICE_LAB_KILL_SWITCH=true`,
   `SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_EXPECTED_COMMIT` equal to the actual
   `RENDER_GIT_COMMIT`/`COMMIT_SHA`, and
   `SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_INVENTORY_SHA256` equal to step 4.
   This is a separate operator command, never automatic startup migration.
6. Require schema 5, target bundle SHA
   `2bf482062671be20224d442f69c16f7478f035c622e57bf67fe4ec40a550e8b2`,
   exact reference catalog and unchanged retained inventory. The operator writes
   neither a host seal nor an admission grant. Lost output is unconfirmed:
   inspect metadata/inventory before retrying the same inputs. Never rewrite
   metadata to force startup or rerun historical v3-to-v4 backfill.
7. Complete the normal exact-release closed deployment order for product services,
   then Lab worker and MCP. Current startup accepts only the v5 catalog and writes
   a v5 host seal. Require one settled worker and fresh closed readiness on all
   services before collecting a fence. Existing unresolved active count remains
   visible. Do not roll back a v5 database to old binaries by changing metadata;
   keep gates closed and forward-repair if deployment fails.

## Collect, publish, settle

Use the external-attestations CLI with private controller input, public authority
configuration, protected transport/key files and a new private journal directory.
Controller input binds the exact run/request, worker service, original raw worker
identity, Lab origin, current Lab/LangGraph SHAs and all three current product SHAs.
Never substitute the historical product pins for the current repair deployment.

- `collect-service-owner-fence` requires the Render credential and checkpointed
  signing custody. It consumes one durable dispatch and makes at most one restart
  request. Resume uses `--resume true`; an ambiguous restart never permits another
  restart. `receipt_collected` is not ingestion or cleanup.
- `publish-service-owner-fence` uses the same input, authority/key files and completed
  authenticated journal, without a Render token or `--resume`. It submits the exact
  receipt, verifies persisted proof, and can inspect a replay after settlement.
  An ambiguous submission triggers one read, not another restart. `ingested` is
  still not cleanup.
- Observe the existing retained-recovery worker joining this proof with a fresh
  authenticated canonical receipt and durable exact-attempt audit. Require exact
  lease/version settlement, canonical session/provider/auth terminal states and
  authoritative Builder zero. Export the owning evidence and confirm J01's actual
  obligation status before reopening a qualification window.

No steps waive D02 boundaries, per-run limits, historical disclosure, twenty
journeys, five canaries, fresh installed-root P01 or the canonical suite.
