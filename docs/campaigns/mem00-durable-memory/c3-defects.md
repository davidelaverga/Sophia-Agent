# Closure correction — 2026-09-22

Release blockers repaired and hosted-verified: frontend accepted-source timestamp rewrite (ef12097b, deployedb103c4af) and ordinary companion warm-recovery refusal (63d9810, deployed). The final same-thread edit/forget journey completed with current/empty final manifests and verified provider cleanup. See c3-hosted-acceptance-2026-09-22.md. **MEMORY_TEXT_PILOT_READY** is limited to the bounded ordinary text pilot.

Fresh app rerun (c3-app-e2e-2026-09-22.md) also observed a combined duplicate recap candidate, broad semantic match to the one approved record for a different project query, and an explicitly false explanation that Journal is separate from Sophia memory. Rejected content was not admitted; warm edit/forget and physical cleanup passed. These are recorded, not silently fixed.

Follow-up defects: (1) Journal projection-status observation says unavailable despite verified effects; (2) no-memory response gives speculative authorization/session-scope explanations; (3) older exhausted extraction targets and prior database lock observation need exact-source investigation if historical recovery is required; (4) startup YAML scanner and Deck-quality reporting403 remain outside this passing memory path. Separate Claude clear/new-session edge case is not claimed repaired. No full destructive matrix, provider replacement or client migration is required for first use.

Earlier D1 causal hypotheses and deployment statuses below are historical, not instructions to implement a dangling-tool-call workaround. D2 wrong-owner hypothesis remains retracted.

---

# Current correction — 2026-09-22

The entries below are historical hypotheses, not the current diagnosis. Claude's 2026-09-21 15:58Z capture shows a real background-run MemoryContextUnavailable failure in before_agent. A parsed model result or HTTP 200 never proved complete graph success. The dangling-tool-call explanation and automatic persistence workaround below are unproven and must not be implemented without causal evidence. Installed local langgraph-api 0.8.1 emits relative Content-Location; its absence in production has not been demonstrated.

D2 wrong-owner-on-run is **retracted**: correct owner appeared on the run; default_user appeared on GET /state. The subsequent `13eb09d3` refusal diagnostic awaits a hosted failing-turn receipt. Latest retained test thread now returns owner-scoped 404, so it cannot supply that old state. See c3-current-state.md for current obligations and exact versions.

---

# MEM00-C3 — open defects

Date: 2026-09-20. Frontend `dpl_99vszUEXAXnZ5LP68EPKWJ3w843t` (`a5982c6`, `frontend/` ≡ r8).

---

## D1 — governed turns fail confirmation; a lost tool-call continuation bricks the session

**Severity: release-blocking.** Not cosmetic.

### Symptom
Every governed text turn raises *"Connection interrupted. Retry?"* after the response has fully streamed. On simple turns the assistant message still persists. **On a turn containing a tool call, the continuation is lost and the thread becomes permanently unusable** — every later turn in that thread returns no response.

Reproduced 5/5 on `dpl_99vszUEXAXnZ5LP68EPKWJ3w843t`. Session `f1a7f011-b57e-4b86-841d-ef2cacc95663` is a live example: three user messages after a `retrieve_memories` call, zero responses.

### Mechanism (traced)
`frontend/src/app/api/chat/_lib/stream-transformers.ts:1019-1027`:

```js
if (done) {
  ensureTextEnd();
  if (confirmCompletion && !(await confirmCompletion())) {
    emit({ type: 'error', errorText: 'memory_source_send_unconfirmed' });
    safeClose();
    return;            // artifacts, meta and finalization discarded
  }
```

`memory_source_send_unconfirmed` → `frontend/src/app/lib/error-copy.ts` → `connectionInterrupted: "Connection interrupted. Retry?"`.

`post-handler.ts:389` wires `confirmCompletion` **only when `sourceAction` is set**, which happens only for a governed owner. **The defect was latent until the Phase D owner declaration activated it** — it was not introduced by the frontend deploy.

Consequence chain for tool-call turns: confirmation fails → stream aborts → continuation never persisted → dangling tool call left in thread state → all later turns fail. `CLAUDE.md` documents this hazard (`DanglingToolCallMiddleware`; PR #129's note that a bad dispatch "would loop on dangling tool calls").

### Ruled out
- **Not a transport/edge failure.** `POST /api/chat → 200` every time in Vercel logs, no error text.
- **Not a model failure.** LangSmith shows `memory.model.transport → response_headers_received` and `memory.model.result → parsed_result_recorded`. The run completes and records a result.
- **Not the 3-poll cap in `run-completion.ts`.** That bound is deliberate and asserted by `frontend/src/__tests__/api/chat/run-completion.test.ts` — *"allows bounded pending/running visibility to settle, not an unbounded poll."* Raising it would break an intentional contract and is the wrong fix.

### Leading hypothesis (untested)
`run-completion.ts` is written against a specific server behaviour:

> *"The installed server issues relative Content-Location and owner-filters GET /threads/{thread}/runs/{run}."*

```js
const location = upstream.headers.get('content-location')?.match(LOCATION);
const runId = location?.[1] === threadId ? location[2] : null;
if (!url || !runId || !token || signal?.aborted) return false;   // instant false, no network call
```

Render logs show the deployment runs `api_variant=local_dev`, `langgraph_api_version=0.8.1`. If that build does not emit a relative `Content-Location`, `confirmCompletion()` returns `false` deterministically with no network call — which matches the observed 5/5 determinism and the full-response-then-error ordering. The backend repo contains **zero** references to `content-location`, so nothing guarantees the Gateway forwards it either.

A second candidate: the poll target `{SOPHIA_LANGGRAPH_BASE_URL}/threads/{id}/runs/{id}` returning non-200.

### Discriminating test (not yet run)
Live-tail `sophia-langgraph` on Render **without typing in the search box** (entering a search freezes the tail), send one governed text turn, and read the `POST /threads/{id}/runs/stream` lines — establishing whether `Content-Location` is emitted and what the run-status GET returns.

### Candidate fixes (decide after the test)
1. If the header is absent: emit it from the Gateway/LangGraph, **or** give `run-completion.ts` a documented fallback that identifies the run without it. Preserve the existing safety intent — only the original authenticated run may confirm a finish.
2. Independently, make a failed confirmation **non-destructive**: persist the assistant message and resolve any dangling tool call before surfacing the error, so a failed check degrades to a warning instead of bricking the thread.

Fix 2 is worth doing regardless of the root cause, because it removes the permanent-damage property.

---

## D2 — memory context entry denied as `unavailable`; LangGraph resolves `default_user`

**Severity: high — likely why recall-after-edit never answered.** Correlated, not proven.

LangSmith logged `memory.context.entry_denied → unavailable` at 22:55:38, exactly on the failing recall turn.

Render logs show the LangGraph service resolving governance for the wrong principal:

```
GET …/sophia_memory_user_governance?…&user_id=eq.default_user&limit=2
Creating Sophia companion agent: platform=voice, ritual=None, context_mode=life
```

`default_user` is **not** a declared governed owner — only `CUyZxRFmDNONbR0eKqkJjTrJ2z8nkDKd` is. An undeclared principal yields unknown authority, and unknown authority denies memory by design. The `platform=voice` line (the session was in **text** mode, context **Gaming**) points the same way: the `configurable` context is not arriving. `CLAUDE.md` constraint #6 makes that signal mandatory on every DeerFlow request.

**Caveat, stated plainly:** every observed `default_user` line is on `path=/threads/{thread_id}/state` — a state read, not a run. No run-path line has yet been captured showing a mis-scoped principal. This is a strong correlation, **not** proof that runs are mis-scoped. The same discriminating test as D1 settles it.

---

## Retracted — recorded so they are not re-investigated

- **"Journal/Pool UI is broken."** False. The guard is `document.visibilityState === 'hidden'` in `JournalPageClient.tsx:573`, which deliberately refuses to display memory when the surface is not verifiably visible. The symptom was caused by driving a closed/backgrounded browser pane. Correct behaviour.
- **"Projection is not happening."** False. Mem0 shows both approved memories stored, correct namespace, `Active`. `projection_state: "unavailable"` alongside `provider_state_queried: false` means "not queried", which is the required canonical-vs-provider honesty, not a failure.

---

## Observations carried forward, not investigated

- The three historical session-start 502s were attributed in the C2 release record to the Vercel proxy in front of the **old** frontend. The frontend has now changed; that attribution should be rechecked rather than inherited.
- The stranded 2026-08-21 session still appears in the session list ("Hey, Sofia", 7 turns, Archived). Untouched.
- Supabase Security Advisor reports 17 issues including CRITICAL *RLS Disabled in Public* on `turn_feedback` and three `*_backup_20251127` tables. Pre-existing, out of MEM00 scope, spun out as a separate task.
- Historical Postgres error volume is **15 errors / 24h** — the 2,602-error card is not an active pattern.
