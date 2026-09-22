# VT00-C5-R1 operator handover — NOT READY, 2026-09-22

Current authoritative status is `current-state.md` and `first-use-evidence-index.md`; the older record below is retained history. User approved the separate $5 Voice cap and BOTH Lab services' post-cleanup suspension. OAuth is connected; no new provisioning is needed. Product pins are current. One installed-plugin attempt failed basic audio and normal-End evidence, then completed verified recovery and durable export. MCP admission is closed; both Lab services are verified suspended as of16:02Z during repair. Final product-gate closure is still owed. Wake the existing services only for the verified candidate retry.

Next use is not yet qualified. Finish the narrow authenticated End receipt repair, verify its exact compatible deployment, and retry the same C5 audio journey within the remaining authorized cap. No automatic/provider-model upgrade or broader certification. Do not reuse old pinned hashes from the historical instructions. The two adaptive audio turns and playback must pass before declaring VOICE_LAB_INTERNAL_USE_READY.

## Historical record

# VT00-C5-R1 operator handover — validation pending

Latest checkpoint (2026-09-21 17:07 UTC): OAuth is connected and both repaired
product components are deployed, independently verified at406ff0a6. See
deployment-receipt.md and evidence/pre-activation-capabilities.json. Earlier
access/deployment-blocker entries below are historical. Current activation is
still blocked by the controller's Production Deploy approval gate; all Voice
gates remain closed. The exact remaining configuration/run/close scope is in
the worktree-root activation-scope.md. The user has been asked once for the
remaining supported platform action and an explicit MCP+worker suspension
posture, because the referenced agreement could not be recovered. No live run
has started. Do not use a different controller to route around the denial.

This is a resumable work record, not a readiness handover. Completion still
requires the real installed-plugin demonstration and present-run settlement.

1. Reauthenticate the existing Sophia Voice Lab connection through its supported
   client flow; call installed get_capabilities and retain its exact versions,
   package hash, limits, targets and obligations. No recurring provisioning.
2. Review [PR #149](https://github.com/davidelaverga/Sophia-Agent/pull/149)
   (use its latest head, including the circular-import follow-up), then finish qualification/deployment on the
   current MEM00-compatible source. One shared deployment owner/window. Keep
   receiving authentication installed and memory configuration unchanged.
3. Verify current resources and permissions; preserve the historical exception.
   Use the original bounded window (concurrency one; ceiling 30 minutes,
   20 utterances, 180 seconds injected audio, 30 seconds per utterance) only
   after confirming these are still the authorized limits. This demo uses two
   short utterances, no Builder/fault/reconnect/endurance campaign. Raw audio off.
4. Open in existing frontend → product → worker → MCP order, with exact verified
   pins and fresh singleton readiness. Start via plugin; wait for actual READY.
5. Speak once, inspect the actual reply and input/output/playback chain, choose
   the second utterance from that reply, then wait and inspect both chains.
6. End via the supported plugin operation, wait for finalization and resource
   receipts, export durable evidence. Account for browser/process/provider,
   session, operation queues and any unexpected Builder task.
7. Close MCP admission, settle resources, close worker, Gateway/Voice, frontend,
   and suspend the services required by the established agreement. Preserve
   inspection/recovery until obligations are disposed. Report separate harness
   and product verdicts plus exact versions and next-use recipe.

Do not label this plan `VOICE_LAB_INTERNAL_USE_READY` or `PROMOTE VT00`.
