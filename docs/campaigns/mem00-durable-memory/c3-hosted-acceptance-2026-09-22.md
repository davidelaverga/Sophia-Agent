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
