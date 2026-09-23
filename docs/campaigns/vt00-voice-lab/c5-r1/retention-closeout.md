# Bounded retention closeout

Checkpoint: 2026-09-23 20:39 UTC, closeout C088. This supersedes September22 instructions; historical failures remain archived, not current repair instructions.

The five obligations from the original closeout request are below. A1 was already positively purged locally/remotely; A2/A3 are now also confirmed. All five have positive live-resource settlement; retained content is a separate obligation.

| Run | Exact deadline UTC (2026) | Rome | Present result |
|---|---|---|---|
| A2 `a2a9308c-1ee8-43d8-8798-6fdbfb6ca02a` | Sep23 16:41:16.942 | Sep23 18:41:16.942 | Local16:41:17.074Z; remote confirmed |
| A3 `c31c0117-0e95-4374-9981-762eeebe9716` | Sep23 17:09:33.731 | Sep23 19:09:33.731 | Local17:09:33.899Z; remote confirmed |
| J4 `6a05f180-0d8d-44d5-b08b-422c8c8526e1` | Sep24 08:39:46.775 | Sep24 10:39:46.775 | Retained; not yet due |
| J5 `d356836c-269d-42c9-9599-233a0c790a87` | Sep24 13:27:55.991 | Sep24 15:27:55.991 | Retained; not yet due |
| J6 `bb39a997-a819-40e6-a276-53c088055f52` | Sep24 14:20:06.803 | Sep24 16:20:06.803 | Retained; not yet due |

Storage and ownership: Lab PostgreSQL stores run content, events, operations and evidence artifacts under `sophia_voice_lab`; the worker's `maintainSessions` calls `purgeExpiredRetention` and deletes expired run content through the schema's cascades. Separate recovery controls and HMAC tombstones survive for bounded recovery/audit. Product storage targets are canonical synthetic sessions/messages, immutable finalization receipts and any Builder artifact metadata/objects in the existing product stores. Gateway’s restart-safe retention worker discovers those three indexes, obtains its PostgreSQL advisory lease and reuses exact recovery before deleting raw identity. Cleanup runs independently of enable/kill gates. Product canonical/session evidence is owned by Gateway retention/recovery machinery; authenticated exact-session recovery verifies its disposition. The worker records remote confirmation only from a verified purge/maintenance-complete receipt. Local deletion alone is insufficient. No raw audio was retained. The local operator ZIP is an explicitly labeled evidence export, not a live provider or server-retention substitute.

Approved executable disposition: keep only the existing worker running with kill=true and all admission closed, under the original total $5 cap, through the final existing deadline. No deadline extension, new session or historical exception. One-time thread automation `finish-voice-lab-retention-and-suspend-worker` was actually created and read back, scheduled Sep24 16:25 Rome. Revalidate it before relying on it. At closeout, use authenticated read-only worker-shell queries to join exact run recovery controls with retention tombstones. Require `content_purged_at`, `remote_purge_complete=true`, `remote_purge_status=confirmed`, and recorded settlement receipt hashes for J4/J5/J6. Export/inspect through the installed MCP if already available; do not wake it merely to replace adequate authoritative readback. Then suspend worker via Render and verify both Lab services suspended with zero instances. If proof is missing, bound investigation, suspend to prevent indefinite spend, and report the exact unresolved obligation. Never infer purge from an empty run list or expired lease.

Authoritative receipts: `evidence/2026-09-23-a1-retention-confirmed.json`, `evidence/2026-09-23-a2-a3-retention-confirmed.json`; remaining inventory observed18:35Z. Historical136 quarantined/136accepted and one Gateway accepted pending remain unverified and excluded.

## Evidence custody

Full plugin responses, event archive and operator ZIP remain in the operator-local campaign directory `/Users/davidelaverga/Documents/Codex/2026-08-19/pl/work/Sophia-Agent-mem00-closure/docs/campaigns/vt00-voice-lab/c5-r1/evidence/`. Relative evidence filenames above identify that archive unless included alongside this published handover. Public handover publication does not imply public upload of the full operational bundle. The immutable manifest identity and hashes are recorded for verification.
