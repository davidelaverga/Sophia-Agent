# C2 receiving authentication — cross-owner maintenance coordination

**Status:** opened for coordination with the Voice owner. **Nothing here is
applied, deployed or activated.** No `langgraph.json` change, no caller change
and no new scope exist yet in the tree; this document states the exact coupling
and the options, so the decision that follows is the Voice owner's to make with
the facts in front of them rather than after the fact.

Parent: the current `codex/mem00-text-pilot` head. Pilot activation stays
closed, and none of this changes that.

---

## 1. What "receiving authentication" is still missing

The receiving side is written and unit-tested. `deerflow/sophia/langgraph_auth.py`
defines an `@auth.authenticate` handler that accepts two credential shapes:

| credential | verified by | resulting permissions |
| --- | --- | --- |
| `SophiaLG1 <token>` | `verify_service_authorization` | `readiness`, or `USER_PERMISSION` + `sophia:service` |
| `Bearer <token>` | Gateway `/api/sophia-auth/subject` bridge | `USER_PERMISSION` |

It is **not installed**. `backend/langgraph.json` has no `auth` key, and
`backend/tests/test_render_config.py:96` asserts exactly that:

```python
assert "auth" not in config
```

So today the deployed LangGraph server authenticates nothing, and the
`create_run` policy in the same module — including the undeclared-owner repair
in this slice — never runs in production. Installing it is a one-line config
change plus that assertion. The cost is entirely in what it breaks.

## 2. The four callers, and why they break on install

The Gateway has an owner-scoped SDK adapter,
`deerflow/sophia/langgraph_client_auth.get_client`, which attaches
`OwnerScopedAuth` and mints a per-request token from the current
`langgraph_owner_scope`. Most call sites already use it.

Four do not. They import `langgraph_sdk.get_client` directly, so they send no
credential at all and would receive `401` the moment the handler is installed:

| # | site | what it does | owner available? |
| --- | --- | --- | --- |
| 1 | `app/gateway/routers/builder_events.py:1405` | synthetic Builder cleanup for one obligation | `cleanup.test_principal_id` |
| 2 | `app/gateway/routers/builder_events.py:1606` | post-retention cleanup from the opaque obligation id alone | **no** — by design |
| 3 | `app/gateway/routers/builder_events.py:1779` | global reaper for expired obligations | **no** — by design |
| 4 | `app/gateway/workers/deck_quality_dispatcher.py:402` | deck-quality run dispatch | **no** |

Three of the four are Voice Lab's retention machinery and the fourth is deck
quality. All four are cross-owner by construction: (2) and (3) exist precisely
to keep working *after* the raw principal has been erased, which is a Voice Lab
retention obligation, not an incidental convenience.

## 3. The part that cannot be solved by adding an owner scope

Wrapping (1) in `langgraph_owner_scope(cleanup.test_principal_id)` looks like
the obvious fix. It does not work, and the reason matters:

```python
# deerflow/sophia/langgraph_service_auth.py, _scope()
if owner == (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip():
    raise LangGraphServiceAuthError()
```

The service-auth primitive **refuses to mint a token for the Voice Lab test
principal**, deliberately. That refusal is part of the MEM00/Voice Lab isolation
the campaign already committed to — the same rule that makes
`build_configured_memory_governance_worker` reject cohort overlap with Voice Lab
at startup. Reaching for it here to make cleanup work would quietly undo it.

So all four sites need a lane that is **not owner-scoped**, and creating one is
an authorization decision about Voice Lab's and deck quality's resources. That
is the coordination point.

## 4. Options, with what each costs

**A. Add a third scope to `_scope()`, alongside `readiness`.**

A `maintenance` scope for a fixed non-user principal, restricted to the exact
routes the four callers use (`POST /threads/search`, `GET`/`DELETE` on a thread,
run cancel), and refused for every real user id. The existing `readiness` scope
is the precedent: it is already a non-owner scope pinned to one exact route.

*Cost:* a principal that can enumerate and delete threads across owners. It must
be unable to read thread **state** or start runs, or it becomes a cross-owner
read primitive. This needs the Voice owner's sign-off on the exact route list.

**B. Keep the four unauthenticated by exempting their routes.**

*Cost:* rejected. It leaves an unauthenticated thread-search and thread-delete
surface on the deployed runtime, which is worse than the status quo because the
rest of the surface would now look authenticated.

**C. Install receiving authentication without touching the four.**

*Cost:* Voice Lab retention cleanup and deck-quality dispatch start failing with
`401` on the next deploy. Retention obligations are time-bound, so this is a
correctness failure for Voice Lab, not a degradation. Rejected unless the Voice
owner explicitly accepts a window.

**D. Defer install until the four are migrated.**

The status quo. Receiving authentication stays uninstalled, and the C2
`create_run` policy stays unexercised in production.

**Recommendation: A**, with the route list fixed and reviewed before any install,
and the install and the four caller changes shipped as one change rather than
two — because either half alone is one of C or D.

## 5. What the Voice owner is being asked to decide

1. Is a non-owner `maintenance` scope acceptable for Voice Lab's synthetic
   Builder cleanup and reaper paths, given that (2) and (3) cannot carry a
   principal by design?
2. Exactly which routes it may reach. The proposed minimum is thread search,
   thread read, thread delete and run cancel — **no** state read and **no** run
   create.
3. Whether deck-quality dispatch shares that scope or gets its own, given it
   *does* create runs and therefore needs a different route set.
4. Whether the Voice Lab principal refusal in `_scope()` stays absolute (the
   recommendation) or gains an exception. The recommendation is that it stays
   absolute and the maintenance scope never carries a user id at all.

## 6. Explicitly out of scope of this document

- Applying `backend/migrations/2026_09_17_mem00_c2_serving_grants.sql`, which
  remains unapplied and pending the coordinated release decision.
- Pilot activation, cohort changes, account declarations and production grants.
- The fault-injection RPC permissions, which are recorded separately.
- Any change to `_memory_flags` or the dedicated memory endpoints.
