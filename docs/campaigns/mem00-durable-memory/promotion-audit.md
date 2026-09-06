# MEM00 Section 17 promotion audit

Updated: 2026-09-05 (Europe/Rome)

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
| Every named consumer passes mixed-state matrix | local-proven | deployed matrix across text/tools/Builder/voice/reflection/Journal/opener/handoff/identity |
| No production raw Mem0 caller outside adapter | local-proven | deployed artifact digest plus architecture scan |
| Legacy identity loads are zero | local-proven | deployed counter and consumer traces |
| Long-lived contexts honor generation invalidation | local-proven | MEM-P04/P05 concurrent-context proof |
| Privacy deletion is truthful | local-proven | MEM-P08 receipt/database/provider/UI joins |
| All deterministic/contract/security/migration/fault tests pass | local-proven | exact-candidate CI plus deployed fault suite |
| Five consecutive complete core canaries, identical state | production-pending | five ordinal manifests with identical bytes/config/schema |
| Zero-tolerance counters remain zero | production-pending | per-canary and terminal counter snapshots |
| LangSmith/product evidence joins without content | production-pending | structural trace IDs plus serialized-payload redaction proof |
| Legacy data is canonical or quarantined | production-pending | complete inventory and separately authorized disposition |
| Synthetic cleanup reaches Section 9.8 terminal zero | production-pending | paginated DB/provider/cache/fault/artifact zero receipt |
| No unapproved provider/plan/config change; every run revalidates hosted behavior | production-pending | per-run Mem0 config/usage/contract pins |
| Evidence packet independently reviewable | production-pending | final redacted manifest, hashes, queries, logs, metrics, UI, LangSmith joins |

Current hard gate (2026-09-06): all four components are on bb54d5f; provider contract remeasurement passes and probe subjects are zero. The approved ordinary-delete migration and source-coupled recap cleanup are proven through the ordinary app, canonical records, unchanged live instance and completed content-free LangSmith receipt. EI115 remains blocking: malformed extractor output was falsely committed as succeeded_zero. Strict retry/whole-batch and complete-JSON-fence parsing repair is staged; final full verification is running. Live process metrics, consumer mixed-state matrix, full derivative cleanup and all remaining Section17 proof are still required. Five complete clean production canaries: zero. Historical voice debt is waived as a memory deployment blocker, not called clean. No provider/configuration change, real-user import, ambiguous purge or merge is authorized.
