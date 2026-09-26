# claude-028: A-011 production rollout AUTHORIZED (Davide)

Epoch: voice-next-20260924 · Follows: claude-027 @ b9a455cd · Written 2026-09-24T21:05Z
**Authority:** Davide, 2026-09-24 ~21:04Z, replying "approved" to my request "approve A-011 rollout". The request described the steps below: gateway first, then the migration, then readback, with a private pre-image for rollback.

You do not need to send codex-022 separately. Put P1/P2 into the rollout handback.

## Authorized, in this order
0. **Prerequisites. Do not skip.**
   - **P1:** capture the private pre-image of the 47 target definitions and the metadata snapshot, outside the repo. Record the count and the storage location only.
   - **P2:** check the deployed commit of `sophia-langgraph`. Deploy langgraph (in step 1) only if the merged head adds nothing but #158 on top of what it runs now. Otherwise skip it and record why.
1. **Merge and deploy the gateway.**
   - Merge PR #158 at exact head `ad9fd263` into `codex/vt00-c5-first-use-repair`.
   - Deploy **sophia-gateway** to the merged commit and wait until it is live and healthy.
   - **If the deploy fails or health does not return: STOP.** Do not run the migration. Roll back to `dep-daqo76mk1f9s73csgeig` and report.
2. **Apply the migration once.** Run `2026_09_24_non_retryable_rpc_business_errors.sql` at `ad9fd263` exactly as committed, in the Supabase SQL editor, as `postgres`.
   - **If it aborts** (unexpected function, missing RPC, or 40001 remaining), it rolls itself back. Do not edit and retry. Report the message.
3. **Readback within about 2 minutes:**
   - active PostgREST statements on the authorize RPC;
   - the 40001 and P0001 rates in the Postgres logs;
   - zero explicit 40001 remaining;
   - post-apply metadata and normalized MD5 compared with P1.
4. **Readback at 15 minutes:**
   - the CPU chart (before, and at +2 and +15 minutes);
   - gateway MEM00 worker and error logs (counts only);
   - one read-only memory route check showing its usual status.
5. **Rollback, only if a readback shows harm caused by this change**, for example a new error storm or memory routes failing:
   - first replay the database pre-image;
   - then roll back the gateway.

   Report immediately. A slow decline in CPU is not harm.

## Not authorized
- The A-009e cancel. It is no longer needed; if statements are still active after step 3, report them and do not cancel.
- `pg_terminate_backend`, a REVOKE, restarts, compute or plan changes, any other migration, or a data change.
- Any A-010 step. The W1 Lab deploy still waits for the final purge/suspend readback. The capped validation waits for an unsaturated Supabase, and step 4 decides that.

## Handback
Send `codex-022` in under 60 lines:
- P1 and P2;
- the merge commit and the deploy IDs, with their rollback IDs;
- the migration result;
- the step 3 and step 4 numbers.

Ring #154.
