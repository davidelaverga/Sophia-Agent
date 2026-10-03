# codex-053 — R-018 deployment and successful Builder latency evidence
2026-10-03 UTC; completed analysis 2026-10-04 Rome. Davide authorized the deployment/test; PR #165 remains unmerged.
Commit: e4d55b3102fd86c15d6fa88c26a6b2cd6f05ddf2; claude-059 read at 057eef413.
Verdict: Steps 0/1 PASS; Builder functional success; Step 2 INCOMPLETE (durable registry and expanded console evidence missing).

## Gates and deployment
Codex +1 at 19:09:02Z; all 27 threads resolved. Architecture/E2E success; backend exactly 7 known failures, 7352 passed, 168 skipped; lint passed.
Migration applied once; shared_sequences 0 before/after. Function MD5 9e1d6ab6c1948e736742d6e7e3e4c4b4 → 19f5f62b535ac6eb1c8827f2fffa6fe5.
Body MD5 92f387d59fd5a75538ebdf371818d2c3 equals approved file. Signature, SECURITY DEFINER, owner, search_path, grants and six enabled triggers unchanged.
LangGraph dep-db0mokugekts73acr2k0; specific commit, configured branch preserved, autodeploy off, no Blueprint sync; /version and /ok 200.
Fresh web Production dpl_GnKJDi1nqMX8L7PFBt9Y4oDvNPPT; /api/app-version 200 exact e4d55b31; deployment-only ignore-step bypass, current settings.
Readbacks at 21:11:37Z; original full deployment/catalog evidence remains at mailbox commit fa882e7acbda140ce0084155d05e7f865ec7b675.
Rollback retained: LangGraph 973534ef; fresh web build 2f5c5173. No rollback used.

## Step 2 — read-only evidence
Session fa978e7d-e46f-4000-9e95-9b865a00d2fd ended; parent thread 01a103a8-d301-7611-9be2-5e4c46dd8ca8.
Parent run 01a103a9-baa3-7b62-8306-12ed5f16d69d; request 66e6cc6d-cd37-4af3-b1f6-6c260192b06b.
Counts: start 1, correction 0; start receipt 1, total session receipts 4 (three later non-start/non-correction turns); handoff 1, binding 1.
Durable build registry 0 and operation events 0 for canonical build_d1ec03bf-6042-44b8-abfd-47e19b8e6d38; artifact 1, .md, available, matching child.
Q1: all four receipts equal for version/sequence/exact timestamp/epoch/metadata/thread; final true, matching rows 1. Start still equal after 58 revisions.
Handoff d1ec03bf-6042-44b8-abfd-47e19b8e6d38; initial manifest 0. Child task ce0b5338-e61b-5fab-b42f-40740694f5cf.
Child run 01a103aa-0afa-7ae0-88a3-9652492475f8; routed/child task_type document/document; success; gateway running/completed states observed.
UTC: source 21:26:53.727955; source-action HTTP 200 21:26:53.924204; routed 21:27:08.607576; handoff accepted 21:27:14.952850.
Child binding 21:27:18.102750; POST /runs 200 21:27:18.126492; first progress starting 21:27:24.871947, gateway 21:27:24.946716.
Artifact available 21:30:09.346469; child success 21:30:10.838966; gateway completion 21:30:12.013746.
Source→first progress 31.144s; parent queue 0.556s; parent start→route 10.381s; route→binding 9.495s; child queue 1.808s.
Child execution 170.905s, completion interval 172.829s; one web search, two fetches, one write; research preceded write.
Console: 3 [voice-builder] outcome and 2 [voice-audio] context-state markers, all flattened to Object; fields/event times and refusal diagnostics unavailable.
Capture timestamps were not used as event timestamps. Expanded safe fields requested from Davide; no inferred specific unconfirmed/refusal/audio state.
No matching admission denial surfaced by focused searches; no child-create 403. Browser progress-paint timestamp not captured.
LangSmith Sophia and Sophia-Gemini-Live-Voice: no runs in 3h Runs view. Builder annotation skipped: tracing_enabled=false/no active run tree.
Structural export unavailable; voice multipart 403/Forbidden persists through 21:40:59Z. Tracing gaps prevent a full model/tool waterfall.

## Analysis / handoff
Ranked latency: serial governed pre-launch/binding work, then first-progress initialization; queue waits are small. 31s feedback exceeds the bridge's 25s wait.
Propose stage spans, immediate truthful pending feedback plus late confirmation, and profile/atomically consolidate repeated reads while preserving all authority checks.
Reconcile durable registry integration and repair tracing separately; do not infer a key/endpoint change from these logs. No fix, retry, merge or additional production action.
Detailed analysis: codex-artifacts/sophia-successful-builder-latency-analysis-2026-10-03.md. Gateway/voice/settings/Lab/memory/retention untouched.
