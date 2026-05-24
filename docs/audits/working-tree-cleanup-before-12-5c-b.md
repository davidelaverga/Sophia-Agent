# Phase 12.5C-Prep - Working Tree Cleanup And Migration Hygiene

Date: 2026-05-22
Status: cleanup/hygiene pass only; no runtime behavior changes
Source branch: `audit/conversation-context-artifact-orientation-phase-12-5c`
Working branch: `cleanup/working-tree-hygiene-before-12-5c-b`

## Why Cleanup Was Needed

The Phase 1 through Phase 12.5C migration work left a large dirty working tree containing implementation code, tests, audit docs, runtime/user artifacts, generated cache output, deleted tracked session files, and local ignore-rule changes. Before continuing to Phase 12.5C-B artifact visibility proof work, the tree needed a dedicated inspection pass so source work and documentation are not lost during future cleanup.

This phase did not change Gemini/GPT routing, prompts, VAD, memory behavior, artifact behavior, builder behavior, or runtime implementation. It did not commit, push, stage files, restore tracked files, or run broad cleanup commands.

## Branch And Safety Baseline

| Item | Result |
|---|---|
| Source branch | `audit/conversation-context-artifact-orientation-phase-12-5c` |
| Cleanup branch | `cleanup/working-tree-hygiene-before-12-5c-b` |
| Main touched? | No. Baseline branch was not `main`; cleanup branch was created from the current branch. |
| Staged files before cleanup | None (`git diff --cached --name-status` returned no paths). |
| Staged files after cleanup | None confirmed (`git diff --cached --name-status` returned no paths). |
| Dirty count before cleanup | 209 (`git status --porcelain=v1 -uall | Measure-Object -Line`). |
| Dirty count after cleanup | 210 after adding this audit doc; ignored cache cleanup did not affect git status count. |

## Status Summary Before Cleanup

| Git status | Count | Meaning |
|---|---:|---|
| `M` | 46 | Modified tracked files. |
| `A` | 6 | Added tracked files already known to Git but not committed. |
| `D` | 2 | Deleted tracked runtime/session JSON files under `backend/users/`. |
| `??` | 155 | Untracked files, mostly migration docs/source/tests plus runtime user JSON output. |
| Staged | 0 | No staged files found. |

## Inventory Summary

| File/path | Git status | Category | Recommended action | Reason |
|---|---|---|---|---|
| `.env.example` | `M` | Runtime config/documentation | Keep; review with implementation branch | Tracks new voice/realtime environment needs; not generated. |
| `.gitignore` | `M` | Ignore hygiene | Keep; review before commit | Existing telemetry JSON ignore came from Phase 12.5B-E; this pass labels it and adds zip sibling only. |
| `COMPOUND_LOG.md` | `M` | Compound log | Keep | Phase log entries are legitimate migration documentation. |
| `backend/app/gateway/routers/voice.py` | `M` | Recent implementation source | Keep; review/test with voice phases | Voice gateway changes are migration implementation work. |
| `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/artifact.py` | `M` | Artifact implementation source | Keep; human review | Artifact path is high-risk; this pass did not alter it. |
| `backend/packages/harness/deerflow/sophia/mem0_client.py` | `M` | Memory implementation source | Keep; review with memory phases | Phase 12.4M/12.5B-C memory provider work. |
| `backend/packages/harness/deerflow/sophia/tools/emit_artifact.py` | `M` | Tool implementation source | Keep; review with artifact/tool phases | Existing migration work; not generated. |
| `backend/packages/harness/deerflow/sophia/tools/retrieve_memories.py` | `M` | Tool implementation source | Keep; review with Phase 12.5B-B/C/D/E | Existing realtime memory-tool work. |
| `backend/packages/harness/deerflow/sophia/tools/*_contract.py` | `??` | New provider/tool contract modules | Keep; review with migration source | Likely legitimate new contract surfaces for builder/artifact/memory tools. |
| `backend/tests/test_mem0_client.py` | `M` | Recent tests | Keep | Covers memory provider behavior. |
| `backend/tests/test_sophia_middlewares.py` | `M` | Recent tests | Keep | Covers companion middleware/artifact behavior. |
| `backend/tests/test_voice_gateway.py` | `M` | Recent tests | Keep | Covers voice gateway changes. |
| `backend/tests/test_retrieve_memories_contract.py` | `??` | Recent tests | Keep | Phase 12.5B-B/C/D/E memory contract coverage. |
| `backend/tests/test_voice_normalizer_sequence.py` | `??` | Recent tests | Keep | Voice transcript/order migration coverage. |
| `backend/users/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/sessions/{6c2f3270,85db2a07}*.json` | `D` | Deleted tracked user/session artifacts | Needs human review | Tracked April open-session records were removed and no same-ID untracked replacement was found. Do not restore or remove in cleanup phase. |
| `backend/users/*/sessions/*.json` | `??` | User/local runtime output | Leave for human review | 11 untracked generated session files. Could be local output or dogfood evidence; not safe to delete silently. |
| `frontend/next.config.js` | `M` | Frontend config source | Keep; review with frontend phases | Existing migration config change, not generated. |
| `frontend/src/__tests__/**/*.test.*` | `M`, `A`, `??` | Recent frontend tests | Keep | Gemini/OpenAI dogfood, telemetry, session, CSP, hook, and artifact contract coverage. |
| `frontend/src/app/api/sophia/**/voice/**` | `??` | Recent frontend API route source | Keep | Gemini/OpenAI dogfood and relay routes are legitimate migration implementation work. |
| `frontend/src/app/companion-runtime/voice-runtime.ts` | `M` | Frontend runtime source | Keep | Existing voice runtime migration work. |
| `frontend/src/app/components/VoiceFocusView.tsx` | `M` | Frontend UI source | Keep | Voice session UI migration work. |
| `frontend/src/app/components/session/PresenceArtifactPanel.tsx` | `M` | Frontend artifact UI source | Keep; review with artifact phases | Artifact visibility surface; not changed by cleanup. |
| `frontend/src/app/components/session/VoiceMetricsPanel.tsx` | `M` | Frontend telemetry UI source | Keep | Telemetry export and diagnostics UI work. |
| `frontend/src/app/debug/realtime/**` | `??` | Debug/dogfood UI source | Keep; review before commit | Debug pages and run recorder appear phase-owned. |
| `frontend/src/app/hooks/useStreamVoice.ts` | `M` | Frontend hook source | Keep | Existing voice runtime integration work. |
| `frontend/src/app/hooks/useStreamVoiceSession.ts` | `M` | Frontend hook source | Keep | Large current-session voice migration changes; not generated. |
| `frontend/src/app/hooks/voice-session-event-ingestion.ts` | `??` | Frontend hook source | Keep | Event ingestion source, likely legitimate phase work. |
| `frontend/src/app/lib/artifacts-adapter.ts` | `M` | Frontend artifact adapter source | Keep | Artifact adapter changes are source work. |
| `frontend/src/app/lib/auth/server-auth.ts` | `M` | Frontend auth source | Keep | Existing auth/voice integration work. |
| `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts` | `A` | Dogfood implementation source | Keep | Phase-owned Gemini dogfood harness. |
| `frontend/src/app/lib/openai-browser-webrtc-dogfood.ts` | `??` | Dogfood implementation source | Keep | Phase-owned OpenAI dogfood harness. |
| `frontend/src/app/lib/turn-capture-diagnostics.ts` | `??` | Diagnostics source | Keep | Turn-capture diagnostics work. |
| `frontend/src/app/lib/voice-runtime-metrics.ts` | `M` | Telemetry implementation source | Keep | Voice metrics source work. |
| `frontend/src/app/lib/voice-telemetry-report.ts` | `A` | Telemetry implementation source | Keep | Generates local telemetry export; source file is legitimate. |
| `frontend/src/app/lib/voice-types.ts` | `M` | Frontend type source | Keep | Voice runtime type changes. |
| `frontend/src/app/session/**` | `M` | Frontend session/artifact source | Keep | Session and artifact surfaces are source work. |
| `skills/public/sophia/AGENTS.md` | `M` | Runtime contract/agent instructions | Keep; human review | Sophia companion-builder contract file. Cleanup pass did not modify prompts or skill behavior. |
| `users/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/handoffs/latest.md` | `M` | User/local runtime artifact | Needs human review | Tracked handoff changed; could be local session output or intentional fixture update. |
| `users/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/memories/review_metadata.json` | `M` | User/local runtime artifact | Needs human review | Tracked review metadata changed; do not revert/delete in cleanup. |
| `users/*/recaps/*.json` | `??` | User/local runtime output | Leave for human review | 20 untracked recap files. Likely generated, but may be dogfood evidence. |
| `users/*/traces/*.json` | `??` | User/local runtime output | Leave for human review | 3 untracked trace files. Trace files can be evidence; not deleted. |
| `voice/config.py` | `M` | Voice implementation source | Keep | Provider/runtime config source work. |
| `voice/server.py` | `M` | Voice implementation source | Keep | Voice server migration work. |
| `voice/sophia_llm.py` | `M` | Voice implementation source | Keep | Voice LLM runtime integration work. |
| `voice/realtime/gemini_browser_dogfood.py` | `A` | Voice dogfood implementation source | Keep | Phase-owned Gemini dogfood harness. |
| `voice/realtime/*.py` | `??` | Voice realtime implementation source | Keep | New runtime/provider/normalizer/tool modules are legitimate migration source. |
| `voice/tests/*.py` | `M`, `??` | Voice tests | Keep | Realtime provider, normalizer, dogfood, and prompt tests. |
| `docs/architecture/sophia-realtime-runtime-contract.md` | `??` | Runtime contract doc | Keep | Central phase contract; referenced by Phase 12.5 docs. |
| `docs/architecture/sophia_frontend_architecture_spec_v2.md` | `??` | Architecture/spec doc | Keep; review | Looks like legitimate architecture documentation. |
| `docs/architecture/sophia_gpt_realtime_experiment_spec_v1_3.md` | `??` | Architecture/spec doc | Keep; review | Looks like legitimate GPT realtime experiment spec. |
| `docs/audits/*.md` | `??` | Recent docs/audits | Keep | Phase 11 through 12.5C audit record; do not delete. |
| `docs/common-pitfalls.md` | `??` | Common pitfalls doc | Keep | Migration knowledge update. |
| `docs/debug/gemini-live-fully-rendered-sophia-prompt.md` | `??` | Prompt debug doc | Keep; review | Debug documentation, not a runtime prompt change. |
| `docs/testing/**` | `??` | Test/dogfood documentation and schema | Keep | Dogfood run templates, schemas, and testing notes. |
| `scripts/render_gemini_live_prompt.py` | `??` | Utility script | Keep; review | Debug/prompt rendering utility, not generated output. |
| `specs/sophia_*_v1.md` | `??` | Source specs | Keep | Requested examples list these as legitimate migration specs. |
| `.pytest_cache/`, `.ruff_cache/` | ignored | Cache files | Deleted now | Exact ignored generated cache directories; safe to regenerate. |
| `.venv/`, `frontend/node_modules/`, logs | ignored | Local environment/build/log output | Leave | Large local dependencies/logs; not part of dirty status. No broad cleanup. |

## Phase Ownership Map

This mapping is approximate and based on filenames, audit docs, and the realtime runtime contract entries.

| Phase | Likely owned files/path families | Keep/delete guidance |
|---|---|---|
| Phase 12.4K-B | `docs/audits/gemini-transcript-coalescing-correctness-phase-12-4k-b.md`, transcript/relay tests, `frontend/src/app/hooks/useStreamVoiceSession.ts`, Gemini dogfood transcript handling | Keep; legitimate transcript correctness work. |
| Phase 12.4L | `docs/audits/gemini-spoken-intent-deictic-policy-phase-12-4l.md`, `voice/realtime/sophia_prompt.py`, prompt guidance tests | Keep; no prompt files changed in this cleanup. |
| Phase 12.4M | `docs/audits/gemini-memory-parity-artifact-contract-phase-12-4m.md`, `voice/realtime/gemini_memory_context.py`, Mem0/setup-context tests, `backend/packages/harness/deerflow/sophia/mem0_client.py` | Keep; memory parity/source work. |
| Phase 12.5A | `docs/audits/realtime-context-value-decision-phase-12-5a.md`, runtime contract/common pitfalls updates | Keep; docs-only decision work. |
| Phase 12.5B-A | `docs/audits/sophia-voice-spec-alignment-phase-12-5b-a.md`, `specs/sophia_*_v1.md`, runtime contract updates | Keep; source specs and audit work. |
| Phase 12.5B-B | `retrieve_memories_contract.py`, `retrieve_memories.py`, Gemini/OpenAI tool declaration tests, `docs/audits/realtime-retrieve-memories-tool-phase-12-5b-b.md` | Keep; realtime memory tool contract work. |
| Phase 12.5B-C | `mem0_client.py`, Gemini memory provider availability docs/tests, `docs/audits/realtime-memory-tool-availability-phase-12-5b-c.md` | Keep; provider availability work. |
| Phase 12.5B-D | Memory routing/epistemic docs and prompt guidance tests, `docs/audits/realtime-memory-routing-epistemic-honesty-phase-12-5b-d.md` | Keep; behavior guidance source/tests. |
| Phase 12.5B-E | Attribution diagnostics, telemetry redaction/report files, `.gitignore` telemetry JSON ignore, `docs/audits/memory-attribution-tree-cleanup-phase-12-5b-e.md` | Keep; this prep adds only zip ignore and cleanup audit. |
| Phase 12.5C | `docs/audits/conversation-context-artifact-orientation-phase-12-5c.md`, runtime contract/common pitfalls updates | Keep; docs-only artifact orientation design. |

## Generated/Local Artifact Findings

| Artifact type | Finding | Action |
|---|---|---|
| Local telemetry JSON/zip exports | No visible ignored `sophia-voice-telemetry-report-*.(json|zip)` exports were present during this pass. Docs mention earlier exports used as investigative evidence. | No telemetry exports deleted. Added zip ignore sibling for future generated exports. |
| Python lint/test caches | `.pytest_cache/` and `.ruff_cache/` existed as ignored local caches. | Deleted exact cache directories. |
| Dependency/build caches | `.venv/` and `frontend/node_modules/` exist and are ignored; `git ls-files --others --ignored` reports Windows filename-length warnings inside `frontend/node_modules/.pnpm`. | Left untouched; no broad dependency cleanup. |
| Runtime user JSON | 34 untracked JSON files under `backend/users/*/sessions`, `users/*/recaps`, and `users/*/traces`. | Left untouched for human review because dogfood traces/recaps may be evidence. |
| Logs | `logs/` is ignored and not part of the visible dirty status. | Left untouched. |

## Files Cleaned

| Path | Action | Reason |
|---|---|---|
| `.pytest_cache/` | Deleted exact ignored directory | Generated pytest cache, safe to regenerate. |
| `.ruff_cache/` | Deleted exact ignored directory | Generated Ruff cache, safe to regenerate. |

No source, tests, docs, tracked files, untracked migration files, user recaps, user traces, user sessions, logs, dependencies, or build outputs were deleted.

## `.gitignore` Review

The working tree already had one Phase 12.5B-E ignore addition for generated telemetry JSON exports:

```gitignore
**/sophia-voice-telemetry-report-*.json
```

This cleanup pass kept that exact-prefix JSON rule, added a comment, and added the matching zip rule:

```gitignore
# Sophia voice local telemetry exports
**/sophia-voice-telemetry-report-*.json
**/sophia-voice-telemetry-report-*.zip
```

The pattern is intentionally narrow: it only matches files with the generated telemetry export prefix and only `.json`/`.zip` extensions. It does not hide arbitrary JSON, docs, source, test fixtures, frontend files, backend files, or voice modules.

## Deleted Tracked Files Review

| Deleted tracked file | HEAD content summary | Replacement found? | Recommendation |
|---|---|---|---|
| `backend/users/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/sessions/6c2f3270-cca1-4797-ad92-d8351f4d7ee1.json` | April 16 open text `prepare`/`gaming` session with zero messages. | No same-ID untracked replacement found. | Needs human review; do not restore or remove automatically. |
| `backend/users/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/sessions/85db2a07-4cbb-452a-a845-952ec445019b.json` | April 16 open text `prepare`/`gaming` session with zero messages. | No same-ID untracked replacement found. | Needs human review; do not restore or remove automatically. |

## Files Intentionally Kept

- All modified and added source files under `backend/`, `frontend/`, and `voice/`.
- All recent tests under `backend/tests/`, `frontend/src/__tests__/`, and `voice/tests/`.
- All recent docs/audits/specs under `docs/` and `specs/`.
- `COMPOUND_LOG.md` and `docs/common-pitfalls.md` migration knowledge updates.
- `skills/public/sophia/AGENTS.md`, because it is a tracked runtime contract file and this cleanup phase must not alter prompt/skill behavior.
- All runtime user/session/recap/trace JSON, because some may be dogfood evidence and tracked user artifacts already exist in the repo.

## Files Needing Human Review

- The two deleted tracked `backend/users/.../sessions/*.json` files listed above.
- Modified tracked user artifacts: `users/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/handoffs/latest.md` and `users/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/memories/review_metadata.json`.
- The 34 untracked runtime JSON files under `backend/users/*/sessions`, `users/*/recaps`, and `users/*/traces`.
- `skills/public/sophia/AGENTS.md`, to confirm the change is a companion-builder contract update and not an unintended prompt/context drift.
- `docs/debug/gemini-live-fully-rendered-sophia-prompt.md`, to confirm it remains debug documentation only.

## Commands Run

```powershell
git branch --show-current
git status --short -uall
git status --porcelain=v1 -uall | Measure-Object -Line
git diff --stat
git diff --name-status
git diff --cached --name-status
git ls-files --others --exclude-standard
git switch -c cleanup/working-tree-hygiene-before-12-5c-b
git diff -- .gitignore
git status --porcelain=v1 -uall | Group-Object
git ls-files --deleted
git ls-files --others --exclude-standard
git ls-files --others --ignored --exclude-standard
git show HEAD:backend/users/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/sessions/6c2f3270-cca1-4797-ad92-d8351f4d7ee1.json
git show HEAD:backend/users/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/sessions/85db2a07-4cbb-452a-a845-952ec445019b.json
Select-String -Path COMPOUND_LOG.md -Pattern '2026-05-22|12.5B|12.5C|12.4M|12.4L|12.4K'
Remove-Item -Recurse -Force .pytest_cache
Remove-Item -Recurse -Force .ruff_cache
```

One broad recursive filesystem probe was started for generated export names, then stopped when it was slower than useful. No cleanup decision depended on it; follow-up checks used git path lists instead.

## Validation Results

Final validation commands for this cleanup phase:

```powershell
git status --short -uall
git status --porcelain=v1 -uall | Measure-Object -Line
git diff --stat
git diff --name-status
git diff --check
git diff --cached --name-status
```

Actual outcomes:

- No staged files (`git diff --cached --name-status` returned no paths).
- Dirty count increased from 209 to 210 only because this audit doc is new.
- `git diff --check` passed with exit code 0. Git also repeated existing CRLF normalization warnings for several dirty files; no whitespace errors were reported.
- Runtime tests were not run because this phase changed only `.gitignore`, cleanup documentation, and `COMPOUND_LOG.md`, plus deletion of ignored cache directories.

## Recommendation For Phase 12.5C-B

It is safer to continue to Phase 12.5C-B after this hygiene pass, with one important constraint: do not treat the remaining dirty tree as disposable. Source/tests/docs look phase-owned and should be preserved. Runtime user artifacts and deleted tracked session files need human review before any future deletion or ignore-rule expansion.

Most important next-prompt context: Phase 12.5C-B should focus on artifact visibility proof harness work only. Start from `cleanup/working-tree-hygiene-before-12-5c-b`, keep `main` untouched, preserve the uncommitted migration source/docs/tests, and avoid cleaning `users/` or `backend/users/` without explicit sign-off.