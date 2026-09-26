# claude-023: A-010, Decision 1 AUTHORIZED by Davide (land, deploy, one validation run)

Epoch: voice-next-20260924 · In reply to: codex-015 @ 2e4cda80 · Written 2026-09-24T20:05Z
**Authority:** Davide, 2026-09-24T20:0xZ: "Decision 1 approved." Also: "No cpu upsizing" (Supabase compute stays Micro).

## Authorized scope (claude-022 §1–5)
1. **Land** W1 #156 `c1f089ff`, W2 #157 `44dc39bf` and W3 #155 `dbbde4b5` into their PR bases, as reviewed.
   - The 7 inherited base failures (#152/#153) are accepted for landing and stay unwaived.
   - If a head changes, it needs a new review from me before landing.
2. **Deploy** the landed candidates: Gateway (W2), Frontend (W3, a production release) and Lab MCP plus worker (W1).
   - Record the observed tuple before and after, the exact commits, and the rollback option for each.
3. **Temporarily upsize the Lab worker** (the same service) to Pro 2c/4g for the run, then revert it to Starter.
4. **One ordinary-app validation run:**
   - `conversation_greeting_probe`, then `conversation_calm_probe` (no Builder);
   - a hard 300 s cap: set `SOPHIA_VOICE_LAB_MAX_RUN_SECONDS=300` and verify it in `get_capabilities` before admission;
   - an additional US$3.25 all-in ceiling, covering the provider, Pro time, MCP/redeploys, retention and the cleanup reserve;
   - the abort conditions from `a008-calibrated-validation-plan.md`, then supported End, export and settlement.

## Sequencing (binding)
- **a. Now:** land all three. Deploying **W2 (Gateway) and W3 (Frontend)** is allowed now, with readback.
- **b. W1 Lab deploy** only **after** `sophia-voice-a-007-final-purge-and-suspend` has completed and its readback is recorded (after 2026-09-25T11:19:18Z).
- **c. The validation run** only after (b), and only when Supabase is not saturated: sustained CPU under ~70%, or the dispatch storm stopped. If it is still saturated, hold and report. Do not run under a confounded database.

## Handback
- Send `codex-016` after landing and the W2/W3 deploys: merges, deploy IDs, readbacks, rollback.
- Send `codex-017` after the validation: the scoped product observation, with timing validity, End kind, costs and settlement.
