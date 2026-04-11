# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sophia Frontend is a Next.js 16 web application for the Sophia AI voice companion. It provides voice conversations, text chat, session recap, memory review, reflections, and settings — communicating with a LangGraph backend, Vision Agents voice server, and gateway API.

**Stack**: Next.js 16.2, React 19.2, TypeScript 5.9, Tailwind CSS 4.2, Better Auth 1.5, pnpm 10.26.2

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Dev server with Turbopack (http://localhost:3000) |
| `pnpm build` | Production build (requires `BETTER_AUTH_SECRET`) |
| `pnpm lint` | ESLint (flat config, 0 errors expected) |
| `pnpm typecheck` | TypeScript type check (`tsc --noEmit`) |
| `pnpm test` | Vitest unit tests |
| `pnpm start` | Start production server |

## Architecture

```
Frontend (Next.js) ──▶ Gateway API (FastAPI :8001) ──▶ LangGraph Backend (sophia_agent)
                   ──▶ Voice Server (:8000)
```

### Source Layout (`src/`)

- **`app/`** — Next.js App Router.
  - Routes: `/` (dashboard), `/chat` (text companion), `/session` (voice session), `/recap/[sessionId]` (session recap), `/reflections`, `/settings`, `/debug`, `/privacy`, `/history`
  - `api/` — API routes: auth, conversation, consent, privacy, memories, reflections, usage, health
  - `components/` — UI components (dashboard, voice recorder, consent modal, preset selector, error fallback)
  - `hooks/` — React hooks (conversation history, usage monitor, backend token sync, interrupts, connectivity)
  - `lib/` — Utilities (API client, auth helpers, error logger, debug logger)
  - `stores/` — Zustand stores (auth token, session)
  - `companion-runtime/` — Companion runtime manager
  - `copy/` — i18n translations
- **`server/`** — Server-side code:
  - `better-auth/` — Better Auth config, client, server session helpers
- **`__tests__/`** — Vitest unit tests

### Auth Architecture (Two-Token System)

1. **Frontend session** — Better Auth cookie-based session (Google OAuth)
2. **Backend API token** — `sophia-backend-token` httpOnly cookie (30-day expiry), obtained by calling the Sophia backend legacy social-login bridge after OAuth

Client-side auth: `useAuth()` hook from `providers.tsx` returns `{user, loading, signOut}`.
Server-side auth: `auth.api.getSession({ headers: await headers() })` from `@/server/better-auth`.
Backend auth: `getServerAuthToken()` reads `sophia-backend-token` cookie.

### Key Patterns

- **Dev bypass**: `NEXT_PUBLIC_DEV_BYPASS_AUTH=true` skips all auth
- **Path alias**: `@/*` maps to `src/*`
- **Environment validation**: `@t3-oss/env-nextjs` in `src/env.js`. Skip with `SKIP_ENV_VALIDATION=1`
- **ESLint flat config**: `eslint.config.js` with `typescript-eslint`. Run `eslint .` directly (not `next lint`)

## Code Style

- **Imports**: Warn-level ordering (builtin → external → internal → parent → sibling), alphabetized. Use inline type imports: `import { type Foo }`.
- **Unused variables**: Prefix with `_`.
- **Class names**: Use `cn()` from `@/lib/utils` for conditional Tailwind classes.
- **Components**: `components/ui/` and `components/ai-elements/` are registries — don't manually edit.

## Environment

See `.env.example` for all required variables. Key ones:

```
BETTER_AUTH_SECRET=          # Required for build
GOOGLE_CLIENT_ID=            # Google OAuth (optional in dev with bypass)
GOOGLE_CLIENT_SECRET=
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_GATEWAY_URL=http://localhost:8001
NEXT_PUBLIC_DEV_BYPASS_AUTH=true   # Skip auth in development
```

Requires Node.js 22+ and pnpm 10.26.2+.
