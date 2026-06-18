# Sophia — Claude Code Context
**Spec version:** 7.0 · March 2026
**Repo:** fork of bytedance/deer-flow
**Team:** Davide (product/architecture) · Jorge (backend) · Luis (voice + frontend)
Read the full specs in `docs/specs/` before making architectural decisions. This file gives you working context — it does not replace the specs.
---
## What Sophia Is
Sophia is an AI voice companion with genuine continuity, emotional attunement, and measurable self-improvement. She is not a therapist, not a coach, not an assistant. She remembers, notices, and sometimes surprises.
Five properties that define her:
- **Emotional intelligence** — calibrates to the user's tone using a 5-band scale, lifts them half a point, never more
- **Genuine continuity** — remembers across sessions via Mem0 9-category memory, session handoffs, and a persistent identity file
- **Emotionally calibrated voice** — the LLM chooses the right Cartesia emotion per turn, not a rules engine
- **Self-improvement** — every prompt file is measurable against tone delta and optimizable via GEPA
- **Physical presence** — native iOS app via Capacitor, one-time microphone permission, always one tap away
Three platforms, one intelligence layer: web voice, web text, iOS voice.
---
## Hard Constraints — Never Violate These
1. **soul.md is permanently immutable.** Never propose modifying it. It is architecturally excluded from GEPA. Two enforcement mechanisms: filesystem read-only + GEPA exclusion list.
2. **Mem0 is the single memory authority.** No LangGraph checkpointer running in parallel. No competing memory providers. One source of truth.
3. **Mem0 writes happen only in the offline pipeline, never in-turn.** The `Mem0MemoryMiddleware` after-phase queues extraction — it does not write per turn.
4. **emit_artifact is required on every companion turn, via tool_use.** Never via text parsing. Anthropic guarantees valid JSON on tool calls. Text parsing does not have this guarantee.
5. **`runs/stream` always for companion turns. Never `runs/wait` for voice.** Text tokens pipe to Cartesia immediately. `runs/wait` adds ~1.2s latency. This is the difference between hitting or missing the 3-second voice target.
6. **Platform signal is mandatory in every DeerFlow request.** Pass `platform` in `configurable` on every call. The entire middleware chain adapts on this signal.
7. **`lead_agent/` is never modified.** `sophia_builder` reuses it as-is. Sophia lives in `sophia_agent/` and `sophia/` only.
8. **Pipeline prompt templates are not skill files.** Files in `backend/src/sophia/prompts/` are pipeline inputs. They go to Claude Haiku in offline processing. They must never appear in the agent's per-turn context.
9. **RitualMiddleware must be at position 11 (before SkillRouter at 12).** Order is load-bearing. SkillRouter reads `active_ritual` from state — if Ritual hasn't run first, skill routing has no ritual context.
10. **The offline pipeline is idempotent.** Use the `processed_sessions` set to prevent double processing.
11. **Builder artifacts must land under `/mnt/user-data/outputs/`** (PR #129 / Phase 2F). `BuilderArtifactMiddleware._has_output_file()` scans only that prefix; files outside it count as "no output". `write_file_tool` auto-prefixes BARE filenames (e.g. `report.md`) to that dir, but only when `runtime.config["configurable"]["graph_id"] == "sophia_builder"` OR `state["delegation_context"]` is populated (builder-context gate via `_is_builder_runtime_context`). Other callers — companion, lead_agent, tests — keep strict path validation.
12. **`langgraph dev --n-jobs-per-worker 10`** (PR #129 / Phase 2A). The CLI hardcodes default 1 and explicitly overrides any external env var (`langgraph_api/cli.py:262-263, 286` — "Don't overwrite"). The flag lives in `backend/Dockerfile.langgraph` CMD; do NOT add `N_JOBS_PER_WORKER` to Render env — it will be silently dropped. `render.yaml` carries a comment documenting this trap.
13. **`task_type` must come from `_CANONICAL_TASK_TYPES = {document, research, presentation, frontend, visual_report}`** (PR #129 codex P1). Never default to `"build"` or any other string — `StartBuilderTaskInput` validation rejects it. The `update_async_task_wrapper`'s `_safe_task_type` walks `tracked` first, then `delegation_context`, then falls back to `"document"`. Add a graph_id-based + delegation_context-based two-tier check anywhere you need to identify a builder context.
---
## Repository Structure
```
sophia/  (fork of bytedance/deer-flow)
├── backend/src/
│   ├── agents/
│   │   ├── lead_agent/              ← NEVER MODIFY — sophia_builder uses this unchanged
│   │   └── sophia_agent/            ← SOPHIA COMPANION (Jorge creates entirely)
│   │       ├── graph.py
│   │       ├── agent.py             ← make_sophia_agent()
│   │       ├── state.py             ← SophiaState TypedDict
│   │       └── middlewares/         ← 14 middleware files
│   └── sophia/                      ← SOPHIA SERVICES (Jorge creates entirely)
│       ├── mem0_client.py           ← SDK wrapper + LRU cache
│       ├── extraction.py
│       ├── handoffs.py
│       ├── smart_opener.py
│       ├── identity.py
│       ├── reflection.py
│       ├── offline_pipeline.py
│       ├── trace_logger.py
│       ├── golden_turns.py
│       ├── bootstrap.py
│       ├── gepa.py
│       └── prompts/                 ← NOT skill files — pipeline prompt templates only
│           ├── mem0_extraction.md
│           ├── session_state_assembly.md
│           ├── smart_opener_assembly.md
│           ├── identity_file_update.md
│           └── reflect_prompt.md
├── voice/                           ← VISION AGENTS LAYER (Luis)
│   ├── server.py
│   ├── sophia_llm.py
│   ├── sophia_tts.py
│   └── sophia_turn.py
├── skills/public/sophia/            ← SKILL FILES (read by agent at runtime)
│   ├── soul.md                      ← IMMUTABLE
│   ├── voice.md                     ← GEPA target (Week 6+)
│   ├── techniques.md
│   ├── tone_guidance.md             ← partial injection (1 band per turn)
│   ├── artifact_instructions.md
│   ├── context/work.md
│   ├── context/gaming.md
│   ├── context/life.md
│   ├── skills/                      ← 8 companion skill files
│   └── rituals/                     ← 4 ritual files (to create)
├── users/{user_id}/
│   ├── identity.md
│   ├── handoffs/latest.md           ← always overwritten, never accumulated
│   └── traces/{session_id}.json
├── gateway/routers/sophia.py
├── langgraph.json
├── config.yaml
└── .env
```
---
## Companion Middleware Chain — Order Is Law
The conceptual chain (consult `backend/packages/harness/deerflow/agents/sophia_agent/agent.py` for the exact production list, which also includes `MessageCoercionMiddleware`, `TurnCountMiddleware`, `WebResearchGuidanceMiddleware`, `BuilderCommandMiddleware`, `PromptAssemblyMiddleware`, `DanglingToolCallMiddleware`, `AnthropicPromptCachingMiddleware`):
```python
middlewares = [
    # 1. Infrastructure
    ThreadDataMiddleware(),
    # 2. Crisis fast-path — BEFORE any expensive middleware
    CrisisCheckMiddleware(),
    # 3. Always-loaded identity files (incl. role-scoped companion build contract)
    FileInjectionMiddleware(SKILLS_PATH / "soul.md"),
    FileInjectionMiddleware(SKILLS_PATH / "voice.md",       skip_on_crisis=True),
    FileInjectionMiddleware(SKILLS_PATH / "techniques.md",  skip_on_crisis=True),
    FileInjectionMiddleware(SKILLS_PATH / "coordination_core.md"),
    FileInjectionMiddleware(SKILLS_PATH / "companion_delegation.md"),
    # 4. Platform signal — sets state["platform"] for all downstream
    PlatformContextMiddleware(),
    # 5–6. User context
    UserIdentityMiddleware(user_id),
    SessionStateMiddleware(user_id),
    # 7–9. Calibration — tone THEN context THEN ritual (this order matters)
    ToneGuidanceMiddleware(SKILLS_PATH / "tone_guidance.md"),
    ContextAdaptationMiddleware(SKILLS_PATH / "context", context_mode),
    RitualMiddleware(SKILLS_PATH / "rituals", ritual),   # ← MUST be before SkillRouter
    # 10. Skill routing — reads tone band + ritual from state
    SkillRouterMiddleware(SKILLS_PATH / "skills"),
    # 11. Memory — after ritual+skill set (retrieval biased by both)
    Mem0MemoryMiddleware(user_id),
    # 11b. Build awareness — refreshes async_tasks status from SDK and injects
    #      short prompt block so Sophia answers "how's the build going?"
    #      without needing to call check_async_task. Sits between Mem0 and
    #      Artifact so the block lands in the assembled system message.
    BuildAwarenessMiddleware(),
    # 12. Artifact system
    ArtifactMiddleware(SKILLS_PATH / "artifact_instructions.md"),
    # 12b. deepagents AsyncSubAgentMiddleware — always-on. Owns lifecycle
    #      (check/update/cancel/list_async_task). start_async_task is
    #      filtered; the model launches builds via start_builder_task.
    #      PR #129 (Phase 2B): update_async_task is ALSO filtered and
    #      replaced by a terminal-thread-guarded wrapper (see
    #      ``deerflow.sophia.tools.update_async_task_wrapper``). On a
    #      terminal target the wrapper redirects to start_builder_task
    #      with a v2 brief instead of letting the native dispatch
    #      create a new run on a finished thread (which would loop on
    #      dangling tool calls).
    AsyncSubAgentMiddleware(...),
    # 13–14. DeerFlow (adapted)
    SophiaTitleMiddleware(),
    SophiaSummarizationMiddleware(),
]
```
### Crisis fast-path
When `CrisisCheckMiddleware` detects crisis language, it sets `state["force_skill"] = "crisis_redirect"` and `state["skip_expensive"] = True`. All middlewares check this flag and short-circuit. Only soul.md + crisis_redirect.md are injected. Response time is ~200ms faster than normal.
Crisis signals: `"want to die"`, `"kill myself"`, `"end it all"`, `"don't want to be here"`, `"hurt myself"`, `"self harm"`, `"suicide"`, `"not worth living"`, `"can't go on"`, `"want to disappear"`.
### ToneGuidanceMiddleware — partial injection only
Parses `tone_guidance.md` into 5 band sections at **startup**, caches them. Injects **one band section per turn** (~726 tokens), not the full file (~3,630 tokens). Band selection is based on `state["previous_artifact"]["tone_estimate"]`.
Band ranges:
```
shutdown:          0.0–0.5
grief_fear:        0.5–1.5
anger_antagonism:  1.5–2.5
engagement:        2.5–3.5
enthusiasm:        3.5–4.0
```
---
## SophiaState — Key Fields
```python
class SophiaState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    # Platform and mode
    platform: str          # "voice" | "text" | "ios_voice"
    active_mode: str       # "companion" | "builder"
    turn_count: int        # first-turn logic gates on this
    # User context
    user_id: str
    context_mode: str      # "work" | "gaming" | "life"
    # Ritual
    active_ritual: str | None   # "prepare" | "debrief" | "vent" | "reset" | None
    ritual_phase: str | None    # e.g. "debrief.step2_what_worked"
    # Crisis
    force_skill: str | None     # set by CrisisCheckMiddleware
    skip_expensive: bool        # True = crisis path, most middlewares skip
    # Tone and skill
    active_tone_band: str       # band_id from tone_guidance
    active_skill: str           # skill name selected by SkillRouter
    skill_session_data: dict    # cross-turn counters (persisted via LangGraph checkpointer)
    # Artifacts
    current_artifact: dict | None
    previous_artifact: dict | None
    # Memory
    injected_memories: list[str]   # memory IDs for trace logging
    # Builder lifecycle (post-migration: deepagents async-subagent path)
    async_tasks: dict[str, dict]   # canonical: keyed by builder thread_id; agent_name="sophia_builder"
    delegation_context: dict | None  # task brief + parent_thread_id seeded by start_builder_task
    # Legacy fields (kept for in-flight thread compatibility — primary lifecycle is async_tasks)
    builder_task: dict | None
    builder_result: dict | None
```
---
## Mem0 — 9 Categories and Rules
```python
custom_categories = [
    {"fact":         "Static user info — name, job, location. High stability."},
    {"feeling":      "Emotional patterns. ALWAYS include tone_estimate in metadata."},
    {"decision":     "Genuine decisions made. Not considerations."},
    {"lesson":       "Insights the user articulated or realized."},
    {"commitment":   "Goals, deadlines, stated intentions."},
    {"preference":   "Communication style, how they want to be treated."},
    {"relationship": "People in the user's life — names, roles, dynamics."},
    {"pattern":      "Recurring behavioral observations. Require 2+ session evidence."},
    {"ritual_context": "How the user uses each ritual — what works, preferences."},
]
```
### Memory write — always include full metadata
```python
client.add(
    messages,
    user_id=user_id,
    agent_id="sophia_companion",
    run_id=session_id,
    timestamp=turn_timestamp,
    metadata={
        "tone_estimate": 1.4,           # REQUIRED for feeling category
        "ritual_phase": "debrief.step2",
        "importance": "structural",     # structural | potential | contextual
        "platform": "voice",
        "status": "pending_review",
        "context_mode": "work",
    }
)
```
### Retention
| Importance | Expires | Use when |
|---|---|---|
| structural (≥ 0.8) | permanent | facts, decisions, core relationships |
| potential (0.4–0.79) | long-term | preferences, feelings, single-session insights |
| contextual (< 0.4) | 7 days | routine observations, temporary states |
### LRU cache
60-second TTL. Cache hits ~70% of turns within a session. Call `invalidate_user_cache(user_id)` after any Mem0 write.
### Rule-based category selection (before semantic search)
```python
categories = ["fact", "preference"]  # always
if ritual in ["prepare", "debrief"]:
    categories += ["commitment", "decision"]
if ritual == "vent":
    categories += ["feeling", "relationship"]
if ritual == "reset":
    categories += ["feeling", "pattern"]
if active_skill in ["vulnerability_holding", "trust_building"]:
    categories += ["feeling", "relationship"]
if active_skill == "challenging_growth":
    categories += ["pattern", "lesson"]
if ritual:
    categories.append("ritual_context")
# + "relationship" if person mentioned, "feeling" if emotion signal
```
---
## Tools Available to Companion
```python
tools = [
    emit_artifact,        # REQUIRED every turn — carries TTS emotion + session continuity
    start_builder_task,   # delegates to sophia_builder via deepagents AsyncSubAgentMiddleware
    retrieve_memories,    # targeted deep retrieval (reflect flow, specific queries)
    view_user_image,      # vision: see an uploaded/rendered image by bare filename (gated on supports_vision)
    read_user_document,   # vision: read text from an uploaded PDF/DOCX/etc. by bare filename
]
# Plus the four lifecycle tools native to deepagents AsyncSubAgentMiddleware:
# check_async_task / update_async_task / cancel_async_task / list_async_tasks.
# update_async_task is filtered + replaced by ``make_update_async_task_wrapper``
# (Phase 2B): on a terminal target → redirect to start_builder_task with v2
# brief; on a non-terminal target → augment user message with file-target
# directive + slug-derived filename + "RESUMING (not restarting)" language,
# then delegate to native. The wrapper also re-checks live SDK status to
# defeat ~10s cache staleness from BuildAwarenessMiddleware.
# (start_async_task is filtered out — the model only launches via the
# enriched start_builder_task wrapper.)
```
### emit_artifact — 13 required fields
`session_goal`, `active_goal`, `next_step`, `takeaway`, `reflection` (nullable), `tone_estimate` (0–4.0), `tone_target` (tone_estimate + 0.5, max 4.0), `active_tone_band`, `skill_loaded`, `ritual_phase`, `voice_emotion_primary`, `voice_emotion_secondary`, `voice_speed` (slow|gentle|normal|engaged|energetic).
Voice speeds → Cartesia values: slow=0.8, gentle=0.9, normal=1.0, engaged=1.05, energetic=1.15.
Artifact arrives **after** the text stream completes. It updates the emotion for the **next** TTS call.
### start_builder_task
Companion asks all clarifying questions first, then calls `start_builder_task(description, task_type)` with a complete brief. The wrapper (in `deerflow.sophia.tools.start_builder_task`) enriches the description with live session context (memories, emotional state, ritual, explicit URLs) before dispatching to the `sophia_builder` graph via LangGraph SDK ASGI in-process transport. It writes a row to `state["async_tasks"]` keyed by builder thread_id and returns immediately. Lifecycle (check / update / cancel / list) is owned by deepagents' native `AsyncSubAgentMiddleware`. Builder artifacts are uploaded to Supabase under the **parent (companion) thread_id** so the channel adapter's bytes-download path stays aligned with the upload path; `BuildAwarenessMiddleware` (companion side) refreshes `async_tasks` status from the SDK on companion turns and injects a short prompt block so Sophia answers "how's the build going?" naturally without polling.

### Vision & attachments (PR #132)

The companion and builder can both see images and read documents in-process via the upstream `view_image` stack, gated on `vision_gate.supports_vision(model_name)` (default-on for Sonnet 4.6 + Haiku 4.5). Companion narrow tools `view_user_image(image_filename)` / `read_user_document(document_filename)` are thread-scoped (bare filename, current thread's `uploads/` + `outputs/` only). Web users attach via the Next.js AttachmentBar → `POST /api/threads/{id}/uploads` (auth + thread-ownership gated). Full implementation details + the production-hardening wave (cross-service Supabase bridge, keyspace separation, idempotent delete, base64 accumulation guards, the live-FileList silent-attach fix) live in **`backend/CLAUDE.md` → "Sophia Vision Port (PR #132)"**.

**Deployment fact that is load-bearing:** on Render, `sophia-gateway` and `sophia-langgraph` are **separate web services with separate ephemeral disks** (no shared/persistent disk). Uploads land on the gateway disk but the companion read tools run in langgraph — so every upload is **mirrored to Supabase Storage** under `{thread_id}/uploads/{name}` and the read tools download from the mirror on a local miss. Any change to upload/read/delete paths must keep the gateway mirror and the langgraph fallback in sync, and **both services must redeploy together**.

### Builder deliverable truth + visual reliability (2026-06-10)

Hard invariants after the 2026-06-10 incident (text-only decks/PDFs, rendered primaries mislabeled as fallbacks, `.pdf.md` source surfaced over the real PDF):

1. **A delivered artifact in the requested format is never a fallback.** Missing visuals become `quality_warning="visuals_not_embedded"` + capped confidence — never `artifact_is_fallback=true`.
2. **Format-swapped fallbacks are disabled for pdf/pptx requests.** A `.md`/`.html` emission for a pdf/pptx target is rejected; if the primary genuinely cannot be produced, the build completes as an honest failure (`artifact_path=null` + truthful `companion_summary`). Sources stay in session artifacts.
3. **Visuals must actually embed.** One bounded repair turn (`_visual_gate_blocks_emit`), harness auto-wiring of generated PNGs into the slide plan, pandoc `cwd`/`--resource-path` so relative image refs resolve.
4. **PPTX gets a canvas preview.** `<deck>.preview.pdf` (headless LibreOffice, langgraph image) rides along with the completion payload as `artifact_preview_filename`; the webapp renders decks through the PDF canvas, downloads keep serving the `.pptx`.

Full detail: **`backend/CLAUDE.md` → "Builder deliverable truth + visual reliability"**.

Follow-up wave (2026-06-11): generated imagery (gpt-image-2) is **on by default for decks** — 1 hero + up to 2 supporting images, hard cap 3 calls/build (harness-enforced with a terminal-error short-circuit and per-image cost in the budget breaker), plain/minimal briefs opt out; the PPTX compositor gained 8 layouts + 4 themes; PDFs render through a themed pandoc template (cover page, footer, auto-TOC, template-less retry on failure). Requires `OPENAI_API_KEY` on sophia-langgraph. Detail: **`backend/CLAUDE.md` → "Image-gen enrichment + artifact-skill quality"**.

Spec VQ wave (2026-06-11): three prod bugs fixed (HTML max_tokens truncation loop → 32k output + chunking correction; duplicate tool_result 400 → duplicate-proof dangling patcher; PDF template rc=5 → a `$if$` token in its own header comment) and the visual-quality constraint set landed: text-fit engine + 10 distinct diagram kinds (G-VIS-1/2 goldens), harness-stamped `image_generation_outcome` + `--preflight`, hero/cover gate, PDF cover enrichment, preview-raster self-review on repair turns, variety guard, design-language themes, and the build-to-condition loop at cap 3 (`SOPHIA_BUILDER_MAX_ITERATIONS`; payload carries `iterations_used`/`unmet_conditions`). Provider matrix: `make eval-visuals` + nightly visual-evals workflow. Detail: **`backend/CLAUDE.md` → "Spec VQ wave"**.

Spec D wave (2026-06-11): the delegation boundary gains a flush and a floor. Per-turn append-only **delegation ledger** (`users/{user_id}/traces/{thread_id}.ledger.jsonl`, compaction-immune, Supabase-mirrored for gateway-side deletion + restart durability), deterministic **conversation digest** in every long-session brief + `[Conversation since dispatch]` deltas on updates, **builder-side Haiku brief extraction** (`[t{n}]`-provenance-validated schema; never companion-side — voice latency), builder tool **`read_session_context`** (parent-session recall, scope-locked, 4 calls/build), and the **brief-completeness gate** (briefing directive + `brief_assumptions[]` emit field the companion relays + `brief_incomplete:*` honesty stamps in `unmet_conditions`). Five `SOPHIA_DELEGATION_*` flags, all default ON, each independently revertible. `make eval-delegation` live lane. Detail: **`backend/CLAUDE.md` → "Spec D — Delegation Boundary"**.

### Builder progress streaming (webhook relay)

PR #128 shipped the live `[ Researching ]` → `[ Drafting ]` → `[ Finalizing ]` → `[ Done ]` placeholder UX via a webhook relay (NOT SDK streaming — `langgraph_runtime_inmem` doesn't deliver events to late-joining HTTP `runs.join_stream` consumers across processes; verified in production smoke tests).

**Flow**:
1. Companion calls `start_builder_task(...)`. The wrapper dispatches via `client.runs.create(thread_id, "sophia_builder", input=..., context=..., stream_resumable=True)` and writes a row to `state["async_tasks"]` keyed by builder thread_id.
2. Companion's voice reply sends. After the reply, `ChannelManager._maybe_open_progress_placeholders` publishes the "Working on it…" placeholder via `bus.publish_outbound_strict`. The Telegram channel's `_register_progress_entry` callback registers `(task_id, chat_id, message_id, channel_name, run_id)` with the per-process `BuilderProgressRegistry`.
3. As the builder runs, the langgraph-side `BuilderProgressMiddleware` fires fire-and-forget HTTP POSTs to the gateway's `/internal/builder-progress` endpoint on every lifecycle hook (`abefore_agent` → `phase=starting`; `aafter_model` → tool_calls + phase from `_TOOL_LABELS` classification; `aafter_agent` → `phase=done`).
4. The gateway endpoint dispatches each event through the registry's per-task `ProgressRenderer.apply` (under a per-entry `asyncio.Lock` so concurrent events serialize at the renderer-mutation boundary). On state change, the channel's edit callback (`TelegramChannel._edit_progress_placeholder`) is invoked — it hops to `_tg_loop` and calls `bot.edit_message_text(chat_id, message_id, new_body)`.
5. On terminal, the existing `/internal/builder-events` completion webhook calls `registry.mark_done(task_id, run_id)` (success) or `mark_stopped(task_id, reason, run_id)` (error/cancelled). The renderer clears its accumulated activity history so the final placeholder shows just `[ Done ]` + optional summary. Failed terminal edits retry with 2/5/15s backoff (`_schedule_terminal_retry`).

**Key files**:
- [backend/app/gateway/builder_progress/registry.py](backend/app/gateway/builder_progress/registry.py) — `BuilderProgressRegistry` singleton (channel-agnostic).
- [backend/app/channels/telegram_progress_renderer.py](backend/app/channels/telegram_progress_renderer.py) — event → plain-text rendering. `_TOOL_LABELS` (visible tools + emoji/verb) and `_HIDDEN_TOOLS` (suppressed: `ls`, `read_file`, `str_replace`, `todo_read`, `todo_write`, `bash`).
- [backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_progress.py](backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_progress.py) — langgraph-side emitter.
- [backend/app/gateway/routers/builder_events.py](backend/app/gateway/routers/builder_events.py) — `POST /internal/builder-progress` (live) + `POST /internal/builder-events` (terminal) + `GET /api/threads/{thread_id}/builder-events` (webapp SSE for terminal — no progress SSE yet).

**Streaming primitives are channel-agnostic.** Adding a new channel (or the webapp) is one method call:

```python
registry = get_progress_registry()
registry.register_channel_callback("webapp", _emit_sse_event)

async def _emit_sse_event(chat_id: int, message_id: int, body: str) -> bool:
    await sse_worker.publish(thread_id=..., event={"body": body})
    return True  # Phase 4M codex P1 explicit-True contract
```

For the webapp to get full parity, two things need to be built:
1. **Webapp SSE bridge** at `/api/threads/{thread_id}/builder-progress` (mirror the existing terminal-events SSE). The registry's edit callback publishes per-thread; the SSE endpoint streams to connected clients.
2. **Webapp-side `register_task(task_id, chat_id, message_id, channel_name="webapp", run_id)`** call when the webapp displays a placeholder — `chat_id`/`message_id` can be webapp-internal handles, any stable identifier for the placeholder slot.

The langgraph-side middleware doesn't change — it already emits events for every task regardless of who's listening.

**Builder tool authoring rules (Phase 4M)**:
- `write_file_tool` has an `append: bool` parameter. For long documents that won't fit in one model output: first call writes the opening chunk (`append=False` or omit), subsequent calls extend with `append=True`. Multiple calls to the same path are EXPECTED for long-form deliverables.
- `bash_tool` is for EXECUTION, NOT text authoring. Heredocs / `python -c "with open(...).write(...)"` / `echo > file` / `printf > file` for file authoring are FORBIDDEN by the system prompt. The Phase 4M prompt injects this explicit prohibition every turn.
- `str_replace_tool` for targeted edits to existing content.

### Render production deployment topology

**Source of truth for `/app/config.yaml` is `config.production.yaml` in the repo root** — NOT the local `config.yaml` (which is `.gitignore`'d). `backend/Dockerfile.gateway` line 8 does `COPY config.production.yaml ./config.yaml` to bake the file into the image. `backend/Dockerfile.langgraph` does the same. Editing the local `config.yaml` does NOTHING to production. To verify the live state, SSH into the Render service shell and `cat /app/config.yaml`.

**Both services load this same file** — gateway AND langgraph each call `AppConfig.from_file()` at startup, which calls `resolve_env_variables` ([packages/harness/deerflow/config/app_config.py:188-190](backend/packages/harness/deerflow/config/app_config.py)) which **raises a hard `ValueError` on any missing `$VAR`**. There is no tolerant fallback syntax. **Any new `$VAR` reference in `config.production.yaml` requires the env var to be set on EVERY service that loads the file.** When in doubt, hardcode public values (bot usernames, channel names, recursion limits) — secrets like tokens still use `$VAR`.

**Required env vars on Render** (declared in `render.yaml` with `sync: false` = "operator-set in dashboard"):
- **sophia-gateway**: `ANTHROPIC_API_KEY`, `MEM0_API_KEY`, `STREAM_API_KEY`, `STREAM_API_SECRET`, `LANGGRAPH_URL`, `SOPHIA_VOICE_SERVER_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`
- **sophia-langgraph**: `ANTHROPIC_API_KEY`, `MEM0_API_KEY`, `SOPHIA_GATEWAY_URL` (so `BuilderProgressMiddleware` knows where to POST progress events — defaults to `http://localhost:8001`)

**The `runs.wait` 400 trap** — when calling `client.runs.wait`/`runs.create` from a channel adapter (HTTP-mode SDK against the langgraph service), set `thread_id` / `user_id` / `channel` in `context` ONLY, NEVER also in `config["configurable"]`. langgraph-api 0.7+ rejects both-channels payloads with HTTP 400 in <1ms before the run starts. See [manager.py](backend/app/channels/manager.py) for the working pattern; regression-guard test in [tests/test_channels.py](backend/tests/test_channels.py) under `TestDispatchPayloadShape`. `start_builder_task.py` is allowed to set `configurable` because it dispatches via SDK ASGI in-process transport (`get_client(url=None)`), which has different validation.

---
## Platform Values and Effects
| Value | Who sets it | What adapts downstream |
|---|---|---|
| `"voice"` | Luis (web) | 1–3 sentence responses, full 13-field artifact, Cartesia TTS |
| `"ios_voice"` | Luis (iOS) | identical to voice — same token budget, same artifact depth |
| `"text"` | Luis (web text) | 2–5 sentence responses, full 13-field artifact, no TTS |
Set in `configurable` on every DeerFlow request:
```python
config = {"configurable": {
    "user_id": user_id,
    "platform": "voice",    # or "text" or "ios_voice"
    "ritual": ritual,       # or None
    "context_mode": "life", # or "work" or "gaming"
}}
```
---
## Prompt Token Budget (Companion, Voice Peak)
| Component | Tokens |
|---|---|
| soul.md + voice.md + techniques.md | ~2,853 |
| Tone guidance (1 band) | ~726 |
| Context adaptation (1 file) | ~130 |
| Ritual file (when active) | ~600 |
| artifact_instructions.md | ~2,760 |
| User identity file | ~650 |
| Session handoff | ~375 |
| Smart opener instruction (turn 1 only) | ~50 |
| Mem0 memories (filtered, ~10 results) | ~750 |
| Previous artifact (conditional) | ~200 |
| Active skill file | ~650 |
| **Peak total** | **~9,144** |
4.6% of Claude Haiku's 200k context. No compression needed at normal operation.
Models:
- Companion: `claude-haiku-4-5-20251001`
- Builder: `claude-sonnet-4-6`
- Offline pipeline (all steps): `claude-haiku-4-5-20251001`
---
## Offline Pipeline — 7 Steps
Fires on WebRTC disconnect or 10-minute inactivity. Idempotent — safe to run twice.
```
Step 1: Smart opener generation
Step 2: Handoff write → users/{user_id}/handoffs/latest.md
Step 3: Mem0 extraction → all memories written with status="pending_review"
Step 4: In-app notification (memory candidates ready)
Step 5: Trace aggregation
Step 6: Identity update (every 10 sessions or on structural memory change)
Step 7: Visual artifact check (if 3+ sessions this week)
```
Smart opener is a single warm sentence injected by `SessionStateMiddleware` on `turn_count == 0` only. Stored in handoff YAML frontmatter: `smart_opener: "..."`. Examples of good openers:
- Upcoming event: `"The investor pitch is tomorrow. How are you feeling going into it?"`
- Unresolved thread: `"You mentioned the conversation with your co-founder — did that happen?"`
- After absence (3+ days): `"It's been a few days. Where are you at?"`
- Low tone, no open threads: `"How are you doing today?"` — don't overcomplicate a quiet return
- Post-breakthrough: `"Something shifted last time. How does it feel from the other side?"`
---
## Trace Schema (Every Turn, from Week 2)
```json
{
  "turn_id": "sess_{session_id}_turn_{n}",
  "timestamp": "ISO8601",
  "tone_before": 0.0,
  "tone_after": 0.0,
  "tone_delta": 0.0,
  "is_golden_turn": false,
  "voice_emotion_primary": "sympathetic",
  "voice_emotion_secondary": "calm",
  "voice_speed": "gentle",
  "skill_loaded": "vulnerability_holding",
  "active_tone_band": "grief_fear",
  "ritual": "debrief",
  "platform": "voice",
  "context_mode": "work",
  "memory_injected": ["mem_abc123", "mem_def456"],
  "prompt_versions": {
    "voice_md": 1,
    "tone_guidance_md": 1,
    "active_skill_md": 1
  }
}
```
Written to `users/{user_id}/traces/{session_id}.json`.
---
## GEPA Rules
1. `soul.md` is **never** a GEPA target — excluded by exclusion list, not just convention
2. Trace files are ground truth — never modified
3. Global/shared files require human (Davide) review before deployment
4. Tone regression is a hard block — no variant that performs worse than baseline is deployable
5. Schema version increments on any structural change to prompt files
First GEPA target (Week 6): `voice.md`. Golden turn threshold: `tone_delta >= +0.5`.
---
## iOS — Capacitor Wrapper (Week 6, Luis)
The existing Next.js web app wrapped in a native iOS shell. No Swift required.
```bash
npm install @capacitor/core @capacitor/cli
npx cap init "Sophia" "com.sophia.app" --web-dir=out
npx cap add ios
npm run build && npx cap sync ios
npx cap open ios  # Opens Xcode
```
Key test: after user taps Allow once, closing and reopening the app must NOT show the mic dialog again. If it does, something is wrong with the native permission flow.
The `ios/` directory generated by Capacitor is gitignored. Xcode project settings (icons, splash, capabilities) are configured in Xcode, not in code.
WebRTC requires: `allowsInlineMediaPlayback = true` and `mediaTypesRequiringUserActionForPlayback = []` in `WKWebViewConfiguration`. Capacitor sets these by default.
---
## Environment Variables
```bash
# Core (required)
ANTHROPIC_API_KEY=sk-ant-...
MEM0_API_KEY=m0-...
# Voice layer (required)
CARTESIA_API_KEY=...
SOPHIA_VOICE_ID=...         # Cartesia voice ID for Sophia
DEEPGRAM_API_KEY=...
STREAM_API_KEY=...
STREAM_API_SECRET=...
# Optional
SOPHIA_USER_ID=...          # single-user deployment; multi-user: per-request
MEM0_BASE_URL=...           # if self-hosting Mem0
SOPHIA_SKILLS_PATH=...      # override default skills path
```
---
## Gateway Endpoints
```
GET    /api/sophia/{user_id}/memories/recent?status=pending_review
PUT    /api/sophia/{user_id}/memories/{memory_id}
DELETE /api/sophia/{user_id}/memories/{memory_id}
POST   /api/sophia/{user_id}/memories/bulk-review
GET    /api/sophia/{user_id}/visual/weekly
GET    /api/sophia/{user_id}/visual/decisions
GET    /api/sophia/{user_id}/visual/commitments
POST   /api/sophia/{user_id}/reflect
       body: {query: str, period: "this_week"|"this_month"|"overall"}
       returns: {voice_context: str, visual_parts: [...]}
GET    /api/sophia/{user_id}/journal
```
---
## Common Pitfalls
### Jorge
- `RitualMiddleware` at position 11, `SkillRouterMiddleware` at position 12. Never swap them.
- `ToneGuidanceMiddleware` injects ONE band (~726 tokens), not the full file (~3,630 tokens). Always use band parsing.
- Handoff path is `users/{user_id}/handoffs/latest.md` — always overwritten, never accumulated.
- Pipeline prompts go in `backend/src/sophia/prompts/` — never in `skills/public/sophia/`.
- `soul.md` is excluded from GEPA. Add it to the exclusion list before running any optimization pass.
- Run the offline pipeline only once per session. Use the `processed_sessions` set.
- `smart_opener_assembly.md` must not reference `{cross_platform_memories}` — that placeholder was removed in v7.0.
- `GET /api/sophia/{user_id}/memories/recent?status=pending_review` must apply the local review metadata overlay before deciding whether Mem0 detail hydration is needed. If the overlay already supplies `metadata.status`, avoid per-memory `client.get(...)` calls or recap loads regress into an N+1 Mem0 path.
- The offline pipeline's `_serialize_messages` must accept three message shapes: LangChain `BaseMessage` objects (use `msg.type`), LangChain JSON-serialized dicts from `GET /threads/{id}/state` (`{"type": "human", ...}` with no `role`, and `content` either at the top level or nested under `data.content`), and channel-adapter raw dicts (`{"role": "human", "content": ...}`). The dict branch reads `msg.get("role") or msg.get("type", "")` for role and falls back to `msg["data"]["content"]` when top-level `content` is `None`. Skip any of these and `extraction._format_transcript` silently drops the messages, producing 0 Mem0 candidates from a real conversation.
- Offline-pipeline recap envelopes must write `recap_artifacts: {}` (truthy empty dict), never `null`. The frontend recap mapper early-null-returns on `null`, so the loader never reaches `status='ready'` even when the gateway returns 200.
- **Prior-task memories must never reach the builder** (PR #137) — a "report on Hermes" brief once retrieved a prior "user requested … about OpenClaw" `fact`/`decision` (score ~1.0) and built the wrong subject. Every builder-feeding path filters task-history by **content** (`extraction._candidate_policy_rejection_reason` → `"task_history"`), not by excluding whole categories: `BuilderMem0RetrievalMiddleware` retrieves durable build-relevant categories `_BUILDER_MEMORY_CATEGORIES = ["preference", "fact", "relationship", "decision", "commitment", "lesson"]` (over-fetch-then-trim) and post-filters by **category ∈ that set AND content not policy-rejected** — so Builder-as-Main runs still get durable facts ("make a card for my daughter" → the daughter's name) while the episodic "user requested … about X" rows drop regardless of category; the companion-embedding path (`start_builder_task._resolve_memory_snippets` / `_drop_builder_task_history`) drops any policy-rejected snippet too. Write side: `mem0_extraction.md` skip-lists deliverable/build requests and the offline Haiku classifier is authoritative. Do NOT revert builder retrieval to "preference only" — that starves direct builds of facts. See `backend/CLAUDE.md` → "Builder memory-contamination guard" for the full contract.
### Luis
- `runs/stream` not `runs/wait` — always. The ~0.6s difference matters on voice.
- Artifact arrives after text. It updates the emotion for the **next** TTS call. Design `SophiaTTS` plugin accordingly.
- Always pass `platform` in `configurable`. The chain behaves differently per platform.
- Smart opener is injected on the **first turn** of a new session. Sophia delivers it before the user says anything — it's not a system message the user sees.
- If Live mode audio doesn't work on device, check WKWebView media playback settings in Capacitor config.
- `ios/` directory is gitignored.
- The recap fallback route must preserve `pending_review` semantics even when it falls back to the unfiltered memory list. Filter fallback candidates back down to `pending_review` or missing-status records, or approved/discarded memories will reappear in recap.
- If runtime `users/{user_id}` artifacts are committed for testing or demos, do not default dev auth bypass to a tracked seeded user. Use an explicit `NEXT_PUBLIC_SOPHIA_USER_ID` or a neutral local-only default.
---
## Spec Documents (source of truth)
All architectural decisions derive from these. When in doubt, read the spec before implementing.
```
docs/specs/01_architecture_overview.md   — system overview, platforms, iOS Capacitor
docs/specs/02_build_plan.md              — 6-week three-track execution plan
docs/specs/03_memory_system.md           — Mem0 config, retrieval, handoffs, smart opener
docs/specs/04_backend_integration.md     — middleware chain, voice pipeline, offline flows, GEPA
docs/specs/05_frontend_ux.md             — Vision Agents, Journal, visual artifacts, Capacitor
docs/specs/06_implementation_spec.md     — precise codebase details for Jorge and Luis
```
---
## Sentrux feedback loop
Sentrux is wired in as an MCP server (see [.mcp.json](.mcp.json)) and as a blocking PR gate. Use it to sense your own architectural blast radius:
- **Before any non-trivial structural change**: call `mcp__sentrux__session_start` to capture a baseline.
- **After edits**: call `mcp__sentrux__check_rules`. The rules in [.sentrux/rules.toml](.sentrux/rules.toml) encode the dependency-shaped subset of the Hard Constraints above (sophia_agent ↮ sophia/prompts, voice ↮ agents, app ← deerflow one-way, lead_agent ↮ sophia_agent). Runtime constraints — middleware ordering, soul.md immutability, runs/stream usage — are NOT in those rules; review still owns them.
- **At task end**: call `mcp__sentrux__session_end`. The architectural quality score must not regress.
- **Quick checks**: `mcp__sentrux__scan` for a snapshot, `mcp__sentrux__dsm` for the dependency-structure matrix.

CI runs the same gate on every PR ([.github/workflows/sentrux-gate.yml](.github/workflows/sentrux-gate.yml)): score regressions vs `main` block the merge; rule violations are advisory in v1.

---
## Compound Log
Every merged PR appends an entry to `COMPOUND_LOG.md` at the repo root.
Format per entry:
```
## YYYY-MM-DD · [component] · PR #[N]
Author / Track / Spec reference
What changed · What we learned · CLAUDE.md updates · Skills created · GEPA log entry
```
If a prompt file changed, write a GEPA log entry with: before behavior, after behavior, tone_delta if measurable, and whether a trace pair is available.
