# Worker investigation — 2026-09-21

Conclusion: the replacement worker is alive and runtime-ready with correct
product pins. The MCP rejects its heartbeat because MCP still expects the old
pins. A worker startup crash or pin-induced failure is not supported by the
evidence. No restart, configuration mutation or source repair was performed in
this investigation.

## Authoritative observations

Render's worker shell selected instance
`srv-da6uiqfavr4c739mtbo0-5986f8b476-64x9g`. The live deployment link is
`dep-daop3k6gekts73efokj0` at source
`2deb762a7a03ca7f260ec2efd670b5993f7dc977`.

In that existing shell, a bounded SELECT used the existing database connection
with PostgreSQL default_transaction_read_only=on. No secret was printed and no
database mutation or model/provider operation occurred. Result:

| Field | Observed value |
|---|---|
| worker_id | srv-da6uiqfavr4c739mtbo0-5986f8b476-64x9g |
| booted_at | 2026-09-21T20:22:28.175Z |
| observed_at | 2026-09-21T20:41:22.225Z |
| heartbeat_sequence | 564 |
| browser_ready / fixtures_ready / tts_ready | true / true / true |
| effective_kill_switch_engaged | true |
| worker_boot_id_sha256 | 0318ae5ceb19692278a8afd4f811f1a60b2b5c3fc90dae1e801750d7a678bf3d |
| worker_instance_id_sha256 | 137cf9910c1764a24273796c0c6320a5c9fa6ce14d0d19b54a510cf49f6e8e92 |
| deployment_identity_sha256 | 03d86985fef200f5d7e434bda8978e33de925c58d7d92cd659b5a89a9eeca61d |

The current worker's loadConfig plus workerDeploymentIdentitySha256 computed
that exact identity. It loaded frontend a5982c6e57efde05311a6add245e0258693f1471,
Gateway/LangGraph406ff0a6f9d64c04bbfd55ae1ea87b5a559cf490 and
Voice5538d08b20a4cfed29e85e61abdffd4c22af6ce8. Source/repository candidate2deb762a
is unchanged. The worker is closed, matching the user's diagnostic redeploy.

## Why the logs were misinterpreted

Render logs show these DIFFERENT instance suffixes (times are CEST):

| New worker startup | Later ELIFECYCLE line |
|---|---|
| 21:47:52, 4p4h8; migrations done21:47:55 | 21:48:50, **vg8pw** |
| 22:22:21, 64x9g; migrations done22:22:24 | 22:23:18, **4p4h8** |

The exit lines belong to predecessors. They do not establish that either new
worker failed on startup or hit a55-second startup timeout. Shutdown is the
consistent interpretation; exact exit cause was not reconstructed. The fresh
database heartbeat independently proves the latest replacement is running.

## Why MCP readiness hides the healthy heartbeat

At deployed2deb, http-server.ts:141 queries listLiveWorkers with a10-second
cutoff; postgres-ledger.ts:765 enforces observed_at >= cutoff. The endpoint's
cache is5seconds. Repeated live_workers=1 cannot be explained by a three-day-old
row. assessWorkerReadiness nulls the attestation and observed gate when validation
fails; null therefore does not prove worker death.

worker-heartbeat.ts validates the identity against MCP's configuration using the
OBSERVED worker gate. Thus opposite gate settings alone do not cause
heartbeat_deployment_identity_mismatch; the unequal expected product pins do.
The worker probes browser/TTS readiness under either gate setting.

## Next step

Do not revert correct pins or repair a hypothetical startup defect. Keep MCP
admission closed until ordered activation resumes: open worker execution at
source2deb with the current pins, verify its new exact open heartbeat via the
same bounded read-only lane, then apply matching MCP pins and open MCP last.
Require full authenticated readiness before the one installed-plugin run.
Deployment actions still use the existing authorized/manual controller route;
this investigation does not bypass the recorded Production Deploy denial.

Resource settlement and first-use readiness remain unproven. No new live run
was created by these diagnostic reads; historical exceptions remain unchanged.
