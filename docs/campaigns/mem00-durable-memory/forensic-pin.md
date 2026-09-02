# MEM00 forensic pin

Captured: 2026-09-02 (Europe/Rome)

This is a content-free R0 snapshot. Secret values, memory text, raw user/session/provider identifiers, transcripts, authorization URLs, and provider error bodies are intentionally excluded.

## Repository lineage

- Reviewed reference: `1e11584050927bac2b4c851533614bc9d63e4eab`.
- Newest remote head at the latest reconciliation: `7d1e6b6a58ea98a77c00e96be54c61f8fdf2b66e`.
- Base tree: `734bb4dfa8a9c472ea9ee9ba5f49900e5c3ba079`.
- Isolated branch: `codex/mem00-durable-memory-governance`.
- Active VT00 worktree remains separate on `codex/vt00-implementation`; MEM00 did not modify it.
- Changes after the reviewed reference were explicitly reconciled through `7d1e6b6a`: `0b505c40` owns disposable Voice Lab browser epochs; `8f0cb46a` gates lease release on terminal cleanup; `81e3da16` removes browser-storage transplant; `b9fafffe` removes the DOM activation fallback; `b973a2af` removes superseded UI activation fallbacks; `66cebaa4` removes CDP React diagnostics; `ad611e38` enforces controller callback parity; `d8ad61b3` adds control-cancellation proof documentation plus two frontend adapter regressions; `566bf2ab` proves Voice Lab dynamic-injection trials; `80801eff` binds fresh-session canaries; and `7d1e6b6a` preserves an authorized voice-start request across callback identity changes while invoking the latest exact action once. They affect Voice Lab process ownership, cleanup, browser isolation, evidence, and tests—not memory authority. Their active-run safety boundary is preserved.
- The immutable MEM00 candidate commit/tree is populated in the post-freeze evidence manifest. Pre-freeze deterministic attempts use the exact base above plus their ledger identity; they are not represented as immutable candidates.

## Deployed component snapshot

| Component | Service/deployment | Reported revision | Public identity |
| --- | --- | --- | --- |
| Gateway | `srv-d7be5s9r0fns7397l4g0` / `dep-dac9lumq1p3s73fc3g3g` | `7d1e6b6a58ea98a77c00e96be54c61f8fdf2b66e` | `https://sophia-gateway.onrender.com` |
| LangGraph | `srv-d7be5s9r0fns7397l4fg` / `dep-dac9ltnavr4c73flc5h0` | `7d1e6b6a58ea98a77c00e96be54c61f8fdf2b66e` | `https://sophia-langgraph.onrender.com` |
| Voice | `srv-d7be5s9r0fns7397l4f0` / `dep-dac9q6vavr4c73flvku0` | `7d1e6b6a58ea98a77c00e96be54c61f8fdf2b66e` | `https://sophia-voice-2uzr.onrender.com` |
| Voice Lab worker | `srv-da6uiqfavr4c739mtbo0` / `dep-dac7hfdg1s2s738pdvn0` | `66cebaa414b2a8b89f2881b34baaac22870652f5` | internal worker |
| Voice Lab MCP | `srv-da6uiqfavr4c739mtbng` | read-only identity captured | internal MCP |
| Frontend | Vercel project `sophia-agent-front` / deployment `AfZz3YaPCag7bAA6ksxv6pHF1AFU` | `7d1e6b6a58ea98a77c00e96be54c61f8fdf2b66e` | `https://www.sophia-ei.com` (`sophia-agent-front-ory3qko89-sophia-30911edf.vercel.app`) |

The participating product services are now converged on remote head `7d1e6b6a`; none is on the isolated MEM00 candidate yet. The earlier failed LangGraph attempt for `d8ad61b3` remains evidence-bearing, but later same-branch deployments succeeded. Voice Lab's 2026-09-03 action-time read reported no active run or operation, an engaged kill switch, and closed backend/voice product-mutation gates. Its target contract still expected `80801eff`; during that read Gateway/frontend/LangGraph had already advanced to `7d1e6b6a` while Voice was still on `80801eff`. A subsequent signed-in Render read proved Voice deployment `dep-dac9q6vavr4c73flvku0` live on `7d1e6b6a`. R4 must still re-read Voice Lab immediately before any deploy.

## Product database snapshot

- Supabase project reference: `vlxnwmyvhchwbousrdzc`.
- Region/compute observed: `us-west-1`, micro, healthy.
- Latest pre-MEM00 schema snapshot: PostgreSQL `17.6`; 1,413 entries and MD5 `35ae9752dee02bca116c2aa3905195f9` using the recorded union of public columns, constraints, routine signatures/results, relations, and index definitions. The earlier 890-entry snapshot used a narrower catalog projection and remains historical rather than directly comparable.
- Zero public relations matched `sophia_memory%`; `public.sophia_memory_contract` did not exist and no production MEM00 migration had been applied at the latest pin.
- Additive migration staged at `backend/migrations/2026_09_02_mem00_durable_memory_governance.sql`.
- Migration SHA-256: `96303ed50b1508b35287cb70acd26dd34e58aa44a50b0527090f17ac302f96b7`.
- Contract default after migration: epoch `1`, schema `mem00.v1`, mode `disabled`, candidate plaintext retention exactly 30 days, content-free receipts at least 3,650 days.
- Browser roles retain no direct memory-table, fault-setting, operational-view, or fault-control privileges; service-role access is explicit and RPC mutations are owner scoped. Five structural operational views cover extraction freshness, lifecycle transitions, projection health, retrieval authorization, and owner-scoped certification cleanup.

## Existing Mem0 runtime contract

- Existing organization ID: `org_UIGCqdvDj2Yl9F7y9bTEIhQdzH4JX9bYT58i9FPt` (deployed variable `MEM0_ORG_ID`).
- Existing project ID: `proj_q1I90sXEFJXjVt3Mvghj2P7nKEfzPvT9h0t9Ft3Z` (`default-project` in `davide5-default-org`).
- Existing plan shown by the dashboard: Growth Plan. Extra Usage was off.
- Billing window observed: 2026-08-11 through 2026-09-11.
- Usage at the latest read-only refresh: 30/200,000 add requests and 1,786/20,000 retrieval requests; the dashboard showed 518 requests, two entities, and zero memories stored in its selected seven-day metrics window.
- SDK dependency: `mem0ai==1.0.9` in both backend package graphs.
- Locked wheel SHA-256: `5153883da8f49296de763f4f92876ce3d4ee7daf7f596e3d4feb3a1709d3c4b0`.
- Deployed module SHA-256 observed: `d4dea4af0e23d544a8a004dd385656ab49ea14180d1d854ef81483e94c1d045d`.
- Existing API host: `https://api.mem0.ai`; no base-URL override was present.
- SDK paths observed: direct add `POST /v1/memories/`, search `POST /v2/memories/search/`, enumerate `POST /v2/memories/`, get/delete `/v1/memories/{id}/`.
- Direct add supports initial metadata in 1.0.9. The governed adapter uses `infer=false`, `async_mode=false`, verifies initial markers, paginates enumeration, treats provider text as untrusted, and verifies deletion.
- R3 remeasurement proved direct non-inferred storage, two distinct rows without merge, initial metadata, stable returned IDs/search, exact operation-marker reconciliation, repeated convergence, page-size-one pagination, subject isolation, namespace metadata, and semantic search. A fresh action-time probe against the deployed `mem0ai==1.0.9` runtime again returned 403 for exact-ID deletion. The currently documented `DELETE /v1/batch` body (`memory_ids`) was then sent through the same SDK transport and returned 400; the exact single synthetic row remains fenced under its isolated certification subject. The user authorized one same-project replacement key, replacement of only the existing Gateway `MEM0_API_KEY`, retention of the old provider key for rollback, and a full terminal-zero R3 rerun. Browser policy still requires immediate confirmation before the prepared Create action and secret transfer to Render. Projection remains closed.
- The signed-in project membership is `Admin`. The API-key inventory contains five hashed keys and exposes no per-key scope selector. No key was created, rotated, revealed, or revoked during inspection.
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

All new flags are absent in the latest signed-in service environment reads and default false in code. Gateway and LangGraph each expose the same eight legacy Mem0 key names (`MEM0_API_KEY`, `MEM0_ENABLED`, `MEM0_MAX_SEARCH_RESULTS`, `MEM0_ORG_ID`, `MEM0_PROJECT_ID`, `MEM0_REFERENCE_DATE_ENABLED`, `MEM0_REMOVE_CATEGORY_FILTER_ENABLED`, and `MEM0_USER_ID_PREFIX`). Voice exposes six: it omits the two reference-date/category-filter toggles. Vercel exposes no `SOPHIA_MEMORY_*`, `MEM0_*`, or `NEXT_PUBLIC_*MEMORY*` key. Secret values are excluded.

`candidate_ledger_write`, `candidate_ledger_read`, `canonical_pool_read`, `provider_projection`, `governed_runtime_read`, `legacy_inventory`, `legacy_import`, and `memory_fault_injection`.

Invalid partial combinations are rejected. No combination may activate a reader without its preceding authority, projection without canonical reads, or fault injection without projection. Tombstone fencing remains independent of provider availability.

## No-change attestation

This pin made no intentional SDK-major, API-version, endpoint, project, organization, configuration, algorithm-toggle, plan, billing, credential, or paid-service change. It created no second memory authority and wrote no provider memory.
