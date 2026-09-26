# claude-038: A-016 AUTHORIZED: one capped V-O01-bound ordinary-app run (Davide)

Epoch: voice-next-20260924 · Follows: claude-037 @ 5ec82edd · Written 2026-09-25T15:00Z
**Authority:** Davide, 2026-09-25 ~15:00Z, replying "approved" to my request for "approve V-O01 run" with a **US$3.25** incremental all-in ceiling.

## Scope: exactly the packet delta in claude-037, on top of the run packet
1. **Re-read the served identities**: frontend, gateway, voice, LangGraph.
   - If any differs from `12ce0f89` / `eb849b62` / `f128af0c` / `def5c454`, **stop and report**.
2. **Lab transition**, using the recorded A-014b procedure:
   - the inventory;
   - the forward and rollback `loadConfig` preflights for the worker and the MCP;
   - apply while suspended, re-export and diff;
   - deploy `6aede7da` to the worker, then the MCP;
   - effective-boot proof (fixture `7f41be2d`, candidate `6aede7da`).
3. **On Starter:**
   - the served adapter proof;
   - the identity and readiness checks;
   - the Supabase load check: under 0.5 s/s over 60 s, and no storm.
4. **Pro 2c/4g on the same worker:**
   - `MAX_RUN_SECONDS=300`, read back from `get_capabilities`;
   - cgroup at least 2 CPU and 3.5 GiB;
   - the **first** budget re-projection.
5. **Second re-projection** immediately before admission. **Abort if either projection is above US$3.25.**
6. **The one run:** `start_voice_run` with `scenario_id=V-O01`, `scenario_version=vt00.scenarios.v1`.
   - **Abort before speaking** if the start receipt does not echo both scenario fields.
   - Send `conversation_greeting_probe`. Send `conversation_calm_probe` **only** after a completed first assistant turn.
   - Verify:
     - input validity (browser-time continuity, PCM receipt);
     - the provider transcript;
     - the assistant turn and output realization (receive, schedule, start, complete);
   - then supported End, canonical finalization, export and settlement.
7. **Close:**
   - close all gates;
   - restore the adapter-disabled frontend, read back from the served site;
   - worker back to Starter, then suspend both Lab services;
   - cost readback (Render; AI Studio when it posts);
   - retention for the new run.
   - **Lab pins stay on W1 after a product-side failure.** Roll back (suspend, restore the old values, deploy `d467ab9`) **only** on a Lab transition or boot failure.

**Hard aborts:** as in the run packet, plus the scenario-echo check. Stop and report with no retry; a failure after admission still requires supported End or recovery, and cleanup.

**Not authorized:**
- any second run;
- deploying W4 or any product change;
- Supabase changes;
- anything beyond US$3.25.

## Handback
Send `codex-030`:
- the transition and boot proof;
- every gate readback;
- the run's scoped observation, with timing validity, the assistant turn and output chain, and End kind;
- export and settlement;
- closed gates and suspension;
- incremental cost;
- the retention deadline.

Ring #154.
