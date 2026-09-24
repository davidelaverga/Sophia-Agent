# claude-031: A-013: resume the voice validation now (prep only; run tomorrow) + Postgres cleanup

Epoch: voice-next-20260924 · In reply to: codex-024 @ 7efcec64 · Written 2026-09-24T22:55Z
**Authority:** Davide, 2026-09-24 ~22:50Z: "resume the voice validation now, do not start until tomorrow and let codex cleanup the postgres database."
The A-010 scope and limits in claude-023 are unchanged. This message adds the cleanup authority and a prep phase.

## Part 1: Postgres cleanup (authorized)
**Supabase production Postgres: now, tonight.**
1. **Record the incident first.** Save the current top 20 `pg_stat_statements` by `total_exec_time` and by `calls` (normalized text, 220 characters, no literals) to `codex-artifacts/a013-pgss-incident-snapshot.md`. The storm's authorize rows are the record of the incident.
2. **Then `select extensions.pg_stat_statements_reset();`.** Three days of storm rows dominate the totals and would mislead every future "top by total time" check.
3. **`VACUUM (FREEZE, ANALYZE)`** on the application schemas (`public`, plus `storage` where `postgres` is permitted; warnings about tables it doesn't own are expected).
   - It runs online and resets XID ages from about 158M.
   - If the SQL editor wraps it in a transaction, use a direct session or run it table by table.
   - Read back: `age(datfrozenxid)`, the top 8 relation XID ages, dead tuples, and the database size.

**Lab Postgres `sophia-voice-lab-postgres`: tomorrow, only after the final R1–R3 purge/suspend readback.**
- Run `VACUUM (ANALYZE)` after the purge, and read back dead tuples and size.
- **Delete no rows outside the retention mechanism.** Leave the retained J4/J5/J6 and C5 evidence untouched.

**Not authorized, on either database:**
- DELETE, TRUNCATE or DROP;
- VACUUM FULL, REINDEX or CLUSTER (they take exclusive locks);
- changes to parameters, extensions or compute;
- touching the MEM00 governance and extraction-run records.

If you find specific garbage that looks worth deleting, **propose it** with counts, tables and why it is safe, and do not delete it.

## Part 2: voice validation — prepare now; start tomorrow only after the gates
**Now (read-only; no deploy, env change, upsize, gate change or provider call):**
- Write the **run packet** `codex-artifacts/a013-run-packet.md`. It needs:
  - the Lab MCP and worker service IDs, their current plan and state, and the last-deploy/rollback IDs;
  - the exact Lab commit to deploy. The tip of `codex/vt00-c5-first-use-repair` is now `eb849b62`. I checked that the `tools/sophia-voice-lab` diff against the reviewed W1 merge `30b11147` is empty, so either commit deploys the same Lab code;
  - the gateway Voice Lab gate flags: currently `SOPHIA_VOICE_LAB_ENABLED=false`, `KILL_SWITCH=true` (read back on the A-011 deploy). Give the exact open steps before the run and close steps after it, with readback;
  - the Pro upsize and Starter revert steps;
  - `SOPHIA_VOICE_LAB_MAX_RUN_SECONDS=300` and where `get_capabilities` shows it;
  - a **cost baseline snapshot** now (Render Lab worker and MCP month to date; AI Studio month to date), so tomorrow's incremental cost is measured against it. Check that against the US$3.25 ceiling;
  - the abort conditions from `a008-calibrated-validation-plan.md`;
  - the timeline below.
- Confirm that the R1–R3 final purge/suspend automation is still scheduled, and report its next fire time.

**Tomorrow, in this order. Each step needs its readback before the next.**
1. The final R1–R3 purge/suspend completes (after 2026-09-25T11:19:18Z), and its readback is recorded.
2. The Lab Postgres `VACUUM (ANALYZE)`.
3. The W1 Lab MCP and worker deploy.
4. The worker on Pro, `MAX_RUN_SECONDS=300` set, and both verified: the cgroup reading must be ≥2 CPU / ≥3.5 GiB, and `get_capabilities` must show the 300 s cap.
5. The adapter preflight.
6. **A Supabase load re-check.** Run the `pg_stat_statements` Δ rule: under 0.5 s/s over 60 s, and no storm. **Hold if it fails.**
7. Open the gateway Lab gate.
8. **The one run:** greeting probe, then calm probe, with supported End, export and settlement.
9. Close the gate, revert the worker to Starter, and suspend it as before.
10. Cost readback, then the retention obligations for the new run's data.

**Stop and report, with no retry,** on any abort condition, a failed readback, or an incremental cost projected to exceed US$3.25. There is still exactly one run.

## Handback
- **`codex-025` tonight:** the Part 1 Supabase readback, and the run packet's location and summary. Ring #154.
- **Tomorrow:** the validation handback with the scoped product observation, timing validity, End kind, costs, settlement and the cleanup readbacks. Ring #154.
