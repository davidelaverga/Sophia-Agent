# Sophia background-work incident — 2026-09-29

## Scope

Read-only correlation of the live production voice session, browser telemetry, Render logs, LangGraph logs, and the signed-in LangSmith project. No deploy, configuration, data, Lab, memory, or retention changes were made.

## Incident identity

- Frontend deployment: `dpl_HQFC81JfbqGK2YHnpBTcCzvBaia4`.
- Parent thread: `01a0ea63-535c-7843-a35e-b49581d10201`.
- Production voice session: `gemini-prod-b0fe9242c3d0405f99568fdf69931d1e`.
- The browser emitted three `[Voice build request]` companion messages: two requests for competitive-AI-platform research/PDF and one simplified Markdown request.
- Sophia described the first two as unconfirmed and the third as not sent. No Builder task, run, progress event, or artifact appeared.

## Definitive backend evidence

| UTC | Gateway source action | LangGraph companion run | Result |
| --- | --- | --- | --- |
| 23:49:39 → 23:49:44 | `POST .../memory-source-actions` 200 | `POST /threads/01a0ea63.../runs/stream` | 403, request `d87e0f5e...` |
| 23:50:02 → 23:50:05 | 200 | same route | 403, request `36269a8b...` |
| 23:50:32 → 23:50:36 | 200 | same route | 403, request `a5b0746d...` |

Each LangGraph response was 33 bytes, exactly the policy body `{"detail":"sophia_access_denied"}`. This is an authorization-policy refusal after authentication, not a missing credential (which would be 401), timeout, model-provider failure, or Builder failure.

Gateway Builder-canvas snapshots remained `active_task_present=False`, `recent_events=0`; the SSE subscriber was connected and snapshots returned 200. Artifact lookup returned zero local, Builder-thread, Supabase, and merged artifacts. No `start_builder_task` launch or `gemini.builder_lifecycle` event exists. Therefore the request failed before the companion could call Builder.

## Where the refusal occurs

The voice UI intentionally routes mutating Builder actions through the governed text companion. The frontend first records a canonical source action, then posts the hidden `[Voice build request]` to the ordinary chat route. LangGraph's `langgraph_auth.create_run` collapses all owner/config/source-provenance failures to the same safe 403 body.

The strongest remaining cause is the governed create-run admission boundary: the Gateway successfully records each source action, but LangGraph cannot validate the owner/config/source witness when it receives the companion run. Candidate guards include the `langgraph_auth_user_id`/owner match and `issue_recorded_authenticated_input` readback of the source action. The deployed and current source-action wire keys match, so this is not a frontend/backend field-name version skew. Current logs do not expose a safe per-guard reason, so naming one exact guard would exceed the evidence.

## “Connection interrupted” is a separate event

The generic banner appeared after the failed Builder attempts. It maps to Gemini provider stage `connection_lost`, which is emitted only after an unexpected provider WebSocket close cannot be restored by continuation. Voice-service `/ready` stayed 200 and later continuation bootstrap returned 200 with a new `setupComplete`, so the session recovered. Builder-canvas SSE timeout/reconnect warnings are also separate: the stream reopened and continued returning an empty, healthy snapshot.

## LangSmith gap

The signed-in `Sophia-Gemini-Live-Voice` project has no trace for this session; its newest visible trace is from 2026-09-27. Voice logs still show EU multipart ingest rejected with HTTP 403 `{"error":"Forbidden"}` at 23:53:37 and 23:53:38 UTC. Thus LangSmith cannot provide the missing per-turn detail for this incident. This observability failure did not cause the LangGraph 403.

## Ranked causes and next fix

1. **Governed companion create-run admission mismatch** — proven failure boundary; likely source-witness/store readback or authenticated-owner/config mismatch. Add a content-free, enumerated denial code at each `langgraph_auth.create_run` guard, then reproduce one text turn for this owner. Keep the external body generic.
2. **Shared governance-store/config mismatch between Gateway and LangGraph** — consistent with Gateway accepting source actions while LangGraph refuses their readback; compare relevant endpoint/project/key identity privately and report only equal/not-equal.
3. **Parent-thread ownership/config drift** — less likely because Gateway ownership checks and Builder-canvas routes accept the thread, but LangGraph applies a separate owner filter.

The frontend fix is behaving usefully: it no longer claims a background build started when no run exists. The next code/config change belongs at the governed text-companion admission seam, not in voice audio or Builder execution.
