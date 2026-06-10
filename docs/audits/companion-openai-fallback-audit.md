# Companion OpenAI Fallback — Audit + Design Note

Date: 2026-06-09
Branch: `feat/coreview-native-builder-actions` (worktree `main-health-pr133-verify`)
HEAD at audit: `6c48b744` (feat: add OpenAI Builder fallback)
Context: Anthropic credit balance is exhausted; Davide has OpenAI credits.
Scope: **`sophia_companion` model call only.** No changes to Gemini voice
runtime, Coreview visual review, artifact persistence, or the Builder artifact
handoff contract. The Builder fallback (PR `6c48b744`) is left functionally
as-is; only the **shared** provider-error classifier is extended (see below).

## Verdict

**LOW_RISK_NOW** — implementable with the exact same isolated
`wrap_model_call` / `awrap_model_call` middleware pattern already proven for
the Builder, plus a narrow extension to the shared error classifier. No
companion orchestration rewrite.

## Evidence: the request fails BEFORE it reaches the Builder

`logs/langgraph.log` (live local repro, 2026-06-09T23:50:25Z) shows the
failure happens inside `graph_id=sophia_companion` at `langgraph_node=model`,
**before** any `start_builder_task` tool call and **before** any
`sophia_builder` run is created:

```
graph_id=sophia_companion ... langgraph_node=model
  HTTP Request: POST https://api.anthropic.com/v1/messages "HTTP/1.1 400 Bad Request"
  Run encountered an error in graph: anthropic.BadRequestError
    Error code: 400 - 'Your credit balance is too low to access the Anthropic API.
    Please go to Plans & Billing to upgrade or purchase credits.'
```

Confirmed for the five Phase-2 questions:

1. **Does the failing request reach `sophia_builder`?** No. The companion
   model call fails first; no `sophia_builder` run is ever started.
2. **Does `[BuilderProviderFallback]` appear?** No. The Builder middleware is
   never entered.
3. **Does the companion fail before `start_builder_task`?** Yes. The failure
   is at the companion's first model call, before any tool dispatch.
4. **Is the Anthropic failure in `graph_id=sophia_companion`?** Yes.
5. **Is the Builder fallback unused because the Builder never starts?** Yes.

Conclusion: the Builder-only fallback cannot help, because Anthropic fails at
the **companion** model node. A companion-side fallback is required.

## Current companion provider path

- `backend/packages/harness/deerflow/agents/sophia_agent/agent.py::make_sophia_agent`
  constructs **`ChatAnthropic` directly** (hardcoded provider class):
  `model="claude-haiku-4-5-20251001"`, `max_tokens=512` (voice) / `4096`
  (text), `timeout=60.0`.
- The model node is wrapped (innermost → outermost) by
  `AnthropicPromptCachingMiddleware` → `DanglingToolCallMiddleware` →
  `AsyncSubAgentMiddleware` (preamble) → the actual model call. The provider
  exception surfaces out of `AnthropicPromptCachingMiddleware.awrap_model_call`
  (see traceback in the log).
- Tools (`emit_artifact`, **`start_builder_task`**, `edit_builder_artifact`,
  `retrieve_memories`, optional `view_user_image`, `read_user_document`, web
  tools) are bound to the **request's** model at model-node execution time —
  which is exactly what makes a per-call model override preserve the tool set.
- Provider errors are **not classified** on the companion path today — an
  Anthropic auth/quota/billing failure propagates up, the LangGraph run
  errors out, and the user surface shows the generic "I'm having trouble"
  fallback text.

## Why the Builder fallback alone is insufficient

The Builder fallback (`BuilderProviderFallbackMiddleware`) wraps only the
`sophia_builder` graph's model call. Delegation to the Builder happens via the
companion's `start_builder_task` **tool call**, which can only be produced
after a successful companion model call. When Anthropic is unavailable, the
companion model call fails first, so:

- `start_builder_task` is never emitted,
- `sophia_builder` never runs,
- the Builder fallback never executes.

The fix must let the **companion** retry its own model call through OpenAI, so
the companion can still produce the `start_builder_task` tool call and hand off
to the Builder (which then runs on its own provider path, with its own,
separate fallback if Anthropic is still down there too).

## The "credit balance too low" 400 — classifier gap

The live error is `anthropic.BadRequestError` (HTTP **400**), not a 402/403/429.
The existing shared `classify_provider_error` returns `None` for any 400 (a
400 is normally a prompt/validation error that would fail on *any* provider).
So a naive companion fallback would still re-raise on this exact error and not
fix the reported symptom.

Resolution: extend the **shared** classifier with a **narrow positive match**
for Anthropic's billing-400 — `isinstance(exc, anthropic.BadRequestError)`
AND the structured error message carries a billing signal (`credit balance`,
`billing`, `purchase credits`, `plans & billing`, `payment`). This maps to
`permission_or_payment_error`. Generic 400s (real prompt/validation failures,
and the non-`anthropic` `status_code=400` test doubles) still return `None`.
The raw message is read **only** to decide eligibility; it never enters the
diagnostics snapshot (a fixed safe template is used). This shared change also
benefits the Builder fallback (it can now recover from a billing-400 too) but
changes nothing while either fallback flag is off.

## Proposed fallback insertion point

A new **`CompanionProviderFallbackMiddleware`** placed **first** in the
companion middleware chain (before `ThreadDataMiddleware`). It implements only
`wrap_model_call` / `awrap_model_call`, so being first makes its model-call
wrapper the **outermost** — it catches the exception raised out of
`AnthropicPromptCachingMiddleware` and the model call itself. It has no
before/after hooks, so placing it first is behavior-neutral for the
load-bearing before/after ordering (crisis fast-path, tone→context→ritual→
skill, prompt assembly → dangling-tool → caching all keep their positions).

Decision table on a primary-model exception (mirrors the Builder):

1. Not a provider-availability error → re-raise unchanged.
2. Classified but fallback **disabled** (default) → one structured log line
   (`fallback_result=fallback_disabled`), re-raise unchanged. Byte-identical
   to today.
3. Classified + enabled but `OPENAI_API_KEY` or fallback model missing → log
   `fallback_result=fallback_not_configured`, re-raise. OpenAI never called.
4. Classified + enabled + configured → retry **once** with
   `request.override(model=ChatOpenAI(...))`. `request.tools` is rebound to
   the override model verbatim, so `start_builder_task` and every other
   companion tool remain available on the OpenAI path. On success the response
   is wrapped in `ExtendedModelResponse` whose `Command` writes a sanitized
   `companion_provider_fallback` snapshot into state.
5. On fallback failure, the fallback exception propagates (chained to the
   primary) and the run fails as it would today.

`AnthropicPromptCachingMiddleware` self-skips on a non-Anthropic model (its
`_should_apply_caching` returns `False` with a warning when
`request.model` is not `ChatAnthropic`), so the OpenAI retry path never
receives Anthropic `cache_control` blocks. Verified in the installed package.

## Env/config proposal (placeholders only — no real keys anywhere)

```
SOPHIA_COMPANION_OPENAI_FALLBACK_ENABLED=false        # default OFF
SOPHIA_COMPANION_OPENAI_FALLBACK_MODEL=<openai-model-placeholder>
SOPHIA_COMPANION_OPENAI_FALLBACK_TIMEOUT_SECONDS=120
SOPHIA_COMPANION_OPENAI_FALLBACK_MAX_RETRIES=1
OPENAI_API_KEY=<existing env name; never logged, never stored in repo>
```

- Separate env namespace from the Builder
  (`SOPHIA_BUILDER_OPENAI_FALLBACK_*`). Builder-specific env controls Builder
  fallback only; companion-specific env controls companion fallback only.
- Fallback requires BOTH the enabled flag AND a configured model AND
  `OPENAI_API_KEY`. Anything missing → `fallback_not_configured`, original
  error propagates exactly as today.
- No `$VAR` additions to `config.production.yaml` (the config resolver
  hard-fails on missing vars across BOTH Render services — pure-env flags
  avoid that trap). `langchain-openai` / `ChatOpenAI` is already a direct
  dependency; no dependency change needed.

## Triggering vs non-triggering failures

Trigger fallback ONLY for provider-availability classes:

| Error | Class |
|---|---|
| `anthropic.AuthenticationError` (401) | `auth_error` |
| `anthropic.PermissionDeniedError` (403) | `permission_or_payment_error` |
| `anthropic.RateLimitError` (429) | `rate_limit_or_quota` |
| `anthropic.APIConnectionError` | `provider_unreachable` |
| `anthropic.BadRequestError` (400) **with billing signal** | `permission_or_payment_error` |
| `anthropic.APIStatusError` ≥ 500 (incl. 529 overloaded) | `provider_unavailable` |

Explicitly NOT fallback triggers (classification returns `None` → re-raise):

- Generic `BadRequestError` (400) **without** a billing signal — real
  prompt/validation issues that would fail on any provider.
- `start_builder_task` / `emit_builder_artifact` product errors and
  artifact-missing — product events, never surfaced as exceptions through the
  model call.
- Tool execution bugs — tool-node territory, not `wrap_model_call`.
- User cancellation — `asyncio.CancelledError` is a `BaseException`; the
  middleware only catches `Exception`.
- Safety/policy refusals — normal model *responses*, not exceptions.
- LangGraph control-flow exceptions (interrupts) — not positively matched.

## Tool preservation strategy

`request.override(model=...)` changes only the model; `request.tools` is
carried verbatim and rebound to the OpenAI model at the model node. A mocked
test asserts the retry request's `tools` is identical to the primary's and
contains `start_builder_task`, and that the OpenAI model can still emit a
`start_builder_task` tool call — so the delegation contract is provider-
independent.

## Telemetry / diagnostics safety

The sanitized `companion_provider_fallback` snapshot uses an allowlist of
boolean / enum / fixed-template fields only:

- `companion_primary_provider` (`anthropic`)
- `companion_fallback_provider` (`openai`)
- `companion_fallback_enabled` (bool)
- `companion_fallback_attempted` (bool)
- `companion_fallback_reason` (error class enum)
- `companion_fallback_result` (`success` / `fallback_failed` /
  `fallback_disabled` / `fallback_not_configured`)
- `companion_fallback_model_configured` (bool only — never the model name)
- `companion_provider_error_class` (error class enum)
- `companion_provider_error_safe_message` (fixed template per class)
- `raw_provider_payload_excluded` = `True`
- `provider_secrets_excluded` = `True`

Never included: API keys, raw provider payloads, prompts, full exception
messages, signed URLs, file contents. The diagnostics prefix
(`[CompanionProviderFallback]` logs + `companion_*` snapshot keys) is distinct
from the Builder's so the two paths stay separable in telemetry.

## Risk level

**LOW.** The change is additive and default-off:

- Default behavior (flag unset) is byte-identical to today plus, at most, one
  explanatory log line on a provider error.
- Only `wrap_model_call` is touched; every before/after middleware hook and
  the Builder artifact handoff contract are untouched.
- The shared classifier change is a narrow positive match that cannot
  reclassify the existing generic-400 test doubles.
- Anthropic remains the constructed primary model for the companion; OpenAI is
  never the default.
