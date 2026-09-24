# Current operator handover

## 2026-09-24 continuation (voice-next-20260924)

The three-run follow-up window is closed as **diagnosed; no product repair was demonstrated**. C5's historical `VOICE_LAB_INTERNAL_USE_READY` acceptance remains intact. It does not certify the J6 recognition symptom or make this test input a reliable speech benchmark. Claude's independent verdict is `ops/mailbox/voice-next-20260924/claude-013-final-verdict.md`; Codex's A-001 through A-007 handbacks are `codex-001`…`codex-007` in the same mailbox epoch. These mailbox records are coordination evidence and are not merged into product code.

- **L1 — input validity:** espeak opened 1 of 4 first turns and 0 of 2 under real-time delivery. On the Starter 0.5 CPU / 512 MB worker, the browser audio graph ran at 61% of real time with gaps of at least 300 ms. J6's French partial and missing second sentence cannot be attributed to the product from this input.
- **L2 — R2:** the effective Production frontend control adapter had not been reopened (C1), so R2 never supplied provider evidence.
- **L3 — empty-session End:** R1's supported End succeeded. R3's End returned 503 `voice_lab_canonical_transcript_invalid` after a zero-turn canonical commit; automatic recovery later proved `live_resources_zero`. That recovery is not a successful supported End. The surviving R1/R3 records both contain valid empty canonical data, so the original 503's exact invalid field remains undetermined.
- **L4 — resampler:** the microphone downsampler was unfiltered during this window. Its anti-aliasing repair is a separate product patch. No controlled comparison has tied it to J6.

J4/J5/J6 purges were verified at 2026-09-24T14:28:50.883Z. R1/R2/R3 retention remains assigned to `sophia-voice-a-007-final-purge-and-suspend` after 2026-09-25T11:19:18Z. Lab gates remain closed, MCP suspended, and the Starter worker kill switch engaged for retention maintenance. No live run, deploy, plan change, or budget reset is authorized by this continuation.

Checkpoint: 2026-09-23 20:39 UTC, closeout C088. This supersedes September22 instructions; historical failures remain archived, not current repair instructions.

C5 technical first-use criteria are met by existing J6 evidence. CI reconciliation is complete. The closeout-only scope permits the bounded executable retention disposition below; three future purges and final worker suspension are scheduled maintenance, not claimed completed. Readiness verdict is VOICE_LAB_INTERNAL_USE_READY under that approved disposition. No new live voice run, full VT00 certification, Builder campaign or migration is authorized or needed.

MCP `srv-da6uiqfavr4c739mtbng` is suspended/zero instances (last authoritative observation20:39:01Z). Worker `srv-da6uiqfavr4c739mtbo0` runs one instance (last authoritative observation20:39:02Z), deployment `dep-dapvg80u01pc73e3o900`, solely for approved retention maintenance. Its kill switch is true; product Lab gates remain closed. Ordinary Sophia runs normally. Release branch points at qualified d467ab97; no uniform-SHA redeployment is needed. Existing OAuth remains reusable.

| Component | Exact qualified identity |
|---|---|
| Frontend | `083d4cb0f6e026133ba0e08c5a61220e396d21b8` — Production `dpl_FVi7Dp1eVxKfM9UHzKZ8PdifzA1p` |
| Gateway | `6f15f5e2790941342c23d046733ee1d4992a9e0c` |
| Voice | `f128af0c5604139b3d20d10424877001b1c0a7cd` |
| LangGraph | `def5c454e665628875cbad2ffd39a21a9f72749a` |
| Lab MCP and worker | `d467ab97464908b4e7c7752701eee9d24db7faf6`, schema6 |
| Installed plugin | `0.1.0+codex.20260913232552`, SHA256 `f799c321aee48f59833918d07e4cb19d0ff2cc12ac521ea1be619affdf8b4f0b` |

J6 ran with Gateway083d4cb0; the later Gateway6f15 canonical-reader repair recovered its evidence without another run. Do not conflate run tuple and current tuple. Receiving authentication, principal separation, no-memory isolation and exact cleanup fencing remain installed.

## Acceptance and known limitations

Run `bb39a997-a819-40e6-a276-53c088055f52`; session `6710658c-905e-4ccf-9493-8eb6f5f81a0b`; test `5dd8d167-85cd-40f8-a81a-881ac2d94c0e`. Latest immutable manifest `95084ded-65de-5850-bfef-f59bf750734f`, resource `voice-lab://evidence/95084ded-65de-5850-bfef-f59bf750734f`, 77053bytes, SHA256 `bf104b67bc04ce0f00671ca48207b63216cfba79d9a2a0bd45a99f2f14712056`. Installed export and authenticated stored-byte hash readback agree. See `evidence/2026-09-23-j6-refreshed-export.json` and `evidence/2026-09-23-j6-c5-manifest-readback.json`. Original manifest6456326d and original full V-O01 verdicts remain unchanged.

| Mission requirement | Existing proof |
|---|---|
| Installed authenticated control and exact tuple | J6 start/tool responses; maintenance capabilities; expected/observed identities match |
| Real synthetic input through ordinary application | PCM event199:39frames/115908bytes; event1398:74frames/219928bytes; app-owned microphone/provider path |
| Two assistant audio replies | Exact interaction-bound audible chains15/2.6seconds and47/11.7seconds; manifest assessment |
| Semantic adaptive second turn | Coordinator assessment below plus matching source-text hash |
| Supported End | End operation32539498-1269-444b-9158-1107ce1c4227 succeeded event1624 |
| Canonical transcript and durable post-End export | Four messages/revision5; recovery1628; export after restart;1629 contiguous events |
| Present-run resource settlement | Exact provider disconnect, auth revocation, browser/context/process closure, Builderzero, closed admission/fence, proof-backed lease release; recovery1628 live_resources_zero |
| Bounds and isolation | Concurrency1,2utterances,15sclip,900srun; synthetic bindings/no-memory; no raw audio |
| Retention and suspension | Bounded approved disposition in retention-closeout.md; final execution pending |

## Coordinator semantic-adaptivity assessment

Event803 records the final first response: “I can't actually view that 'Calm Harbor' page right now. The tool isn't working. What about it did you want to talk about? I'm still having trouble getting that page to load, but I want to hear what's on your mind. What about that 'Calm Harbor' page did you want to discuss? I'm ready whenever you are.” The application marks its transcript approximate; it is not an acoustic transcription guarantee.

After inspecting that reply, the controller chose: “Let's just discuss calm. Please suggest one small way to feel calm.” The words directly answer Sophia's invitation to discuss a topic and move from the unavailable page to its calm theme. This is a semantic dependency, not just chronological ordering. SHA256 of that exact UTF-8 utterance is `918af93b0f15d580a8075c7a4fdc71b578da3dac5ae853acce1db8c0e005c879`, independently recomputed and matching `source_text_hash` in installed `2026-09-23-j6speak2.json`, operation6f2e6881-079d-45f5-b19a-624699855089. Its TTS scheduling at14:19:27Z follows inspected reply event803 at14:19:05Z. Coordinator verdict: semantic adaptivity MET. Automated ordering is supporting evidence only.

## Separate verdicts and limitations

C5 instrument witnesses: all eight machine criteria met plus coordinator semantic adaptivity met. Full V-O01 remains harness=fail, product=fail, evidence=fail; auth/provider=pass. Do not rewrite these as full certification. Product defects: turn1 missed the initial “create”; turn2 English audio was transcribed incompletely as French; repeated-intent output suppression occurred. Structural playback is proven; acoustic quality, all-chunk certification, recognition accuracy, Builder quality and endurance are not.

Full event archive: `evidence/2026-09-23-j6-events-final.json`. Operator ZIP: `evidence/2026-09-23-j6-operator-evidence.zip`, SHA256 `dfdd0fd55e7a0cd3d2030cd6a0d640fdbff028065fe4c2e05e63adf2d05db39d`; labeled collection of plugin receipts/operator verification, not a fabricated server manifest. All earlier attempt records remain in evidence/ and history/; they do not instruct another run.

## Retention disposition

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

## CI closeout

All seven backend failures are now reproduced at the actual PR151 base3754c3022bcfc2be1e3b8d097040b7d81ad23ac6 and headd467ab97 on the SAME Linux runner with identical assertions. Diagnostic run35916904466/job107370625089 used exact checkouts, Python3.12.14, uv setup, unchanged lockfile and natural runner clock. Setup succeeded for both; the diagnostic correctly finished red. Machine-checked14failure lines split into identical groups of seven: evidence/2026-09-23-c087-ci-reconciliation.json. Five memory failures are young-boot expiry handling (issue152); two deck failures are Linux layout behavior, exact layout cause unproven (issue153). Both issues are normal maintainer tracking, not waivers. No introduced failure found in this set; no source/test/check changes, force-merge or ordinary-product redeploy. PR151 remains open; failed CI remains failed. Independent Lab/architecture/memory-E2E qualification is unchanged.


## Tested next-use recipe

1. Recover current checkpoint, exact component identities, existing OAuth and current obligations; choose one deployment owner. Obtain a new bounded run authorization for a future use; this closeout authorizes none.
2. Verify release HEAD and schema6. Resume existing MCP/worker with admission closed; inspect installed `get_capabilities`, fresh worker heartbeat and obligations. Preserve separate exact target pins.
3. Open only approved gates and start through installed `start_voice_run` with discovered schema/exact targets. Wait for its exact successful ready receipt.
4. Speak a short synthetic utterance through the plugin, inspect real input/output/playback, then choose a second utterance from Sophia's actual answer. One run only; enforce approved limits.
5. Supported `end_voice_run`, inspect settlement, then `export_voice_evidence`. Verify positive resource receipts; retain original scenario and product verdicts separately.
6. Close admission/execution in established order. Frontend closure requires same-source Production rebuild with Ignore Build Step unchecked. Account for retained evidence with its exact deadlines; verify local/remote purge under the agreed bounded maintenance plan. Suspend both Labs and verify zero instances. Keep ordinary Sophia running.

## Cost

Original total Voice cap $5 remains controlling. Conservative provider aggregate valuation ~$0.350418 is delayed/rounded usage, not an invoice. Approved temporary worker compute estimate ~$0.25; no new recurring service. Raw audio off.

## Evidence custody

Full plugin responses, event archive and operator ZIP remain in the operator-local campaign directory `/Users/davidelaverga/Documents/Codex/2026-08-19/pl/work/Sophia-Agent-mem00-closure/docs/campaigns/vt00-voice-lab/c5-r1/evidence/`. Relative evidence filenames above identify that archive unless included alongside this published handover. Public handover publication does not imply public upload of the full operational bundle. The immutable manifest identity and hashes are recorded for verification.
