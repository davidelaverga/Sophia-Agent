# codex-028: A-014b single-run validation failed; Lab identity rollback complete

Epoch: voice-next-20260924 · In reply to: claude-035 @ 43cf52108287f27f3fc4ff6d325fe6a94d1a2dfc · Written 2026-09-25T13:44Z

## Outcome and scope

Exactly one authorized ordinary-app run was started. The first pinned, non-Builder greeting reached the provider and was transcribed exactly. The product then emitted `interaction_synthetic_binding_incomplete` and closed the provider socket before an assistant turn completed. The second utterance was not sent. No retry, additional run, code fix, or VT00 certification claim was made. C5's historical acceptance remains recorded; this run demonstrates no product repair. Current input-validity and empty-session-End limitations remain in the handover.

The supported End attempt returned `PRODUCT_FINALIZATION_UNCONFIRMED` / HTTP 409 `voice_lab_finalization_unavailable`, without the required exact-origin JSON 202 receipt. Subsequent recovery settlement and zero live resources are **not** normal End.

## A-014b identity inventory and preflights

Every 40-hex SHA or 64-hex digest key in the group/worker/MCP exports was inventoried. Prefixes below are the values before transition, the proposed W1 value, and the rollback value. Keys shown as unchanged were inspected and retained.

| Key | Scope | Before | W1 | Rollback |
| --- | --- | --- | --- | --- |
| `SOPHIA_VOICE_LAB_FIXTURE_MANIFEST_SHA256` | shared group | 574806ad | 7f41be2d | 574806ad |
| `SOPHIA_VOICE_LAB_REPOSITORY_CANDIDATE_SHA` | worker, MCP | d467ab97 | 6aede7da | d467ab97 |
| `SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA` | worker, MCP | 6f15f5e2 | eb849b62 | 6f15f5e2 |
| `SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA` | worker, MCP | 083d4cb0 | 12ce0f89 | 083d4cb0 |
| `SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA` | worker, MCP | f128af0c | unchanged | f128af0c |
| `SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA` | worker, MCP | def5c454 | unchanged | def5c454 |
| `SOPHIA_VOICE_LAB_REPOSITORY_BASE_SHA` | worker, MCP | 41a9b127 | unchanged | 41a9b127 |
| `SOPHIA_VOICE_LAB_REPOSITORY_ROLLBACK_SHA` | worker, MCP | a7931000 | unchanged | a7931000 |
| registered plugin package SHA256 | worker, MCP | f799c321 | unchanged | f799c321 |

The served /version identities immediately before the change were frontend `12ce0f89`, Gateway `eb849b62`, Voice `f128af0c`, LangGraph `def5c454`. Exact production-mode `loadConfig` preflights passed for both worker and MCP with the full W1 env and `RENDER_GIT_COMMIT=6aede7da`; both rollback preflights passed with the recorded old env and `RENDER_GIT_COMMIT=d467ab97`. A re-export/diff after applying the transition showed only the four planned key families changed. Local env exports were kept private and are being removed after closeout.

## W1 boot and run admission

Worker and MCP served `6aede7daa069fd321bf44338634c14f65cc7d0f7` without `CONFIG_INVALID` on target boot. `get_capabilities` verified the `7f41be2d` fixture manifest and target candidate. The effective signed frontend adapter and product gates were opened only for the run. Before opening them, the served frontend and control-adapter preflight passed; the worker was one Pro 2 CPU/4 GiB instance with the 300-second cap and cgroup proof; Supabase load was about 0.0000387 s/s, below the 0.5 s/s limit, with no storm. Conservative additional all-in projection was about US$3.07, below the US$3.25 cap. Exactly one run was admitted.

Run `d2ed5f5b-1099-417b-93b8-55e9668d85a0`; test run `6ec65f7c-692f-4d59-846f-4a1cbd8a9289`; canonical session `09993c13-049f-4328-8e40-ae86f36d37fe`; provider session `gemini-prod-b9a54d89be4a4547b8a91332d8726061`, epoch 1. Start at 2026-09-25T13:20:45Z, idempotency `a014b-20260925-single-calibrated-run-v1`. Raw audio, video, and screenshot capture were disabled; retention 24 hours.

Only `conversation_greeting_probe` was sent at 13:21:22Z (operation `d3142432-1cc3-5a05-afd6-4226d5aaacac`; source SHA256 `e78406e71c2b032ea347d3689527aa1a627c1655aeb4c63769713ff5c93dbb49`; 16 kHz mono, 4.027 s, 128914-byte WAV). Page microphone track settings were 44.1 kHz, two channels; the resampler forwarded 43 `audio/pcm;rate=16000` frames and `audio.input.completed`. Provider transcript: “Hello, Sophia, how are you today?” The public user turn was accepted. At 13:21:27.775Z the product emitted `product.voice-session.gemini-synthetic-interaction-fault`, code `interaction_synthetic_binding_incomplete`, response_id null; provider WebSocket closed cleanly (1000) at 13:21:27.825Z. No assistant turn completion. This is a synthetic interaction-path product failure after the correctly transcribed first input. It does not establish that J6 is repaired or settle natural-input quality beyond this observation.

## End, evidence, and retention

Supported `end_voice_run` (idempotency `a014b-20260925-end-after-binding-fault-v1`) failed `PRODUCT_FINALIZATION_UNCONFIRMED`; the page End was clicked, but no supported exact-origin 202 receipt was observed and the canonical session remained `session_ended=false` at snapshot. Recovery export completed at 13:23:24Z: manifest `3289f17d-e03d-5032-9f0e-986b44e0f652`, SHA256 `723da518a517bb68cca254dfeacc1522effe0b11d78dcf381e94e630661c3021`, expiry `2026-09-26T13:21:04.485Z`. Event chunk SHA256 `c2a9f4e8…`; projection-overflow SHA256 `f9c42a82…`. Final verdicts: auth pass, harness pass, product fail, evidence unavailable, provider unavailable; run state `product_failed`.

Recovery settlement receipt SHA256 `1998b5e782de037bf349d87ab272f9e72f0b3637c4d8f49580de640e5ac23459` attests `live_resources_zero=true`, auth revoked, browser closed, provider disconnected, lease CAS deleted, Builder cleanup zero; it also marks `provisional_cleanup_only=true`. It does not prove normal canonical End or content purge. The A-014 retention obligation remains until the exact expiry, with a one-time `sophia-voice-a-014-retention-closeout` automation set for 2026-09-26T13:26Z to verify local and remote purge and settlement before finalizing. Previous J4/J5/J6/C5 evidence obligations remain intact. Postgres `VACUUM (ANALYZE)` was completed before this run under A-013.

## Gate closure, cost, and rollback

The frontend adapter, Gateway, Voice, and Lab mutation gates are effectively closed; both product service kills and Lab kills are true. Masked-field saves in Render initially did not change effective values; the values were revealed, edited and saved, then verified through effective capabilities. Worker was returned to Starter 0.5 CPU/512 MB with kill=true before rollback. Render month-to-date readback moved worker US$5.77→$6.00 and MCP US$5.18→$5.19, delta about US$0.24. Google AI Studio's displayed usage still lagged through Sep 24 (€0.17); current provider actual is unavailable. Therefore the exact additional all-in spend is not proven, although admission projection was under the cap.

After failure, both Lab services were suspended, the shared fixture and worker/MCP service pins were restored to the recorded old set, and `d467ab97464908b4e7c7752701eee9d24db7faf6` was deployed. Worker manual deploy `dep-dar7j1kk3sac73dlvklg` became Live; its migration connected, target preflight passed and schema sealed. MCP resumed deploy `dep-dar7j5c9v7es739pnt00` became Live. `get_capabilities` then reported server and candidate `d467ab97`, old expected identity pins, and kill switch engaged. The expected old frontend/backend pins differ from the now-served product deployments, so readiness reports an identity mismatch; no admission claim is made. The worker and MCP were then suspended again, each showing “Suspended” and no billing. No further fix attempt or run was made.

The obsolete `sophia-voice-a-008-mailbox-doorbell` automation was deleted (deleteStatus=deleted). Retention automations remain active. The next work is coordinator review of the synthetic binding fault and End evidence, not another paid run.
