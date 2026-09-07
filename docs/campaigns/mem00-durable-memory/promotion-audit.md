# MEM00 Section 17 promotion audit

Updated: 2026-09-07 (Europe/Rome)

Status values are deliberately strict: `local-proven` is not production proof, `production-pending` is incomplete, and only `production-proven` can satisfy promotion. The terminal declaration remains unavailable until every row is `production-proven` and the evidence packet independently reproduces each reference.

| Section 17 requirement | Current status | Required authoritative production evidence |
| --- | --- | --- |
| Exact deployed SHA/tree/schema/epoch converge | production-pending | one immutable MEM00 commit/tree, four deployment IDs, schema digest, epoch responses |
| One durable finalization run for exact transcript range | local-proven | MEM-P01 joined session/range/run rows |
| Recap waits for terminal extraction | local-proven | MEM-P01 UI plus terminal transition timing |
| Recap and review use identical candidate IDs | local-proven | MEM-P01 joined API/UI IDs |
| Partial/duplicate extraction batches impossible | local-proven | MEM-P01/P06 transaction and restart evidence |
| Pending/rejected/expired/quarantined isolation | local-proven | MEM-P02 zero provider/admission/consumer proof |
| Approval yields one canonical memory and desired projection | local-proven | MEM-P03 cardinality joins |
| Manual create/edit/forget/delete share canonical authority | local-proven | MEM-P03–P05 lifecycle receipts |
| Pool is canonical and provider health secondary | local-proven | MEM-P03/P07 UI/API/outage proof |
| Tombstone monotonic; content scrubbed to contract | local-proven | MEM-P05 database/provider timing and retention proof |
| Exact Mem0 dependency/endpoint behavior passes complete R3 | production-pending | replacement-key R3 add/get/search/reconcile/paginate/delete/zero proof |
| Every eligible binding is fully version/owner/project/environment bound | local-proven | MEM-P03–P07 admission-denial joins |
| Provider text never rendered or admitted | local-proven | MEM-P03/P04 adversarial provider-text proof |
| Ambiguous effects and late workers converge | local-proven | MEM-P06 restart/response-loss/late-worker proof |
| Top-K starvation cannot cause unsafe fallback | local-proven | MEM-P02/P07 >K stale/denied fixture proof |
| Governance/provider outage admits zero memory | local-proven | MEM-P07 database/provider outage receipts |
| Every named consumer passes mixed-state matrix | known-gap | entry cleanup is deployed on c41bbb1; Builder handoff repair is staged; per-model/tool/history and complete deployed matrix remain unproven |
| No production raw Mem0 caller outside adapter | local-proven | deployed artifact digest plus architecture scan |
| Legacy identity loads are zero | local-proven | deployed counter and consumer traces |
| Long-lived contexts honor generation invalidation | known-gap | voice is explicitly disabled; text/Builder per-model and retained-history fencing plus MEM-P04/P05 proof remain outstanding |
| Privacy deletion is truthful | local-proven | MEM-P08 receipt/database/provider/UI joins |
| All deterministic/contract/security/migration/fault tests pass | local-proven | exact-candidate CI plus deployed fault suite |
| Five consecutive complete core canaries, identical state | production-pending | five ordinal manifests with identical bytes/config/schema |
| Zero-tolerance counters remain zero | production-pending | per-canary and terminal counter snapshots |
| LangSmith/product evidence joins without content | production-pending | structural trace IDs plus serialized-payload redaction proof |
| Legacy data is canonical or quarantined | production-pending | complete inventory and separately authorized disposition |
| Synthetic cleanup reaches Section 9.8 terminal zero | production-pending | paginated DB/provider/cache/fault/artifact zero receipt |
| No unapproved provider/plan/config change; every run revalidates hosted behavior | production-pending | per-run Mem0 config/usage/contract pins |
| Evidence packet independently reviewable | production-pending | final redacted manifest, hashes, queries, logs, metrics, UI, LangSmith joins |

Current hard gate (2026-09-07): all four components run c41bbb102022c82a50c8afe4080068e54ea0c409, tree000f36250b922aca089fbfada2dac865e2d7477c, mem00.v1/epoch1. Fresh three-fixture hosted contract passes and both probe subjects are zero. Actual deployed text/Builder automatic entry cleanup joins two zero-admission DB/LangSmith records; earlier deployed voice containment remains reduced-personalization containment, not a retained-context protocol or ordinary serving-HTTP run. EI126 Builder handoff repair is local and verified in154focused tests; EI127's serialized full backend rerun is pending. The content-free retention planner is not runtime integrated. Repeated read-only schema-surface fingerprints cover489catalog items, not the entire database or retained data. Broader per-model and retained-history admission remains a known gap. Partial serving-process metrics are not complete release observation windows. P01D cross-candidate lifecycle/cleanup cannot count as an immutable canary. The bounded project marker inventory excludes content, backups and null-entity bugs; complete Section9.8 cleanup remains unproven. Full mixed-state consumer/fault matrix and remaining Section17 proof are outstanding. Five complete clean production canaries: **zero**. See `repair-deployment-c41bbb1.json`, `builder-handoff-repair-20260907.json` and `schema-attestation-20260907.json`. Historical voice debt is waived as a memory deployment blocker, not called clean. No real-user import, ambiguous purge, provider/configuration change or merge has been performed.
