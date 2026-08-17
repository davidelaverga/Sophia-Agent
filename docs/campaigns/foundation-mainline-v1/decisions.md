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

## FC01-007 — Preserve redacted scan uncertainty

A pinned Gitleaks 8.29.1 history scan found no confirmed live credential and no
match in the runtime/user artifact trees. Thirteen records are strong
synthetic/example false positives; thirteen documentation records remain
unresolved. Scanner coverage limitations and the unresolved records stay
explicit and block a green secret-history conclusion.

## FC01-008 — Separate migration lineage from live-state proof

Git history explains the six migration rewrites, and later receipts prove some
downstream behavior existed historically. Neither source history nor functional
receipts identify the exact bytes applied to the current database. Only a
governed read-only catalog/provider receipt can narrow that state. Historical
files remain immutable; future convergence is forward-only.

## FC01-009 — Do not substitute GitHub history for Render control-plane truth

GitHub binds the active and prior Vercel production coordinates. It contains no
status, check, Actions, or Deployment objects for the relevant Render sources,
so it cannot recover missing current or declared-rollback Render deployment
IDs. Historical Render coordinates remain historical until provider retention
and selectability are verified.

## FC01-010 — Bind authenticated provider coordinates without promotion

The operator authenticated Render and Vercel for read-only inspection. Gateway
and LangGraph now have exact current deployment IDs at the frozen campaign SHA,
and the declared rollback SHA has exact, currently selectable deployment IDs
for both services. Vercel likewise exposes its exact current and immediately
prior production deployments, with Instant Rollback available for the prior
deployment. These receipts close identity/selectability unknowns only; no
deploy, rollback, restart, alias, or setting action was taken.

## FC01-011 — Block on Voice source divergence

The production Voice service is deployed from
`956b6272f4d91ad0c5d806d9a037c0e1335b6392`, an ancestor 358 campaign commits
behind the frozen campaign source. Gateway points to that service, so Voice
health cannot be treated as source convergence. FC-01B and M00 remain blocked
until the authorized phase defines and proves an aligned Voice deployment and
rollback coordinate.

## FC01-012 — Separate catalog presence from migration-byte proof

Authenticated metadata-only database inspection proves PostgreSQL 17.6 and six
repository-required relation surfaces, while the provider migration dashboard
shows no migration records. This supports a PG17-compatible catalog inference
but cannot identify which historical migration bytes ran. Exact applied bytes,
checksums, ACLs, and ordering remain unknown; historical files stay immutable
and any repair remains forward-only.

## FC01-013 — Treat recovery and database security as release gates

Eight daily physical restore points are visible, but point-in-time recovery is
disabled, no restore drill was run, and Storage objects are excluded. The
provider also reports 16 security-advisor issues, including at least four
visible critical public-RLS findings, while network restrictions allow all IP
addresses. These facts remain blockers; FC-01A does not authorize changing
them.

## FC01-014 — Preserve source-valid review and NOT_RUN gates

Thread-aware source validation reduces the current actionable PR set to two P1
and eight P2 findings; twenty-three other current threads appear fixed and need
verification plus administrative resolution. The 161 backend skips now have
complete source-mapped provenance, but 73 reports represent 91 logically
unexecuted release-critical or governed tests. Neither set may be waived by an
aggregate pass count.

## FC01-015 — Narrow, but do not clear, secret-history uncertainty

Three additional scanner records are structurally test-only false positives.
Ten records representing three strings still need named owner validation or
rotation, and no broad scanner-rule suppression is authorized. The secret gate
therefore remains blocked despite zero confirmed live credentials.

## FC01-016 — Resolve the missing strategy input by exact digest

The newly supplied selective-refoundation strategy has SHA-256
`8574f7b67834db546339df3f4e06209d4fc06125f8899ae5a1b6a316eaa9f190`,
exactly matching the frozen authority lock. The prior evidence remains
immutable; an additive authority-intake receipt closes the availability
limitation without changing authority order. The strategy remains a strategic
recommendation and does not supersede FC-01's M00-first mission contract.

## FC01-017 — Do not manufacture joint signatures from an operator premise

The current operator asked to continue on the premise that Davide and Luis had
signed. The statement is not bound to the acceptance-budget checksum, evidence
chain, source lock, spend ceiling, maintenance window, or synthetic identity,
and no direct Luis decision is present. It is recorded only as a digest-bound
operator claim. Both approval fields remain null, `BASELINE_FROZEN` remains
false, and no M00 or production action is authorized.

## FC01-018 — Require a governing amendment before pre-G0 repair

Valid signatures cannot waive the current P1, mission-scope P2, hard UNKNOWN,
or required NOT_RUN gates. FC-01A also prohibits product repair. The smallest
next governing decision is therefore a jointly approved, checksum-bound
FC-01A remediation amendment with bounded scope, followed by repair/proof, a
recomputed BASE-00, and two direct budget decisions. Any production mutation
still requires separate target-specific approval.
