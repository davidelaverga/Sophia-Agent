# Step 0a — acceptance record: the narrowed Voice Lab principal refusal

**Status: NOT YET ACCEPTED.** The campaign sponsor has recorded support in
principle (§3). The Voice owner's acceptance is §4 and is still blank.
Installing receiving authentication (release sequence step 2) is gated on §4
being signed, not on §3.

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

## 4. Voice owner's acceptance

> _Blank. To accept, the Voice owner records here: the clause list in §1 as
> accepted or amended, the date, and the identity accepting._

| field | value |
| --- | --- |
| Accepted clauses 1–8 as written | — |
| Amendments, if any | — |
| Accepted by | — |
| Date | — |

## 5. What acceptance authorizes, and what it does not

**Authorizes:** release sequence step 2 only — adding the `auth` entry to
`backend/langgraph.json` and updating the assertion in
`backend/tests/test_render_config.py:96` that currently pins its absence.

**Does not authorize:** enabling Voice Lab (`SOPHIA_VOICE_LAB_ENABLED` stays
`false`, `SOPHIA_VOICE_LAB_KILL_SWITCH` stays `true`), applying the serving
grants, declaring any account, pilot activation, provider obligations, or the
fault-injection RPC permissions.

**If the Voice owner declines:** receiving authentication is not installed, the
four migrated callers stay inert, and the campaign proceeds without it. That is
a smaller release, not a blocked one — but the unauthenticated receiving
boundary then remains an accepted risk rather than a closed one, and that choice
belongs in this file too.
