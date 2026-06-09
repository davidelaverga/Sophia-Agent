# Builder OpenAI Fallback — Audit + Design Note

Date: 2026-06-09
Branch: `feat/coreview-native-builder-actions` (worktree `main-health-pr133-verify`)
Context: Anthropic API key/card access is blocked; Davide has OpenAI credits.
Scope: **Builder only.** No changes to Gemini voice runtime, Coreview visual
review, artifact persistence, or the Builder artifact handoff contract.

## Verdict

**LOW_RISK_NOW** — implementable with a small isolated middleware, no Builder
orchestration rewrite.

## Current Builder provider path

- `backend/packages/harness/deerflow/agents/sophia_agent/builder_agent.py::_create_builder_agent`
  constructs **`ChatAnthropic` directly** (hardcoded provider class) with
  `streaming=True`, `timeout=120.0`, `max_retries=1`.
- Model **name** (not provider) resolves via `_resolve_builder_model_name`:
  parent `configurable.model_name` → `SOPHIA_BUILDER_MODEL` env →
  first "sonnet" model in app config → `DEFAULT_BUILDER_MODEL`
  (`claude-sonnet-4-6`).
- The agent is built by `langchain.agents.create_agent(model=..., tools=...,
  middleware=build_builder_middleware_chain(...))`. Tools are bound to the
  request's model at model-node execution time, which is what makes a
  per-call model override safe.
- Provider errors are **not classified anywhere today** — an Anthropic
  auth/quota failure propagates up, the LangGraph run errors out, and the
  companion's lifecycle surfaces a generic error status.

## Existing OpenAI support

- `langchain-openai>=1.1.7` is **already a direct dependency** of both
  `backend/pyproject.toml` and `backend/packages/harness/pyproject.toml`;
  `ChatOpenAI` imports cleanly. No dependency change needed.
- `OPENAI_API_KEY` is an **established env name** in this repo: the
  `image-generation` skill requires it on `sophia-langgraph`, and
  `config.example.yaml` shows commented `langchain_openai:ChatOpenAI`
  model examples using `$OPENAI_API_KEY`.
- No OpenAI chat model is wired into any agent path today (skills shell out
  to the OpenAI HTTP API for images; that path is unrelated and unchanged).

## Proposed fallback insertion point

A new **`BuilderProviderFallbackMiddleware`** in the Builder middleware chain
using langchain 1.3's `AgentMiddleware.wrap_model_call` / `awrap_model_call`
hooks (verified present in the installed version):

1. Call `handler(request)` (the normal Anthropic model call).
2. On exception, classify it (see below). Unclassified → re-raise unchanged.
3. If classified but fallback **disabled** → log a safe structured line
   (`fallback_result=fallback_disabled`) and re-raise unchanged. Behavior is
   exactly today's, plus an explanatory log/diagnostic.
4. If enabled but `OPENAI_API_KEY` or `SOPHIA_BUILDER_OPENAI_FALLBACK_MODEL`
   missing → log `fallback_result=fallback_not_configured`, re-raise.
5. Otherwise retry **once** with
   `handler(request.override(model=ChatOpenAI(...)))`. langchain rebinds the
   same `request.tools` to the override model, so the Builder tool set
   (write/read/ls/bash/str_replace, web search/fetch, render_markdown_to_pdf,
   create_pdf_artifact, **emit_builder_artifact**) is preserved verbatim.
6. On fallback success, return the response wrapped in
   `ExtendedModelResponse(command=Command(update={"builder_provider_fallback":
   <sanitized snapshot>}))` so the snapshot lands in graph state and is merged
   into any later `builder_failure_diagnostics`.
7. On fallback failure, re-raise (chained) — the run fails as it would today.

Why this point is minimal blast radius:

- It wraps **only the model invocation**. All before/after middleware hooks
  (briefing, research policy, progress, todo, artifact capture, prompt
  assembly, dangling-tool-call patching) are untouched.
- The terminal artifact handoff contract (`<terminal_artifact_handoff>`,
  `BuilderArtifactMiddleware` validation, emit-or-fail reconciliation) sits
  entirely outside the model call and applies identically to fallback turns.
- Anthropic remains the constructed default model; nothing about
  `_resolve_builder_model_name` changes.

## Failure classification

Trigger fallback ONLY for provider-availability classes (positive match on
Anthropic SDK exception types / HTTP status):

| Error | Class |
|---|---|
| `anthropic.AuthenticationError` (401) | `auth_error` (bad/blocked key) |
| `anthropic.PermissionDeniedError` (403) | `permission_or_payment_error` |
| `anthropic.RateLimitError` (429) | `rate_limit_or_quota` |
| `anthropic.APIConnectionError` | `provider_unreachable` |
| `anthropic.InternalServerError` / `APIStatusError` ≥ 500 (incl. 529 overloaded) | `provider_unavailable` |

Explicitly NOT fallback triggers (classification returns None → re-raise):

- `BadRequestError` (400) — prompt/validation issues would fail on any provider
- Builder prompt validation failures, `emit_builder_artifact` rejection,
  artifact-file-missing — these are product-level events handled by
  `BuilderArtifactMiddleware` and never pass through the model call as
  exceptions
- Tool execution bugs — tool errors are tool-node territory, not
  `wrap_model_call`
- User cancellation — `asyncio.CancelledError` is a `BaseException`; the
  middleware only catches `Exception`
- Safety/policy refusals — those are normal model *responses*, not exceptions
- LangGraph control-flow exceptions (interrupts) — not positively matched,
  so re-raised untouched

## Env/config proposal (placeholders only — no real keys anywhere)

```
SOPHIA_BUILDER_OPENAI_FALLBACK_ENABLED=false        # default OFF
SOPHIA_BUILDER_OPENAI_FALLBACK_MODEL=<openai-model-placeholder>
SOPHIA_BUILDER_OPENAI_FALLBACK_TIMEOUT_SECONDS=120  # mirrors Anthropic timeout
SOPHIA_BUILDER_OPENAI_FALLBACK_MAX_RETRIES=1        # mirrors Anthropic retries
OPENAI_API_KEY=<existing env name; never logged, never stored in repo>
```

- Fallback requires BOTH the enabled flag AND a configured model AND
  `OPENAI_API_KEY` present. Anything missing → `fallback_not_configured`
  diagnostic, original error propagates exactly as today.
- No `$VAR` additions to `config.production.yaml` (the resolver hard-fails on
  missing vars across BOTH Render services — pure-env flags avoid that trap
  entirely).
- The fallback model is constructed with `streaming=True` + timeout/retries
  mirroring the Anthropic settings, for the same read-timeout reasons.

## Compatibility with Builder tools

`ChatOpenAI.bind_tools` supports the same LangChain tool schemas; the agent's
model node binds `request.tools` to whatever model the request carries, so the
override path exercises identical tool routing, including the terminal
`emit_builder_artifact` call. Format-shape risk (an OpenAI model writing
slightly different HTML/Markdown) is contained by the existing
`BuilderArtifactMiddleware` validation, which is unchanged — invalid output
still gets rejected, and completion-without-deliverable still reconciles to a
failed terminal.

## Diagnostics (sanitized; no payloads, prompts, keys, or URLs)

New allowlisted keys in `builder_failure_diagnostics` (merged from the
`builder_provider_fallback` state snapshot when present):

`primary_provider`, `fallback_provider`, `fallback_enabled`,
`fallback_attempted`, `fallback_reason`, `fallback_result`,
`fallback_model_configured` (boolean only — never the model string from a
failure path, never the key), `provider_error_class`,
`provider_error_safe_message` (classified template text, never raw provider
body), `raw_provider_payload_excluded=true`, `provider_secrets_excluded=true`.

`fallback_result` values: `success` | `fallback_failed` | `fallback_disabled`
| `fallback_not_configured`.

## Risk assessment

- **Low.** Default-off flag; with the flag unset the only behavioral delta is
  a classified log line on provider errors.
- The middleware catches only positively-classified provider exceptions;
  everything else re-raises byte-identical.
- Tool/handoff contract preserved structurally (same request.tools, same
  middleware chain, same artifact validation).
- Residual risk: an OpenAI fallback model may follow the Builder prompt less
  precisely than Sonnet. Contained by existing validation + the
  no-deliverable reconciliation — worst case is an honest failed build, not a
  phantom success.
- Tests use mocked handlers/models only; no real API calls.

## Decision

**LOW_RISK_NOW** — implemented in this change:

- `deerflow/sophia/builder_provider_fallback.py` — config readers, error
  classification, sanitized snapshot builder, fallback model factory.
- `deerflow/agents/sophia_agent/middlewares/builder_provider_fallback.py` —
  the `wrap_model_call`/`awrap_model_call` middleware.
- Wired into `build_builder_middleware_chain` (Builder only; companion and
  lead_agent untouched).
- `builder_failure_diagnostics.py` — provider fields allowlisted + merged
  from state.
- Tests: `tests/test_builder_provider_fallback.py` (mocked providers).

Frontend telemetry surfacing of the new fields can follow the existing
`builderFailure*` mapping pattern (`builder-completion.ts` →
`useSessionRouteExperience.ts` → `voice-runtime-metrics.ts` →
`voice-telemetry-report.ts`) in a follow-up; the backend now exposes them
under `builder_failure_diagnostics`.
