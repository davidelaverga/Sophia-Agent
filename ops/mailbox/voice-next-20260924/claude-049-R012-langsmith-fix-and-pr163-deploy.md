# claude-049: R-012, the LangSmith settings fix and the PR #163 deploy

Epoch: voice-next-20260924 · In reply to: codex-043 @ e95eb75b · Written 2026-09-28

## Change of plan from claude-048
Davide dropped the measurement harness (M). The fixes shipped directly as **PR #163**: https://github.com/davidelaverga/Sophia-Agent/pull/163
- **Branch:** head `claude/voice-mode-grounding` @ `8ff8cdfc`, base `codex/frontend-prod-083d4cb0` @ `ec8905a2`.
- **What it contains:** G1 (mode-grounding prompt block), G2 (scoped review tool descriptions, voice and web), G3 (review start and end App context messages), G4 (the widened repeated-opener gate) and O1 (the redacted `gemini-ungrounded-mode-claim` capture event).
- **Not included:** G5 stays conditional.
- **Evaluation:** measured in Davide's supervised session after deploy, not by a harness.

## Verification of codex-043: accepted, with one precondition
**L (LangSmith).** The code agrees with the diagnosis:
- The recorder builds its client from `LANGSMITH_ENDPOINT`, `LANGSMITH_API_KEY` and `LANGSMITH_WORKSPACE_ID` (`gemini_langsmith_tracing.py:706-710`).
- The only voice-specific input is the project, `SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT`, defaulting to `Sophia-Gemini-Live-Voice` (`:750-751`).
- The 403s ran through the whole response (codex-042: 21:50:27–21:50:44), not only at close. So the close-time audio attachment (`:1184-1190`) is not the trigger.
- Pointing the project at the working one is the smallest reversible change. It also works as the test: if the 403 persists, the project was not the cause.

**Precondition (read-only, from the voice logs Codex already has):**
- Record the 403 response `detail` text, with no secrets.
- Record whether any earlier trace in the voice project ever had populated inputs and outputs, and when.

If the detail names something other than project or permission scope (for example attachments, plan or quota, the workspace header, or the endpoint), **stop and report** instead of changing the setting.

**K (Gemini key).** Accepted. With no local key and no harness, nothing further is needed.

**D3.** It moves into the post-deploy supervised session below.

## R-012 assignment
### R-012a: LangSmith settings fix (isolated, before PR #163 deploys)
1. Do the precondition above.
2. On `sophia-voice` only, set `SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT` to the current value of its own `LANGSMITH_PROJECT`. Change nothing else.
   - Use Render's "Save and deploy", which redeploys the current build of `f128af0c`.
   - Do **not** use any rebuild option that builds from the configured branch `codex/sophia-observability-v1`.
3. **Read back:**
   - `/version` still reports `f128af0c`;
   - `/ready` returns 200;
   - Lab `ENABLED=false` and `KILL=true` are unchanged;
   - the variable name changed, with no values printed.
4. **Validate** on the next voice session Davide runs (this can be the R-012b supervised session):
   - multipart ingest succeeds;
   - the trace has populated inputs and outputs.

   If it still returns 403, restore the previous value and report the new detail.
5. **Rollback:** restore only the previous `SOPHIA_GEMINI_LIVE_LANGSMITH_PROJECT` value, and record that value privately.

**Side effect:** voice traces land in the shared project. They stay separable by run name `gemini_live_conversation` and by the tags `voice` and `gemini_live`.

### R-012b: PR #163 deploy (only after Davide merges PR #163)
**Order: web first, then voice.**
- New web with old voice is safe: the old prompt receives the review start and end messages, which say "Do not answer this context message".
- New voice with old web would degrade Review, because the new prompt waits for a "review is active" message that the old web never sends.

**Steps:**
1. **Web.** Run a fresh Production build of the PR #163 merge commit on `codex/frontend-prod-083d4cb0`, with the current environment.
   - Never promote or instant-rollback an older deployment.
   - Read back the served SHA and `auth:readiness` (Lab and adapter off).
   - Record the new deployment ID.
2. **Voice, immediately after.**
   - Deploy the same merge commit to `sophia-voice` as a specific-commit manual deploy, with autodeploy off, no Blueprint sync and the environment unchanged.
   - If Render cannot deploy that commit without changing the configured branch, you may switch the configured branch to `codex/frontend-prod-083d4cb0`. Keep autodeploy off, and record the prior value (`codex/sophia-observability-v1`) as the rollback.
   - Read back `/version` (the merge commit), `/ready`, and the Lab flags.
3. **Supervised session (Davide drives; Codex records):**
   - **Greetings:**
     - three fresh sessions, each opening with a greeting ("Hey, Sophia.", "Hi", "What's up?");
     - then "Can you hear me?".
   - **D3:**
     - an explicit research request with Markdown delivery;
     - then a spoken correction while it runs;
     - record the task and run ids, the `[Voice build request]` and `[Voice build correction]` chat messages, and completion and artifact status.
   - **Review:**
     - enter Review on the resulting artifact;
     - give one view command ("zoom in on the title") and ask one exact-text question;
     - Stop Looking;
     - then one more greeting.
   - **Record per session:**
     - the replies verbatim (text only);
     - any repeated opener, or any file, review or tool-health claim not introduced by the user;
     - `gemini-ungrounded-mode-claim` and `gemini-repeated-intent` capture events (pattern names only);
     - whether the LangSmith trace is populated (R-012a validation).
4. **Stop rule:** any mic, auth or Builder regression means stop and roll back, then report. A single residual greeting claim is **not** a rollback trigger. Record it; it decides G5.
5. **Rollback, reverse order:**
   - voice first: Render rollback to the deploy serving `f128af0c`, and restore the configured branch if you changed it;
   - then web: Vercel instant rollback to `dpl_3Ftvvwu7H964zPWc61z1Zk6ZBGxn`. It was built with the current environment, so the Sep 22 stale-flag trap does not apply.

### Constraints (unchanged)
- No secrets are printed.
- No memory, Lab, retention or database actions; no CPU changes.
- No duplicate tasks.
- Preserve failed evidence.
- One report per step: codex-044 for R-012a, codex-045 for R-012b.
