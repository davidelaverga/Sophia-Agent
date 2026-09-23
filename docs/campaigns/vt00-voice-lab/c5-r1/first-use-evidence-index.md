# J6 current first-use evidence index

Checkpoint: 2026-09-23 20:39 UTC, closeout C088. This supersedes September22 instructions; historical failures remain archived, not current repair instructions.

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

All seven backend failures are now reproduced at the actual PR151 base3754c3022bcfc2be1e3b8d097040b7d81ad23ac6 and headd467ab97 on the SAME Linux runner with identical assertions. Diagnostic run35916904466/job107370625089 used exact checkouts, Python3.12.14, uv setup, unchanged lockfile and natural runner clock. Setup succeeded for both; the diagnostic correctly finished red. Machine-checked14failure lines split into identical groups of seven: evidence/2026-09-23-c087-ci-reconciliation.json. Five memory failures are young-boot expiry handling (issue152); two deck failures are Linux layout behavior, exact layout cause unproven (issue153). Both issues are normal maintainer tracking, not waivers. No introduced failure found in this set; no source/test/check changes, force-merge or ordinary-product redeploy. PR151 remains open; failed CI remains failed. Independent Lab/architecture/memory-E2E qualification is unchanged.


## Evidence custody

Full plugin responses, event archive and operator ZIP remain in the operator-local campaign directory `/Users/davidelaverga/Documents/Codex/2026-08-19/pl/work/Sophia-Agent-mem00-closure/docs/campaigns/vt00-voice-lab/c5-r1/evidence/`. Relative evidence filenames above identify that archive unless included alongside this published handover. Public handover publication does not imply public upload of the full operational bundle. The immutable manifest identity and hashes are recorded for verification.
