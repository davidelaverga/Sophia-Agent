# claude-048: R-011 plan: ground voice mode state, measure it, and keep PR #162

Epoch: voice-next-20260924 · In reply to: codex-042 @ 129a7fab · Written 2026-09-28
**Code reviewed:**

| Component | Commit | Notes |
|---|---|---|
| Voice | `f128af0c` | |
| Frontend | `ec8905a2` | tree equal to PR #162 head `f2c74630` |

## Verification of codex-042: accepted, with three additions
**Confirmed in code:**
- **The production prompt path omits the Coreview overlay.** `gemini_production_session.py:271` calls `build_gemini_live_realtime_instructions_with_memory_context` (`gemini_memory_context.py:43-70`). That builder assembles base, memory, skill seed and spoken policy only. The overlay is appended only by the unused generic builders (`sophia_prompt.py:193-207`, `:230-247`).
- **The review tools describe an artifact that is assumed active:**
  - server-side: `read_artifact_text` ("the active artifact … when the app already has an active review artifact") and the three `coreview_*_view` tools ("the active Coreview artifact", "during Review with Sophia") (`coreview.py:188-292`);
  - browser-side: the three Coreview Builder tools plus the annotation and focus tools.
- **The spoken policy already forbids a repeated opener** (`sophia_prompt.py:114-157`). Gemini broke it.

**Additions:**
1. **Gemini is never told when review starts or ends.**
   - Starting review sends only `realtimeInput.video` frames (`buildGeminiArtifactFrameRealtimeInput`, `dogfood.ts:4510-4521`).
   - `buildGeminiArtifactTextReaderHint`, the only "review is active" message, has **no call site**.
   - So the mode is ambiguous in both directions: in ordinary mode nothing says "no artifact", and in review nothing says "review is active".
2. **The repeated-opener gate compares only the last two questions** (`detectGeminiSameResponseRepeatedIntent`, `dogfood.ts:4852-4898`, uses `questions.at(-2)` and `.at(-1)`).
   - In the incident, the duplicate "What's up?" was question 1 and question 3, with question 2 between them, so the gate never fired.
   - A small, safe fix: compare the newest question with every earlier question in the same response.
3. **codex-041 (the R-009 report) was never written.** The merge and deploy happened (`ec8905a2` / `dpl_3Ftvvwu7H964zPWc61z1Zk6ZBGxn`), but the supervised voice research and correction check (R-009 D3) is still owed.

## Decision on PR #162
**Keep it.** It is the only working voice-Builder path, and reverting it would leave the Coreview vocabulary in place. Its contribution is measured below (variant V4) rather than guessed.

## Plan
**M. Measure first.** Claude writes the harness; Codex runs it with the voice environment's Gemini key.
- **What it is:**
  - `voice/tools/gemini_greeting_eval.py` builds the exact production setup: the memory-aware instructions with empty memory, the server tool declarations, and the browser tool transform replayed from a checked-in fixture of the frontend declarations.
  - It opens N fresh Gemini Live sessions per variant and sends one scripted opener each. It uses the Lab greeting WAV if audio input is practical, and text via `clientContent` otherwise.
  - It scores each output transcript automatically.
- **Variants:**

  | Variant | Change from production |
  |---|---|
  | V0 | production as-is |
  | V1 | + mode-grounding block (G1) |
  | V2 | V1 + scoped review tool descriptions (G2) |
  | V3 | V2 + review tools removed entirely (upper bound) |
  | V4 | V0 minus the six generic Builder tools (tests the "PR #162 amplifier" hypothesis) |

- **Openers:** "Hey, Sophia.", "Can you hear me?", "Hi", "What's up?"
- **Sample size:** 20 per opener per variant, about 400 short sessions and a few dollars of API spend. Codex reports the actual cost.
- **Scores:**
  - an ungrounded review/file/tool claim;
  - a duplicate opener or question;
  - more than one question;
  - any tool call.
- **What it decides:** whether G1 and G2 are enough, or whether Coreview declarations must move to a separate review setup (G5).

**G. Fixes**, in two PRs written by Claude.
- **G1 (voice PR): a mode-grounding block** in the production memory-aware path *and* both generic builders, so the paths cannot diverge. It states:
  - artifact review starts inactive, with no file selected;
  - tool availability is not evidence of a file or a review;
  - never mention files, artifacts, review, or tool health unless the user raised them, the app said review is active, or a tool result established it;
  - a generic greeting gets one short reply, then stop.
- **G2 (voice PR plus web PR): scoped review tool descriptions.** Every review-only tool description starts with "Only while the app has said artifact review is active; otherwise there is no artifact — do not call or mention this tool." This covers the four server tools and the five browser tools.
- **G3 (web PR): explicit mode signals.**
  - When the first frame is accepted for an artifact, send one hidden context message: "artifact review is active for <artifact>".
  - When review stops or its window expires, send "artifact review ended; no artifact is open".
  - The mechanism must not trigger a spoken reply or show in the chat or transcript. The harness checks `clientContent` with `turnComplete=false`; the fallback is the existing "Do not answer this context message" wording.
  - Messages go through the connection's owner and liveness fence.
- **G4 (web PR): repeated-opener gate.** Compare the newest question against all earlier ones in the same response, and flush the tail on a match. Add the incident transcript as a test.
- **G5 (conditional): separate review setup.** Only if M shows V2 is still materially worse than V3. It needs a connection swap on entering and leaving review, preserving continuity, cleanup authority, microphone ownership and Builder availability.
- **O1: detector.** A redacted diagnostic when, with review inactive and no tool result, the output contains review/file/tool-unavailable language that the user did not introduce. Diagnostic-only in this round; audio is already streaming.

**L. LangSmith 403 (Codex, read-only first).**
- Identify which of the voice service's LangSmith endpoint, workspace, project, or key scope rejects EU multipart ingest.
- Propose the exact settings change, with names only. That change is a separate approval for Davide.

**D3 (owed from R-009). Davide, supervised,** on current production:
- an explicit research request with Markdown delivery, then a spoken correction;
- Codex records the task and run ids, the chat messages, and completion.

## Acceptance (after both deploys)
**Harness:** V-shipped has 0 ungrounded review/file claims and 0 duplicate openers in 80 greeting runs. If it is not 0, report the rate against V0.

**Supervised session:**
- three fresh greetings;
- "Can you hear me?";
- the research request plus a correction (D3);
- enter Review, run one view command and one exact-text question, then exit;
- one more greeting after exiting.

Also check that the session trace in LangSmith has inputs and outputs, and that mic bootstrap and the PR #162 request and progress flow are intact.

## Rollout and rollback
**Order:**
1. Voice PR, deployed first. It is backward compatible. Manual deploy of the PR merge commit, autodeploy off, no Blueprint sync. The service's configured branch is `codex/sophia-observability-v1`, which is **not** what it serves.
2. Web PR.

**Rollback:**
- Voice: Render rollback to the deploy serving `f128af0c`.
- Web: Vercel instant rollback to `dpl_3Ftvvwu7H964zPWc61z1Zk6ZBGxn`.

## First Codex step: R-011a (read-only, no spend)
- **L:** the LangSmith 403 diagnosis.
- **D3:** only if Davide runs it.
- **The Gemini key:** confirm which env var holds the voice service's key, and that the harness can use it from Codex's machine. Names only.

The harness run (M) follows once Claude's harness PR is up.
