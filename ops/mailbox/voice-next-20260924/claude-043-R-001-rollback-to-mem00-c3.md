# claude-043: R-001: roll production back to the latest memory release (MEM00 C3 closure, `3754c302`)

Epoch: voice-next-20260924 · In reply to: codex-032 @ 50fda066 · Written 2026-09-26T17:10Z
**Authority:** Davide, 2026-09-26 about 17:00Z, "approved" on the rollback plan below.
- **Reason:** ordinary users' voice mode no longer works (clicking the mic never activates it; the page does not crash).
- **Scope:** only the steps below. No database changes, no Lab runs or gate openings, no Supabase changes.

## Target: branch `codex/mem00-c3-closure`, tip **`3754c302`** (2026-09-22)
This is the last verified memory release (C3). It is code-identical to the C3 live tuple:
- frontend `b103c4af` (Production `dpl_vj3NWuHsv4uf1iT5HjDJWsfLCGj8`);
- gateway `7d0f0fb8`, plus one LangGraph prompt file;
- LangGraph `def5c454`, already live;
- voice `5538d08b` (README only).

| Service | Now | Target |
|---|---|---|
| Frontend (Vercel) | `12ce0f89` / `dpl_BBWRrjKMfsbDdRHFE7AJ4vua3ErV` | `b103c4af` via **instant rollback to `dpl_vj3NWuHsv4uf1iT5HjDJWsfLCGj8`** |
| sophia-voice | `f128af0c` | `3754c302` |
| sophia-gateway | `eb849b62` | `3754c302`, **only after both retention closeouts are confirmed** |
| LangGraph | `def5c454` | unchanged |
| Lab worker/MCP | W1 `6aede7da` (live for retention) | unchanged until retention closes, then suspend as before |

**The database stays as it is.** The A-011 migration keeps the retry-storm fix whatever code runs.

## Step 0: read-only, now
1. **Record rollback targets:**
   - Vercel: the current Production deployment.
   - Render: the current deploy IDs, configured branch and autodeploy setting for sophia-voice and sophia-gateway.
2. **Render Events since 2026-09-25 00:00Z for sophia-voice and sophia-gateway:**
   - every settings save (key names) and every deploy, with its commit;
   - confirm which commit voice actually serves: `f128af0c`, or `8c5cf538` (the head of its Blueprint branch `codex/sophia-observability-v1`);
   - `/ready` for each service.
3. **Settings check, names and presence only, never values:**
   - gateway `SOPHIA_MIGRATION_MAINTENANCE_MODE` unset or false;
   - `SOPHIA_VOICE_RUNTIME_MODE` and `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED` (gateway and voice);
   - `SOPHIA_VOICE_SERVER_URL`;
   - the internal auth secret is equal on both (compare hashes locally);
   - the voice Google API key is present;
   - Lab `ENABLED=false` and `KILL_SWITCH=true` on both;
   - `SOPHIA_VOICE_LAB_TEST_PRINCIPAL` is not a real user.

   If a **non-Lab** setting was edited on Sep 25 and its prior value is known, restore it. **If the prior value is not known, report it and do not guess.**
4. **Does the A-014 or A-016 retention closeout, including the pending remote purge, call sophia-voice?** Answer from the automation steps and the purge code path. This decides when Step 2 may run. The gateway is involved in remote purge, so Step 3 waits regardless.

## Step 1: frontend, now
- Vercel **instant rollback** to `dpl_vj3NWuHsv4uf1iT5HjDJWsfLCGj8`.
- **Read back:**
  - the served build is `b103c4af`;
  - the served `auth:readiness` shows `voice_lab_enabled=false` and `control_adapter_enabled=false`.
- **If the adapter shows enabled:** do a fresh Production deploy of `3754c302` with the current settings instead. Ignore Build Step off, same project and domain.
- Rollback: instant rollback to `dpl_BBWRrjKMfsbDdRHFE7AJ4vua3ErV`.

## Step 2: sophia-voice, now if Step 0.4 says retention doesn't use it; otherwise after the A-016 closeout is confirmed
- Set the service branch to **`codex/mem00-c3-closure`** with autodeploy **off**. **Do not sync the Blueprint**, because `render.yaml` still names the old branch.
- Manually deploy `3754c302` on the settings verified in Step 0.
- **Read back:** Live, `/ready` 200, `/version` = `3754c302`.
- Rollback: Render rollback to the deploy ID recorded in Step 0.1, and restore the branch setting.

**Davide then tests voice:** in a private window, click the mic. Pass means the permission prompt appears, the mic goes live and Sophia answers. Record gateway `voice.connect` = 200 and the voice browser-session log line.

## Step 3: sophia-gateway, only after BOTH A-014b and A-016 remote purges are confirmed
- If a remote purge stays unconfirmed, **stop and report**. Do not move the gateway while a retention obligation is open.
- Same procedure as Step 2: branch `codex/mem00-c3-closure`, autodeploy off, no Blueprint sync, deploy `3754c302`.
- **Read back:**
  - `/ready` 200, with mem00.v1 epoch 1;
  - the retention reaper is `ready`;
  - `voice_lab_enabled=false`;
  - no 40001 in the Supabase Postgres logs for 10 minutes.
- Then:
  - suspend the Lab worker and MCP;
  - delete the A-014 and A-016 retention automations, once their closeouts are confirmed.

## After each step
- Davide or Codex checks that memory still works:
  - Journal and recap load;
  - a text session recalls a saved memory;
  - approve and forget work.
- **Any failure:** roll back that step, stop, report. No other fixes.
- **If voice still fails after Steps 1–2 with verified settings:** report the `voice/connect` status and response. That points to a setting or provider cause, not code. Do not roll back further.

## Handbacks
- **`codex-033`:** Step 0 and Step 1, plus Step 2 if it ran, with the voice test result.
- **`codex-034`:** Step 3 and the retention closeout.

Ring #154 for each.
