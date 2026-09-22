# VT00-C5-R1 first-use evidence index — 2026-09-22

**VOICE_LAB_INTERNAL_USE_READY is not yet achieved.** The installed-plugin attempt ran, but did not produce an assistant response. Current run is fully settled and its failure export is available.

| Required evidence | Current evidence / gap |
|---|---|
| Installed authenticated controller | Exact installed plugin get_capabilities/start/speak/wait/end/export recorded in `evidence/2026-09-22-first-attempt.json` |
| Exact compatible tuple | All four product identities verified before start and after MCP reclosure; full hashes in `current-state.md` |
| Authenticated synthetic session start | Passed through ordinary deployed app; run4e79cd35-5d99-4ea2-998b-1cee97066bcd, session4ffcf9ca-693d-467b-9353-57274359ae21 |
| Two adaptive turns | Not passed: first produced no response, second withheld |
| Actual input PCM |48frames,142656bytes,71328samples,58956nonzero; product receipt157 plus harness frame hashes |
| Provider output and playback | Missing; no transcript or assistant audio observed |
| Supported normal End | Failed PROVIDER_CLEANUP_UNCONFIRMED; local repair in progress |
| Durable failure export | manifest30f031cc-44de-5968-a251-06d7a5a9fa51, SHA2567179e02f8391898ec4462c6676762317f6b0022be54d927d808b7d3b4e3a0262 |
| Current resources | Recovery event206 confirms authoritative live zero; browser204, exact lease-release207; export cleanup_complete=true |
| Service closure | MCP kill switch engaged15:55:25Z; both Lab services verified suspended16:02Z; final product-gate closure outstanding |

Settlement and export receipts: `evidence/2026-09-22-first-attempt-settlement.json`.
Plugin manifest resource: `voice-lab://evidence/30f031cc-44de-5968-a251-06d7a5a9fa51`.
Evidence retention expires2026-09-23T15:49:04.758Z. No raw audio/video captured.
Automated verdicts: authpass, harnesspass, productfail, evidence/providerunavailable. These scenario verdicts are distinct from the successful durable failure export and cleanup; harness readiness remains unproven because basic audio is missing.
Historical accepted inventory remains unverified, unchanged, and separate from this run's positive settlement proof.
