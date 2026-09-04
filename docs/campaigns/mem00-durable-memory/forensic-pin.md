# MEM00 forensic pin

Captured: 2026-09-04 (Europe/Rome; refreshed from the original 2026-09-02 pin)

This is a content-free R0 snapshot. Secret values, memory text, raw user/session/provider identifiers, transcripts, authorization URLs, and provider error bodies are intentionally excluded.

## Repository lineage

- Reviewed reference: `1e11584050927bac2b4c851533614bc9d63e4eab`.
- Newest remote head at the latest reconciliation: `3add3336216e74324cd1ed4d3859caccc70c94fe`.
- Reconciled upstream tree: `a867e9d378db33eeee4d292bb130995bc0bf9f12`.
- Isolated branch: `codex/mem00-durable-memory-governance`.
- Active VT00 worktree remains separate on `codex/vt00-implementation`; MEM00 did not modify it.
- Changes after the reviewed reference were explicitly reconciled through `3add3336`. The newest eight commits after `fb8a6655` repair Voice Lab cross-region readiness, rounded fixture accounting, synthetic cleanup and audio flushing, anonymous provider binding, finalization exit guards, durable provider cleanup, and orphan recovery. Their 12-file delta does not add or bypass a memory authority and preserves the active-run safety boundary. The merged pre-evidence candidate is `77424edab7a682d2acea1e328a0e27336b5470df` / tree `d2d19514b8c78c7c2d1a3f2965493ecda4c6fc53`; backend 111/111, complete frontend 1,952 passed/two skipped, complete Voice Lab 348 passed/six skipped, and both TypeScript checks are green.
- The refreshed isolated-branch publication is verified at immutable commit/tree `ba24bef4662868609b64bc9dfaa0ca6e159f163f` / `1b5766c179eea2d531421ea0a6307f2bcb528d1d`. Its three-day, one-repository fine-grained credential was revoked immediately after verification, and no pull request or merge was created. The upstream observability branch remains pinned at `3add3336216e74324cd1ed4d3859caccc70c94fe`.
- The immutable MEM00 candidate commit/tree is populated in the post-freeze evidence manifest. Pre-freeze deterministic attempts use the exact base above plus their ledger identity; they are not represented as immutable candidates.

## Deployed component snapshot

| Component | Service/deployment | Reported revision | Public identity |
| --- | --- | --- | --- |
| Gateway | `srv-d7be5s9r0fns7397l4g0` / `dep-dad6him7bikc739st6m0` | `ba24bef4662868609b64bc9dfaa0ca6e159f163f` | `https://sophia-gateway.onrender.com` |
| LangGraph | `srv-d7be5s9r0fns7397l4fg` / `dep-dad6hq710e5c73di51lg` | `ba24bef4662868609b64bc9dfaa0ca6e159f163f` | `https://sophia-langgraph.onrender.com` |
| Voice | `srv-d7be5s9r0fns7397l4f0` / `dep-dad6hrqfngtc738222j0` | `ba24bef4662868609b64bc9dfaa0ca6e159f163f` | `https://sophia-voice-2uzr.onrender.com` |
| Voice Lab worker | `srv-da6uiqfavr4c739mtbo0` / `dep-dac7hfdg1s2s738pdvn0` | `66cebaa414b2a8b89f2881b34baaac22870652f5` | internal worker |
| Voice Lab MCP | `srv-da6uiqfavr4c739mtbng` | read-only identity captured | internal MCP |
| Frontend | Vercel project `sophia-agent-front` / deployment `6UvzkSkbVW5SDHYcS8Y3FB7xWcDg` | `ba24bef4662868609b64bc9dfaa0ca6e159f163f` | `https://www.sophia-ei.com` (`dpl_6UvzkSkbVW5SDHYcS8Y3FB7xWcDg`) |

The product table is the post-deployment 2026-09-04T10:26+02:00 snapshot. Public version probes join all four product surfaces to the immutable candidate, `mem00.v1`, and supported epoch `1`. The Voice Lab reported no active run or operation, an engaged kill switch, and closed product-mutation gates. It remains intentionally pinned to expected VT00 identity `e3b40f1b21739479db239c383ce88285ce740152`, so its identity verdict is a truthful expected-candidate mismatch; no Voice Lab run was started.

## Product database snapshot

- Supabase project reference: `vlxnwmyvhchwbousrdzc`.
- Region/compute observed: `us-west-1`, micro, healthy.
- Pre-MEM00 schema snapshot: PostgreSQL `17.6`; 1,413 entries and MD5 `35ae9752dee02bca116c2aa3905195f9` using the recorded union of public columns, constraints, routine signatures/results, relations, and index definitions.
- The exact additive migration is now applied. Its content-free post-check proves `mem00.v1`, epoch `1`, mode `disabled`, candidate plaintext retention 30 days, receipt retention 3,650 days, 13 MEM00 tables, five views, 22 functions, zero `anon`/`authenticated` table privileges, and zero active faults.
- Additive migration staged at `backend/migrations/2026_09_02_mem00_durable_memory_governance.sql`.
- Migration SHA-256: `96303ed50b1508b35287cb70acd26dd34e58aa44a50b0527090f17ac302f96b7`.
- Contract default after migration: epoch `1`, schema `mem00.v1`, mode `disabled`, candidate plaintext retention exactly 30 days, content-free receipts at least 3,650 days.
- Browser roles retain no direct memory-table, fault-setting, operational-view, or fault-control privileges; service-role access is explicit and RPC mutations are owner scoped. Five structural operational views cover extraction freshness, lifecycle transitions, projection health, retrieval authorization, and owner-scoped certification cleanup.

## Existing Mem0 runtime contract

- Existing organization ID: `org_UIGCqdvDj2Yl9F7y9bTEIhQdzH4JX9bYT58i9FPt` (deployed variable `MEM0_ORG_ID`).
- Existing project ID: `proj_q1I90sXEFJXjVt3Mvghj2P7nKEfzPvT9h0t9Ft3Z` (`default-project` in `davide5-default-org`).
- Existing plan shown by the dashboard: Growth Plan. Extra Usage was off.
- Billing window observed: 2026-08-11 through 2026-09-11.
- Usage at the resumed refresh: 34/200,000 add requests and 1,933/20,000 retrieval requests. Growth Plan remains active and Extra Usage remains off.
- SDK dependency: `mem0ai==1.0.9` in both backend package graphs.
- Locked wheel SHA-256: `5153883da8f49296de763f4f92876ce3d4ee7daf7f596e3d4feb3a1709d3c4b0`.
- Deployed module SHA-256 observed: `d4dea4af0e23d544a8a004dd385656ab49ea14180d1d854ef81483e94c1d045d`.
- Existing API host: `https://api.mem0.ai`; no base-URL override was present.
- SDK paths observed: direct add `POST /v1/memories/`, search `POST /v2/memories/search/`, enumerate `POST /v2/memories/`, get/delete `/v1/memories/{id}/`.
- Direct add supports initial metadata in 1.0.9. The governed adapter uses `infer=false`, `async_mode=false`, verifies initial markers, paginates enumeration, treats provider text as untrusted, and verifies deletion.
- The approved same-project replacement key passed complete R3 on deployed `mem0ai==1.0.9`: it deleted the fenced preflight row, created three direct non-inferred rows across two subjects, preserved distinct stable IDs and initial metadata, passed search/repeated reconciliation/page-size-one pagination/subject isolation, deleted all exact IDs through the public SDK, and ended with terminal counts `[0,0,0]`. The replacement key was saved only to the existing Gateway `MEM0_API_KEY` using Render's save-only path. The old provider key remains unrevoked; no service restart occurred from the save.
- The signed-in project membership is `Admin`. The API-key inventory contains six hashed keys and exposes no per-key scope selector. Exactly one replacement key was created; none was revoked.
- Existing service flags: `MEM0_ENABLED=true`, max search results `3`, reference date enabled, category-filter removal enabled, user prefix `sophia_user_`. No MEM00 flag existed in production.
- Dashboard configuration observed: multilingual extraction enabled, nonempty user custom instructions, blank agent custom instructions, nine existing categories (`fact`, `feeling`, `decision`, `lesson`, `commitment`, `relationship`, `pattern`, `ritual_context`, `personal_goal`), Memory Decay enabled, and no expiration date selected.
- Dashboard 7-day counters at pin: stored `0`, recalled `0`, searches `465`.
- The portable evidence records configuration shape and keyed references only; it never copies custom-instruction content.

## LangSmith snapshot

- Workspace ID: `26b7385f-8e69-4a13-b4da-49873ae46191`.
- Sophia project ID: `7dd40980-665a-4f4a-95c3-582e6270b707`.
- Retention: 14 days.
- The signed-in regional endpoint is `https://eu.smith.langchain.com`. No runs were visible in the selected one-day window at the latest pin.
- MEM00 export is default-disabled and content-free. When enabled for the synthetic cohort it sends structural metadata and counters only.

## Default-closed feature snapshot

All new flags are absent in the latest signed-in service environment reads and default false in code. Gateway and LangGraph each expose the same eight legacy Mem0 key names (`MEM0_API_KEY`, `MEM0_ENABLED`, `MEM0_MAX_SEARCH_RESULTS`, `MEM0_ORG_ID`, `MEM0_PROJECT_ID`, `MEM0_REFERENCE_DATE_ENABLED`, `MEM0_REMOVE_CATEGORY_FILTER_ENABLED`, and `MEM0_USER_ID_PREFIX`). Voice exposes six: it omits the two reference-date/category-filter toggles. Vercel exposes no `SOPHIA_MEMORY_*`, `MEM0_*`, or `NEXT_PUBLIC_*MEMORY*` key. Secret values are excluded.

`candidate_ledger_write`, `candidate_ledger_read`, `canonical_pool_read`, `provider_projection`, `governed_runtime_read`, `legacy_inventory`, `legacy_import`, and `memory_fault_injection`.

Invalid partial combinations are rejected. No combination may activate a reader without its preceding authority, projection without canonical reads, or fault injection without projection. Tombstone fencing remains independent of provider availability.

## No-change attestation

This pin made no intentional SDK-major, API-version, endpoint, project, organization, configuration, algorithm-toggle, plan, billing, or paid-service change. The only credential change was the approved same-project replacement stored under the existing Gateway variable after complete R3; the old provider key remains unrevoked. Synthetic provider rows were terminal-zero cleaned, and no second memory authority was created.
