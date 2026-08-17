# FC-01 Decisions

## FC01-001 — Keep product lineage immutable during BASE-00

The shared checkout is user-owned and dirty. All deterministic tests use a
detached clean worktree at the frozen campaign SHA. The control branch starts
at the frozen main SHA and may touch only this campaign directory.

## FC01-002 — Use provider truth only where independently observable

Public application receipts may establish health and an application-reported
source identity. They do not establish provider deployment IDs, branch mapping,
retention, rollback selectability, or database state. Unavailable fields remain
`UNKNOWN`.

## FC01-003 — Treat production checkpointer durability as unproven

The frozen campaign's production configuration contains no checkpointer block,
and its configured factory therefore resolves to an in-process memory saver.
The actual live instantiated class is not exposed and the current LangGraph
provider source identity is unknown. BASE-00 records the strong non-durable
source/config inference without promoting it to direct runtime proof. M01 owns
the durable checkpointer repair and restart proof.

## FC01-004 — Preserve historical migration bytes

Three historical migration files differ across the frozen lineages. Until the
governed live catalog proves which checksums ran, neither variant may be called
canonical and no historical byte may be changed. Any later convergence must be
forward-only and idempotent.

## FC01-005 — Keep M00 frozen

The next M00 attempt uses campaign source
`9ee901fd2cdcfb55df31c0377e0f1fa26b1b4cca` and prompt digest
`bdad62c0d47b8ca26c6cfc69422ceafd222a0b3851f19eb6e430895d28edacea`.
It uses one fresh approved synthetic identity and one shared repair maximum.
No attempt begins until exact active and rollback deployment identities are
provider-verified and the acceptance budget is signed.

## FC01-006 — Block on tracked runtime-record provenance

Both frozen lineages contain the same tracked runtime/user artifact set with
stable-identifier-shaped and content-bearing fields. No values are copied into
this campaign. Real-versus-synthetic provenance remains unknown and blocks the
privacy gate.
