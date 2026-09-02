# MEM00 forensic pin

Captured: 2026-09-02 (Europe/Rome)

This is a content-free R0 snapshot. Secret values, memory text, raw user/session/provider identifiers, transcripts, authorization URLs, and provider error bodies are intentionally excluded.

## Repository lineage

- Reviewed reference: `1e11584050927bac2b4c851533614bc9d63e4eab`.
- Newest remote head at the latest reconciliation: `d8ad61b303b5df8df262dad46d51782353741761`.
- Base tree: `5e61d93139eba1aa41049dda002362f299fa505c`.
- Isolated branch: `codex/mem00-durable-memory-governance`.
- Active VT00 worktree remains separate on `codex/vt00-implementation`; MEM00 did not modify it.
- Changes after the reviewed reference were explicitly reconciled through `d8ad61b3`: `0b505c40` owns disposable Voice Lab browser epochs; `8f0cb46a` gates lease release on terminal cleanup; `81e3da16` removes browser-storage transplant; `b9fafffe` removes the DOM activation fallback; `b973a2af` removes superseded UI activation fallbacks; `66cebaa4` removes CDP React diagnostics; `ad611e38` enforces controller callback parity; and `d8ad61b3` adds control-cancellation proof documentation plus two frontend adapter regressions. They affect Voice Lab process ownership, cleanup, browser isolation, and tests—not memory authority. Their active-run safety boundary is preserved.
- The immutable MEM00 candidate commit/tree is populated in the post-freeze evidence manifest. Pre-freeze deterministic attempts use the exact base above plus their ledger identity; they are not represented as immutable candidates.

## Deployed component snapshot

| Component | Service/deployment | Reported revision | Public identity |
| --- | --- | --- | --- |
| Gateway | `srv-d7be5s9r0fns7397l4g0` / `dep-dac8a2n40ujc73edenfg` | `d8ad61b303b5df8df262dad46d51782353741761` | `https://sophia-gateway.onrender.com` |
| LangGraph | `srv-d7be5s9r0fns7397l4fg` / `dep-dac7uqe10ojc73a18eu0` | `ad611e382ecd96a2ab1b7a5041b187f7d9f39aed` | `https://sophia-langgraph.onrender.com` |
| Voice | `srv-d7be5s9r0fns7397l4f0` / `dep-dac7vgf40ujc73ec2j9g` | `ad611e382ecd96a2ab1b7a5041b187f7d9f39aed` | `https://sophia-voice-2uzr.onrender.com` |
| Voice Lab worker | `srv-da6uiqfavr4c739mtbo0` / `dep-dac7hfdg1s2s738pdvn0` | `66cebaa414b2a8b89f2881b34baaac22870652f5` | internal worker |
| Voice Lab MCP | `srv-da6uiqfavr4c739mtbng` | read-only identity captured | internal MCP |
| Frontend | Vercel project `sophia-agent-front` / deployment `3zGWvywGVZjtoQLP9fEP5GuWwdNq` | `d8ad61b303b5df8df262dad46d51782353741761` | `https://www.sophia-ei.com` (`sophia-agent-front-b1ltqhp18-sophia-30911edf.vercel.app`) |

The services are intentionally not on one MEM00 candidate yet. Gateway and frontend are live on `d8ad61b3`; Voice and LangGraph remain live on `ad611e38`. The manually initiated LangGraph attempt for `d8ad61b3` (`dep-dac8blu1a4lc73d6ohkg`) failed with provider status 134 after its logs showed a YAML scanner error and then an apparently completed application startup. Because `ad611e38..d8ad61b3` changes no backend/runtime file, the cause is not attributed to application bytes without a controlled rerun. Voice Lab independently reported this mixed identity, kept its kill switch engaged, and exposed no open product mutation gate. R4 must not start until the production migration/deployment approval is granted, the candidate is frozen, and every participating deployment is repinned.

## Product database snapshot

- Supabase project reference: `vlxnwmyvhchwbousrdzc`.
- Region/compute observed: `us-west-1`, micro, healthy.
- Pre-MEM00 schema snapshot: 890 catalog entries, MD5 `2dba7958516953a2539fd71b3571f270`.
- No MEM00 table existed at the pin and no production migration has been applied.
- Additive migration staged at `backend/migrations/2026_09_02_mem00_durable_memory_governance.sql`.
- Migration SHA-256: `e05ca68055712d9cea2eae3bfc2467d03406235eedfaa0aa1317a3e10e9f396a`.
- Contract default after migration: epoch `1`, schema `mem00.v1`, mode `disabled`, candidate plaintext retention exactly 30 days, content-free receipts at least 3,650 days.
- Browser roles retain no direct memory-table privileges; service-role access is explicit and RPC mutations are owner scoped.

## Existing Mem0 runtime contract

- Existing organization ID: `org_UIGCqdvDj2Yl9F7y9bTEIhQdzH4JX9bYT58i9FPt` (deployed variable `MEM0_ORG_ID`).
- Existing project ID: `proj_q1I90sXEFJXjVt3Mvghj2P7nKEfzPvT9h0t9Ft3Z` (`default-project` in `davide5-default-org`).
- Existing plan shown by the dashboard: Growth Plan. Extra Usage was off.
- Billing window observed: 2026-08-11 through 2026-09-11.
- Usage at pin: 27/200,000 add requests and 1,732/20,000 retrieval requests.
- SDK dependency: `mem0ai==1.0.9` in both backend package graphs.
- Locked wheel SHA-256: `5153883da8f49296de763f4f92876ce3d4ee7daf7f596e3d4feb3a1709d3c4b0`.
- Deployed module SHA-256 observed: `d4dea4af0e23d544a8a004dd385656ab49ea14180d1d854ef81483e94c1d045d`.
- Existing API host: `https://api.mem0.ai`; no base-URL override was present.
- SDK paths observed: direct add `POST /v1/memories/`, search `POST /v2/memories/search/`, enumerate `POST /v2/memories/`, get/delete `/v1/memories/{id}/`.
- Direct add supports initial metadata in 1.0.9. The governed adapter uses `infer=false`, `async_mode=false`, verifies initial markers, paginates enumeration, treats provider text as untrusted, and verifies deletion.
- R3 remeasurement proved direct non-inferred storage, two distinct rows without merge, initial metadata, stable returned IDs, exact operation-marker reconciliation, repeated reconciliation convergence, page-size-one pagination, subject isolation, namespace metadata, and semantic search. The current API key denied both exact-ID and batch v1 deletion with HTTP 403; authenticated-dashboard cleanup removed all three probe rows and paginated API enumeration proved both synthetic subjects at zero. Projection remains closed until a same-project delete-capable credential is explicitly authorized and the full R3 proof passes.
- The signed-in project membership is `Admin`. The API-key inventory exposes hashed keys but no per-key scope selector. No key was created, rotated, revealed, or revoked during inspection.
- Existing service flags: `MEM0_ENABLED=true`, max search results `3`, reference date enabled, category-filter removal enabled, user prefix `sophia_user_`. No MEM00 flag existed in production.
- Dashboard configuration observed: multilingual extraction enabled, nonempty user custom instructions, blank agent custom instructions, nine existing categories (`fact`, `feeling`, `decision`, `lesson`, `commitment`, `relationship`, `pattern`, `ritual_context`, `personal_goal`), Memory Decay enabled, and no expiration date selected.
- Dashboard 7-day counters at pin: stored `0`, recalled `0`, searches `465`.
- The portable evidence records configuration shape and keyed references only; it never copies custom-instruction content.

## LangSmith snapshot

- Workspace ID: `26b7385f-8e69-4a13-b4da-49873ae46191`.
- Sophia project ID: `7dd40980-665a-4f4a-95c3-582e6270b707`.
- Retention: 14 days.
- No runs were visible in the selected one-day window at the pin.
- MEM00 export is default-disabled and content-free. When enabled for the synthetic cohort it sends structural metadata and counters only.

## Default-closed feature snapshot

All new flags are absent/false in production and default false in code:

`candidate_ledger_write`, `candidate_ledger_read`, `canonical_pool_read`, `provider_projection`, `governed_runtime_read`, `legacy_inventory`, `legacy_import`, and `memory_fault_injection`.

Invalid partial combinations are rejected. No combination may activate a reader without its preceding authority, projection without canonical reads, or fault injection without projection. Tombstone fencing remains independent of provider availability.

## No-change attestation

This pin made no intentional SDK-major, API-version, endpoint, project, organization, configuration, algorithm-toggle, plan, billing, credential, or paid-service change. It created no second memory authority and wrote no provider memory.
