# MEM00 consumer and authority register

The canonical product database is the only approval authority. Mem0 is a desired-state projection and ranking/index hint. Every runtime hit is authorized against current owner-scoped canonical state, provider binding, project/environment, content revision, memory-governance revision, catalog generation, revocation epoch, and tombstone state. Rendering always uses canonical text.

| Surface | Governed caller label | Required behavior |
| --- | --- | --- |
| Text automatic context | `text_automatic_context` | canonical active records only; zero on provider/database uncertainty |
| Explicit text retrieval tool | `text_retrieval_tool` | provider IDs/scores only, then canonical authorization/text |
| Builder context | `builder_context` | same governed facade; no preview/raw-provider bypass |
| Voice setup context | `voice_setup` | generation-bound admission; zero on stale/unknown governance |
| Voice direct fallback | `voice_direct_fallback` | governed facade only; no legacy fallback |
| Voice dynamic retrieval | `voice_dynamic_retrieval` | governed facade only; caller-attributed receipt |
| Voice preferred name | `voice_preferred_name` | identity-derived memory disabled under MEM00; no identity claim from memory |
| Voice retrieval tool | `voice_retrieval_tool` | canonical authorization/text only |
| Reflections | `reflection` | governed facade and current generation |
| Journal/Pool | canonical API | active canonical database records; provider health is secondary |
| Recap/review inbox | durable candidate ledger | the same candidate IDs and terminal extraction state |
| Opener | disabled under governed authority | no stale derivative memory |
| Handoff | quarantined/disabled under governed authority | no ungoverned derivative handoff |
| Identity | isolated identity store only | legacy memory identity loads remain zero |
| Privacy export | canonical authority plus candidate ledger | fail closed unless active, forgotten, and pending memory scope is complete; never emit a fabricated empty success |
| Privacy memory deletion | canonical authority plus candidate ledger | reject pending candidates; revision-fence active and forgotten canonical memories; report provider purge, transcript scope, derived invalidation, and other account data separately |

## Raw provider boundary

`deerflow.sophia.memory_governance.adapter` is the sole production SDK/network boundary. `deerflow.sophia.mem0_client` is a compatibility facade that delegates to the governed reader/adapter. The architecture test rejects any new direct `MemoryClient`, `api.mem0.ai`, or raw memory endpoint use outside the boundary.

## Denial matrix

The following states always produce no consumer influence: pending review, rejected, expired, legacy quarantined, forgotten, tombstoned, stale content revision, stale governance revision, stale catalog generation, wrong owner, wrong project, wrong environment, missing/unverified binding, provider-ID collision/reconciliation hold, database outage, provider outage, and unknown status.

Provider text and previews are never rendered, logged, traced, or admitted. Top-K starvation yields fewer or zero memories; it never falls back to raw provider content.
