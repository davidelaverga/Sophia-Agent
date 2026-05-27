# Phase 12.5B-D - Realtime Memory Routing And Epistemic Honesty

Date: 2026-05-22
Status: implemented focused routing and source-labeling hardening after live memory smoke
Working branch: `fix/realtime-memory-routing-epistemic-honesty-phase-12-5b-d`

## Why This Phase Exists

Phase 12.5B-B added a dependency-safe realtime `retrieve_memories(query)` contract. Phase 12.5B-C fixed provider availability so Gemini Live could call the tool and receive precise statuses: `success`, `no_results`, `unavailable`, `error`, and `invalid_query`.

The next live smoke showed that availability was no longer the main blocker. Gemini called `retrieve_memories` for broad recall, but later specific recall and hint/guess flow exposed weak tool-routing discipline and weak epistemic labeling.

This phase keeps the same tool surface. It does not add `consult_skill`, ritual tools, web tools, sideband memory writeback, artifact schema changes, VAD changes, default routing changes, or Builder storage/UI changes.

## Live Smoke Symptoms

- Setup identity worked: `What is my name?` was answered from setup context as `Luis`.
- Broad recall partially worked: `What do you remember about me?` triggered `retrieve_memories` and produced relevant context.
- Specific recall was weak: `Do you remember what I use to stay calm when gaming?` did not clearly retrieve or answer the known cue.
- Missing memory was partially correct: `Do you remember my favorite childhood movie?` was initially treated as not stored.
- Hint/guess flow failed epistemically: after user hints, Sophia guessed `Lord of the Rings` and said `I knew it had to be`, implying stored memory or confidence it did not have.

## Root Cause Classification

- Provider availability: resolved by Phase 12.5B-C.
- Memory storage coverage: still unknown for some facts; missing facts should surface as `no_results`, not hallucinated recall.
- Repeated explicit recall routing: weak before this phase; a later specific recall question needed clearer guidance to trigger a separate focused lookup.
- Epistemic honesty after `no_results` or guessing: weak before this phase; the prompt and tool guidance did not clearly separate stored memory, setup context, current-session context, inference, and guesses.
- Writeback: not implemented yet; new current-session facts must not be treated as durable memory.

## Routing Guidance Changes

- Strengthened the realtime `retrieve_memories` declaration to call out explicit recall prompts, including broad recall, gaming calm cues, favorite childhood movie, prior-session references, and `what do you know about my thesis/project/work/workout` questions.
- Added guidance that broad recall and later specific recall are separate retrieval opportunities. A broad search earlier in the session is not enough for a new focused question unless the matching fact was already retrieved or spoken.
- Kept negative routing rules: no calls for simple greetings, hearing checks, current-turn facts, generic advice, present-moment clarifying questions, every turn, or `what is my name?` when preferred name is already in setup context.
- Kept the query-only schema. Realtime providers still expose only `query`; trusted runtime context supplies `user_id`, and category weighting stays internal.

## Epistemic Honesty Policy

Added a compact realtime memory recall guidance block to the assembled realtime prompt. It distinguishes:

- Stored memory: only when a matching retrieved memory or explicit setup seed fact supports the answer.
- Setup context: identity, handoff, or profile context loaded before the session.
- Current-session context: facts the user just said in the live conversation.
- Inference or guess: reasoning from hints or context without stored support.
- Missing memory: provider reached, no relevant stored result.
- Unavailable memory: provider unavailable or errored, so Sophia cannot check.

The guidance explicitly forbids phrases such as `I knew it`, `I remembered that`, `I had that`, `I knew it had to be`, `Of course, I remember`, and `That's what I had stored` after the user reveals an answer that was not retrieved.

The Gemini setup context block now says preferred name, identity excerpts, and handoff excerpts are setup context from earlier, while stored memories are only the `Relevant stored memories` items.

## Tool Result Guidance Changes

Realtime `retrieve_memories` responses now use status-specific `guidance`:

- `success`: use returned memories only if directly relevant; say a fact is remembered only when the matching fact appears in returned memories.
- `no_results`: do not pretend to remember; label hints as guesses; user-provided answers are current-session knowledge until offline writeback confirms persistence.
- `unavailable`: do not say the memory does not exist; say Sophia cannot check stored memory right now.
- `error`: do not expose provider details and do not claim absence; say stored memory cannot be checked at the moment.
- `invalid_query`: ask for a clearer memory question if needed.

## Diagnostics

No new ledger was added. The existing Gemini memory tool diagnostics already include tool call id, status, count, latency, query length, result categories, bounded result text lengths, provider status/reason/transport, trusted user id source, ignored model argument names, and `raw_memory_text_excluded`. Raw memory text remains limited to the tool response sent back to the model and is not duplicated in diagnostics.

## Tests

Added or updated focused tests for:

- Tool declaration routing guidance for explicit, repeated, and negative recall cases.
- Query-only realtime schema with no model-facing `user_id` or categories.
- Status-specific result guidance for `success`, `no_results`, `unavailable`, `error`, and `invalid_query`.
- Gemini setup including the strengthened memory declaration and prompt guidance.
- Gemini setup context labeling setup context separately from stored memories.
- Gemini diagnostics staying privacy-minimized while memory calls appear in tool-loop status.
- OpenAI function-schema conversion retaining the query-only memory shape and updated description.
- Rendered Gemini prompt snapshot containing the memory epistemics block.

## Manual Smoke Plan

Smoke 1 - Name should not call memory:
User: `Sophia, what is my name?`
Expected: answers from setup context if available; no memory call unless setup context is missing.

Smoke 2 - Broad explicit memory recall:
User: `Sophia, what do you remember about me?`
Expected: calls `retrieve_memories`, answers with a few relevant memories, and uses stored-memory language only for returned memories.

Smoke 3 - Specific memory recall:
User: `Do you remember what I use to stay calm when I'm gaming?`
Expected: calls `retrieve_memories` again unless the matching memory was already retrieved or spoken. If present, says the cue; if absent, says it is not stored.

Smoke 4 - Missing memory:
User: `Do you remember my favorite childhood movie?`
Expected: calls `retrieve_memories`. If no stored memory exists, says `I don't have that stored` and does not hallucinate.

Smoke 5 - Hint/guess flow:
User gives hints such as `It was action-packed` and `It had a big quest`.
Expected: guesses are labeled as guesses. If the user confirms `Lord of the Rings`, Sophia says she did not have it stored and will keep it in mind for this session. She must not say `I knew it` or imply durable memory.

Smoke 6 - Telemetry:
Expected: memory calls and precise statuses are visible; repeated specific recall shows a separate call unless already covered; diagnostics do not duplicate raw memory text and ignore model-supplied `user_id` or categories.

## Deferred Work

- Memory writeback and persistence of newly learned facts such as a favorite childhood movie.
- `consult_skill` and ritual tools.
- Web tools.
- Artifact 15-field migration.
- GPT Realtime production/dogfood execution wiring for memory.
- VAD/turn-detection tuning.
- Builder storage/UI changes.