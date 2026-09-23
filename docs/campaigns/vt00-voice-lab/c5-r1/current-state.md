# VT00-C5-R1 current state

Checkpoint: 2026-09-23 20:39 UTC, closeout C088. This supersedes September22 instructions; historical failures remain archived, not current repair instructions.

C5 technical first-use criteria are met by existing J6 evidence. CI reconciliation is complete. The closeout-only scope permits the bounded executable retention disposition below; three future purges and final worker suspension are scheduled maintenance, not claimed completed. Readiness verdict is VOICE_LAB_INTERNAL_USE_READY under that approved disposition. No new live voice run, full VT00 certification, Builder campaign or migration is authorized or needed.

MCP `srv-da6uiqfavr4c739mtbng` is suspended/zero instances (last authoritative observation20:39:01Z). Worker `srv-da6uiqfavr4c739mtbo0` runs one instance (last authoritative observation20:39:02Z), deployment `dep-dapvg80u01pc73e3o900`, solely for approved retention maintenance. Its kill switch is true; product Lab gates remain closed. Ordinary Sophia runs normally. Release branch points at qualified d467ab97; no uniform-SHA redeployment is needed. Existing OAuth remains reusable.

## Exact identities

| Component | Exact qualified identity |
|---|---|
| Frontend | `083d4cb0f6e026133ba0e08c5a61220e396d21b8` — Production `dpl_FVi7Dp1eVxKfM9UHzKZ8PdifzA1p` |
| Gateway | `6f15f5e2790941342c23d046733ee1d4992a9e0c` |
| Voice | `f128af0c5604139b3d20d10424877001b1c0a7cd` |
| LangGraph | `def5c454e665628875cbad2ffd39a21a9f72749a` |
| Lab MCP and worker | `d467ab97464908b4e7c7752701eee9d24db7faf6`, schema6 |
| Installed plugin | `0.1.0+codex.20260913232552`, SHA256 `f799c321aee48f59833918d07e4cb19d0ff2cc12ac521ea1be619affdf8b4f0b` |

J6 ran with Gateway083d4cb0; the later Gateway6f15 canonical-reader repair recovered its evidence without another run. Do not conflate run tuple and current tuple. Receiving authentication, principal separation, no-memory isolation and exact cleanup fencing remain installed.

## Remaining work

All seven backend failures are now reproduced at the actual PR151 base3754c3022bcfc2be1e3b8d097040b7d81ad23ac6 and headd467ab97 on the SAME Linux runner with identical assertions. Diagnostic run35916904466/job107370625089 used exact checkouts, Python3.12.14, uv setup, unchanged lockfile and natural runner clock. Setup succeeded for both; the diagnostic correctly finished red. Machine-checked14failure lines split into identical groups of seven: evidence/2026-09-23-c087-ci-reconciliation.json. Five memory failures are young-boot expiry handling (issue152); two deck failures are Linux layout behavior, exact layout cause unproven (issue153). Both issues are normal maintainer tracking, not waivers. No introduced failure found in this set; no source/test/check changes, force-merge or ordinary-product redeploy. PR151 remains open; failed CI remains failed. Independent Lab/architecture/memory-E2E qualification is unchanged.


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

## Cost

Original total Voice cap $5 remains controlling. Conservative provider aggregate valuation ~$0.350418 is delayed/rounded usage, not an invoice. Approved temporary worker compute estimate ~$0.25; no new recurring service. Raw audio off.

## Evidence custody

Full plugin responses, event archive and operator ZIP remain in the operator-local campaign directory `/Users/davidelaverga/Documents/Codex/2026-08-19/pl/work/Sophia-Agent-mem00-closure/docs/campaigns/vt00-voice-lab/c5-r1/evidence/`. Relative evidence filenames above identify that archive unless included alongside this published handover. Public handover publication does not imply public upload of the full operational bundle. The immutable manifest identity and hashes are recorded for verification.
