# claude-046: Situation assessment and plan; R-008 (read-only checks, two draft PRs, one memory probe)

Epoch: voice-next-20260924 · Follows claude-045 · Written 2026-09-27T19:30Z
**Code reviewed at the served tuple:**

| Component | Commit | Scratch worktree |
|---|---|---|
| Frontend | `87d471f2` | `fe` |
| Gateway | `eb849b62` | `gw` |
| LangGraph | `def5c454` | `lg` |
| Voice | `f128af0c` | `vc` |
| Lab | `6aede7da` | `lab` |

**The R-007 prompt from claude-045 is WITHDRAWN. Do not execute it.**
- It fixed only D1 below.
- It also contradicted an existing test that asserts the stripping.

## 1. Research from voice: two independent defects; both must be fixed
**D1 (frontend): the Builder tools are never declared.** Confirmed in code; the served flag value still needs confirming.
- **What strips them:**
  - With `NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED` truthy, `withCoreviewGeminiToolDeclarations` removes all six generic Builder tools and `emit_artifact` from the Gemini setup, for every voice session. It is called at `gemini-browser-live-websocket-dogfood.ts:3370` and `:3452`, and the filter is at `coreview-actions.ts:1239-1264`.
  - Production passes no override (`useStreamVoiceSession.ts:3350` → `dogfood.ts:4412-4418`).
- **Why the server can't restore them:** `tools` is browser-owned, and the ephemeral token's field mask drops the server's tool list (`voice/realtime/gemini_browser_dogfood.py:90`, `:547-558`, `:620-631`). The browser sends the filtered setup straight to Google (`dogfood.ts:4251`, `:7203`).
- **The server prompt still tells Sophia to call `start_builder_task`** (`voice/realtime/sophia_prompt.py:135-137`). That prompt/tool mismatch is why she announced a launch.
- **LangSmith records the server baseline, not the tools actually sent** (`gemini_browser_dogfood.py:903-911`), so its 14-tool list is misleading.
- **The stripping is encoded in tests:** `gemini-browser-live-websocket-dogfood.test.ts:4565` (asserts at `:4692-4695`) and `coreview-actions.test.ts:591-609`.

**D2 (voice): the Builder bridge calls LangGraph unsigned, so it would get 401 even with D1 fixed.**
- `GeminiBuilderLifecycleExecutor._request_json` (`voice/realtime/gemini_tool_loop.py:1523-1545`) sends only trace headers.
- LangGraph has enforced receiving authentication since `e94b0047` (2026-09-18/19). `_authenticate` answers 401 when there is no `Authorization` header (`deerflow/sophia/langgraph_auth.py:139-141`).
- `5538d08b` (2026-09-21) signed the DeerFlow adapter's four paths (`voice/adapters/deerflow.py:55-90`) but not this executor. Its `/threads` and `/threads/{id}/runs` requests all fall inside the owner-scoped service-auth routes (`langgraph_service_auth.py:38`, `:75-92`), and the voice image already ships the signer (`voice/Dockerfile:50-51`).

**Also relevant:**
- `start_builder_task` is additionally gated on an explicit request in the latest user transcript (`gemini_tool_loop.py:101-155`, `:1848-1874`), so the acceptance request must be phrased explicitly.
- The parent-state write and the UI link require the browser's `threadId` to be a UUID (`:1489-1521`).
- Text-mode research uses the companion's own `start_builder_task` path and is not affected by either defect. **Not verified live.**

## 2. Memory recall
**Correction to codex-039:** the session-start `zero_memory` / `provider_hit_count=0` / `authorized_count=0` event is emitted on every fresh thread, so it is not evidence (`retained_admission.py:61-64`, `:85-98`).

**How recall works:**
- Per-turn recall calls the Mem0 v2 search with `filters={"AND":[{"user_id":subj},{"metadata":{"sophia_managed":True}},{"metadata":{"memory_contract_epoch":1}},{"metadata":{"environment":env}},{"metadata":{"provider_namespace":subj}}]}` and `limit=min(100, 4*limit)` (`memory_governance/mem0_projection_adapter.py:225-232`).
- It then authorizes hits against eligible, verified bindings (`sophia_memory_resolve_provider_hits`).

**What is known:**
- Write and read use the same namespace string by construction.
- Governed memories that are not searchable are never recalled.
- The repo's own contract probe, `tools/mem00_provider_contract_probe.py`, requires an immediate exact-filter search hit after an `infer=false`/sync write (`:90-103`). It passed in September (`docs/campaigns/mem00-durable-memory/forensic-pin.md:53-55`). R-004 now fails the same contract, so Mem0's provider behaviour appears to have changed. **Unproven.**
- **Resilience option:** a binding-based fallback in `GovernedMemoryReader.retrieve` (`reader.py:104-125`), which lists the owner's eligible and verified binding IDs and resolves them through the existing RPC. It gives no relevance ranking and is capped at 100.

**Still open:**
- Whether Davide's governed pool has any active memories at all. The active Journal was empty after the R-002 test Forget (codex-034 A3). An empty pool would make "recall degraded" partly expected.

## 3. A-014b retention: a livelock with no terminal state
**Why it can't finish:**
- Remote purge needs a Gateway receipt with `canonical_evidence_purged`, set in `settle` (`lab/.../postgres-recovery-control.ts:343-353`).
- Retries run every 30 s forever, with no cap and no terminal state (`recovery-control.ts:16`; status is CHECKed to `confirmed|unconfirmed`).

**Likely blockers:**
- **(a)** A capability deployment mismatch, answered with 409 `voice_lab_capability_deployment_mismatch`. It can be bypassed only with `SOPHIA_VOICE_LAB_CROSS_DEPLOY_RECOVERY_ENABLED` plus the kill switch (`voice_lab_capability.py:300-305`, `:942-962`).
- **(b)** A `session_provisional` product session that only the reaper can purge, which may be stuck on owner-ack or a finalization conflict (`voice_lab_recovery.py:3534-3553`; `voice_lab_retention.py:1632-1779`, `:1982-2011`).

**Diagnostic:** in `recovery_controls`, a flat `version` with a moving `recovery_scheduled_at` means the Gateway is not returning 200 (so 409 or 202). A `version` that keeps rising means live cleanup completes but the canonical evidence is not purged.

**Impact:**
- Ordinary users are unaffected. `voice_connect` checks retention readiness only when a Lab capability is present (`routers/voice.py:2729-2742`; `voice_lab_capability.py:880-883`).
- The degraded reaper blocks only Lab admission.
- The worker and MCP stay live, and cost money, while this runs.

## R-008 (approved when Davide pastes the prompt): read-only checks, two DRAFT PRs, one disposable memory probe
**Allowed:** no merge, no deploy, no env/settings change, no Lab action, no retention change, no data deletion apart from probe fixtures.

**S (read-only)**
- **S1.** Served-bundle value of `NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED` and `NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED` for `87d471f2`, with the Vercel env history date. Also `SOPHIA_GEMINI_COREVIEW_ENABLED` / `_STILL_FRAME_ENABLED` on sophia-voice. These are public or non-secret flags.
- **S2.** sophia-voice, over the full log retention:
  - the last `gemini.builder_lifecycle.start_builder_task launched` line;
  - any `LangGraph builder lifecycle request failed` lines;
  - whether `LANGGRAPH_URL` or `SOPHIA_LANGGRAPH_BASE_URL` is set and points at the live LangGraph host (host only).
- **S3.** Gateway and LangGraph logs: the date of the last successful Builder launch from **text** mode.
- **S4.** Supabase, counts only, for the cohort principal: canonical memories by lifecycle state; candidates by review state; bindings by `binding_state` × `metadata_verification_state`; projection jobs by state over the last 14 days.
- **S5.** For A-014b:
  - the `recovery_controls` `version` and `recovery_scheduled_at` now and 10 minutes later;
  - Gateway `/recover` response codes for that run over the last hour;
  - `/ready` reaper `last_cycle` (`pending`/`accepted`/`blocking`);
  - the obligation's cleanup phase and reason code;
  - the Lab worker and MCP plans with their cost rate.
- **S6.** Cost readback if posted: Render deltas for A-014b and A-016, and AI Studio for Sep 25.

**PR-F (frontend; base `codex/frontend-prod-083d4cb0` @ `87d471f2`). Open it only if S1 shows the still-frame flag is truthy.**
- **Change:**
  - At `:3370` and `:3452`, pass `allowGenericBuilderTools: true`. Keep `allowArtifactCreation: false`.
  - Make non-launch results truthful: `suppressedGenericBuilderToolResponse` gets a not-started message plus `builder_task_started: false`; `noActiveStatusResult` gets `builder_task_started: false`.
- **Tests:**
  - Update `dogfood.test.ts:4565` to assert that the initial and continuation setups contain the six generic tools plus the three Coreview Builder tools, with `emit_artifact` absent. It must fail on `87d471f2` first.
  - `start_builder_task` is relayed unchanged outside a review.
  - It is still suppressed during a review, with `builder_task_started: false`.
  - An empty status result carries no `task_id`.
  - Keep `coreview-actions.test.ts:591` unchanged; the helper's default is unchanged.
  - Keep every other review-routing test green.

**PR-V (voice; new branch from `f128af0c`)**
- **Change:**
  - Sign every `GeminiBuilderLifecycleExecutor` LangGraph request with `mint_service_authorization(owner_id=<trusted session user_id>, method, path)`, reusing the helper in `voice/adapters/deerflow.py`.
  - Synthetic/Lab builder threads must stay **fail-closed**: no new Lab capability path.
  - Add one prompt rule to `sophia_prompt.py:136`: never say a Builder or research task has started unless a tool result in this turn returned `ok=true` and a non-empty `task_id`; otherwise say it wasn't started.
- **Tests:**
  - A fake LangGraph that returns 401 without a valid signature: start, check and cancel all send it.
  - Unsigned is rejected.
  - The prompt contains the rule.
  - The voice suite stays green.

**M1 (disposable Mem0 probe; cleans up after itself)**
- Run `tools/mem00_provider_contract_probe.py --fixtures 1` with the Gateway environment and `--expected-activation open --expected-commit eb849b62d0e80777fbe1f333818510b0e7f1ff7f`, and report the receipt. A pin-fingerprint assertion failure is itself a finding; report it, don't bypass it.
- Then two synthetic records, each searched at 0, 60 and 300 s with both the exact runtime AND filter and a `user_id`-only filter:
  - (A) `infer=false`, `async_mode=false`;
  - (B) `infer=false`, `async_mode=true`.
- Delete both and verify GET 404 and search 0.

**Handback: `codex-040`, under 60 lines**
- S1–S6;
- the PR links, head SHAs and test fail→pass results;
- the M1 receipt and a 2×2 visibility table.

Ring #154, then stop.

## After R-008: approvals Claude will request from Davide
1. **Voice research.** Review both PRs, then:
   - deploy voice first (it is backward compatible);
   - read back `/ready` and `/version`;
   - deploy the frontend;
   - Davide makes one explicit research request.
   - **Rollbacks:** Render rollback of voice to its current deploy; Vercel `dpl_4jVRzMq4L1ANhx8nAWcR4uzBvptP`.
2. **Memory.** Based on M1:
   - if (B) is visible: an adapter change to `async_mode=true` with a bounded readback via event/GET (gateway);
   - if `user_id`-only is visible but the AND filter is not: a reader filter fix (LangGraph);
   - if neither: a Mem0 support ticket, plus the binding-based fallback.
3. **A-014b.** Based on S5:
   - if 409: a temporary Gateway flag pair for one confirming cycle, then revert;
   - if provisional-stuck: a targeted reaper fix or a supervised, in-retention purge.
   - Then suspend the worker and MCP, delete the automation and close #154.
4. **Later, separately approved.** Production runs from stacked side branches, about 880 commits ahead of `main`, which was last merged on June 18. The Render services name `codex/sophia-observability-v1` but serve other commits. Proposal: a pinned production branch (or tags) for each service, with no Blueprint sync, followed by a planned consolidation into `main`.

## Open product questions for Davide
- **F3:** during a review, and for 10 minutes after, fresh builds are always suppressed (the tautology at `dogfood.ts:6879-6895`). Should an explicit new deliverable be allowed?
- **F4:** `emit_artifact` is stripped from voice sessions. Should it be restored, and if so, how?
- **Voice Lab:** it stays suspended. Retire it, or keep it for later?
