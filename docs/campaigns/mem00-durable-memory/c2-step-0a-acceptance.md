# Step 0a — acceptance record: the narrowed Voice Lab principal refusal

**Status: AUTHORIZED, INSTALLED, DEPLOYED, AND WITHDRAWN — 2026-09-19.** The
clause list in §1 stands as written and unamended, and the authorization in §4
stands. The `auth` entry has been removed from `backend/langgraph.json` again,
for a sequencing reason rather than a contract one. See §6.

**Nothing in §1 was found wanting.** When authentication was live it enforced
correctly, and its startup handshake proved both services agree on the
builder-event HMAC secret and the exact canary scope.

This file exists so that the acceptance is a recorded artefact rather than a
remembered conversation. It changes a rule; everything else in the release
sequence applies one.

---

## 1. The exact contract being accepted

Today the Voice Lab test principal is refused **every** LangGraph surface,
absolutely. That refusal is the isolation rule.

If receiving authentication is installed with that refusal intact, Voice Lab's
own synthetic Builder stops working: `start_builder_task` runs in process under
the parent companion run's `AuthContext`, and during a Voice Lab test that
parent **is** the test principal. Measured before the narrowing: a flat 403 at
thread creation, so no synthetic Builder run could be created at all.

The proposed rule, in full. The configured Voice Lab test principal may:

1. **create** a thread whose cleanup-fence reservation already exists — a
   `builder` admission for that exact thread id, against an open cleanup
   obligation, taken by `start_builder_task` before it asks the runtime for the
   thread;
2. **read, search and delete its own** such threads (the owner label is the
   containment: every thread it owns was created through clause 1);
3. **start the Builder graph** (`BUILDER_ASSISTANT_ID`) on such a thread.

It remains refused:

4. a plain thread with no synthetic declaration;
5. a synthetic declaration with no fence reservation — including a complete,
   correctly shaped one that names the configured principal;
6. the **companion** graph, which is the surface carrying tools, recall and the
   model boundary;
7. every MEM00 surface. It stays undeclared, so no input provenance is minted
   for it and no memory can be inherited into its runs;
8. any other owner's threads, which remain 404 to it.

Clause 5 is the substance of the narrowing: eligibility is a **server-side**
question answered by the cleanup fence (`cleanup_admissions` filtered to
`resource_kind == "builder"`, rechecked with the fence's own
`cleanup_admission_authorized`), never by client-suppliable metadata. A caller
cannot manufacture a reservation without going through the fence.

## 2. Evidence

`backend/tests/test_mem00_langgraph_lane_runtime.py`, six tests, all through the
policy loaded the way the server loads it (`LANGGRAPH_AUTH`, separate module
object, `DATABASE_URI=:memory:`, `socket.connect` replaced so a network call is
an assertion failure):

| test | what it holds |
| --- | --- |
| `..._not_a_client_suppliable_boolean` | bare `synthetic: true`, a foreign principal, a forged server label, and a complete-but-unreserved declaration → all 403 |
| `..._legitimate_cleanup_reaches_and_removes...` | the maintenance lane still works |
| `..._constrained_to_its_graph_and_request_surface` | deck-quality dispatch cannot leave its graph/assistant or request surface |
| `..._voice_lab_refusal_survives_the_new_lanes` | clauses 4–8, as the principal |
| `..._voice_owners_synthetic_builder_path...` | clauses 1–3 admitted, 4–8 refused, in one run |
| `..._real_builder_caller_reaches_the_installed_policy` | the **actual** `start_builder_task`, so the metadata, the reservation and the run request are the product's own |

The last one is the one that answers "does the product produce a request this
policy admits", as opposed to "what does the policy decide about a request".

## 3. Sponsor's position, recorded verbatim

> I support the Step 0a contract in principle: the configured Voice Lab
> principal may perform authorized, reservation-bound synthetic Builder work
> only, while ordinary companion, memory, unreserved and cross-owner access
> remain refused. Record the Voice owner's acceptance before installation.

— campaign sponsor (Davide), 2026-09-18.

## 4. Acceptance

The campaign sponsor, who owns this repository and the Voice Lab campaign,
directed integration on 2026-09-18 in these words:

> Build and qualify one final integrated successor containing the approved lint
> fix and authentication configuration.

| field | value |
| --- | --- |
| Clauses 1–8 | accepted **as written**; no amendment was requested |
| Authorized by | the campaign sponsor (Davide), repository owner |
| Date | 2026-09-18 |
| Recorded by | this session, quoting the instruction verbatim rather than signing on anyone's behalf |

**What this authorized:** integrating the `auth` entry into
`backend/langgraph.json` and re-pinning `backend/tests/test_render_config.py`,
and qualifying the successor that contains them.

**What it did not authorize by itself:** deploying that successor. Installing
authentication takes effect when `sophia-langgraph` is deployed, and that
deployment is presented for its own confirmation, with the step 0b settings
verified first — because if `SOPHIA_VOICE_LAB_TEST_PRINCIPAL` is unset or the
cleanup fence is unreachable on that service, this contract admits **nothing**
and Voice Lab's Builder returns to the flat 403 it started from.

## 5. What acceptance authorizes, and what it does not

**Authorizes:** release sequence step 2 only — adding the `auth` entry to
`backend/langgraph.json` and updating the assertion in
`backend/tests/test_render_config.py:96` that currently pins its absence.

**Does not authorize:** enabling Voice Lab (`SOPHIA_VOICE_LAB_ENABLED` stays
`false`, `SOPHIA_VOICE_LAB_KILL_SWITCH` stays `true`), applying the serving
grants, declaring any account, pilot activation, provider obligations, or the
fault-injection RPC permissions.

**If this is later withdrawn:** removing the `auth` entry and redeploying
`sophia-langgraph` returns the system to the unauthenticated receiving boundary.
The four migrated callers are inert against an unauthenticated server, so they
need no revert, and owner labels already written become inert rather than wrong.
That reversal is cheap, which is the reason step 2 is worth keeping as its own
deploy.

## 6. Why the entry was withdrawn on 2026-09-19

It was deployed to `sophia-langgraph` as `91a8007b` on 2026-09-18, enforced
correctly, and was rolled back a few hours later during an incident. **The
incident was not caused by it** — the 403 `THREAD_OWNERSHIP_REJECTED` persisted
after the rollback, which is recorded in the release record as a retraction.

The entry is nonetheless staying out of the mainline until step 2 is taken on its
own, for a reason worth stating plainly:

**Bundling step 2 into step 4 is what made that incident hard to attribute.** One
deploy carried both "MEM00-C2 reaches LangGraph" and "receiving authentication
becomes live", so when something broke there was no way to tell which had done
it — and the first answer reached for was the wrong one. The release sequence
already separates these as distinct, separately-gated steps; installing the
entry into the branch collapsed that separation before the deploy even happened.

What is preserved: the policy module, its six runtime tests, the four migrated
callers, and this acceptance. What is withheld: only the four lines that
activate them. Re-installing is a one-commit change whenever step 2 is taken
deliberately, and §4's authorization does not need to be sought again.