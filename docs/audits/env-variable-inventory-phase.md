# Environment Variable Inventory and Cleanup Plan

Date: 2026-05-24
Branch: `audit/env-inventory-cleanup-plan`
Scope: audit/planning only. No runtime behavior changes.

## Safety Status

| Check | Result |
| --- | --- |
| Starting branch | `integrate/realtime-voice-main` |
| Starting commit | `a00ebb88d2c02f6c2cd700d0679125497f916b4d` |
| Audit branch | `audit/env-inventory-cleanup-plan` |
| Real env files modified | No |
| Production config modified | No |
| Vercel envs modified | No |
| Runtime/user files touched | No |
| Full test suite run | No; docs/example-only phase |

Existing dirty runtime state was present before this audit under `users/**` and `backend/users/**`; it was not touched.

## Git Ignore Check

| File | Ignored | Source |
| --- | --- | --- |
| `.env` | yes | `.gitignore` |
| `backend/.env` | yes | `.gitignore` |
| `voice/.env` | yes | `.gitignore` |
| `frontend/.env.local` | yes | `frontend/.gitignore` |
| `config.yaml` | yes | `.gitignore` |

## Inputs Inspected

Code/config reads were searched without intentionally reading or printing env values. Sources inspected:

- Frontend: `frontend/src/env.js`, `frontend/next.config.js`, `frontend/package.json`, route/config files, test config, Vercel config.
- Backend/gateway/LangGraph: `backend/app/gateway/**`, `backend/packages/harness/deerflow/config/**`, Sophia agent/services/storage/progress modules.
- Voice: `voice/config.py`, `voice/realtime/**`, `voice/Dockerfile`.
- Skills: provider scripts under `skills/public/**/scripts`.
- Deployment/config docs: `render.yaml`, `config.example.yaml`, `config.production.yaml`, Dockerfiles, existing example env files.

Local env files were parsed for variable names only. No values are included in this document.

## Code Read Inventory

| Env var | Runtime area | Required / optional | Code/config locations | Classification | Confidence | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | backend, LangGraph, gateway | Required for companion/builder Anthropic model paths | `config.production.yaml`, `config.example.yaml`, `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`, `builder_agent.py`, `reflection.py` | ACTIVE_REQUIRED | high | Required on Render gateway and LangGraph. |
| `MEM0_API_KEY` | backend, gateway, LangGraph | Required for Mem0-backed memory paths; optional only for no-Mem0 local tests | `backend/packages/harness/deerflow/sophia/mem0_client.py`, `backend/app/gateway/routers/sophia.py`, `render.yaml` | ACTIVE_REQUIRED | high | Single memory authority per repo rules. |
| `MEM0_BASE_URL` | backend, LangGraph | Optional | `backend/packages/harness/deerflow/sophia/mem0_client.py` | ACTIVE_OPTIONAL | high | Self-hosted Mem0 override. |
| `OPENAI_API_KEY` | backend, skills, voice | Required for image-generation skills and OpenAI realtime runtime; optional otherwise | `config*.yaml`, `skills/public/image-generation/scripts/generate.py`, `backend/.../builder_task.py`, `voice/config.py`, `voice/realtime/openai_browser_dogfood.py` | ACTIVE_REQUIRED | high | Canonical OpenAI key. Never expose in client env. |
| `GOOGLE_API_KEY` | backend config, voice | Required only for Gemini Live if `GEMINI_API_KEY` absent | `config*.yaml`, `voice/config.py` | ACTIVE_ALIAS_KEEP | high | Preferred Gemini Live provider key for voice; alias with `GEMINI_API_KEY`. |
| `GEMINI_API_KEY` | voice, skills | Required only for Gemini Live if `GOOGLE_API_KEY` absent; required by video-generation skill | `voice/config.py`, `skills/public/video-generation/scripts/generate.py` | ACTIVE_ALIAS_KEEP | high | Keep as alias because skills read this exact name. |
| `TAVILY_API_KEY` | backend, LangGraph | Required when web_search is enabled and Tavily is selected | `config.example.yaml`, `.env.example`, production web_search docs | ACTIVE_REQUIRED | medium | `config.production.yaml` enables Tavily web_search but currently omits a direct `$TAVILY_API_KEY` field; provider may read it internally. |
| `JINA_API_KEY` | backend, LangGraph | Optional | `backend/packages/harness/deerflow/community/jina_ai/jina_client.py` | ACTIVE_OPTIONAL | high | Web fetch can use no-key endpoint; key enables authenticated reader. |
| `INFOQUEST_API_KEY` | backend, LangGraph | Optional unless InfoQuest tools are selected | `backend/packages/harness/deerflow/community/infoquest/infoquest_client.py`, `config.example.yaml` | ACTIVE_OPTIONAL | high | Alternative search/fetch provider. |
| `DATABASE_URL` | frontend, backend config | Active alias / required when selected by Better Auth or config checkpointer | `frontend/src/env.js`, `frontend/src/server/better-auth/database.ts`, `config*.yaml` | ACTIVE_ALIAS_KEEP | high | Alias of `BETTER_AUTH_DATABASE_URL` for frontend; also dynamic config placeholder. |
| `BETTER_AUTH_SECRET` | frontend | Required in production | `frontend/src/env.js`, `frontend/src/server/legacy-backend-auth.ts`, `frontend/package.json` | ACTIVE_REQUIRED | high | Must be >=32 chars in production builds. |
| `BETTER_AUTH_URL` | frontend | Optional, recommended for auth | `frontend/src/env.js`, Better Auth config/migration script | ACTIVE_OPTIONAL | high | Canonical frontend app URL for Better Auth. |
| `BETTER_AUTH_DATABASE_URL` | frontend | Required when Better Auth DB is used and no `DATABASE_URL` fallback | `frontend/src/env.js`, Better Auth database/migration code | ACTIVE_REQUIRED | high | Preferred frontend DB var. |
| `BETTER_AUTH_DATABASE_SSL_MODE` | frontend | Optional | `frontend/src/env.js`, Better Auth database/migration code | ACTIVE_OPTIONAL | high | Valid values: `auto`, `disable`, `require`, `verify-full`, `no-verify`; insecure modes are rejected in production. |
| `BETTER_AUTH_DATABASE_SSL_CA` | frontend and database operators | Required for production Supabase | Better Auth database/migration TLS resolver | ACTIVE_REQUIRED_PRODUCTION | high | Supabase server root CA PEM used with hostname verification; never overridden by URL SSL parameters. |
| `BETTER_AUTH_DATABASE_POOL_MAX` | frontend | Optional | `frontend/src/env.js`, Better Auth database/migration code | ACTIVE_OPTIONAL | high | Pool tuning. |
| `GOOGLE_CLIENT_ID` | frontend | Optional; required for Google OAuth | `frontend/src/env.js`, `frontend/src/server/better-auth/config.ts` | ACTIVE_REQUIRED | high | Required if social login is enabled. |
| `GOOGLE_CLIENT_SECRET` | frontend | Optional; required for Google OAuth | `frontend/src/env.js`, `frontend/src/server/better-auth/config.ts` | ACTIVE_REQUIRED | high | Server-side only. |
| `BACKEND_API_URL` | frontend, gateway auth fallback | Optional URL alias | `frontend/src/env.js`, frontend gateway URL helpers/routes, `backend/app/gateway/auth.py` | ACTIVE_ALIAS_KEEP | high | Frontend/server-side alias for backend/gateway URL. |
| `NEXT_PUBLIC_API_URL` | frontend | Optional URL alias | `frontend/src/env.js`, `frontend/next.config.js`, many frontend routes | ACTIVE_ALIAS_KEEP | high | Public legacy API base. Prefer `NEXT_PUBLIC_GATEWAY_URL` for gateway-facing paths. |
| `NEXT_PUBLIC_GATEWAY_URL` | frontend | Optional, recommended local/prod public gateway URL | `frontend/src/env.js`, `frontend/next.config.js`, frontend gateway helpers, Playwright config | ACTIVE_REQUIRED | high | Canonical public gateway URL for frontend. |
| `RENDER_BACKEND_URL` | frontend | Optional production alias | `frontend/src/env.js`, frontend route helpers | ACTIVE_ALIAS_KEEP | high | Render-era backend URL alias; consolidate after deployment mapping is verified. |
| `SOPHIA_LANGGRAPH_BASE_URL` | frontend, gateway, voice | Required for direct LangGraph local/e2e paths; optional with defaults elsewhere | `frontend/src/app/api/chat/_lib/config.ts`, `backend/app/gateway/routers/sessions.py`, `voice/config.py`, scripts | ACTIVE_ALIAS_KEEP | high | Canonical server-side LangGraph URL for local tools. |
| `NEXT_PUBLIC_LANGGRAPH_BASE_URL` | frontend | Optional public LangGraph/proxy URL | `frontend/src/env.js`, chat API config/tests | ACTIVE_ALIAS_KEEP | high | Public/client-side counterpart of `SOPHIA_LANGGRAPH_BASE_URL`. |
| `LANGGRAPH_URL` | backend, gateway, voice tool loop | Required in production gateway channel manager; optional local default | `config.production.yaml`, `render.yaml`, `backend/.../offline_pipeline.py`, `voice/realtime/gemini_tool_loop.py` | ACTIVE_REQUIRED | high | Render gateway uses it to reach LangGraph. |
| `SOPHIA_BACKEND_BASE_URL` | voice, gateway | Legacy alias | `voice/config.py`, `backend/app/gateway/routers/sessions.py` | ACTIVE_ALIAS_KEEP | medium | Alias of `SOPHIA_LANGGRAPH_BASE_URL`; do not remove yet. |
| `SOPHIA_ASSISTANT_ID` | voice, frontend chat API | Optional with default | `voice/config.py`, `frontend/src/app/api/chat/_lib/config.ts`, scripts, Render voice service | ACTIVE_OPTIONAL | high | Defaults to `sophia_companion`. |
| `SOPHIA_PLATFORM` | voice | Optional with default | `voice/config.py`, Render voice service | ACTIVE_OPTIONAL | high | Valid: `voice`, `text`, `ios_voice`. |
| `SOPHIA_CONTEXT_MODE` | voice | Optional with default | `voice/config.py`, Render voice service | ACTIVE_OPTIONAL | high | Defaults to `life`. |
| `SOPHIA_RITUAL` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Active ritual override. |
| `SOPHIA_AGENT_USER_ID` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Defaults to `sophia-agent`. |
| `SOPHIA_AGENT_USER_NAME` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Defaults to `Sophia`. |
| `SOPHIA_BACKEND_MODE` | voice, e2e scripts | Optional with default; required as `deerflow` for real backend voice | `voice/config.py`, `scripts/sophia-e2e.ps1`, Render voice service | ACTIVE_REQUIRED | high | Canonical voice backend mode. |
| `SOPHIA_LLM_MODE` | voice | Legacy alias | `voice/config.py` | ACTIVE_ALIAS_KEEP | high | Alias of `SOPHIA_BACKEND_MODE`; remove only after local env cleanup. |
| `STREAM_API_KEY` | voice, gateway voice route, Render | Required for Stream voice/video | `voice/config.py`, `backend/app/gateway/routers/voice.py`, `render.yaml` | ACTIVE_REQUIRED | high | Required by voice server and gateway voice token route. |
| `STREAM_API_SECRET` | voice, Render | Required for Stream voice/video | `voice/config.py`, `render.yaml` | ACTIVE_REQUIRED | high | Server-side only. |
| `DEEPGRAM_API_KEY` | voice | Required for `legacy_cascade` voice runtime | `voice/config.py`, Render voice service | ACTIVE_REQUIRED | high | Not needed if active runtime is OpenAI/Gemini. |
| `CARTESIA_API_KEY` | voice | Required for `legacy_cascade` voice runtime | `voice/config.py`, Render voice service | ACTIVE_REQUIRED | high | Not needed if active runtime is OpenAI/Gemini. |
| `SOPHIA_VOICE_ID` | voice | Optional but expected for Cartesia voice identity | `voice/config.py`, Render voice service | ACTIVE_REQUIRED | high | Canonical replacement for older `CARTESIA_VOICE_ID*` names. |
| `SOPHIA_CARTESIA_MODEL` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Defaults to `sonic-3`. |
| `SOPHIA_CARTESIA_SAMPLE_RATE` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Defaults to 16000. |
| `SOPHIA_DEEPGRAM_MODEL` | voice | Optional | `voice/config.py`, Render voice service | ACTIVE_OPTIONAL | high | Defaults to `flux-general-en`. |
| `SOPHIA_DEEPGRAM_LANGUAGE` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Language override. |
| `SOPHIA_SMART_TURN_SILENCE_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Canonical smart-turn silence threshold. |
| `SOPHIA_SMART_TURN_SPEECH_THRESHOLD` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Canonical smart-turn speech threshold. |
| `SOPHIA_BUFFER_IN_SECONDS` | voice | Legacy alias | `voice/config.py` | ACTIVE_ALIAS_KEEP | high | Legacy fallback for silence threshold. |
| `SOPHIA_CONFIDENCE_THRESHOLD` | voice | Legacy alias | `voice/config.py` | ACTIVE_ALIAS_KEEP | high | Legacy fallback for speech threshold. |
| `SOPHIA_SMART_TURN_PRE_SPEECH_BUFFER_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Smart-turn buffer tuning. |
| `SOPHIA_SMART_TURN_VAD_RESET_SECONDS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Smart-turn reset tuning. |
| `SOPHIA_BACKEND_TIMEOUT_SECONDS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Backend request timeout. |
| `SOPHIA_READINESS_TIMEOUT_SECONDS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Service readiness timeout. |
| `SOPHIA_SHIM_RESPONSE_TEXT` | voice | Local/test only | `voice/config.py` | ACTIVE_LOCAL_ONLY | high | Shim mode text. |
| `SOPHIA_SHIM_CHUNK_DELAY_MS` | voice | Local/test only | `voice/config.py` | ACTIVE_LOCAL_ONLY | high | Shim mode streaming delay. |
| `SOPHIA_SHIM_FAILURE_STAGE` | voice | Local/test only | `voice/config.py` | ACTIVE_LOCAL_ONLY | high | Forced failure testing. |
| `SOPHIA_SHIM_FAILURE_MESSAGE` | voice | Local/test only | `voice/config.py` | ACTIVE_LOCAL_ONLY | high | Forced failure testing. |
| `SOPHIA_SHIM_EMIT_INVALID_ARTIFACT` | voice | Local/test only | `voice/config.py` | ACTIVE_LOCAL_ONLY | high | Test-only artifact fault injection. |
| `SOPHIA_ADAPTIVE_SILENCE_SHORT_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Adaptive silence tuning. |
| `SOPHIA_ADAPTIVE_SILENCE_MEDIUM_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Adaptive silence tuning. |
| `SOPHIA_ADAPTIVE_SILENCE_LONG_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Adaptive silence tuning. |
| `SOPHIA_ADAPTIVE_SILENCE_CEILING_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Adaptive silence tuning. |
| `SOPHIA_ADAPTIVE_SILENCE_CONTINUATION_BONUS_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Adaptive silence tuning. |
| `SOPHIA_ADAPTIVE_SILENCE_FRAGMENT_BONUS_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Adaptive silence tuning. |
| `SOPHIA_BACKEND_STALL_TIMEOUT_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Backend stall tuning. |
| `SOPHIA_FRAGILE_WINDOW_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Interrupt/rhythm tuning. |
| `SOPHIA_MERGE_MIN_NEW_WORDS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Transcript merge tuning. |
| `SOPHIA_RHYTHM_MIN_SESSIONS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Rhythm learner tuning. |
| `SOPHIA_RHYTHM_BASE_MIN_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Rhythm learner tuning. |
| `SOPHIA_RHYTHM_BASE_MAX_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Rhythm learner tuning. |
| `SOPHIA_SAME_TURN_REPEAT_DEBOUNCE_MS` | voice | Optional | `voice/config.py` | ACTIVE_OPTIONAL | high | Debounce tuning. |
| `SOPHIA_VOICE_RUNTIME_MODE` | voice | Optional; required to activate non-default runtimes | `voice/config.py`, `voice/realtime/runtime_selection.py`, `.env.example` | ACTIVE_OPTIONAL | high | Defaults to `legacy_cascade`. |
| `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED` | voice | Required for OpenAI/Gemini experimental runtimes | `voice/config.py`, `voice/realtime/runtime_selection.py`, `.env.example` | ACTIVE_OPTIONAL | high | Must be true before experimental runtime activation. |
| `SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED` | voice | Required for OpenAI realtime runtime | `voice/config.py`, `voice/realtime/openai_realtime.py` | ACTIVE_OPTIONAL | high | Gate separate from runtime mode. |
| `SOPHIA_OPENAI_REALTIME_MODEL` | voice | Optional | `voice/config.py`, `.env.example` | ACTIVE_OPTIONAL | high | OpenAI realtime model override. |
| `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED` | voice | Required for Gemini Live runtime | `voice/config.py`, `voice/realtime/gemini_live.py` | ACTIVE_OPTIONAL | high | Gate separate from runtime mode. |
| `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED` | voice, gateway voice route | Required only to promote Gemini on production route | `voice/config.py`, `backend/app/gateway/routers/voice.py` | ACTIVE_OPTIONAL | high | Separate promotion gate. |
| `SOPHIA_GEMINI_LIVE_MODEL` | voice | Optional | `voice/config.py`, `.env.example` | ACTIVE_OPTIONAL | high | Gemini Live model override. |
| `SOPHIA_GEMINI_LIVE_VOICE_NAME` | voice | Optional | `voice/config.py`, `voice/realtime/gemini_live.py`, `.env.example` | ACTIVE_OPTIONAL | medium | Gemini Live prebuilt voice override for new sessions. Unset preserves `Kore`; invalid values fall back safely and are reported through `gemini_voice_*` diagnostics. |
| `SOPHIA_VOICE_REALTIME_SHADOW_PARITY_ENABLED` | voice | Optional/local validation | `voice/config.py`, `voice/realtime/runtime_selection.py` | ACTIVE_OPTIONAL | high | Only valid with legacy cascade. |
| `CORS_ORIGINS` | gateway | Optional | `backend/app/gateway/app.py`, `backend/app/gateway/config.py` | ACTIVE_OPTIONAL | high | Gateway CORS list. |
| `GATEWAY_HOST` | gateway | Optional | `backend/app/gateway/config.py` | ACTIVE_OPTIONAL | high | Local gateway bind override. |
| `GATEWAY_PORT` | gateway | Optional | `backend/app/gateway/config.py` | ACTIVE_OPTIONAL | high | Local gateway bind override. |
| `SOPHIA_AUTH_BYPASS` | gateway | Local only | `backend/app/gateway/auth.py` | ACTIVE_LOCAL_ONLY | high | Explicit backend auth bypass. |
| `SOPHIA_USER_ID` | gateway | Local only | `backend/app/gateway/auth.py` | ACTIVE_LOCAL_ONLY | high | Bypass user id. |
| `SOPHIA_AUTH_BACKEND_URL` | frontend, gateway, scripts | Optional / required for legacy auth bridge | `backend/app/gateway/auth.py`, `frontend/src/env.js`, frontend auth bridge code, scripts | ACTIVE_REQUIRED | high | Canonical server-side auth bridge URL. |
| `NEXT_PUBLIC_SOPHIA_AUTH_BACKEND_URL` | frontend | Optional public alias | frontend auth bridge code | ACTIVE_ALIAS_KEEP | high | Public fallback alias. |
| `NEXT_PUBLIC_SOPHIA_AUTH_BYPASS` | frontend | Local only | `frontend/src/env.js`, frontend dev-bypass helper/tests | ACTIVE_LOCAL_ONLY | high | Preferred frontend bypass flag. |
| `NEXT_PUBLIC_DEV_BYPASS_AUTH` | frontend | Legacy local only | `frontend/src/env.js`, frontend dev-bypass helper/tests, Playwright config | ACTIVE_ALIAS_KEEP | high | Legacy fallback; keep until local env cleanup. |
| `NEXT_PUBLIC_SOPHIA_USER_ID` | frontend | Local only | `frontend/src/env.js`, frontend dev-bypass helper/tests | ACTIVE_LOCAL_ONLY | high | Bypass user id. |
| `SOPHIA_BACKEND_TOKEN_SECRET` | frontend | Optional; required for backend token bridge in prod if no Better Auth secret fallback | `frontend/src/env.js`, `frontend/src/server/legacy-backend-auth.ts` | ACTIVE_OPTIONAL | high | Secret, server-side only. |
| `BACKEND_API_KEY` | frontend | Legacy local/server fallback | `frontend/src/app/lib/auth/server-auth.ts`, tests | ACTIVE_LOCAL_ONLY | medium | Legacy fallback; not user-scoped auth. |
| `VOICE_SERVER_URL` | gateway | Optional alias | `backend/app/gateway/auth.py`, `backend/app/gateway/routers/voice.py`, e2e scripts | ACTIVE_ALIAS_KEEP | high | Canonical production name appears to be `SOPHIA_VOICE_SERVER_URL` in Render, but code reads `VOICE_SERVER_URL`; verify. |
| `SOPHIA_VOICE_SERVER_URL` | Render/gateway | Production declared; not directly code-read in grep | `render.yaml` | UNKNOWN_NEEDS_HUMAN_REVIEW | medium | Possible production mismatch with code's `VOICE_SERVER_URL`. Verify before cleanup/deploy. |
| `SOPHIA_GATEWAY_URL` | LangGraph, builder progress | Required for deployed builder webhooks | `backend/packages/harness/deerflow/sophia/builder_events.py`, `builder_progress.py`, `middlewares/builder_progress.py`, `.env.example` | ACTIVE_PRODUCTION_ONLY | high | Required on LangGraph in production. |
| `BUILDER_PROGRESS_EMIT` | LangGraph | Optional | `backend/packages/harness/deerflow/sophia/builder_progress.py` | ACTIVE_OPTIONAL | high | Disables live builder progress when false. |
| `SOPHIA_BUILDER_MODEL` | LangGraph | Optional | `backend/packages/harness/deerflow/agents/sophia_agent/builder_agent.py` | ACTIVE_OPTIONAL | high | Builder model override. |
| `TELEGRAM_BOT_TOKEN` | gateway, frontend telegram login, config | Required for Telegram channel/login | `config.production.yaml`, `render.yaml`, `frontend/src/app/api/auth/telegram-login/route.ts` | ACTIVE_REQUIRED | high | Needed in gateway and frontend if LoginUrl verification runs in frontend. |
| `TELEGRAM_BOT_USERNAME` | gateway | Required for deep links | `backend/app/gateway/telegram_link_store.py`, `render.yaml` | ACTIVE_REQUIRED | high | No `@`. |
| `SOPHIA_WEB_BASE_URL` | gateway | Required for Telegram memory review notification flow | `backend/app/channels/telegram_session_tracker.py`, `.env.example` | ACTIVE_PRODUCTION_ONLY | high | Must match BotFather domain. |
| `TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED` | gateway | Optional | `backend/app/channels/telegram_session_tracker.py`, `.env.example` | ACTIVE_OPTIONAL | high | Kill switch. |
| `SOPHIA_TELEGRAM_BINDINGS_TABLE` | gateway | Optional | `backend/app/gateway/telegram_link_store.py` | ACTIVE_OPTIONAL | high | Defaults to `telegram_user_bindings`. |
| `TELEGRAM_WORKER_BOT_TOKEN` | docs/example only | Not active | `.env.example`, `render.yaml` comment | LEGACY_CANDIDATE | high | Render comments say deleted in Phase 4C. |
| `TELEGRAM_WORKER_BOT_USERNAME` | docs/example only | Not active | `.env.example` | LEGACY_CANDIDATE | high | Builder-as-main worker bot removed per Render comments. |
| `SUPABASE_URL` | backend, gateway | Required for Supabase artifact/login binding features | `backend/app/gateway/telegram_link_store.py`, `backend/.../supabase_artifact_store.py` | ACTIVE_REQUIRED | high | Server-side. |
| `SUPABASE_SERVICE_ROLE_KEY` | backend, gateway | Required for Supabase service role paths | `backend/app/gateway/telegram_link_store.py`, `backend/.../supabase_artifact_store.py` | ACTIVE_REQUIRED | high | Canonical key name in code. |
| `SUPABASE_KEY` | backend, gateway | Legacy alias | Supabase store/link code | ACTIVE_ALIAS_KEEP | high | Alias fallback for service role key. |
| `SUPABASE_BUILDER_BUCKET` | backend | Optional | `backend/.../supabase_artifact_store.py` | ACTIVE_OPTIONAL | high | Defaults in code. |
| `SOPHIA_SUPABASE_MIRROR_ALL` | backend | Optional | `backend/.../supabase_mirror.py` | ACTIVE_OPTIONAL | high | Mirror flag. |
| `SUPABASE_SERVICE_KEY` | backend local env only | Not code-read | `backend/.env` names only | LEGACY_CANDIDATE | high | Alias mismatch; code uses `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_KEY`. |
| `SUPABASE_ANON_KEY` | backend local env only | Not code-read in audited paths | `backend/.env` names only | UNKNOWN_NEEDS_HUMAN_REVIEW | medium | Provider/front-end conventions may use it outside current runtime. |
| `SUPABASE_AUDIO_PREFIX` | backend local env only | Not code-read | `backend/.env` names only | LEGACY_CANDIDATE | medium | No active code/config/doc/script reference found. |
| `SUPABASE_BUCKET_AUDIO` | backend local env only | Not code-read | `backend/.env` names only | LEGACY_CANDIDATE | medium | No active code/config/doc/script reference found. |
| `DEER_FLOW_CONFIG_PATH` | backend, scripts | Optional | `backend/.../app_config.py`, e2e scripts | ACTIVE_LOCAL_ONLY | high | Config path override. |
| `DEER_FLOW_EXTENSIONS_CONFIG_PATH` | backend | Optional | `backend/.../extensions_config.py` | ACTIVE_LOCAL_ONLY | high | Extensions config path override. |
| `DEER_FLOW_SANDBOX_HOST` | backend | Optional | sandbox local backend | ACTIVE_LOCAL_ONLY | high | Sandbox host override. |
| `DEER_FLOW_HOST_SKILLS_PATH` | backend | Optional | sandbox provider | ACTIVE_LOCAL_ONLY | high | Host skills path override. |
| `DEER_FLOW_HOST_BASE_DIR` | backend | Optional | config paths | ACTIVE_LOCAL_ONLY | high | Path override. |
| `DEER_FLOW_HOME` | backend | Optional | config paths | ACTIVE_LOCAL_ONLY | high | Path override. |
| `LANGSMITH_TRACING` | backend | Optional | `backend/.../tracing_config.py` | ACTIVE_OPTIONAL | high | Preferred tracing flag. |
| `LANGCHAIN_TRACING_V2` | backend, Render | Optional | tracing config, `render.yaml` | ACTIVE_ALIAS_KEEP | high | Legacy LangChain tracing flag. |
| `LANGCHAIN_TRACING` | backend | Optional | tracing config | ACTIVE_ALIAS_KEEP | high | Legacy tracing flag. |
| `LANGSMITH_API_KEY` | backend | Optional | tracing config | ACTIVE_OPTIONAL | high | Preferred tracing key. |
| `LANGCHAIN_API_KEY` | backend | Optional | tracing config, backend local env | ACTIVE_ALIAS_KEEP | high | Legacy tracing key. |
| `LANGSMITH_PROJECT` | backend | Optional | tracing config | ACTIVE_OPTIONAL | high | Preferred tracing project. |
| `LANGCHAIN_PROJECT` | backend | Optional | tracing config, backend local env | ACTIVE_ALIAS_KEEP | high | Legacy tracing project. |
| `LANGSMITH_ENDPOINT` | backend | Optional | tracing config | ACTIVE_OPTIONAL | high | Preferred tracing endpoint. |
| `LANGCHAIN_ENDPOINT` | backend | Optional | tracing config | ACTIVE_ALIAS_KEEP | high | Legacy tracing endpoint. |
| `NEXT_PUBLIC_APP_URL` | frontend | Optional | frontend debug/auth backend URL fallback | ACTIVE_ALIAS_KEEP | high | Alias overlap with `BETTER_AUTH_URL`. |
| `NEXT_PUBLIC_WS_URL` | frontend | Optional legacy voice URL | Capacitor/legacy voice helpers | ACTIVE_OPTIONAL | high | Public websocket override. |
| `NEXT_PUBLIC_BACKEND_WS_URL` | frontend | Optional legacy alias | Capacitor API | ACTIVE_ALIAS_KEEP | high | Alias of `NEXT_PUBLIC_WS_URL`. |
| `NEXT_PUBLIC_SENTRY_DSN` | frontend | Optional | frontend error logger/tests | ACTIVE_OPTIONAL | high | Public Sentry DSN. |
| `NEXT_PUBLIC_VERBOSE_LOGS` | frontend | Optional local/debug | frontend debug helper | ACTIVE_LOCAL_ONLY | high | Local debug logging. |
| `NEXT_PUBLIC_MOCK_PRIVACY` | frontend | Local/test only | privacy API helper | ACTIVE_LOCAL_ONLY | high | Mock privacy API. |
| `NEXT_PUBLIC_SESSIONS_PROXY_URL` | frontend | Optional/legacy | sessions API helper | ACTIVE_OPTIONAL | medium | Verify before removal. |
| `NEXT_PUBLIC_API_KEY` | frontend | Local/legacy | `frontend/src/app/hooks/useBackendAuth.ts` | ACTIVE_LOCAL_ONLY | medium | Legacy dev key fallback. |
| `USE_MOCK_STREAMING` | frontend | Local/test only | chat/resume routes/tests | ACTIVE_LOCAL_ONLY | high | Mock streaming path. |
| `USE_MOCK_BOOTSTRAP` | frontend | Local/test only | archived bootstrap route | ACTIVE_LOCAL_ONLY | medium | Archived route only; remove with archived route cleanup. |
| `CORS_ALLOWED_ORIGIN` | frontend | Optional/local | resume route/tests | ACTIVE_OPTIONAL | medium | Frontend route CORS override. |
| `SOPHIA_E2E_TEST_AUTH` | frontend | Test only | e2e scripts/tests/test-auth route | ACTIVE_LOCAL_ONLY | high | Test-only auth gate. |
| `PLAYWRIGHT_TEST_HOST` | frontend | Test only | `frontend/playwright.config.ts` | ACTIVE_LOCAL_ONLY | high | Playwright. |
| `PLAYWRIGHT_TEST_BASE_URL` | frontend | Test only | `frontend/playwright.config.ts`, package scripts | ACTIVE_LOCAL_ONLY | high | Playwright. |
| `E2E_BASE_URL` | frontend | Test only | `frontend/playwright.config.ts` | ACTIVE_LOCAL_ONLY | high | Playwright fallback. |
| `PLAYWRIGHT_REUSE_EXISTING_SERVER` | frontend | Test only | `frontend/playwright.config.ts` | ACTIVE_LOCAL_ONLY | high | Playwright. |
| `CAPACITOR_BUILD` | frontend | Build only | `frontend/next.config.js` | ACTIVE_LOCAL_ONLY | high | Static export mode. |
| `SKIP_ENV_VALIDATION` | frontend | Build only | `frontend/src/env.js` | ACTIVE_LOCAL_ONLY | high | Docker/build escape hatch; prefer setting real vars. |
| `NODE_ENV` | frontend/backend/Node standard | Platform-set | many files | ACTIVE_OPTIONAL | high | Standard runtime variable; do not manage manually except scripts. |
| `PORT` | frontend/backend/Render/Playwright | Platform/local | Dockerfiles, Playwright config, scripts | ACTIVE_OPTIONAL | high | Render and local port. |
| `CI` | frontend/backend tests | Platform-set | Playwright/backend tests | ACTIVE_LOCAL_ONLY | high | Standard CI variable. |
| `BG_JOB_ISOLATED_LOOPS` | scripts/local LangGraph | Optional | `scripts/sophia-dev.ps1`, `scripts/start-all.ps1` | ACTIVE_LOCAL_ONLY | high | Local launcher default. |
| `N_JOBS_PER_WORKER` | scripts/local only | Optional | `scripts/sophia-dev.ps1`, `scripts/start-all.ps1` | ACTIVE_LOCAL_ONLY | high | Do not set on Render for LangGraph; Docker CMD flag owns production concurrency. |
| `VOLCENGINE_TTS_APPID` | skills | Required for podcast generation TTS | `skills/public/podcast-generation/scripts/generate.py` | ACTIVE_OPTIONAL | high | Distinct from generic `VOLCENGINE_API_KEY`. |
| `VOLCENGINE_TTS_ACCESS_TOKEN` | skills | Required for podcast generation TTS | `skills/public/podcast-generation/scripts/generate.py` | ACTIVE_OPTIONAL | high | Distinct from generic `VOLCENGINE_API_KEY`. |
| `VOLCENGINE_TTS_CLUSTER` | skills | Optional | `skills/public/podcast-generation/scripts/generate.py` | ACTIVE_OPTIONAL | high | Defaults to provider cluster. |
| `VOLCENGINE_API_KEY` | backend config/examples | Optional when Volcengine model config is selected | `config.example.yaml`, `.env.example` | UNKNOWN_NEEDS_HUMAN_REVIEW | medium | Generic model provider key, separate from podcast TTS vars. |
| `DEEPSEEK_API_KEY` | backend config/examples | Optional when DeepSeek model config is selected | `config*.yaml`, `.env.example` | ACTIVE_OPTIONAL | medium | Dynamic config placeholder. |
| `MOONSHOT_API_KEY` | backend config | Optional when Moonshot/Kimi config is selected | `config*.yaml` | ACTIVE_OPTIONAL | medium | Dynamic config placeholder. |
| `NOVITA_API_KEY` | backend config/examples | Optional when Novita config is selected | `config*.yaml`, `.env.example` | ACTIVE_OPTIONAL | medium | Dynamic config placeholder. |
| `MINIMAX_API_KEY` | backend config/examples | Optional when MiniMax config is selected | `config*.yaml`, `.env.example` | ACTIVE_OPTIONAL | medium | Dynamic config placeholder. |
| `SLACK_BOT_TOKEN` | backend config/examples | Optional when Slack channel is enabled | `config*.yaml`, `.env.example` | ACTIVE_OPTIONAL | medium | Dynamic config placeholder. |
| `SLACK_APP_TOKEN` | backend config/examples | Optional when Slack channel is enabled | `config*.yaml`, `.env.example` | ACTIVE_OPTIONAL | medium | Dynamic config placeholder. |
| `FEISHU_APP_ID` | backend config/examples | Optional when Feishu channel is enabled | `config*.yaml`, `.env.example` | ACTIVE_OPTIONAL | medium | Dynamic config placeholder. |
| `FEISHU_APP_SECRET` | backend config/examples | Optional when Feishu channel is enabled | `config*.yaml`, `.env.example` | ACTIVE_OPTIONAL | medium | Dynamic config placeholder. |
| `MY_API_KEY` | backend config | Example placeholder only | `config*.yaml` | UNKNOWN_NEEDS_HUMAN_REVIEW | low | Example/provider placeholder. |
| `FIRECRAWL_API_KEY` | docs/example only | Not code-read in audited paths | `.env.example` | UNKNOWN_NEEDS_HUMAN_REVIEW | low | Provider SDK/config may read if tool added later. |
| `CLAUDECODE` | skills subprocess exclusion | Optional | `skills/public/skill-creator/scripts/*.py` | ACTIVE_LOCAL_ONLY | medium | Removed from subprocess env for Claude Code helper scripts. |

## Local Env File Name Inventory

| File | Present | Parsed variable names |
| --- | --- | --- |
| `.env` | yes | none parsed |
| `.env.local` | no | n/a |
| `backend/.env` | yes | many; see groups below |
| `voice/.env` | yes | `CARTESIA_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `SOPHIA_ASSISTANT_ID`, `SOPHIA_BACKEND_MODE`, `SOPHIA_BUFFER_IN_SECONDS`, `SOPHIA_CONFIDENCE_THRESHOLD`, `SOPHIA_CONTEXT_MODE`, `SOPHIA_DEEPGRAM_MODEL`, `SOPHIA_LANGGRAPH_BASE_URL`, `SOPHIA_OPENAI_REALTIME_MODEL`, `SOPHIA_PLATFORM`, `SOPHIA_RITUAL`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED`, `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED`, `SOPHIA_VOICE_ID`, `SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED`, `SOPHIA_VOICE_RUNTIME_MODE`, `STREAM_API_KEY`, `STREAM_API_SECRET` |
| `frontend/.env.local` | no | n/a |
| `frontend/.env` | yes | `BACKEND_API_URL`, `BETTER_AUTH_DATABASE_POOL_MAX`, `BETTER_AUTH_DATABASE_SSL_CA`, `BETTER_AUTH_DATABASE_SSL_MODE`, `BETTER_AUTH_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DEV_BYPASS_AUTH`, `NEXT_PUBLIC_GATEWAY_URL`, `NEXT_PUBLIC_LANGGRAPH_BASE_URL`, `NEXT_PUBLIC_SOPHIA_AUTH_BYPASS`, `NEXT_PUBLIC_SOPHIA_USER_ID`, `SOPHIA_LANGGRAPH_BASE_URL` |

`backend/.env` active names found in code/config include: `ANTHROPIC_API_KEY`, `CORS_ORIGINS`, `DATABASE_URL`, `LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_TRACING_V2`, `MEM0_API_KEY`, `OPENAI_API_KEY`, `SUPABASE_BUILDER_BUCKET`, `SUPABASE_URL`.

`backend/.env` names with no active code/config/doc/script reference found during this pass:

- Backend/server tuning legacy candidates: `APP_NAME`, `APP_VERSION`, `CHECKPOINTER_BACKEND`, `CORS_ALLOW_CREDENTIALS`, `DB_MAX_OVERFLOW`, `DB_POOL_SIZE`, `DB_POOL_TIMEOUT`, `DEBUG`, `DEBUG_ENDPOINTS_ENABLED`, `ENVIRONMENT`, `HEALTH_CHECK_TIMEOUT_MS`, `HOST`, `LOG_FILE`, `LOG_FORMAT`, `LOG_LEVEL`, `LOG_RETENTION`, `LOG_ROTATION`, `MAX_CONCURRENT_SESSIONS`, `MAX_MESSAGE_LENGTH`, `MAX_SESSION_DURATION_SEC`, `METRICS_ENABLED`, `OTEL_ENABLED`, `OTEL_ENDPOINT`, `OTEL_SERVICE_NAME`, `PORT`, `PROMPTS_DIR`, `REDIS_ENABLED`, `REDIS_MAX_CONNECTIONS`, `REDIS_URL`, `RELOAD`, `TEST_MODE`, `VECTOR_STORE_PROVIDER`, `WORKERS`.
- Legacy voice/STT/TTS candidates in backend env: `AUDIO_CHANNELS`, `AUDIO_FORMAT`, `AUDIO_MAX_DURATION_SEC`, `AUDIO_MAX_SIZE_MB`, `AUDIO_SAMPLE_RATE`, `BARGE_IN_COOLDOWN_MS`, `BARGE_IN_ENABLED`, `CARTESIA_API_VERSION`, `CARTESIA_LANGUAGE`, `CARTESIA_MODEL_ID`, `CARTESIA_OUTPUT_SAMPLE_RATE`, `CARTESIA_SAMPLE_RATE`, `CARTESIA_STT_TIMEOUT`, `CARTESIA_TTS_TIMEOUT`, `CARTESIA_VOICE_ID`, `CARTESIA_VOICE_ID_EN`, `CARTESIA_VOICE_ID_ES`, `INWORLD_API_KEY`, `INWORLD_API_SECRET`, `INWORLD_CHARACTER_ID`, `INWORLD_VOICE_ID`, `STT_API_KEY`, `STT_LANGUAGE`, `STT_PROVIDER`, `STT_TIMEOUT`, `TTS_PROVIDER`, `TTS_TIMEOUT`, `VAD_AGGRESSIVENESS`, `VAD_ENABLED`, `VAD_FRAME_DURATION_MS`, `VAD_PADDING_DURATION_MS`.
- Legacy emotional/memory candidates: `BABEL_SENTICNET_API_BASE`, `BABEL_SENTICNET_EMOTION_KEY`, `BABEL_SENTICNET_INTENSITY_KEY`, `BABEL_SENTICNET_POLARITY_KEY`, `EMOTION_LOG_BATCH_SIZE`, `EMOTION_LOGGING_ENABLED`, `EMOTIONAL_SKILLS_ENABLED`, `FEATURE_EMOTION_ENABLED`, `FEATURE_LANGGRAPH_ENABLED`, `FEATURE_MEMORY_ENABLED`, `FEATURE_STREAMING_ENABLED`, `FEATURE_TEXT_ENABLED`, `FEATURE_VOICE_ENABLED`, `FLASH_MAX_SESSIONS`, `FLASH_MAX_TURNS_PER_SESSION`, `FLASH_MEMORY_ENABLED`, `FLASH_SESSION_TTL_SEC`, `MEM0_ENABLED`, `MEM0_MAX_SEARCH_RESULTS`, `MEM0_ORG_ID`, `MEM0_PROJECT_ID`, `MEM0_USER_ID_PREFIX`, `OPENMEMORY_API_KEY`, `OPENMEMORY_BASE_URL`, `OPENMEMORY_EPISODIC_ENABLED`, `OPENMEMORY_WRITE_TIMEOUT_MS`, `PHOENIX_API_KEY`, `PHOENIX_ENABLED`, `PHOENIX_MIN_CONFIDENCE`, `PHOENIX_TIMEOUT`, `PROFANITY_FILTER_ENABLED`, `PROFANITY_FILTER_MODE`, `RESPONSE_LOCK_TIMEOUT`, `SENTENCE_MAX_LATENCY_MS`, `SENTENCE_MIN_CHARS`, `SENTICNET_API_BASE`, `SENTICNET_API_TIMEOUT`, `SENTICNET_DEPRESSION_KEY`, `SENTICNET_EMOTION_KEY`, `SENTICNET_ENABLED`, `SENTICNET_INTENSITY_KEY`, `SENTICNET_MAX_RETRIES`, `SENTICNET_POLARITY_KEY`, `SENTICNET_SARCASM_KEY`, `SENTICNET_TOXICITY_KEY`, `TOKEN_BUS_MAX_QUEUE`, `TOKEN_BUS_STALL_MS`.
- OpenAI tuning candidates not code-read directly: `ANTHROPIC_MAX_TOKENS`, `ANTHROPIC_MODEL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_MAX_TOKENS`, `OPENAI_TEMPERATURE`, `OPENAI_TIMEOUT`.
- Supabase alias mismatch candidates: `SUPABASE_ANON_KEY`, `SUPABASE_AUDIO_PREFIX`, `SUPABASE_BUCKET_AUDIO`, `SUPABASE_SERVICE_KEY`.

## Comparison Tables

### Present In Env Files And Used By Code

| Env file | Used names present |
| --- | --- |
| `backend/.env` | `ANTHROPIC_API_KEY`, `CORS_ORIGINS`, `DATABASE_URL`, `LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_TRACING_V2`, `MEM0_API_KEY`, `OPENAI_API_KEY`, `SUPABASE_BUILDER_BUCKET`, `SUPABASE_URL` |
| `voice/.env` | `CARTESIA_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `SOPHIA_ASSISTANT_ID`, `SOPHIA_BACKEND_MODE`, `SOPHIA_BUFFER_IN_SECONDS`, `SOPHIA_CONFIDENCE_THRESHOLD`, `SOPHIA_CONTEXT_MODE`, `SOPHIA_DEEPGRAM_MODEL`, `SOPHIA_LANGGRAPH_BASE_URL`, `SOPHIA_OPENAI_REALTIME_MODEL`, `SOPHIA_PLATFORM`, `SOPHIA_RITUAL`, `SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED`, `SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED`, `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED`, `SOPHIA_VOICE_ID`, `SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED`, `SOPHIA_VOICE_RUNTIME_MODE`, `STREAM_API_KEY`, `STREAM_API_SECRET` |
| `frontend/.env` | `BACKEND_API_URL`, `BETTER_AUTH_DATABASE_POOL_MAX`, `BETTER_AUTH_DATABASE_SSL_CA`, `BETTER_AUTH_DATABASE_SSL_MODE`, `BETTER_AUTH_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DEV_BYPASS_AUTH`, `NEXT_PUBLIC_GATEWAY_URL`, `NEXT_PUBLIC_LANGGRAPH_BASE_URL`, `NEXT_PUBLIC_SOPHIA_AUTH_BYPASS`, `NEXT_PUBLIC_SOPHIA_USER_ID`, `SOPHIA_LANGGRAPH_BASE_URL` |

### Present In Env Files But Not Found In Code

See the grouped `backend/.env` legacy candidate lists above. Highest-confidence stale/alias issues:

| Env var | Evidence | Plan status |
| --- | --- | --- |
| `SUPABASE_SERVICE_KEY` | Present locally; code reads `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_KEY` | consolidate after verifying no external process expects old name |
| `TELEGRAM_WORKER_BOT_TOKEN` | Present in root example docs only; Render comment says deleted | safe example cleanup candidate, verify dashboard |
| `TELEGRAM_WORKER_BOT_USERNAME` | Present in root example docs only; worker bot removed | safe example cleanup candidate, verify dashboard |
| `CARTESIA_VOICE_ID`, `CARTESIA_VOICE_ID_EN`, `CARTESIA_VOICE_ID_ES` | Present in backend env; active voice code reads `SOPHIA_VOICE_ID` | consolidate to `SOPHIA_VOICE_ID` |
| `STT_*`, `TTS_*`, `VAD_*`, `INWORLD_*` | Present in backend env; active voice server reads `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `SOPHIA_*` voice settings | legacy candidates |
| `OPENMEMORY_*` | Present locally; Sophia memory code reads `MEM0_*` | legacy candidates, confirm no old OpenMemory sidecar |
| `SENTICNET_*`, `BABEL_SENTICNET_*`, `PHOENIX_*` | Present locally; no code/config/docs/scripts references found | legacy candidates, confirm no external analytics pipeline |

### Used By Code But Missing From Local Env Files

| Env var | Runtime area | Status |
| --- | --- | --- |
| `LANGGRAPH_URL` | production gateway/offline pipeline | Missing locally; production required on gateway |
| `SOPHIA_GATEWAY_URL` | production LangGraph builder webhooks | Missing locally; production required on LangGraph |
| `SOPHIA_VOICE_SERVER_URL` | Render gateway declaration | Missing locally; code appears to read `VOICE_SERVER_URL`, needs verification |
| `VOICE_SERVER_URL` | gateway local auth/voice route | Missing locally; local scripts set it for e2e |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role | Missing locally; `backend/.env` has `SUPABASE_SERVICE_KEY` alias mismatch |
| `SUPABASE_KEY` | Supabase service role alias | Missing locally; code fallback only |
| `SOPHIA_WEB_BASE_URL` | Telegram review handoff | Missing locally; production-only unless testing Telegram review locally |
| `TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED` | Telegram review handoff | Missing locally; optional kill switch |
| `SOPHIA_TELEGRAM_BINDINGS_TABLE` | Telegram link store | Missing locally; optional default exists |
| `SOPHIA_BUILDER_MODEL` | builder model override | Missing locally; optional |
| `BUILDER_PROGRESS_EMIT` | builder progress | Missing locally; optional default enabled |
| `GATEWAY_HOST`, `GATEWAY_PORT` | gateway local bind | Missing locally; optional defaults exist |
| `MEM0_BASE_URL` | Mem0 self-host | Missing locally; optional |
| `LANGSMITH_*`, `LANGCHAIN_ENDPOINT`, `LANGCHAIN_TRACING` | tracing | Mostly missing; optional |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_BACKEND_WS_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_VERBOSE_LOGS`, `NEXT_PUBLIC_MOCK_PRIVACY`, `NEXT_PUBLIC_SESSIONS_PROXY_URL`, `NEXT_PUBLIC_API_KEY` | frontend optional/local/legacy | Missing locally; optional unless those features are exercised |
| `BACKEND_API_KEY`, `SOPHIA_BACKEND_TOKEN_SECRET` | frontend auth bridge legacy | Missing locally; optional/legacy |
| `TELEGRAM_BOT_TOKEN` | frontend Telegram login route | Missing from frontend env; production Vercel may require it |
| `VOLCENGINE_TTS_APPID`, `VOLCENGINE_TTS_ACCESS_TOKEN`, `VOLCENGINE_TTS_CLUSTER` | podcast skill | Missing locally; optional unless podcast skill is used |

### Duplicated Across Env Files

| Env var | Files | Recommendation |
| --- | --- | --- |
| `OPENAI_API_KEY` | `backend/.env`, `voice/.env` | Keep duplicated only if both backend skills and voice OpenAI realtime dogfood are run as separate processes reading separate env files. |
| `SOPHIA_LANGGRAPH_BASE_URL` | `voice/.env`, `frontend/.env` | Keep duplicated: voice process and frontend server read different files. |
| Provider keys in backend/root config | backend/root examples/config | Document canonical process ownership; do not rely on cross-process dotenv loading except voice's explicit fallback chain. |

### Alias Overlap

| Area | Aliases | Recommended canonical |
| --- | --- | --- |
| Gemini API key | `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_GENAI_API_KEY` | Use `GOOGLE_API_KEY` for voice Gemini Live, keep `GEMINI_API_KEY` for video-generation skill; no code-read evidence for `GOOGLE_GENAI_API_KEY`. |
| Better Auth DB | `BETTER_AUTH_DATABASE_URL`, `DATABASE_URL` | Prefer `BETTER_AUTH_DATABASE_URL` in frontend; keep `DATABASE_URL` for provider/platform/database conventions and config placeholders. |
| Frontend gateway URL | `NEXT_PUBLIC_GATEWAY_URL`, `NEXT_PUBLIC_API_URL`, `BACKEND_API_URL`, `RENDER_BACKEND_URL` | Prefer `NEXT_PUBLIC_GATEWAY_URL` for public gateway calls and `BACKEND_API_URL` for server-side internal override; keep aliases until route migration is complete. |
| LangGraph URL | `SOPHIA_LANGGRAPH_BASE_URL`, `NEXT_PUBLIC_LANGGRAPH_BASE_URL`, `LANGGRAPH_URL`, `SOPHIA_BACKEND_BASE_URL` | Use `SOPHIA_LANGGRAPH_BASE_URL` locally/server-side voice/frontend, `NEXT_PUBLIC_LANGGRAPH_BASE_URL` only for public proxy, `LANGGRAPH_URL` for production gateway channel config. |
| Voice server URL | `VOICE_SERVER_URL`, `SOPHIA_VOICE_SERVER_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_BACKEND_WS_URL` | Use `VOICE_SERVER_URL` unless code is updated to read `SOPHIA_VOICE_SERVER_URL`; verify Render mismatch before cleanup. |
| Auth bridge URL | `SOPHIA_AUTH_BACKEND_URL`, `NEXT_PUBLIC_SOPHIA_AUTH_BACKEND_URL`, `NEXT_PUBLIC_APP_URL`, `BETTER_AUTH_URL` | Prefer `SOPHIA_AUTH_BACKEND_URL` server-side and `BETTER_AUTH_URL` for frontend app origin. |
| Supabase service key | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_KEY`, `SUPABASE_SERVICE_KEY` | Use `SUPABASE_SERVICE_ROLE_KEY`; keep `SUPABASE_KEY` only as code fallback; migrate away from `SUPABASE_SERVICE_KEY`. |
| Voice backend mode | `SOPHIA_BACKEND_MODE`, `SOPHIA_LLM_MODE` | Use `SOPHIA_BACKEND_MODE`; keep alias until local env cleanup. |
| Smart-turn thresholds | `SOPHIA_SMART_TURN_SILENCE_MS`, `SOPHIA_BUFFER_IN_SECONDS`; `SOPHIA_SMART_TURN_SPEECH_THRESHOLD`, `SOPHIA_CONFIDENCE_THRESHOLD` | Use the `SOPHIA_SMART_TURN_*` names; keep legacy aliases during migration. |
| Cartesia voice id | `SOPHIA_VOICE_ID`, `CARTESIA_VOICE_ID`, `CARTESIA_VOICE_ID_EN`, `CARTESIA_VOICE_ID_ES` | Use `SOPHIA_VOICE_ID`. |

## Cleanup Plan Only

### Safe Removals From Local Env Files After Human Approval

Do not execute in this phase. Candidate removals are local env only:

1. Remove deleted worker-bot variables after confirming Render dashboard does not still have them: `TELEGRAM_WORKER_BOT_TOKEN`, `TELEGRAM_WORKER_BOT_USERNAME`.
2. Remove backend-local legacy voice stack variables after confirming no old server uses them: `STT_*`, `TTS_*`, `VAD_*`, `INWORLD_*`, `AUDIO_*`, `BARGE_IN_*`, old `CARTESIA_*` names except active `CARTESIA_API_KEY` where needed by voice.
3. Remove old emotional analytics/memory variables after confirming no sidecars: `SENTICNET_*`, `BABEL_SENTICNET_*`, `PHOENIX_*`, `OPENMEMORY_*`, `FLASH_*`, `EMOTION_*`, `EMOTIONAL_SKILLS_ENABLED`.
4. Remove old backend tuning variables with no code references: `FEATURE_*`, `RATE_LIMIT_*`, `PROFANITY_*`, `TOKEN_BUS_*`, `RESPONSE_LOCK_TIMEOUT`, `MAX_CONCURRENT_SESSIONS`, `VECTOR_STORE_PROVIDER`, `REDIS_*`, `OTEL_*`.

### Variables To Consolidate

| Consolidate to | Replace / review |
| --- | --- |
| `SOPHIA_VOICE_ID` | `CARTESIA_VOICE_ID`, `CARTESIA_VOICE_ID_EN`, `CARTESIA_VOICE_ID_ES` |
| `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_KEY`; leave `SUPABASE_KEY` only if code fallback remains |
| `SOPHIA_BACKEND_MODE` | `SOPHIA_LLM_MODE` |
| `SOPHIA_SMART_TURN_SILENCE_MS` | `SOPHIA_BUFFER_IN_SECONDS` |
| `SOPHIA_SMART_TURN_SPEECH_THRESHOLD` | `SOPHIA_CONFIDENCE_THRESHOLD` |
| `NEXT_PUBLIC_GATEWAY_URL` | Most frontend gateway use of `NEXT_PUBLIC_API_URL` / `RENDER_BACKEND_URL` after route review |
| `BETTER_AUTH_DATABASE_URL` | Frontend auth DB use of `DATABASE_URL`, while preserving platform DB conventions |

### Keep Duplicated Across Files

Keep these duplicated because separate processes read separate env files:

- `OPENAI_API_KEY` in backend/root and voice if both backend skills and OpenAI realtime voice dogfood are used.
- `SOPHIA_LANGGRAPH_BASE_URL` in voice and frontend local envs.
- `STREAM_API_KEY` / `STREAM_API_SECRET` in voice and gateway production envs.
- `ANTHROPIC_API_KEY` / `MEM0_API_KEY` on both Render gateway and LangGraph services.
- `TELEGRAM_BOT_TOKEN` on gateway and frontend/Vercel if Telegram LoginUrl verification runs in frontend.

### Add To Example Files

Recommended example coverage:

- Root `.env.example`: core backend/LangGraph provider keys, Stream, Supabase service role naming, Render webhook URLs, skill-specific Volcengine TTS names.
- `backend/.env.example`: gateway/LangGraph/Sophia backend active vars and aliases, no old voice stack.
- `voice/.env.example`: voice runtime vars, including legacy aliases clearly marked.
- `frontend/.env.local.example`: frontend local/Vercel vars and optional test/debug flags.
- `frontend/.env.example`: keep aligned with `.env.local.example` or replace with pointer to the local example in a follow-up.

### Verify In Vercel Before Production Deploy

| Env var | Why |
| --- | --- |
| `BETTER_AUTH_SECRET` | Required production build/runtime auth. |
| `BETTER_AUTH_URL` | Canonical frontend app origin. |
| `BETTER_AUTH_DATABASE_URL` or `DATABASE_URL` | Required if auth DB is active. |
| `BETTER_AUTH_DATABASE_SSL_MODE`, `BETTER_AUTH_DATABASE_SSL_CA` | Set `verify-full` and the Supabase server root CA PEM for production. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Required if Google OAuth is active. |
| `NEXT_PUBLIC_GATEWAY_URL` | Frontend gateway access. |
| `NEXT_PUBLIC_LANGGRAPH_BASE_URL` | Public LangGraph/proxy path if chat route requires it. |
| `SOPHIA_LANGGRAPH_BASE_URL` | Server-side chat API direct/proxy target if used. |
| `SOPHIA_AUTH_BACKEND_URL` | Auth bridge if gateway validates frontend tokens. |
| `SOPHIA_BACKEND_TOKEN_SECRET` | Backend token bridge if not falling back to Better Auth secret. |
| `TELEGRAM_BOT_TOKEN` | Required for frontend Telegram login route. |
| `NEXT_PUBLIC_APP_URL` | Used by debug/auth fallback paths. |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional monitoring. |

### Local Dev Required Checklist

Minimal local full-stack voice with legacy cascade:

- Backend/LangGraph: `ANTHROPIC_API_KEY`, `MEM0_API_KEY` if memory is enabled, optional `TAVILY_API_KEY`, optional `OPENAI_API_KEY` for builder image deliverables.
- Voice: `STREAM_API_KEY`, `STREAM_API_SECRET`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `SOPHIA_VOICE_ID`, `SOPHIA_BACKEND_MODE=deerflow`, `SOPHIA_LANGGRAPH_BASE_URL`.
- Frontend: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_DATABASE_URL` or `DATABASE_URL` when auth bypass is disabled, `BETTER_AUTH_DATABASE_SSL_MODE=auto` for local PostgreSQL or `verify-full` plus `BETTER_AUTH_DATABASE_SSL_CA` for Supabase, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_GATEWAY_URL`, `SOPHIA_LANGGRAPH_BASE_URL`, `NEXT_PUBLIC_LANGGRAPH_BASE_URL`, `NEXT_PUBLIC_SOPHIA_AUTH_BYPASS`, `NEXT_PUBLIC_SOPHIA_USER_ID`.

### Ask Davide / Human Confirmation

1. Is `SOPHIA_VOICE_SERVER_URL` in `render.yaml` intentional, or should code also read it alongside `VOICE_SERVER_URL`?
2. Should `SUPABASE_SERVICE_KEY` in local backend env be renamed to `SUPABASE_SERVICE_ROLE_KEY`, or is another external process using the old name?
3. Are any old backend `.env` groups still used by an external sidecar not in this repo: SenticNet, Phoenix, OpenMemory, Inworld, old STT/TTS/VAD, Redis/rate-limit/token bus?
4. Should `TELEGRAM_WORKER_BOT_*` be removed from all dashboards/examples now that Render comments say the worker bot channel was deleted?
5. Which Gemini key should be preferred operationally for voice: `GOOGLE_API_KEY` or `GEMINI_API_KEY`? Code supports both; skills still read `GEMINI_API_KEY`.
6. Should frontend production keep `RENDER_BACKEND_URL`, or consolidate to `NEXT_PUBLIC_GATEWAY_URL`/`BACKEND_API_URL`?

## Do Not Remove Yet

- Any provider SDK standard env var even if only config/examples mention it: `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `JINA_API_KEY`, `LANGCHAIN_*`, `LANGSMITH_*`.
- Any variable consumed dynamically through `config.yaml` / `config.production.yaml` `$VAR` placeholders.
- `DATABASE_URL`, because it is both a Better Auth fallback and a common platform DB convention.
- `SOPHIA_BACKEND_BASE_URL`, `SOPHIA_LLM_MODE`, `SOPHIA_BUFFER_IN_SECONDS`, `SOPHIA_CONFIDENCE_THRESHOLD` until real env files are migrated.
- `NEXT_PUBLIC_API_URL`, `BACKEND_API_URL`, `RENDER_BACKEND_URL` until frontend route ownership is consolidated.
- `SUPABASE_KEY` until the code fallback is removed.
- `VOICE_SERVER_URL` / `SOPHIA_VOICE_SERVER_URL` until the production naming mismatch is resolved.

## Proceed / No-Go

Safe to proceed to actual cleanup only after:

1. Davide/human confirms the old backend `.env` groups are not used outside this repo.
2. Render and Vercel dashboards are checked for the production checklist above.
3. The `SOPHIA_VOICE_SERVER_URL` versus `VOICE_SERVER_URL` mismatch is resolved or documented as intentional.
4. A cleanup PR updates examples first, then real local env files manually outside git, with no secret values committed.
