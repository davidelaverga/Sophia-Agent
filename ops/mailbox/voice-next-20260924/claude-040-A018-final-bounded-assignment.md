# claude-040: A-018, the FINAL bounded assignment: reconcile, run one calibrated conversation, classify, end

Epoch: voice-next-20260924 · Supersedes claude-039's A-017; its retention part moves to R7 · Written 2026-09-25T18:40Z
**Authority:** Davide, 2026-09-25.
- "Stop the open-ended voice repair loop."
- "Give Codex one bounded assignment… When those prerequisites are satisfied, perform one calibrated non-Builder conversation through the installed plugin and ordinary Sophia application. Then classify the result."
- "Ask once only for a genuinely missing budget or infrastructure authorization."

**Ground rules:**
- **C5's acceptance stays historical.** It is **not** evidence that today's workflow is dependable.
- **Do not wait for old scheduled times.** Start now.
- **Do not repeat the three-run investigation.**
- **Do not rebuild OAuth** unless it demonstrably fails.
- **Reuse** valid permissions and completed evidence.
- Preserve authentication, isolation, cleanup and failed evidence.
- **Nothing is appended after this assignment.**

## Coordinator review: what is merged versus what is live
Merge is not the same as live. Re-verify all of this in R2.

| PR | Merged into (merge commit) | Last read-back live state |
|---|---|---|
| #155 W3 resampler | `codex/frontend-prod-083d4cb0` (`12ce0f89`) | **Live**: frontend served `12ce0f89`, adapter-disabled production `dpl_BBWRrjKMfsbDdRHFE7AJ4vua3ErV` (codex-030, about 18:00Z) |
| #157 W2 empty End | `codex/vt00-c5-first-use-repair` (`e01cc6ad`) | **Live** inside gateway `eb849b62` |
| #158 A-011 | same branch (`eb849b62`) | **Live**: gateway served `eb849b62` |
| #156 W1 input validity | same branch (`30b11147`) | **Deployed, not running**: Lab worker and MCP last successful deploys are W1, **both suspended**. The MCP resume path built `d467ab9` (the hazard). |
| #159 fixture pin | same branch (`6aede7da`) | Same as #156. `eb849b62..6aede7da` touches only `render.voice-lab.yaml` and one Lab test. |
| #160 W4 | **draft, not merged or deployed** | none |

- Voice `f128af0c` and LangGraph `def5c454` were not touched by any of these.
- **The Lab-only commits before W1 (`9ccfb57d`…`d467ab97`) changed only `tools/sophia-voice-lab`.** So the gateway's served code is equivalent to `6aede7da`, and no unreviewed backend code went live.

## Phase 1: reconcile (no paid use; Starter resume only where a check needs it)
- **R1. Installed access.**
  - Confirm the installed Sophia Voice Lab plugin/connector is present in your client, and its OAuth works (`get_capabilities` once the MCP is up).
  - Confirm Render, Vercel, Supabase (read-only) and AI Studio access.
  - Re-auth only on a demonstrated failure.
- **R2. Exact deployed component set.**
  - Served identities of the frontend, gateway, voice and LangGraph.
  - For the Lab worker and MCP: the deployed commit, the **configured deploy source and autodeploy**, the plan, the state, and every identity pin.
  - **Fix the resume hazard now (authorized):** set both Lab services' source to `codex/vt00-c5-first-use-repair` at `6aede7da` with autodeploy off, or deploy that specific commit instead of resuming. Prove that W1 boots.
- **R3. Natural fixtures and digest.**
  - Confirm at `6aede7da` that `BUNDLED_FIXTURE_MANIFEST_SHA256` = `7f41be2d…` = sha256(`fixtures/manifest.json`).
  - Confirm the probe WAV SHAs: greeting `e78406e7…`, calm `7dff8e44…`.
  - Once the Lab is live, confirm `get_capabilities` shows fixture readiness `verified`.
- **R4. Measured active-worker profile.** Measure the Pro cgroup reading (≥2 CPU, ≥3.5 GiB) immediately before admission. A-016 measured 2 CPU / 4 GiB; that is history, not today's measurement.
- **R5. The two Lab test failures, under Node 22.**
  - Run the full Lab suite on **Node 22** (the declared engine) at `6aede7da`. The earlier run used Node 24.
  - For each failure (`normal-provider-disconnect` catalog missing `voice_lab_canonical_transcript_unavailable`; `security` golden verifier returning null): give the cause, and say whether it can affect this run's **validity, termination or classification**.
  - **A minimal Lab-only fix is allowed only if one of them does**: one PR, one review round from me, deployed with the Lab.
  - Otherwise, record it as a known limitation.
- **R6. Supported End.** From the code at the deployed versions, state the supported End path's preconditions: run state, an open cleanup obligation, a non-faulted session, the exact-origin JSON 202 receipt and canonical finalization.
  - Show a handler-level test passing, at no cost.
  - **Recovery is never End.**
- **R7. Outstanding retention.**
  - A-014, due 2026-09-26T13:21:04.485Z; A-016, due 2026-09-26T17:47:33.580Z. Their automations must survive the R2 source change and include boot proof.
  - The new run adds its own obligation.
  - **Nothing is purged early.**
- **R8. Remaining authorized cost envelope.**
  - The envelope is **what remains of A-016's US$3.25** after its measured actual incremental cost: Render deltas, plus AI Studio for Sep 25 if it has posted.
  - Re-project this run conservatively.
  - **If the projection exceeds the remainder, or the actuals are too uncertain to bound it, that is the single budget ask.**
- **A-016 start-up timeout: from existing evidence only, no new campaign.** Spend at most about an hour on the retained evidence and logs. Is there an identified cause that would recur, such as a component mismatch, a cold start after redeploys, or the scenario path?
  - If yes and it is cheap to avoid, avoid it. For example, warm the served frontend and voice service before admission.
  - If unknown, proceed. The run will classify it.

**Single ask.** If anything in R1–R8 needs a **genuinely missing** budget or infrastructure authorization, put **all** of it in **one** request (`codex-031-ask`), ring #154 and stop. I will relay it to Davide once. Otherwise go straight on to Phase 2 without asking.

## Phase 2: one calibrated non-Builder conversation (authorized once the prerequisites pass)
- **Access:** through the **installed plugin**, against the **ordinary Sophia app**.
- **Scenario:** `start_voice_run`, `scenario_id=V-O01`, `scenario_version=vt00.scenarios.v1`. **Before the first `speak`, confirm both scenario fields on the durable run record.** The immediate receipt never carries them.
- **Order:**
  1. Starter checks.
  2. Pro, the 300 s cap, and the R4 measurement.
  3. Re-project the budget and confirm it is within the R8 remainder.
  4. Open the gates with exact identities.
  5. Send `conversation_greeting_probe`.
  6. **Only after a completed assistant turn with its output chain**, send `conversation_calm_probe`.
  7. Supported End, then export, then settlement.
- **Hard aborts are unchanged, and there is no retry. A start-up failure consumes the run.**
- **Close:**
  - gates closed, with the adapter-disabled frontend read back from the served site;
  - the worker back on Starter, both Lab services suspended, with **W1 kept** (roll back only on a Lab boot failure);
  - the retention automation for the new run;
  - the cost readback.

## Phase 3: classify, write up, end
**Classify with exactly one label:**
- **Usable calibrated Lab.** All of these hold:
  - input valid (browser-time continuity, PCM receipt);
  - provider transcripts;
  - assistant turn(s) with the output receive/schedule/start/complete chain;
  - supported End 202 plus canonical finalization;
  - normal export and settlement;
  - cleanup complete;
  - within budget.
- **Isolated product defect.** The Lab evidence is valid, the input is valid, the harness passed, and it terminated through supported End or a **designed** recovery with complete evidence. A specific product component fails, attributed with evidence.
- **Invalid/unreliable Lab.** Any of these:
  - a start-up failure with no attributable product cause;
  - invalid input or harness;
  - End or termination unreliable, other than a designed refusal;
  - incomplete evidence.
- **Access/budget blocked.** The single ask was refused or cannot be met.

**If the label is invalid/unreliable, or the Lab cannot terminate reliably:**
- stop further autonomous Lab engineering;
- leave the Lab suspended, with its retention automations intact;
- write a short recommendation for a **separate, supervised ordinary-app test route**: a human with a real microphone on the ordinary app, observed through product logs, with no Lab harness in the loop.

**Final handback `codex-031`, under 80 lines:**
- R1–R8 results;
- the observed versions (served, and deployed-but-suspended);
- input validity;
- the product observation;
- End, export and settlement, with the End kind;
- cost (actuals and remaining envelope) and retention (every open obligation with its deadline);
- the classification label, with evidence.

Then delete the doorbell automation, ring #154, and **end this assignment. Do not start another.**
