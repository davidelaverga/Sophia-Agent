# Recap refresh and proposed-memory quality incident

Investigated 2026-10-04 Europe/Rome; event timestamps below are UTC on 2026-10-03.
Scope: read-only browser, logs, code and diagnostic SQL. One read-only recap Retry; no approval/rejection by Codex, model calls, data rewrites, settings or deployment changes.
Session: `fa978e7d-e46f-4000-9e95-9b865a00d2fd`; production frontend inspected at `e4d55b3102fd86c15d6fa88c26a6b2cd6f05ddf2`; unchanged gateway code at `eb849b62`.

## Conclusions

1. **Confirmed frontend refresh bug:** canonical recap can remain in its initial processing state indefinitely after successful extraction. A single read-only Retry restored the review UI.
2. **Confirmed misleading processing copy:** the UI renders “Couldn’t load recap. Retry?” even for a valid processing response.
3. **Confirmed proposed-memory quality problem:** the visible candidates are lengthy behavioral/preference inferences from task interaction. Davide reports that they do not meaningfully reflect his conversation. The extraction policy permits this generalization; structural validation does not establish semantic grounding.
4. **Confirmed placeholder presented as a takeaway:** canonical hydration supplies no takeaway, but the orbit labels a stock heading “key takeaway.” It is not a generated conversation summary.
5. **No cross-session candidate substitution found:** visible candidate text matched the remaining canonical candidates of this exact session; all stored candidate sources point to this session. Provenance validity does not prove that an inference is useful or justified.

## Timeline and backend evidence

| UTC time | Evidence |
| --- | --- |
| 21:40:56.698583 | Session ended; finalization request logged at 21:40:56.698925. |
| 21:40:57.557903 | `session.finalization recap_persisted status=ready` refers to the derivative recap file, not completion of canonical extraction. |
| 21:40:58.185447 | Canonical extraction run `7b33e682-728d-4cd2-a943-9b419ed33a47` created; source-target receipt committed. |
| 21:40:58.252445 | `end_session_queued recapPipelineQueued=True`. |
| 21:40:58.655516 | `pipeline_complete`; durable extraction is still asynchronous. |
| 21:40:59.151581 | `extraction_dispatch_authorized`, reason `exact_source_dispatch_authorized`. |
| 21:41:03.824223 | Gateway recap GET HTTP 200, before extraction completion. |
| 21:41:05.757774 | Run committed `succeeded_nonzero`, one attempt, four candidates; `candidate_batch_committed`, error_code absent. |
| 21:41:05.816850 | `memory.extraction.completed outcome=succeeded_nonzero candidate_count=4`. |
| 21:41:06.877080 | Current-epoch source target realigned; reason `exact_current_epoch_source`. |

Extraction completion was 9.059 s after session end and 1.934 s after the initial recap GET.
Read-only `sophia_memory_review_snapshot` returned `mem00.review.v2`, extraction_state `complete`, revision 63, target 62 / covered 62, run_count 1, enumeration_complete true, retryable false, recovery_action none.
Initial summary: produced 4, pending 4, approved 0, rejected 0, invalidated 0. Source and input validity were true; all 62 visible messages were eligible; exclusion/unproven/change counts were zero.
During Davide's live review, the counts changed first to pending 3/rejected 1 and then pending 2/rejected 2; approved remained zero. These account for the shrinking UI counter; Codex did not operate a decision control.
The SQL review function was verified STABLE before invocation; no mutating RPC was called.

## Frontend path and recovery

At first inspection the page still displayed processing plus load-failure copy, although the backend was already complete. No matching recap fetch/schema error was found in captured console errors/warnings.
`frontend/src/app/recap/[sessionId]/useRecapArtifactsLoader.ts:674–702` validates and paginates the canonical envelope, publishes its state, sets processing when there are no candidates yet, and returns without scheduling a new GET.
The existing retry timers at lines 597–630 are used by later legacy/404 paths. Canonical processing and awaiting_finalization never reach them.
The effect depends on scope and retryCount, not changes in the server's extraction state. Completion in Postgres cannot update that one fetched snapshot by itself.
The Retry handler is a page reload at lines 932–935. It performs fresh reads; it does not regenerate extraction. One Retry removed the processing/error view and displayed review controls with four candidates.
The initial raw response body was not captured; its processing state is inferred from the displayed branch, request timing and code. The completed canonical state and manual recovery were directly verified.
`RecapEmptyStateViews.tsx:39–41` hard-codes the load-failure RetryAction into processing. That message should not be used as evidence of an HTTP error.
`page.tsx:128–129` makes debug export a silent no-op unless status is ready, although its button is visible in failure/processing states. After recovery, an attempted browser download capture timed out; no separate post-recovery export failure is established.

## Proposed-memory quality and UI

The three candidates visible during inspection contained 32, 35 and 32 words (241, 281 and 262 characters), each combining explanation and inference rather than one concise personal fact.
They describe broad preferences, learning or recurring behavior inferred from research/document iteration. This can borrow vocabulary from a discussion while still misrepresenting what the user intended to retain. Davide explicitly disputes their relevance.
Run model: `claude-haiku-4-5-20251001`; prompt version `mem0_extraction.md:v1`. The durable run records modality `text`; this alone does not establish which UI transport the conversation used.
Candidate categories were fact, lesson, preference and pattern. Confidence 0.80–0.90 and importance 0.58–0.72 were assigned; these scores are model judgments, not proof of meaning.
Each candidate was linked to all 62 messages, including 37 user turns and 25 assistant turns. All sources belonged to this session, but no narrow supporting span was identified for each claim.
`memory_governance/extraction_service.py:276–297` creates one default_sources tuple from the entire selected window and attaches it to every candidate.
`prompts/mem0_extraction.md:5,51,98–105` asks for third-person analyst observations in 1–3 sentences and explicitly allows observed preferences and emerging patterns from a single session.
The prompt asks for atomic, new, useful observations and permits an empty array, but it does not clearly prohibit interpreting task-specific corrections as durable personal preferences or require exact user evidence for each claim.
`extraction.py:88–105` validates shape/category/numeric ranges, not concision, personal relevance, claim support or repeated-pattern evidence.
The governed worker does not provide existing_memories in its extraction metadata; the prompt's existing-memory dedup input defaults to None. Any new memory-context input would need governed authorization and immutable input binding, not an ad hoc provider read.
`useRecapArtifactsLoader.ts:684–694` constructs canonical artifacts without takeaway/reflection/builderArtifact. `RecapCosmicPoolOrbit.tsx:2230–2242` consequently labels a stock fallback title as a key takeaway.
The orbit renders long text in a fixed circle, shrinks typography above 150 characters and blurs peripheral candidates. The examined center paragraph was not geometrically clipped, but this presentation makes comparison and evidence checking difficult.

## Recommended follow-up PRs; no fix applied

**Refresh correctness:** add bounded GET-only polling for canonical processing/awaiting_finalization with fresh first-page snapshots, scope cancellation and existing fail-closed validation. Do not mix pagination cursors across snapshots, call finalize/retry-extraction writes, hydrate Mem0 fallbacks or auto-approve candidates. Keep displayed candidates and version-matched decisions stable while awaiting completion. On exhaustion, state that processing has not completed and offer a read-only refresh.
**Truthful UI:** reserve load-failure copy for actual errors; label pending extraction clearly. Show a neutral review heading when no verified takeaway exists. Enable sanitized diagnostics while processing/unavailable; distinguish HTTP, validation and extraction states in telemetry.
**Extraction quality:** require concise atomic claims, explicit durable personal relevance and specific supporting user turns; suppress task logistics/revision instructions and assistant-generated subject matter as personal facts. Allow zero candidates. Require repeated or explicit evidence before describing a lasting pattern/preference; communicate inference uncertainty. Treat template/version and provenance changes as a governed contract change with appropriate input binding; do not rewrite existing candidates silently.
**Review design:** make exact text easy to scan with readable contrast and a compact list or expandable detail view; clearly label proposals as unsaved and offer provenance/evidence on demand. Preserve manual decisions and consent.
Regression coverage should include canonical processing→complete with/without candidates, bounded exhaustion, awaiting_finalization, failed/changed snapshots, pagination integrity, owner/session changes, cancellation and stable decisions; also truthful processing copy and debug availability.
Quality evaluation should use synthetic research-only/no-personal-fact sessions, task-specific corrections, assistant-only assertions, explicit personal preferences, explicit remember requests and genuinely repeated patterns. Assert source grounding, category accuracy, concision and correct empty output.
Existing recap tests exercise legacy/404 retries and complete canonical snapshots; inspected tests did not cover the canonical processing→complete transition. No tests or live model evaluations were run in this read-only investigation.

## Trace limitations and handoff

Both signed-in LangSmith projects showed “No runs found” in the existing three-hour view. No recap waterfall could be inspected. The diagnosis relies on browser recovery, Render timestamps, canonical durable records and the exact served code, not inferred trace spans.
No content, owner IDs, tokens, credentials or signed URLs are included here. Candidate content equality was checked privately; hashes are omitted.
No deployment, settings, migration, extraction rerun, memory approval, retention or Lab action was performed by Codex.
