# codex-022: A-011 rollout handback

Epoch: voice-next-20260924 · Follows: claude-028 @ 25c36562 · Written 2026-09-24T21:42Z

## Prerequisites and deploy
- P1: private pre-image of all **47** target definitions and metadata outside the repo at `/Users/davidelaverga/Documents/Sophia-Voice-private/a011-20260924` (0700 directory, 0600 files). It includes `preimage.csv`, `metadata.json`, and transaction-wrapped `rollback.sql`; no definition contents are in this mailbox.
- P2: `sophia-langgraph` remained Live at `def5c454e665628875cbad2ffd39a21a9f72749a`, deploy `dep-dap8uvjtqb8s73fom2bg`. Its live-to-merge diff has 117 files, so it did **not** meet the “only #158” condition; no LangGraph deploy.
- PR #158 merged at exact reviewed head `ad9fd26304a259842bf8cf4d1c58448ef606fcea` into `codex/vt00-c5-first-use-repair`; merge commit `eb849b62d0e80777fbe1f333818510b0e7f1ff7f`.
- Gateway deploy `dep-daqp83hsrm7s73dttcmg` of that merge is **Live**; Render `/ready` returned 200. Prior Gateway rollback deploy: `dep-daqo76mk1f9s73csgeig` at `e01cc6ad6644cc53436dc370e32f655df37b6ec3`. Database rollback is the P1 private `rollback.sql`, before Gateway rollback if attributable harm appears.

## Migration and readbacks
- In Supabase production SQL Editor as postgres, ran exact committed `2026_09_24_non_retryable_rpc_business_errors.sql` **once**. Staged SQL Git blob `e3527f047e1c892f94f70a8d027fb2c9bb203488` matched the reviewed file. SQL Editor: **Success. No rows returned**; no edit or retry.
- Before: 17 active PostgREST statements on `sophia_memory_authorize_extraction_dispatch`. Postgres logs 23:21–23:23 Europe/Rome: about **12,000 40001 / 2 min**, zero P0001.
- Within two minutes: 21:24:09Z query showed **0 active authorize / 0 active PostgREST**, **0** public PL/pgSQL functions retaining explicit `ERRCODE='40001'` (137 total public PL/pgSQL functions). Postgres logs 23:24–23:26 Europe/Rome: **0 40001 / 0 P0001**. Later 23:31–23:33 and 23:37–23:39 windows also had **0 Postgres errors**.
- The 47 post-apply signatures, owners, ACLs, security-definer flags, function settings, and definition MD5s all match P1 after the reviewed 40001→P0001 normalization: **0 mismatches**. Private post-apply metadata CSV is beside P1.
- At 21:39:25Z (+15 min), **0 active authorize / 0 active PostgREST**. Gateway Render application-log searches over the last hour: **0** `MEM00 worker cycle failed`, **0** `memory.governance`, **0** generic `ERROR` matches. Gateway `/ready` 200; unauthenticated GET `/api/sophia/readback-probe/memory-observability` returned expected **401** (auth boundary only, not a certified memory-data read).
- Supabase database CPU chart said **“Unable to load data for CPU usage”** before, at +2, and at +15 minutes. The overview remained **Healthy / Micro** but displayed **CPU 95%** and a high-CPU banner throughout; that card does not establish a declining time series. **Supabase unsaturation is unverified**, so the A-010 capped validation remains gated. No harm attributable to A-011 observed; no rollback.
- No A-009e cancel, terminate, revoke, restart, compute/plan change, other migration, paid live run, or A-010 step. R1–R3 retention and the final-purge/W1 Lab deploy obligation remain intact.
