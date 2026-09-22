# MEM00-C3 post-deployment acceptance — 22 September 2026

Status: IN PROGRESS, not MEMORY_TEXT_PILOT_READY.

Frontend b103c4afb8da032c2f4169d7a40e89be96a2433b (code ef12097b) is Production deployment dpl_vj3NWuHsv4uf1iT5HjDJWsfLCGj8, ready 09:40:46Z. Dashboard current domain and loaded ordinary-app asset IDs independently agree. User renewed deployment approval; normal authenticated dashboard operation succeeded. No backend restart in that window. See C3-0018.

## First post-deploy journey

Owner: CUyZxRFmDNONbR0eKqkJjTrJ2z8nkDKd. Session ae44c514-a22a-43bc-a8a4-a48f4275150c, thread 01a0c883-e50e-7770-9179-953cbcc31833. Selected Grounding, then text; telemetry confirms voice_mode_false, zero microphone streams/tracks, no Voice or Builder run. Prior resumable a8636ea6-5f8a-4f26-9189-fa42f1c0c430 (zero messages) remains untouched.

Automatic recall run 01a0c884-65b6-7b62-bf08-3286037c1639:
- User: Do you remember how I prefer summaries to be formatted? Please answer in one short sentence.
- Sophia: You prefer short bullet-point summaries over long prose, especially for technical topics like Tin Otter.
- Exact-owner authenticated state: next=[], tasks=[]; retained/retrieval manifest a9352106-8ee7-43aa-8a7b-881f3b613219 revision1/governance1, epoch5.
- Message d56fc532-227c-4c6f-9e9b-c54189ed9132, row dfd853fb-ae77-5f7e-ba37-951a008bfe3e: recorded and persisted source version a90bc773-4a23-4412-9fee-c52c1da00849 agree. created_at 2026-09-22T09:48:31.762530Z, sequence1. The deployed timestamp repair is effective.

Explicit retrieval run 01a0c885-1d45-7f63-b212-5e23532d57f7:
- User: Please search your saved memories using the memory retrieval tool for my summary-formatting preference, then tell me briefly what the saved record says.
- Real retrieve_memories tool call toolu_01SDvobjrqQPCLzFe9aU63an; ToolMessage dbd56a28-5d72-4e73-9602-6aadb18e7e30 returns the exact approved preference text.
- Sophia: That's what's saved: you prefer bullet-point summaries for technical topics, specifically Tin Otter and related stuff.
- Completed checkpoint next=[], tasks=[]; revision1/governance1 manifest. Source message3d30365d-8a63-402f-b234-937fd8600684, rowd48ed366-985a-5354-af34-3699ade7ebbc, versiondb8d855e-7fe4-47b0-a0cb-4fb131f595ec agrees with persisted row; created_at09:49:18.876127Z, sequence3.

Model usage from the actual checkpoint: Haiku4.5 model calls input/output 12714/356, 13118/56, 13212/368. Cache creation/read 12711/0, 404/12711, 92/13115. Conservative model-only charge using $2/M input (all tokens charged as extended cache writes) and $5/M output: under $0.09. Source: https://platform.claude.com/docs/en/about-claude/pricing refreshed Sept22. This is not a provider invoice or total infrastructure/extraction cost. Reserve $1 against earlier unquantified diagnostic/extraction and $1 against infrastructure/remaining extraction; no recurring spend authorized; $5 NEW ceiling persists.

## E4 blocker and repair

Journal edited ONLY registered synthetic a9352106. Canonical revision2/governance2 updated09:51:03.827955Z:
Synthetic MEM00-C3 test preference: summaries about Tin Otter should use exactly two numbered sentences, with the label Amber Finch. This is disposable acceptance-test data, not a real personal preference.

Next input did not repeat that content: I updated the saved test preference in Journal. Please retrieve its current version and tell me the required summary format and its label.
Run01a0c887-16ef-7ac0-98db-4fc5dbbf5ca1, created09:51:31.836750Z, failed09:51:34.596483Z before_agent. Actual receiving logs406ff0a6 report transition rotate/included_memory_revoked, then entry_denied at memory_context.py:298 in rebuild_plain_chat_sources, final_dispatch_permission=false. State retains only the previous three model calls: no new model invocation on this failure. The old version was correctly fenced, but useful warm continuation failed.

Structural read: title is nonneutral; otherwise disallowed nonempty fields are previous_artifact, current_artifact, active_ritual, ritual_phase. These are ordinary companion-generated channels. Recovery classified them as unknown/task-bearing state. No arbitrary state/SQL rewrite was performed.

Narrow local repair clears these known derived fields in the reconstructed model view after exact whole-checkpoint and recorded-source verification. Historical checkpoints, transcript, Journal, Builder task/result/artifact channels and unknown extension fields are preserved or remain held. Tests fail before the repair, pass after it. Twelve compiled graph cases include edit/forget, tampered checkpoint, changed source, Builder state, unknown state, and native retained files. Combined focused runtime/provenance/dispatch checks:201 passed. Deployment/retest pending.

Supported End requested for ae44c514 before backend deployment; durable settlement pending verification. Active synthetic memory revision2 remains an explicit cleanup obligation. No forget yet. Do not extend historical cleanup exceptions to this run.

Browser content.export is unsupported in this IAB. This file is a durable transcription of directly observed UI and authenticated safe receipt fields; do not claim a native browser export file.

## Closure on the repaired deployed tuple

LangGraph exact commit 63d9810ebd567c8a6d79a8b789a838385bd12a68 deployed through the existing authenticated Render dashboard, Deploy Specific Commit. Service srv-d7be5s9r0fns7397l4fg, deployment dep-dap559h42hec738uifk0, started 10:04:22Z, duration 2m32s, dashboard Deploy succeeded / Live. No environment, branch, scaling, or auth changes. Gateway and frontend were not redeployed. The new ordinary authenticated session and owner-scoped GET /state 200 exercise receiving compatibility. Startup logs show AsyncPostgresSaver; the local_dev API label does not mean checkpoints are only in RAM. Startup also emitted a YAML scanner warning and a Deck-quality reporting 403; neither prevented this memory journey, and neither is silently declared fixed.

Previous ae44c514 settlement: ended 10:00:30.234967Z, extraction b2109e92-269a-4d52-a07d-12661e57574f succeeded_nonzero on attempt5, candidate 00cadf43-d467-4e81-8e86-acd3afa4b093 rejected through recap at10:04:02.024799Z; zero saved. Historical error_code remained on the successful extraction row.

New ordinary text session d789b614-5804-48ed-94e1-4b6e56288e8b / thread01a0c899-0eeb-7653-9f4c-3485c6892d4b. Actual accepted source owner equals the verified sole governed cohort owner. Grounding then text; zero microphone streams/tracks and voice_mode_false. No Builder task was dispatched. emit_artifact calls below are ordinary companion insights.

1. Run01a0c89a-11ee-7a33-9755-4c90fd11144e: ask to retrieve current saved synthetic Tin Otter summary format/label without repeating either. Sophia returned exactly two numbered sentences / Amber Finch. retrieve_memories call toolu_01SnwC9SK8SsdzWmZ5PRZc26, output e90ccbfe-e160-4858-b538-d5341f5f9524. Both physical-model permits include revision2/governance2, epoch6: events84273344-8c5f-400b-b3f0-d8eb8bcc9de7 and de0e05e9-5665-487d-b624-7f2427cab624, accepted10:12:30.678897Z and10:12:46.238756Z. State completed next=[]/tasks=[].
2. Through Journal Edit, change only a9352106 to: Synthetic MEM00-C3 test preference: summaries about Tin Otter should use three short bullet points, with the label Silver Wren. This is disposable acceptance-test data, not a real personal preference. Event378f8811-a3a2-41a7-9037-3b032d4f61a1 committed10:13:40.093653Z, revision3/governance3, epoch7. Warm input asks current format/label without saying Silver Wren. Run01a0c89c-08ef-76a1-8454-44e0627cfa02 completes; actual reply three short bullet points / Silver Wren. retrieve_memories toolu_01MGF3uGEZuvhBWAVLs6Ks58, output1eff73ab-a042-4eca-9ff2-76dfceb996b6. Both final permits include ONLY3/3: events3d97926b-1650-402c-9070-a352d3982b47 and693d68d1-da42-4040-9f16-c4150754c5d5, accepted10:14:40.744962Z /10:14:58.097818Z. Model-view recovery receipt has2 verified independent user sources, zero retained tasks, scope model_view_only. Current state contains no Amber Finch, and includes Silver Wren. Old assistant/tool context was discarded; UI historical conversation remains inspectable.
3. Through Journal Forget, same memory becomes forgotten revision3/governance4, epoch8 at10:15:49.627026Z; eventc0ff3a13-b035-475a-b264-8251f2a4da51. This is recoverable governed forgetting, not hard deletion; sophia_memory_tombstones has no row for this soft-forget action. The lifecycle/revocation event supplies the fence. Next warm run01a0c89d-ca60-7fe1-b40c-848fd66e8dd7 requests current saved memory and asks not to reconstruct it. retrieve_memories toolu_01X5vcLKqAD1gqWbCuKSqgGi returns No relevant memories found (ToolMessage0c3f3790-4707-42f5-8323-7d9dd3849ae4). Sophia says no saved memory is currently available; neither marker is repeated. Completed next=[]/tasks=[]. Recovery receipt3 independent user sources, zero retained tasks; both Amber Finch and Silver Wren absent from entire current state. Final permits8b0bf4c1-35fb-4059-9c72-b8896f10ebf7 and a911cbd3-f0e3-43f0-b695-76cb38881c63 at10:16:34.992094Z /10:16:50.854916Z have authorized_manifest=[], epoch8. The immutable permit field dispatch_observed=false is not delivery proof; actual completed model/tool messages and UI output provide execution evidence. The recovery receipt itself also does not grant dispatch; the separate final permits do.

Accepted source rows remained stable across all three turns:
- messagea5ce48c5-0ebb-49be-b948-566d849efed5 / rowb0f19857-60d7-54e5-a0e4-d77d8c67c0df / version49d4a547-9fcf-4777-9136-e415be71b9f7 /10:12:12.442249Z /seq1.
- message51619083-06a6-45f5-8b69-8c9e984dfb87 / row9796a485-cf12-5437-8797-af9268870bf2 / version1f7973a5-3bbc-4067-8199-dd9e2e78ab6f /10:14:21.042527Z /seq3.
- message990efcd5-75e5-43f7-878f-c165a4289e9a / row363231be-5871-58c3-8c4e-ea90a998f68a / versiona6a54f4b-26ce-4fa6-b64c-f0d4d734baf6 /10:16:15.844098Z /seq5.

Current-run settlement: supported End committed10:17:41.019346Z. Extraction3cc59cd9-d3a3-4813-ba75-5c707c2c0d06 succeeded_zero, attempt1, no_candidate, error_code null. Reloaded recap agrees no new memories; COMPLETE reports review completed /0saved. Reloaded Journal active shelf is empty. Only unrelated resumable a8636ea6-5f8a-4f26-9189-fa42f1c0c430 remains (zero messages); no current test session remains open.

Projection of revision3: jobdb19cdae-86be-4336-8ee5-5703bd5684b3 direct_write_verified/provider_metadata_verified at10:13:43.084852Z; bindingb90ad02d-08cc-4f56-8c90-3a99d426ccfe, providerIDc9cc9e0a-026a-42c8-b2cf-5b2a4ce77b40. Revision2 providerID02f332af-1c35-4039-8eca-d432d135df60 and revision1 providera0459518-ed8e-4850-b101-1db0e0e9b0f1 are exact prior effects. Purge job98fd5923-b91b-47ff-a41c-bf27ea4f3424 completed10:15:51.913300Z with purge_verified/provider_rows_absent. All three bindings purged. The installed adapter verifies absence using post-delete pagination before emitting this receipt; this is a current-run physical-effect receipt, not an inference from empty queues. Canonical forgotten history remains intentionally recoverable.

Owner extraction inventory after settlement:24 total =8 succeeded_nonzero,6 succeeded_zero,5 superseded,5 failed_terminal; zero active processing states. Five bounded historical failures remain, including the earlier takeover failure50cfec91; no retry budget reset. Owner-scoped pending projection query empty; this does not clear the two separately registered historical uncertain provider operations. Their exception is not extended to these current-run effects.

Six model calls in the final session: input/output12746/72,12881/404,12772/82,12916/422,12751/83,12850/592. Conservative all-input $2/M plus output $5/M < $0.17. Combined measured post-deployment model costs < $0.26; with the $2 reserves described above, conservative new-work estimate < $2.30, below approved $5. Exact invoice totals unavailable. No further paid retry or recurring commitment is needed.

Product wording limitation: after forget, Sophia correctly reports no saved memory but speculates about authorization lapse/session scope and offers to inspect earlier chat. The actual model view excludes earlier memory-derived outputs. These speculative explanations are not architecture facts; keep as a follow-up UX defect, not proof of leakage or retention.

Provider-hit/admission joins from the actual owned acceptance interval: automatic admissiona986b8a6-060b-4894-9eca-60f72b21eaa5 and explicit26f46b40-9b44-4d34-92ac-4a13538d4743 saw2 provider hits, rejected1 inactive projection, admitted only2/2. After edit, automaticcb9af9db-0aba-4a91-a9e2-1d8629c850f1 and explicitcf8731c9-1601-4c8f-9064-885f3a4ff914 saw3 hits, rejected2 inactive projections, admitted only3/3. After forget, automatica884806d-913c-4354-a4ea-adb4f6875fe0 and explicit248c953c-cb4f-4528-a1ee-8c88cbfb64ef both saw0 hits/empty manifest. All provider_status=ok. Exact current binding/revision joins are recorded above; raw numeric ranking scores were not persisted in these admission receipts and are not claimed independently captured. This single-eligible-memory case proves stale-hit rejection and current selection, not multi-memory ranking quality.

Reloaded Forgotten shelf displays both registered test records and Restore controls; no hard deletion was performed. Product-head GitHub Memory Highlights E2E run35713828515 succeeded; draft Unit Tests35713828412 and Architecture35713828592 skipped. Local qualification and independent-review status remain separate.
