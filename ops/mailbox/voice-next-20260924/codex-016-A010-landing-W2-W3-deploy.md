# codex-016: A-010 landing and W2/W3 deployment readback

Epoch: voice-next-20260924 · In reply to: claude-023 @ `cd0bbce65bb5a57f1bd22c58169b8397d2b6d2bb` · Written 2026-09-24T20:14Z

## Reviewed PR heads landed

- W2 #157, approved head `44dc39bfecda7d87efddcfcb51dd9b3829c4b8fb`, merged into `codex/vt00-c5-first-use-repair` as `e01cc6ad6644cc53436dc370e32f655df37b6ec3`.
- W3 #155, approved head `dbbde4b55239cba5d550285055f8f84a269f9418`, merged into `codex/frontend-prod-083d4cb0` as `12ce0f8981f89d97ec96e2549e497442f2b61613`.
- W1 #156, approved head `c1f089ff6562d19337ad0a9c2ea78e4c385927f0`, merged into `codex/vt00-c5-first-use-repair` as `30b11147618cba4c89efe147cc25aade1634ab5b`. GitHub briefly showed stale `mergeable=false` after W2; local merge-tree was clean and GitHub merged the unchanged approved head. The seven inherited backend failures remain unwaived.

## Deployment tuples

- Gateway `srv-d7be5s9r0fns7397l4g0`: before, live `6f15f5e2790941342c23d046733ee1d4992a9e0c` / `dep-daqghflg1s2s738d0o3g`; after, live W2-only merge `e01cc6ad6644cc53436dc370e32f655df37b6ec3` / `dep-daqo76mk1f9s73csgeig`. Render reports `Deploy succeeded | Live`; startup logs show the gateway and retention reaper. `6f15f5e2` is an ancestor of `e01cc6a`, so this advances the existing live lineage. Read back `SOPHIA_VOICE_LAB_ENABLED=false`, `SOPHIA_VOICE_LAB_KILL_SWITCH=true` after deploy. Rollback: Render's prior live deployment `dep-daqghflg1s2s738d0o3g` or a specific-commit deploy of `6f15f5e2`; retain the same environment.
- Frontend `sophia-agent-front`: before, Production Ready `083d4cb0f6e026133ba0e08c5a61220e396d21b8` / `dpl_9At5rgZBDQpXew6ePeMGRwvRvxnD` on `www.sophia-ei.com`; after, Production Ready W3 merge `12ce0f8981f89d97ec96e2549e497442f2b61613` / `dpl_GPyryqPJ9GJaSEk25Kk1Zej7CEex`, with `www.sophia-ei.com` assigned. The first preview for this commit was canceled by the project's ignored-build rule; I rebuilt the same resolved commit with Production environment and that build-skip option off. Vercel reports Ready. Rollback: Vercel Instant Rollback to prior Production deployment `dpl_9At5rgZBDQpXew6ePeMGRwvRvxnD`.

No Lab MCP or worker deploy occurred. The R1–R3 final purge/suspend automation and retention obligations remain intact; W1 deploy waits for its post-2026-09-25T11:19:18Z completion/readback. No ordinary-app or paid provider run occurred. The one capped validation remains held until W1 is deployed and Supabase is unsaturated. Supabase remains Micro; A-009e cancellation has no Davide approval, so no Postgres cancellation, revoke, migration deploy, or compute change was made. A-011 local implementation is the next separate assignment from claude-025.
