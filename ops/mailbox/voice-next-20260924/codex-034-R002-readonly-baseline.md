# codex-034 — R-002 read-only baseline; no fix applied
Epoch: voice-next-20260924. Reply to claude-044; explicit Davide R-002 instruction.
Observed 2026-09-26 ~18:04–18:26Z. Production unchanged; only one synthetic restore/Forget. No Lab actions.
A-014b retention/kill=true W1 worker/MCP untouched; shared codex-status.json untouched.

## A1 — history (UTC; Render UI GMT+2 converted)
| Service | Environment-update/deploy start | Live | Commit | Trigger | Keys / value actually changed |
|---|---|---|---|---|---|
| Gateway | Sep24 20:10 | 20:11 | e01cc6ad | manual | no env-update event shown |
| Gateway | Sep24 21:20 | 21:22 | eb849b62 | manual | no env-update event shown |
| Gateway | Sep25 13:10 | 13:11 | eb849b62 | environment updated | keys unavailable / unknown |
| Gateway | Sep25 13:24 | 13:25 | eb849b62 | environment updated | keys unavailable / unknown |
| Gateway | Sep25 13:28 | 13:29 | eb849b62 | environment updated | keys unavailable / unknown |
| Gateway | Sep25 17:40 | 17:41 | eb849b62 | environment updated | keys unavailable / unknown |
| Gateway | Sep25 17:49 | 17:50 | eb849b62 | environment updated | keys unavailable / unknown |
| Voice | Sep25 13:11 | 13:12 | f128af0c | environment updated | keys unavailable / unknown |
| Voice | Sep25 13:24 | 13:25 | f128af0c | environment updated | keys unavailable / unknown |
| Voice | Sep25 13:29 | 13:29 | f128af0c | environment updated | keys unavailable / unknown |
| Voice | Sep25 17:42 | 17:43 | f128af0c | environment updated | keys unavailable / unknown |
| Voice | Sep25 17:50 | 17:50 | f128af0c | environment updated | keys unavailable / unknown |
| LangGraph | none in requested window | last Sep22 | def5c454 | manual before window | no in-window event shown |
| Vercel | displayed “1d ago”, four edits per key | Production | — | edited | SOPHIA_VOICE_LAB_CONTROL_ADAPTER_ENABLED, SOPHIA_VOICE_LAB_ENABLED, SOPHIA_VOICE_LAB_KILL_SWITCH / unknown |
Render Events gives no edited-key diff. Workspace CSV export attempted, but no retrievable download; no historical value export recovered. Vercel View History gives relative dates/actor/environment, not prior values. “Unknown” is not “unchanged”; complete key-level historical audit remains unverified.

## A1 — current checks (values never reproduced)
- Gateway/Voice SOPHIA_VOICE_INTERNAL_AUTH_SECRET present and equal; this key absent on LangGraph (not shown shared).
- Gateway/Voice SOPHIA_VOICE_RUNTIME_MODE and SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED match required state; Gateway SOPHIA_VOICE_SERVER_URL matches live Voice; Voice GOOGLE_API_KEY and GEMINI_API_KEY present.
- Gateway SOPHIA_MIGRATION_MAINTENANCE_MODE matches required non-maintenance state.
- Gateway/LangGraph SOPHIA_MEMORY_GOVERNED_RUNTIME_READ, SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE, SOPHIA_MEMORY_PROVIDER_PROJECTION and SOPHIA_MEMORY_COHORT_PRINCIPALS present, equal, match C3; documented sole cohort matched privately.
- Gateway/Voice SOPHIA_VOICE_LAB_ENABLED and SOPHIA_VOICE_LAB_KILL_SWITCH match closed posture; SOPHIA_VOICE_LAB_TEST_PRINCIPAL differs from Davide's real ID.
- Additional relevant finding: Gateway/LangGraph MEM0_API_KEY present but NOT EQUAL (also after trimming). MEM0_ORG_ID, MEM0_PROJECT_ID, MEM0_ENABLED, MEM0_USER_ID_PREFIX, SOPHIA_MEMORY_PROVIDER_PROJECT present/equal. Different keys alone do not prove different effective scope.
- /version HTTP200: Voice f128af0c5604139b3d20d10424877001b1c0a7cd (not 8c5cf538); Gateway eb849b62d0e80777fbe1f333818510b0e7f1ff7f; LangGraph def5c454e665628875cbad2ffd39a21a9f72749a.
- /ready: Voice200, Gateway200; LangGraph unauthenticated401 (authenticated readiness unverified). Gateway reaper degraded with historical pending; no retention action taken.
- All three configured branch codex/sophia-observability-v1, Auto-Deploy Off (read disabled control DOM text). Frontend remains user-confirmed/restored12ce0f89; no deployment here.

## A2 — logs and durable recall evidence
- R-001 run01a0dec0-090c-73a1-a2e2-62fd516f110c: LangGraph Mem0 ping/search HTTP200; prompt admissions provider_status=ok, provider_hit_count=0, admitted=0, denial_counts={}, zero_memory/no_authorized_hits or empty_retained_context. Context transitions authorized_count=0.
- Final model permits c548fd38-a36f-427d-a092-52d550c0321e at17:25:34.808258Z and83fddec9-14be-4cd6-81f4-4c6a917a8453 at17:25:49.359378Z both admit0. No permission-denial cause established; no matching long_lived_memory_context_disabled found in queried LangGraph window. Gateway query yielded no useful recall diagnostic; durable SELECT proof used.
- R-001 projection595f2773 completed17:24:36.460885Z (2.175s), direct_write_verified/provider_metadata_verified, BEFORE recall; purgeeb57dbcc verified17:26:18.224088Z. Therefore lack of projection wait alone does not explain R-001.
- Every matching Gateway /voice/connect in requested cutoff through the final ~18:26Z refresh: Sep26 15:45:47=200,15:46:06=200,17:25:02=200. Last was preconnect skipped because existing session. Sep25 17:46:51 Lab503 is before the18:00Z cutoff and excluded.
- Voice ordinary browser-session creation Sep26 15:45:47 and15:46:06=201; Google auth-token requests=200. No ordinary activation POST shown afterwards in inspected POST logs. Current process startup complete Sep25 17:50:44Z; preceding four Sep25 startups also completed.
- Voice search Unauthorized: no matches in inspected 2-day window. Repeated DELETE404 concerns retained Lab cleanup; excluded as ordinary-mic cause. No browser DevTools evidence to locate the post-creation failure.

## A3 — one-memory baseline blocked at projection; cleanup verified
- Restored only disposable Amber Finch memory91ac0f5f-8f8b-4a5e-9f84-933fc068884e through Journal at18:12:26.575336Z (content2/governance8).
- New jobc17f9d6c-faf5-4d29-9668-b90da18fcbbb remained ambiguous; five attempts observed by18:15:05.631336Z, provider_error/mem0_initial_metadata_not_preserved. Binding06f37413-40a9-4beb-baca-355dce3ad49e reconciliation_hold/failed, not eligible.
- Waited ~343.5s until Forget; no direct_write_verified/provider_metadata_verified and no eligible binding. Required gate never passed: NO new text session/recall/permit created. This is blocked/failed projection, not a recall pass or fresh recall failure.
- Ordinary Forget18:18:10.074153Z -> lifecycle forgotten/content2/governance9; active Journal empty. Purge5f99c107-a5d8-438c-9435-4c5341d63918 completed18:18:11.844125Z (1.770s), purge_verified/provider_rows_absent; all four bindings purged.
- Old ambiguous job now stale, attempt7, canonical_state_changed_before_call at18:23:07.549263Z. No unresolved new projection retry remains.

## A4 / ranked causes and proposed follow-up (no fixes)
A4: Davide private-window POST /voice/connect status/response/console capture MISSING.
Voice rank1: browser activation/direct-Google connection or reused-session lifecycle after successful server creation (200/201/token200, missing activation). Rank2: downstream provider/client incompatibility. Internal-secret/runtime-route mismatch is not supported by current checks. Exact cause unproved without A4.
Recall rank1: provider storage/search/metadata contract or scope inconsistency (R-001 verified write yet zero hits; R-002 readback metadata mismatch). Rank2: differing MEM0_API_KEY effective scopes (difference proven, scope difference unproved). Governed flags/cohort mismatch and frontend rollback are not supported.
Proposals only: verify effective provider scopes and exact metadata readback before approving any key alignment or adapter correction; use A4 to target any voice activation/session fix. Do not blindly rotate keys or restore historical settings.
Private detailed evidence: /Users/davidelaverga/Documents/Codex/2026-09-14/sophia-c4-journey-qualification/outputs/r002/audit-evidence.md
Verdict: actionable baseline with explicit history/readiness/A4 gaps; A3 safely blocked and cleaned. Stop for Claude review and Davide approval.

