# Would Gemini 3.8 Live fix Sophia's voice-to-Builder failures? Final assessment (2026-09-29)

Scope: research and read-only code checks only. Nothing was edited or deployed, and no production service was called. Code references are to the production commits: LangGraph `def5c454`, gateway `eb849b62`, web and voice `6f6545d6`.

---

## 1. Short answer

**No. Switching to Gemini 3.8 Live would not have prevented the three 403s. It would not have prevented the earlier `memory_context_rotation_required` failure either.**

- Both failures are refusals inside Sophia's own governed admission: the LangGraph `create_run` hook and the companion's `before_agent` check.
- Those checks receive the same hidden turn whichever voice model sent the tool call.
- 3.8's "native async tool calling" changes the session protocol, not where work runs. The model can keep talking while a call is pending, and you choose when the result is spoken. The tool still runs in whoever holds the socket, which for Sophia is the browser. Google offers no durable, authorized job runtime, so the Builder has to stay where it is.
- Its most visible benefit, pushing "your build is ready" into the conversation, already works on 3.1 through the app-context injection the browser uses today. The benefit that really is 3.8-only is non-blocking dispatch: no silence while a build is being confirmed.
- **Recommendation:** fix the admission path first (diagnostics, then the root cause). Treat 3.8 as a later, non-urgent upgrade that is measured before it ships.

---

## 2. What 3.8 Live async tool calling actually is

**Source access.** `ai.google.dev`, `docs.cloud.google.com`, `discuss.ai.google.dev`, `blog.google` and `firebase.google.com` were blocked in every research session.
- Claims from those sites are marked **[snippet-only]**: seen in search results but not fetched.
- **[fetched]** means the source was retrieved and read directly: Google's gemini-skills and cookbook repos, the API discovery documents and proto, the SDK source, the cloud.google.com GA blog and pricing page, and GitHub issues.

### Models, stage, availability
- **`gemini-3.8-live`.**
  - Tools are `NON_BLOCKING` by default.
  - `BLOCKING` is kept "for backwards compatibility" and still accepted [SKILL, MIG fetched; pydantic-ai profile fetched].
- **`gemini-3.8-live-extended-thinking`.**
  - Accepts only `NON_BLOCKING`. It closes the session with code 1007 on `BLOCKING` or on any `scheduling` field. This applies to Extended Thinking only [MIG, PAI-8393 fetched].
  - It is in private preview on Vertex [BLOG38 fetched].
  - One report found no tool call emitted in 39 of 64 runs [GENAI3015 fetched].
  - Not recommended for Sophia.
- **Launch stage.**
  - Gemini Developer API (the API Sophia uses): GA since 2026-09-15 [CB-LIVE fetched; A-CL snippet-only].
  - Vertex: "Gemini 3.8 Live with Live Avatar is now generally available … US and EU endpoints" (2026-09-24) [BLOG38 fetched]. No EU location ID was found, and the Vertex pricing table shows only "Non-global" [PRICE fetched].
- **What Sophia runs today.** `gemini-3.1-flash-live-preview` (`voice/realtime/gemini_live.py:18`). It is a preview model now listed as legacy, with no shutdown date [A-DEP snippet-only]. The real comparison is a two-week-old GA model against a legacy preview model, not "new risk" against "safe status quo".

### Documented semantics
- **`FunctionDeclaration.behavior`** takes `UNSPECIFIED | BLOCKING | NON_BLOCKING` [DISC-B, DISC-V, JSSDK fetched].
  - Sophia sets `behavior` on no tool at `6f6545d6`.
  - On 3.8 every declared tool therefore becomes `NON_BLOCKING` by default, including `retrieve_memories` and `emit_artifact`.
- **`FunctionResponse.scheduling`** takes `SILENT | WHEN_IDLE | INTERRUPT`. It applies only to NON_BLOCKING calls and defaults to `WHEN_IDLE` [DISC-B, PYSDK fetched].
  - The docs' "INTERRUPTED" is a typo.
  - `WHEN_IDLE` by definition prompts the model to generate output [PYSDK fetched]. Responses that should not be spoken, such as `emit_artifact`, therefore need `SILENT`.
  - Unconfirmed: that 3.8 downgrades `INTERRUPT` to `WHEN_IDLE` while the user is speaking, and that new input cancels a BLOCKING call [D-38, D-MIG snippet-only].
  - Unconfirmed: that `SILENT` does not guarantee silence [A-TOOLS snippet-only].
- **`will_continue`** streams progress responses for one call. It exists only on the Developer API, "not supported in Vertex AI" [PYSDK, JSSDK, DISC-V fetched], and it ends with the connection.
- **`interaction_status`** (`IN_PROGRESS` / `IDLE`) sits on `server_content`, not on the top-level message.
  - Google's own skill and cookbook samples read it from the wrong place [PYSDK, JSSDK fetched].
  - Python `receive()` handles IDLE only from 2.23.0 [PYCL fetched].
  - Whether plain 3.8 sends it at all is unverified.
- **`send_client_content`** is allowed for the whole session on 3.8, with roles `user` and `model`. `turn_complete=true` interrupts active generation [SKILL, MIG fetched].
- **`toolCallCancellation`** "occurs only in cases where the clients interrupt server turns" [PROTO fetched]. Nothing documents whether barge-in cancels a NON_BLOCKING call.
- **Where tools run: the client.** The proto describes a tool call as a "Request for the client to execute the function_calls" [PROTO fetched].
  - Live has no automatic function calling [CB-TOOLS fetched].
  - MCP tools are converted into function declarations on the client [PYSDK fetched].
  - A `FunctionCall` carries only `args`, `name` and `id`: no identity and no signature [DISC-A fetched].
  - No Google guidance on authenticating Live tool calls was found.

### Limits that matter for Builder
- A connection lasts about 10 minutes. An audio session lasts 15 minutes without context compression [SKILL fetched].
- **Resumption.** The server may withhold resumption handles "at some points … for example, when the model is executing function calls or generating" [PROTO fetched].
  - Third-party live tests found that a resumed 3.8 session never accepts the lost call's result, and swallows the user's next turn unless the lost call is answered with an error [PAI fetched].
  - pydantic-ai declares tools BLOCKING by default on 3.8 and does not say NON_BLOCKING was tested. For Sophia's intended design this is **unverified**; it is a spike item.
  - Prudent design either way: never hold a Builder call open across a socket rotation.
- 3.8 stays silent after a handoff or re-seed until new input arrives [EX-58, CB-1390 fetched; EX-58 open with no Google response].
- No pending-call timeout and no cap on concurrent pending calls are documented.

### Durable execution: none offered
- **ADK.** `LongRunningFunctionTool` guidance says "implement a separate server" for long tasks. ADK cancels background tools when the live run ends, including when the connection closes [ADK fetched].
- **A third-party sample** linked from Google's GA blog (awesome-llm-apps, `insurance_claim_live_agent_team`) caps its background workflow at 75 s and cancels it on disconnect [AWESOME fetched]. This is community code, not a Google pattern.
- **Interactions API `background:true`** runs Google-hosted agents, not a LangGraph Builder [A-BG snippet-only].

### SDKs and frameworks
- **SDK versions.** Use google-genai 2.23.0 or later and @google/genai 2.18.0 or later for IDLE handling. The latest releases are 2.25.0 and 2.24.0 [PYCL, JSCL fetched]. The skill's stated minimum is too low.
- **ADK Live** [ADK fetched]:
  - marked "Experimental";
  - its docs and source never mention `gemini-3.8-live`;
  - Live `behavior` support arrived only in 2.10.0 (2026-09-24);
  - no `toolCallCancellation` handling.
- **Vision Agents.** Its Gemini plugin defaults to 3.8 with a 30 s tool timeout [VA fetched]. Sophia does not use that plugin:
  - vision-agents is installed without the `gemini` extra (`voice/requirements.txt`);
  - Sophia's Live path is its own browser WebSocket.
  - The timeout matters only if Option C (below) adopts the plugin.

### Vertex and EU
- **Vertex has no ephemeral tokens.** `auth_tokens.create` is "only supported in the Gemini Developer client" [PYSDK fetched], and the Vertex discovery document has no AuthToken schema [DISC-V fetched]. Using Vertex therefore implies a server-side WebSocket proxy (an inference, but a sound one).
- **Vertex scheduling support.** The current Vertex v1 and v1beta1 discovery schemas (rev 20260920) include `FunctionResponse.scheduling` and `id` [DISC-V fetched]. The earlier "no scheduling on Vertex" claim came from a LiveKit plugin code comment pinned to an old SDK commit. Only runtime behaviour on Vertex is untested.
- **EU residency.** No Developer API EU residency commitment was found [snippet-only / third-party]. The Developer API is the same for 3.1 and 3.8, so moving to 3.8 there is residency-neutral.

### What actually changes for Sophia's current setup (corrected)
- **Proactive audio goes from unavailable to permanently on.** Sending `proactive_audio:false` returns an error [MIG fetched].
  - This is the real persona and turn-policy change. It interacts with the existing over-continuation turn-policy work.
  - Vertex pricing: "Proactive Audio Mode: When enabled, input tokens are charged while LiveAPI is listening" [PRICE fetched].
- **Every tool defaults to NON_BLOCKING**, because Sophia sets no `behavior`.
- **It is a new base model.** The model card says "Based on Gemini 3 Pro" and notes "occasional slowness or timeout issues" [CARD fetched].
- **Not losses** (the earlier draft was wrong on these):
  - Affective dialogue and proactivity were never supported on 3.1, and Sophia never configured them (setup builder `gemini_live.py:1024-1072`).
  - The turn-coverage default is unchanged.
  - Sophia does not set `thinkingLevel`.
- **Response modality conflict.** MIG says AUDIO is the only response modality, but CB-TOOLS shows TEXT working. Sophia uses audio, so this is low impact.
- **Cost.**
  - Per-token parity with 3.1 on the Developer API is supported only by LiteLLM's price table and search snippets.
  - Per-token is not per-session. "Tokens from past turns are re-processed and billed in every new turn" [PRICE fetched].
  - Forced proactive audio, fillers, `WHEN_IDLE` generations and pushed completions each add full-context turns.
  - LiveKit measured $0.070 vs $0.053 per minute from placeholder scheduling alone [LKJS2595 fetched].

### Reported issues: a client-handling checklist, not proof of model defects
- **LK7302:** hybrid behaviour when `behavior` is unset; results held until audio playout finishes.
- **LKJS2593:** model fillers mistaken for barge-in, cancelling the call.
- **LKJS2595:** `willContinue` placeholders under `WHEN_IDLE` cause empty turns and repeated calls; `SILENT` fixes it.
- **AOS453:** a tool call arriving after `turn_complete` was dropped by the client's receive loop (closed). This is a client bug, not a server defect.
- **GENAI1894:** speculative answers while a call is pending. Observed on 2.5 native audio, not 3.8.
- **GENAI2981:** no `VoiceActivity` events on 3.8.
- **GENAI3015:** Extended Thinking tool-call failures. The base 3.8 sample is tiny (2 passes, 2 failures).

---

## 3. Hop-by-hop impact on the voice-to-Builder chain

| Hop | Today (3.1, `6f6545d6` / `def5c454` / `eb849b62`) | With 3.8 async | Changes? |
|---|---|---|---|
| H0: Gemini emits `start_builder_task` | Synchronous; the model waits | NON_BLOCKING by default; the model keeps talking | **Yes (experience).** New risks: speculative "it's started" claims that break the rule "launch means accepted" (`sophia_prompt.py:135-137`); duplicate calls |
| H1: browser Lane C routing and 1.5 s transcript grace | Browser holds the socket and runs tools | Same. Developer API with ephemeral tokens keeps the browser as executor | No. The rotation fence is still needed; handling a lost call after resume is an open question |
| H2: explicit-request and duplicate guards; confirm-and-poll up to 25 s | 25 s wait applies only without PR #164; with #164 a failed turn returns early | Can return an immediate `SILENT` acknowledgement and confirm later | Partly. A fast acknowledgement with later confirmation is also buildable on 3.1 |
| H3–H5: source-intent capture, record source action (**succeeded**), AI SDK send | Governance | Same | No |
| H6: `/api/chat` → `runs/stream` | Governed web path | Same | No |
| **H7: LangGraph `create_run` admission (this incident)** | `langgraph_auth.py:420-553`; a dozen direct `_deny()` sites plus `except Exception: _deny()` | Same | **No. Would not have prevented the 403s** |
| **H8: companion `before_agent` (earlier incident)** | `memory_context` `enter()` witness recheck → `rotation_required` | Same | **No** |
| H9: Haiku must choose `start_builder_task` again; governed path rejects `edit_context` | Two model decisions | Same | No |
| H10–H11: handoff mint, Builder `create_run` handoff branch, Builder entry recheck | Governance | Same | No |
| H12: progress via BuilderProgressMiddleware, canvas snapshot, SSE | Durable, outside Live | Same. `will_continue` is Developer-API-only and ends with the connection | No |
| H13: outcome reported to Gemini | 403 surfaces as "unconfirmed" (`memory_source_send_unconfirmed` → `builder_start_unconfirmed`) | Same unless the web maps it to a definite refusal | No. This is a model-independent web fix |
| H14: completion reaches Gemini | Pull only today, but push is possible now via `realtimeInput.text` app-context injection (`gemini-browser-live-websocket-dogfood.ts:2326-2346, 4687-4710`) | Push via `send_client_content` or `realtimeInput.text` | **Not 3.8-specific** |

Net effect: 3.8 changes H0 and part of H2. Every hop where the two incidents happened (H3–H11) is unchanged.

On the silence: the earlier claim of "about 20–30 s of dead air per attempt" is dropped. The requests were 21 s and 31 s apart. That is inconsistent with back-to-back full 25 s waits, so either PR #164 was live or the attempts overlapped. What the timing does show is that uncertain results drive retries: three governed source actions in 52 s.

---

## 4. Options compared and recommended path

| Option | Prevents the observed 403? | Removes hidden turn | Completion push | Latency | Cost | Effort | Risk |
|---|---|---|---|---|---|---|---|
| **0. Fix admission on the current stack (3.1)** | **Yes. This is the only lever that can** | No | Yes, via `realtimeInput.text` | None | None | Low–medium | Low |
| A. 3.8 with NON_BLOCKING Builder tools, current browser topology | No | No | Yes, but 3.1 can too | 3.8 first-audio time unmeasured (go/no-go for the 3-second target); dispatch silence hidden | Unknown. Parity is third-party-sourced; proactive audio and extra turns likely raise cost per minute | Low–medium: model via env var; `behavior` needs a web change | Medium: new model, forced proactive audio, default NON_BLOCKING, more retries |
| B. Dedicated governed voice→Builder lane (3.1 or 3.8) | Not by itself. It helps only if the root cause is specific to the hidden turn, and must land after any persister fix | Yes | No; combine with push | Removes a Haiku turn and the middleware chain from time-to-dispatch (unmeasured); spoken latency unchanged | Lower: one fewer LLM turn | Medium–high: new proof type, security review | Medium: governance design |
| C. Server-side Live session (voice service holds the socket; Vertex optional for EU) | No; only together with B and the root-cause fix | Yes, with B | Yes | Adds a hop on the audio path | Proxy infrastructure | High | High: re-architects the voice path that works |
| D. ADK Live with long-running tools | No | Partly | Yes | n/a | n/a | Very high | High: experimental; a competing session/memory layer conflicts with Mem0 as single authority; ADK itself says to build a separate server |

No option breaks a CLAUDE.md hard constraint outright, except D (a second memory authority).

### Now (days; no model change)

**1. Diagnostics before any schema-level fix.**
- Give every `_deny()` in `create_run` a safe reason code (class and code only, no content). That covers:
  - the pre-`try` owner/config sites (`langgraph_auth.py:422-493`);
  - the direct in-`try` sites (`command` present; assistant id or `active_governed_tool_owner`);
  - the `except Exception` branch (548-550).
  - Logging only the last one would miss most refusal paths.
- Carry the inner witness reason out of `source_input_provenance`, where `from None` (around :67-68 and :85-86) erases it today. Emit it as a safe code.
- On the web, stop discarding the upstream body and code (`post-handler.ts:291-298`).
- Pull `memory.context.entry_denied` (`error_type`, `denied_at_line`) for runs `01a0e866-…` from Render logs. That logging came in `13eb09d3`, which is an ancestor of `def5c454`, so it is there if the earlier incident ran on such a build.

**2. Cheap read-only discriminators.**
- Run one typed-text Builder request on the same deploy. It is not established that typed text works.
- For the three sessions, check:
  - the owner-authority state and store health (a `resolve_owner_authority` store failure falls into `_deny()`);
  - the partition conditions in `sophia_memory_source_snapshot` (`epoch_source_target.sql:17-40`): duplicate sequences or message_ids, sequence ≤ 0, a row with another `thread_id`, a fenced session, or a disallowed status. Any of these fails **every** governed send in the session;
  - each governed row against its intake receipt: sequence, presence, `memory_source_version`, `acceptance_epoch`, `accepted_version`, `created_at`.

**3. Candidate root causes, ranked by fit (none confirmed).**
- **(a) A deterministic refusal.** Candidates: an owner/config deny before the `try`, `memory_source_partition_unavailable`, or an owner-authority store failure. The consistency (3 of 3 at H7 today, 2 of 2 at H8 earlier) favours a deterministic cause.
- **(b) H\*: the transcript persister renumbers or deletes the governed row.** This rotates `memory_source_version`, so the witness recheck fails.
  - The mechanism is confirmed:
    - `PUT` renumbers by payload position (`sessions.py:1660-1667`);
    - the snapshot upsert overwrites changed columns and deletes missing rows (`fc01_m01_c2…sql:49-96`);
    - any column change rotates the version (`dependency_authority.sql:75-87`).
  - The timing is weak for H7:
    - Intake bumps `message_revision` (`source_intake.sql:125`), so the first `PUT` after intake always hits a revision conflict.
    - The rebase keeps the governed row at its database sequence and appends local rows after it.
    - Renumbering needs a later accepted write built from local order: a 700 ms debounce plus about three round trips.
    - That fits the earlier H8 failure better than a denial about a second after send.
  - Two corrections:
    - At `memory_clear_epoch` 0, intake leaves `accepted_version` NULL.
    - A row deleted and reinserted at epoch 0 is still eligible, but fails on a `source_version` mismatch.
- **(c) A second positional writer.** `GET /messages` rebuilds the transcript from LangGraph thread state when it has no assistant rows (`sessions.py:1432-1530`). That rebuild deletes any governed row whose run was refused. It matters for retries and for what happens after a refusal.

**4. Fix once the refusal subtype is known.** If H\* is confirmed:
- Make governed rows server-owned in `sophia_replace_session_messages`, identified by their intake receipt (`source_row_id`), **not** by `accepted_version`, which is NULL at epoch 0.
- The server keeps each existing row's sequence, assigns sequences only to new rows, keeps sequence and message_id unique across the partition, and never deletes receipted rows.
- Stopgap: flush pending transcript snapshots before recording a source action. This only covers the pending-local-row case.

**5. Model-independent hardening.**
- **Definite refusals.** Map an upstream 403 on the governed send to `builder_start_refused`, so Sophia says the build could not start instead of retrying.
- **Server-side idempotency for voice Builder requests.**
  - Today each retry mints a new `command_key` and `message_id`, so each retry is a new source action and a new hidden turn.
  - The only protection across attempts is the client's canvas `builder_already_running` check.
- **Prototype a completion push on 3.1** via `realtimeInput.text`:
  - derive it from durable Builder state;
  - keep a per-task "announced" marker;
  - replay it on every socket activation (rotation, tab suspension) without announcing twice.

**6. Governance decision needed from Davide, whatever model is used.**
- Today the hidden turn records app-written text as a user-attributed governed source row: "I asked for this by voice … Brief: <Gemini's model-written text>" (`voice-builder-actions.ts:189-197`).
- The source-only Builder then consumes that text as user input.

### Next (weeks, after the root cause is known): Option B as a candidate simplification
- **It needs a new handoff proof type.** It cannot reuse `dispatch_independent_builder` / `issue_builder_handoff` as they are: both require an enabled, admitted companion `MemoryRunGuard`, and both derive the child thread from the companion's `INPUT_RUN_KEY` and `tool_call_id`. Security review by Davide.
- **Idempotency key:** derive it from the source action's `command_key`, using `threads.create(if_exists="raise")` plus the observe step.
- **Wire shape:**
  - Carry the handoff in `configurable`; the hook denies it in `context`.
  - Pass `platform`. The existing Builder dispatch omits it, which is a gap under hard constraint #6.
  - Validate `task_type` against `_CANONICAL_TASK_TYPES`.
  - Keep outputs under `/mnt/user-data/outputs/`.
- **Voice context cannot be recovered through Spec D.** Only companion turns write the delegation ledger, so `read_session_context` would see no voice conversation. Design an explicit voice-origin source instead: the verbatim final user transcript segment, with the model's brief marked as derived and untrusted.
- **Sequencing:** if B's source row lives in `sophia_session_messages`, B must land after the persister fix.

### Later (non-urgent: 3.1 has no shutdown date)
- **Migrate to base `gemini-3.8-live`** on the Developer API with the browser topology, gated on the experiment in §6. Use explicit per-tool `behavior`:
  - `retrieve_memories`: BLOCKING;
  - `emit_artifact` responses: `SILENT`;
  - `start_builder_task`: NON_BLOCKING with a `SILENT` acknowledgement, never held open across a rotation.
- **Minimum SDK versions:** google-genai 2.23.0 / @google/genai 2.18.0. Do not use Extended Thinking.
- **Option C** only if EU residency or server-side tool authority becomes a requirement. Davide should answer explicitly whether EU residency is a requirement. Today's 3.1 on the Developer API has the same residency position as 3.8 would.

---

## 5. What 3.8 does NOT fix

- **The 403 at governed `create_run`.**
  - The refused request is the web `/api/chat` → `runs/stream` POST carrying `memory_source_action`, `memory_source_session_id` and `platform` (`backend-client.ts:329-367`).
  - The hook (`langgraph_auth.py:420-553`) never looks at the voice model.
  - Every refusal inside the governed block becomes `_deny()`, and about a dozen more `_deny()` calls fire before it.
  - Nothing in that request changes with 3.8.
- **The earlier `before_agent` `memory_context_rotation_required` failure.**
- **The transcript-persister race, if it is the cause.** Forced proactive audio could add more transcript rows and snapshot writes during the admission window (inferred).
- **Uncertain refusals and retry amplification.** NON_BLOCKING duplicate calls combined with "unconfirmed" results would create more governed source actions per failure.
- **Missing server-side idempotency** across voice attempts.
- **The provenance issue** (model-written brief recorded as user input).
- **The hidden turn's second model decision** and the governed path's `edit_context` rejection.
- **Durable execution, authorization and progress.** These remain Sophia's responsibility.
- **EU residency.** Unchanged on the Developer API.
- **The ephemeral-token mask gap** (§7, item 10).

---

## 6. Risks, and the cheapest de-risking experiment

### Risks of moving to 3.8
- **Forced proactive audio:** persona and turn-policy changes, plus input billing while listening on Vertex.
- **New base model:**
  - Tone and persona drift. Apply GEPA's "tone regression is a hard block" rule by analogy; GEPA literally governs prompt-file variants, not model swaps.
  - Slowness or timeouts noted on the model card.
  - **First-audio latency for 3.8 is unmeasured.** It is the go/no-go metric for the 3-second voice target.
- **Default NON_BLOCKING for every tool:**
  - speculative "started/ready" claims;
  - answers given before memories arrive;
  - empty turns from `WHEN_IDLE`;
  - duplicate calls. Each retry writes a new user-attributed governed row.
- **Resumption with a pending call** is unverified for NON_BLOCKING.
- **Maturity:** two weeks of GA. Framework integrations (LiveKit, pipecat, ADK) all have open async issues.
- **Cost per session** may rise even at per-token parity.
- **The status quo carries risk too:** production runs a legacy preview model.

### Cheapest experiment

**(a) Free, now, on 3.1:** prototype the Builder-completion push via `realtimeInput.text` app context. This removes the main claimed 3.8 benefit from the decision.

**(b) About one day, non-prod, not urgent:**
1. On a non-prod voice service, set `SOPHIA_GEMINI_LIVE_MODEL=gemini-3.8-live` (`voice/config.py:334`). The model is locked into the token by the voice service, so this needs no code.
2. Use a **real browser session**. Voice Lab synthetic runs set `voiceBuilderRouting=null` and bypass Lane C, the path that failed (`gemini-browser-live-websocket-dogfood.ts:3746-3748`).
3. First pin `behavior: BLOCKING` on every browser-declared tool. This is a small web change, since the browser declares the tools. It separates the model change from the protocol change.
4. Confirm that the token mints and the session opens on the v1alpha constrained endpoint.
5. Measure against 3.1:
   - first-audio p50/p95;
   - `start_builder_task` emission rate on about 30 scripted explicit requests;
   - false launches on ambiguous requests;
   - duplicate calls;
   - speculative "started/ready" claims;
   - unprompted or missing responses caused by proactive audio;
   - cost per minute from `usage_metadata`;
   - tone on a fixed golden set.
6. Only then switch `start_builder_task` alone to NON_BLOCKING with a `SILENT` acknowledgement. Force a GoAway and resume while the call is pending, to test lost-call behaviour.

Pass criteria to agree up front:
- no first-audio regression beyond an agreed budget;
- no tone regression;
- emission rate at least equal to 3.1;
- zero false launches;
- no increase in duplicate calls.

---

## 7. Unverified items and how to verify them

Blocked: `ai.google.dev` and `docs.cloud.google.com`, plus the other domains listed in §2.
- **To verify the documentation items:** allow those domains in this environment's network settings, fetch the pages directly, or confirm with a Google account contact.
- **To verify the behavioural items:** use the §6(b) spike.

1. **Pending NON_BLOCKING calls:** Is there a maximum lifetime or server timeout? Is a toolResponse for a call issued before a GoAway accepted after resume? Sources: D-ASYNC, D-SESS, A-SESS. Verify in spike step 6.
2. **Barge-in:** Does it cancel NON_BLOCKING calls via `toolCallCancellation`? Does 3.1's 1008 rejection of realtime input during a pending call still occur on 3.8? Verify in the spike.
3. **Scheduling details:** `INTERRUPT` downgraded while the user speaks, BLOCKING calls cancelled by new input, `SILENT` not guaranteed silent. Sources: D-38, D-MIG, A-TOOLS (snippet-only). Verify with the docs and the spike.
4. **Plain `gemini-3.8-live` behaviour:** Does it send `interaction_status`? Does TEXT response modality work? Is code execution supported (SKILL says no; CB-TOOLS demonstrates it)? Verify in the spike and A-OVR.
5. **Vertex:**
   - runtime support for `scheduling` and `id` (the schema says yes);
   - EU location IDs and data-residency terms for 3.8 Live;
   - the model page's launch stage;
   - whether there is a 10-minute default session cap.
   Sources: D-38, the Vertex locations page, the Google account team.
6. **Resumption handle validity:** 2 h [A-SESS snippet-only] or 24 h [CB-LIVE fetched; D-SESS snippet-only]?
7. **Context-window compression:** how it interacts with a pending call's `functionCall` turn.
8. **Developer API limits and dates:**
   - 3.8 concurrency and rate limits;
   - the deprecation date for `gemini-3.1-flash-live-preview`;
   - per-token price parity (currently third-party-sourced);
   - EU residency terms.
   Sources: A-DEP, A-CL, and the ai.google.dev pricing and terms pages.
9. **Authentication:** any official guidance on authenticating Live tool calls or running them server-side. None was found.
10. **Security (model-independent follow-up):**
    - Sophia's token field mask lists only the setup fields the server populates, minus `tools` and `sessionResumption` (`gemini_browser_dogfood.py:90, 620-632`). Those fields are `model`, `generationConfig`, `systemInstruction`, input/output audio transcription and `contextWindowCompression`.
    - So `tools` **and** any setup field the server leaves unset (for example `realtimeInputConfig`, `proactivity`, `historyConfig`) are client-controllable.
    - Open questions:
      - whether a tools override can enable `codeExecution` on Sophia's constrained endpoint [SEC snippet-only];
      - whether the token can lock `tools` while still allowing per-session co-review tools;
      - whether v1alpha or v1beta is the supported token API version.
    - Verify with a crafted setup in non-prod, and consider masking absent fields explicitly.

Answered from the repo: mid-session context injection works on 3.1 via `realtimeInput.text`, the mechanism the artifact-review hints use today.

---

### Source key
- **SKILL:** https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-live-api-dev/SKILL.md [fetched]
- **MIG:** …/gemini-live-api-dev/references/migration.md [fetched]
- **BLOG38:** https://cloud.google.com/blog/products/ai-machine-learning/gemini-3-8-live-with-live-avatar-is-now-generally-available [fetched]
- **CARD:** https://storage.googleapis.com/deepmind-media/Model-Cards/Gemini-3-8-Audio-Model-Card.pdf [fetched]
- **PRICE:** https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing [fetched]
- **PYSDK / PYCL:** google-genai 2.25.0 and CHANGELOG [fetched]
- **JSSDK / JSCL:** js-genai `types.ts` and CHANGELOG [fetched]
- **DISC-B / DISC-A:** generativelanguage v1beta / v1alpha discovery [fetched]
- **DISC-V:** aiplatform v1 / v1beta1 discovery, rev 20260920 [fetched]
- **PROTO:** googleapis `generative_service.proto` [fetched]
- **CB-LIVE, CB-TOOLS, CB-THINK:** google-gemini cookbook [fetched]
- **EX-58:** gemini-live-api-examples issue 58 [fetched]
- **CB-1390:** cookbook issue 1390 [fetched]
- **ADK:** adk-python 2.10.0 and adk-docs [fetched]
- **Third party** [all fetched]:
  - AWESOME: Shubhamsaboo/awesome-llm-apps
  - VA: GetStream/Vision-Agents
  - PAI and PAI-8393: pydantic-ai
  - LK7302: livekit/agents
  - LKJS2593, LKJS2595: livekit/agents-js
  - GENAI3015, GENAI1894, GENAI2981: python-genai
  - AOS453: autonomous-os
  - LiteLLM price table
- **Snippet-only:**
  - D-ASYNC, D-38, D-MIG, D-SESS, D-WS (docs.cloud.google.com Live API pages)
  - A-OVR, A-SESS, A-TOOLS, A-CL, A-DEP, A-BG (ai.google.dev)
  - SEC (cybersecuritynews.com)