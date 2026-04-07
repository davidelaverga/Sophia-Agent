---
title: "refactor: Consolidate dual frontends into single frontend/"
type: refactor
status: active
date: 2026-04-04
origin: docs/brainstorms/2026-04-04-frontend-consolidation-requirements.md
deepened: 2026-04-05
---

# Consolidate Dual Frontends into Single `frontend/`

## Overview

Replace the DeerFlow agent IDE frontend in `frontend/` with the Sophia companion app currently in `AI-companion-mvp-front/`. Upgrade to Next.js 16 + React 19, Tailwind 4, pnpm, and Better Auth. Delete `AI-companion-mvp-front/` after migration. The result is a single `frontend/` directory matching the upstream repo structure, wired to all existing infrastructure (Makefile, Docker, CI, nginx).

## Problem Frame

Two isolated frontends exist: `frontend/` (DeerFlow agent IDE, unused by Sophia, wired to all infra) and `AI-companion-mvp-front/` (the actual Sophia product, not wired to any infra). Developers run them separately, PowerShell scripts use npm while infra expects pnpm, and a surface boundary guardrail exists solely to enforce separation. The upstream repo has one `frontend/`. (see origin: [docs/brainstorms/2026-04-04-frontend-consolidation-requirements.md](docs/brainstorms/2026-04-04-frontend-consolidation-requirements.md))

## Requirements Trace

- R1–R5: Code migration (src/, middleware, config, tests, public/)
- R6–R8: Framework upgrade (Next.js 16, React 19, Tailwind 4)
- R9–R11: Package manager (pnpm, dependency merge, package.json identity)
- R12–R16: Auth migration (Supabase → Better Auth)
- R17–R20: Capacitor support preservation
- R21–R24: Configuration merge (next.config.js, tsconfig, ESLint, env)
- R25–R29: Infrastructure wiring (Makefile, Docker, serve.sh, PowerShell scripts)
- R30–R32: Guardrail removal
- R33–R34: CI/CD updates
- R35–R37: Cleanup (delete old dir, update docs)

## Scope Boundaries

- Backend (`backend/`, `gateway/`, `langgraph.json`) is not touched
- `voice/` server is not touched
- `skills/`, `users/`, `docs/specs/` are not touched
- Root-level orphan docs (`01_architecture_overview (new).md`, etc.) are NOT reorganized
- `strict: true` TypeScript is deferred to a separate pass (Sophia was written with `strict: false`)
- No new features — same app, new location, upgraded toolchain

## Context & Research

### Relevant Code and Patterns

**DeerFlow frontend infrastructure (preserving):**
- `frontend/Dockerfile` — multi-stage build (dev/prod), Node 22 Alpine, pnpm 10.26.2
- `frontend/eslint.config.js` — ESLint 9 flat config with typescript-eslint
- `frontend/src/env.js` — `@t3-oss/env-nextjs` schema with `BETTER_AUTH_SECRET`
- `frontend/src/server/better-auth/` — config.ts, client.ts, server.ts (scaffolding only, no DB)
- `frontend/src/app/api/auth/[...all]/route.ts` — catch-all auth route

**DeerFlow Tailwind 4 reference:**
- `frontend/src/styles/globals.css` — `@import "tailwindcss"`, `@theme` block, `@custom-variant dark`, `tw-animate-css`
- `frontend/postcss.config.js` — `@tailwindcss/postcss`

**Sophia frontend (migrating):**
- 160 `.tsx` files, 60+ components, 198 `"use client"` directives
- 41 `@keyframes` in globals.css, 31 animation bindings in tailwind.config.ts
- 23 Zustand stores
- 7 files importing `@supabase/*` (providers.tsx, AuthGate.tsx, oauth-callback.ts, backend-auth.ts, server-auth.ts, auth-token-store.ts, api/client.ts)
- 4 files using `@stream-io/video-react-sdk`
- Capacitor config targeting `com.sophia.companion`

### React 19 Migration Scope (LOW RISK)
- **1 file** needs `forwardRef` removal: `PresenceField.tsx`
- 0 `React.FC`, 0 string refs, 0 `propTypes`, 0 `defaultProps`
- 2 class components (ErrorBoundary — allowed in React 19)
- Zustand 4.4.7 is React 19 compatible
- `@stream-io/video-react-sdk` and `@ai-sdk/react` need version verification

### Tailwind 4 Migration Scope (MODERATE)
- PostCSS plugin swap: `tailwindcss` → `@tailwindcss/postcss`
- Config: `tailwind.config.ts` → CSS-first `@theme` block
- 0 `@apply` usages, 0 `theme()` calls, 0 deprecated opacity modifiers
- ~20 `border` classes without explicit width may need `border-1`
- Duplicate keyframes between globals.css and tailwind.config.ts need consolidation
- DeerFlow's TW4 globals.css provides a working reference

### Better Auth Migration Scope (HIGHEST RISK)
- DeerFlow has Better Auth **scaffolding only**: no database, no OAuth, no frontend integration
- Sophia has a two-token system: Supabase session + backend API token (httpOnly cookie)
- 7 files with Supabase imports need rewriting
- AuthGate component, OAuth callback, token store, API client all need replacement
- Backend expects `sophia-backend-token` cookie — this contract must be preserved
- Better Auth needs: database connection, Discord OAuth config, session strategy

## Key Technical Decisions

- **Phased migration**: Each phase produces a buildable, testable app. This avoids the "which change broke it?" problem with 5 simultaneous breaking changes. Phases can be collapsed into fewer commits after all pass.
- **Sophia code as base**: DeerFlow src/ is fully replaced. DeerFlow's infra files (Dockerfile, eslint, env.js, Better Auth scaffolding) are preserved/adapted.
- **Backend token contract preserved**: Better Auth handles frontend sessions, but the backend API token flow (`sophia-backend-token` httpOnly cookie) is kept. Better Auth replaces Supabase as the OAuth provider, then the callback still registers with the backend to get the API token.
- **Tailwind 4 via CSS-first config**: No `tailwind.config.ts`. All theme values, keyframes, and animations defined in `globals.css` using `@theme` blocks (following DeerFlow's pattern).

## Open Questions

### Resolved During Planning

- **Database for Better Auth**: Use SQLite for local dev (file-based, zero config). Better Auth supports SQLite natively via `better-sqlite3` adapter. Production can use the same Supabase PostgreSQL instance through `drizzle-adapter` or `prisma-adapter`.
- **React 19 risk**: Extremely low — only 1 forwardRef to remove. All components already use "use client", hooks patterns are compatible.
- **Tailwind 4 risk**: Moderate but mechanical — 0 @apply usage, DeerFlow's globals.css serves as reference. Main work is config porting and ~20 border class fixes.

### Deferred to Implementation

- Exact `@stream-io/video-react-sdk` React 19 compatibility — test during Phase 3. If incompatible, pin to React 18 types via `@types/react@18`.
- Exact `@ai-sdk/react` React 19 compatibility — test during Phase 3.
- Whether Sophia's dark theme system (`data-sophia-theme` attribute + CSS variables) needs adaptation for DeerFlow's `@custom-variant dark` pattern.
- Exact Better Auth database schema migration for production deployment.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Phase 1: STRUCTURAL MOVE          Phase 2: PNPM               Phase 3: NEXT 16 + REACT 19
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ Copy AI-MVP src/     │     │ Delete package-lock   │     │ Bump next, react,    │
│ into frontend/src/   │────▶│ Add pnpm-lock.yaml   │────▶│ react-dom, types     │
│ Keep Next 14/React 18│     │ Update packageManager │     │ Fix 1 forwardRef     │
│ Keep npm temporarily │     │ pnpm install          │     │ Verify Stream.io     │
│ Verify: app builds   │     │ Verify: app builds    │     │ Verify: app builds   │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
                                                                    │
Phase 6: CLEANUP               Phase 5: BETTER AUTH          Phase 4: TAILWIND 4
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ Delete AI-MVP dir    │     │ Add better-sqlite3   │     │ Swap postcss plugin  │
│ Remove guardrails    │◀────│ Configure Discord    │◀────│ Port config to @theme│
│ Update scripts/docs  │     │ OAuth in Better Auth │     │ Update globals.css   │
│ Update CI workflows  │     │ Replace 7 Supabase   │     │ Fix border classes   │
│ Final verification   │     │ files with BA hooks  │     │ Consolidate keyframes│
└──────────────────────┘     │ Verify: auth works   │     │ Verify: app builds   │
                             └──────────────────────┘     └──────────────────────┘
```

## Implementation Units

### Phase 1: Structural Code Migration + Package Manager

- [ ] **Unit 1: Replace frontend/src/ with Sophia source code and switch to pnpm**

**Goal:** Move all Sophia application code into the `frontend/` directory structure, merge dependencies, and establish pnpm as the package manager — all in one atomic step.

**Requirements:** R1, R2, R3, R4, R5, R9, R10, R11, R17, R20

**Dependencies:** None

**Files:**
- Delete: `frontend/src/` (entire directory — DeerFlow source)
- Copy: `AI-companion-mvp-front/src/` → `frontend/src/`
- Copy: `AI-companion-mvp-front/middleware.ts` → `frontend/middleware.ts`
- Copy: `AI-companion-mvp-front/tailwind.config.ts` → `frontend/tailwind.config.ts`
- Copy: `AI-companion-mvp-front/vitest.config.ts` → `frontend/vitest.config.ts`
- Copy: `AI-companion-mvp-front/playwright.config.ts` → `frontend/playwright.config.ts`
- Copy: `AI-companion-mvp-front/tests/` → `frontend/tests/`
- Replace: `frontend/public/` with `AI-companion-mvp-front/public/`
- Copy: `AI-companion-mvp-front/capacitor.config.ts` → `frontend/capacitor.config.ts`
- Modify: `frontend/package.json` — merge all Sophia dependencies, set `name: "sophia-frontend"`, set `"packageManager": "pnpm@10.26.2"`
- Delete: `frontend/package-lock.json` (if any)
- Create: `frontend/pnpm-lock.yaml` (via `pnpm import` from AI-companion-mvp-front/package-lock.json then `pnpm install`)
- Verify: `frontend/.gitignore` includes `ios/` and `android/` (R20 — already gitignored, just confirm)
- Test: `frontend/tests/` (existing Vitest tests)

**Approach:**
- Delete DeerFlow's `frontend/src/` first, then copy Sophia's `src/` in
- Merge `package.json`: take ALL Sophia dependencies at their current versions (Next 14, React 18, TW3) plus DeerFlow's devDeps for tooling. Remove DeerFlow-only deps: `@codemirror/*`, `@xyflow/react`, `@langchain/*`, `@radix-ui/*`, `shiki`, `rehype-*`, `remark-*`, `katex`, `gsap`, `ogl`, `canvas-confetti`, `cmdk`, `codemirror`, `streamdown`, `tokenlens`, `use-stick-to-bottom`, `nuxt-og-image`, `embla-carousel-react`, `react-resizable-panels`, `best-effort-json-parser`
- Keep Capacitor deps: `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`, `@capacitor/haptics`, `@capacitor/splash-screen`, `@capacitor/status-bar` (R18)
- **Use pnpm from the start** — never npm. Copy `AI-companion-mvp-front/package-lock.json` into `frontend/`, run `pnpm import` to convert it to `pnpm-lock.yaml`, delete the npm lockfile, then run `pnpm install`. This avoids phantom dependency issues that would surface later.
- Keep `postcss.config.js` pointing to `tailwindcss` (TW3) for now
- Replace DeerFlow's `next.config.js` with Sophia's version (Capacitor support, existing security headers to be added later)

**Local dev note:** `make dev` will work after this unit completes — Makefile already uses `cd frontend && pnpm run dev`.

**Patterns to follow:**
- Directory structure from `AI-companion-mvp-front/src/app/` preserved as-is
- DeerFlow's existing `package.json` `packageManager` field pattern

**Test scenarios:**
- Happy path: `pnpm run dev` starts without errors, app renders at localhost:3000
- Happy path: `pnpm run build` completes successfully
- Happy path: All existing Vitest tests pass
- Edge case: Import paths resolve correctly (no leftover DeerFlow path references)
- Edge case: No phantom dependency errors (all imports resolve to declared deps)

**Verification:**
- `pnpm run dev` starts the Sophia frontend
- `pnpm run build` succeeds
- Vitest tests pass
- `make dev` starts all services including frontend

---

### Phase 2: Next.js 16 + React 19 Upgrade

- [ ] **Unit 2: Upgrade Next.js and React**

**Goal:** Upgrade from Next.js 14 + React 18 to Next.js 16 + React 19.

**Requirements:** R6, R7

**Dependencies:** Unit 1 complete

**Files:**
- Modify: `frontend/package.json` — bump `next`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, `eslint-config-next`, `typescript`
- Modify: `frontend/src/app/components/presence-field/PresenceField.tsx` — remove `forwardRef`, destructure `ref` as prop
- Modify: `frontend/next.config.js` — adapt to Next.js 16 config format if needed
- Test: `frontend/tests/`

**Approach:**
- Bump versions: `next@^16.1.7`, `react@^19.0.0`, `react-dom@^19.0.0`, `@types/react@^19.0.0`, `@types/react-dom@^19.0.0`, `typescript@^5.8.2`
- Also bump: `eslint@^9.23.0`, `eslint-config-next@^15.2.3` (for Next 16 compat)
- Fix `PresenceField.tsx`: remove `forwardRef` wrapper, accept `ref` as a regular prop
- Run typecheck to find any React 19 type errors
- Test `@stream-io/video-react-sdk` — if React 19 peer dep fails, use `pnpm install --legacy-peer-deps` or check for SDK update
- Test `@ai-sdk/react` — same approach

**Patterns to follow:**
- React 19 ref-as-prop pattern (no `forwardRef` needed)

**Test scenarios:**
- Happy path: `pnpm run build` completes with React 19
- Happy path: `pnpm typecheck` passes
- Happy path: PresenceField renders correctly with ref passed as prop
- Edge case: Stream.io SDK works with React 19 (test live voice UI)
- Edge case: Zustand stores hydrate correctly (23 stores)
- Error path: If Stream.io SDK has React 19 peer dep conflict, `--legacy-peer-deps` resolves it

**Verification:**
- `pnpm typecheck` passes
- `pnpm run build` succeeds
- `pnpm run dev` — app renders, navigate through all major routes
- Vitest tests pass

---

### Phase 3: Tailwind 4 Migration

- [ ] **Unit 3: Migrate Tailwind CSS 3 → 4**

**Goal:** Upgrade to Tailwind 4 with CSS-first configuration, matching DeerFlow's TW4 pattern.

**Requirements:** R8, R3 (tailwind config adaptation)

**Dependencies:** Unit 2 complete

**Files:**
- Modify: `frontend/package.json` — bump `tailwindcss@^4.0.15`, add `@tailwindcss/postcss@^4.0.15`, remove `autoprefixer` (built into TW4)
- Delete: `frontend/tailwind.config.ts` (replaced by CSS-first config)
- Modify: `frontend/postcss.config.js` — replace `tailwindcss` + `autoprefixer` with `@tailwindcss/postcss`
- Modify: `frontend/src/app/globals.css` — rewrite to TW4 format
- Modify: Any `.tsx` files with `border` classes missing explicit width (~20 files)
- Test: `frontend/tests/`

**Approach:**
- Replace `postcss.config.js` content with `{ plugins: { "@tailwindcss/postcss": {} } }`
- Run `npx @tailwindcss/upgrade` (official Tailwind 3→4 codemod) to auto-migrate most config entries to CSS `@theme`. Manually verify and fix any entries the codemod misses.
- Rewrite `globals.css`:
  - Replace `@tailwind base/components/utilities` with `@import "tailwindcss"`
  - Convert theme extensions (colors, fonts, spacing, shadows, border-radius) to `@theme` block
  - Convert 41 keyframes + 31 animations into the `@theme` block (consolidate duplicates between globals.css and old tailwind.config.ts)
  - Add `@custom-variant dark (&:where([data-sophia-theme="moonlit-embrace"] *))` for Sophia's dark theme system
  - Preserve all 100+ CSS custom properties (light theme, 5 dark themes, atmosphere variants)
- Batch-fix `border` classes: add `border-1` where bare `border` appears without explicit width
- Use DeerFlow's `frontend/src/styles/globals.css` as structural reference

**Patterns to follow:**
- DeerFlow's TW4 globals.css structure (`@import`, `@theme`, `@custom-variant`)

**Test scenarios:**
- Happy path: `pnpm run build` succeeds with Tailwind 4
- Happy path: Light theme renders correctly (all sophia-* colors visible)
- Happy path: Dark theme (moonlit-embrace) renders correctly
- Happy path: All 31 animations play correctly (visual verification)
- Edge case: Border classes render with visible borders (not 0-width)
- Edge case: Safelist classes compile correctly
- Integration: Theme switching between light/moonlit-embrace works

**Verification:**
- `pnpm run build` succeeds
- `pnpm run dev` — visual inspection of all major pages in both themes
- No missing borders, colors, or animations compared to pre-migration

---

### Phase 4: Better Auth Migration

- [ ] **Unit 4: Configure Better Auth with database and Discord OAuth**

**Goal:** Set up Better Auth server-side configuration with SQLite database and Discord OAuth provider.

**Requirements:** R12, R13, R16

**Dependencies:** Unit 3 complete

**Files:**
- Modify: `frontend/src/server/better-auth/config.ts` — add SQLite database, Discord OAuth, session config
- Create: `frontend/src/server/better-auth/schema.ts` — database schema if using Drizzle
- Modify: `frontend/src/env.js` — add Discord OAuth env vars, remove Supabase env vars
- Create: `frontend/.env.example` — document all required env vars
- Modify: `frontend/package.json` — add `better-sqlite3` (dev), remove `@supabase/*` packages

**Approach:**
- Configure Better Auth with `better-sqlite3` adapter for local dev
- Add Discord OAuth: `clientId`, `clientSecret` from env vars
- Configure session strategy (cookie-based, matching Sophia's httpOnly pattern)
- Update `src/env.js` schema: add `BETTER_AUTH_DISCORD_CLIENT_ID`, `BETTER_AUTH_DISCORD_CLIENT_SECRET`, remove `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- The auth API route already exists at `frontend/src/app/api/auth/[...all]/route.ts`

**Patterns to follow:**
- Existing Better Auth scaffolding in `frontend/src/server/better-auth/`

**Test scenarios:**
- Happy path: Better Auth initializes without errors when env vars are set
- Happy path: Auth API responds at `/api/auth/` (health check)
- Error path: Missing env vars produce clear error messages at startup
- Edge case: SQLite database file created automatically on first run

**Verification:**
- Server starts without auth initialization errors
- `GET /api/auth/ok` returns expected response

---

- [ ] **Unit 5: Replace Supabase auth in frontend components**

**Goal:** Replace all Supabase auth usage with Better Auth hooks and components.

**Requirements:** R14, R15

**Dependencies:** Unit 4 complete

**Files:**
- Rewrite: `frontend/src/app/providers.tsx` — replace `SessionContextProvider` with Better Auth provider
- Rewrite: `frontend/src/app/components/AuthGate.tsx` — use Better Auth `useSession()` hook
- Rewrite: `frontend/src/app/auth/callback/route.ts` — Better Auth handles OAuth callback natively via `[...all]` route
- Delete: `frontend/src/app/lib/auth/oauth-callback.ts` (Supabase-specific)
- Rewrite: `frontend/src/app/lib/auth/backend-auth.ts` — adapt backend token registration to use Better Auth session
- Rewrite: `frontend/src/app/lib/auth/server-auth.ts` — use Better Auth server-side session
- Rewrite: `frontend/src/app/stores/auth-token-store.ts` — remove Supabase token, keep backend token
- Rewrite: `frontend/src/app/hooks/useBackendAuth.ts` — replace Supabase session checks with Better Auth
- Rewrite: `frontend/src/app/hooks/useBackendTokenSync.ts` — sync Better Auth session → backend token (currently syncs Supabase cookie → Zustand)
- Modify: `frontend/src/app/hooks/useConversationHistory.ts` — update token-exists check to read from Better Auth session
- Modify: `frontend/src/app/settings/page.tsx` — update logout to use `authClient.signOut()` before clearing backend token
- Modify: `frontend/src/app/lib/api/client.ts` — replace `supabase.auth.getSession()` with Better Auth session for client-side auth headers
- Modify: `frontend/middleware.ts` — add Better Auth session check for route protection
- Delete: `frontend/src/app/api/auth/me/route.ts` (replaced by Better Auth session)
- Delete: `frontend/src/app/api/auth/set-token/route.ts` (Supabase fallback)
- Delete: `frontend/src/app/api/auth/logout/route.ts` (Better Auth handles)
- Delete: `frontend/src/app/api/auth/[...nextauth]/route.ts` (legacy 410 stub)
- Test: `frontend/tests/`

**Approach:**

The current system has a two-token architecture that must be preserved:
- **Frontend session** (currently Supabase, becoming Better Auth) — authenticates the user to the frontend
- **Backend API token** (`sophia-backend-token` httpOnly cookie) — authenticates frontend→backend API calls, obtained by calling `/api/v1/auth/discord/login` after OAuth

Client-side API calls currently use `supabase.auth.getSession()` to get a Bearer token. Server-side API routes read `sophia-backend-token` from the httpOnly cookie. Both paths must be migrated.

Specific file changes:
- `providers.tsx`: wrap app in Better Auth's `AuthProvider` from client.ts, remove Supabase SessionContextProvider
- `AuthGate.tsx`: use `useSession()` from Better Auth React client. If no session, show Discord login button using `authClient.signIn.social({ provider: "discord" })`. Preserve dev bypass mode.
- OAuth callback: Better Auth's `[...all]` catch-all route handles Discord OAuth callback natively. Use Better Auth's `session.afterCreate` hook (or a custom post-login API route at `/api/auth/post-login`) to: (1) extract Discord metadata from the Better Auth session, (2) call backend `/api/v1/auth/discord/login` with discord_id/email/username, (3) set the returned `api_token` as `sophia-backend-token` httpOnly cookie (30-day expiry, same as current)
- `api/client.ts`: replace `supabase.auth.getSession()` with Better Auth's `authClient.getSession()` for client-side auth headers. Server-side auth (`getServerAuthToken()`) continues to read `sophia-backend-token` from cookie — no change needed there.
- `useBackendAuth.ts` + `useBackendTokenSync.ts`: these hooks manage the Supabase→Zustand token sync. Replace with Better Auth session awareness — the Zustand store still holds the backend token for client-side code, but the source changes from Supabase session to Better Auth session.
- `middleware.ts`: add session check — redirect unauthenticated users to login (except for `/auth/*`, `/api/auth/*`, public routes)

**Patterns to follow:**
- Better Auth React client pattern from `frontend/src/server/better-auth/client.ts`
- Sophia's existing AuthGate UI structure (Discord button, loading states, dev bypass)

**Test scenarios:**
- Happy path: User clicks Discord login → redirected to Discord → callback → session created → app renders
- Happy path: Authenticated user's API requests include `sophia-backend-token`
- Happy path: `authClient.signOut()` clears session and redirects to login
- Edge case: Dev bypass mode (`NEXT_PUBLIC_DEV_BYPASS_AUTH=true`) still works
- Edge case: Token refresh — Better Auth session cookie auto-renews
- Error path: OAuth failure (user denies Discord) → shows error message
- Error path: Backend token registration fails → auth reverted, error shown
- Integration: Protected routes redirect to login when unauthenticated
- Integration: Better Auth session + backend token both valid after full login flow

**Verification:**
- Complete Discord OAuth flow works end-to-end
- All protected routes show AuthGate for unauthenticated users
- API client sends backend token on requests
- Logout clears all auth state

---

### Phase 5: Infrastructure & Cleanup

- [ ] **Unit 6: Update infrastructure scripts and remove guardrails**

**Goal:** Update PowerShell scripts, remove surface boundary guardrails, update CI workflows.

**Requirements:** R27, R30, R31, R32, R33, R34

**Dependencies:** Unit 5 complete

**Files:**
- Modify: `scripts/sophia-dev.ps1` — change `AI-companion-mvp-front` → `frontend`, `npm` → `pnpm`
- Modify: `scripts/start-all.ps1` — same changes
- Delete: `docs/MVP_FRONTEND_SURFACE_BOUNDARY.md`
- Delete: `scripts/check-sophia-surface-boundary.js`
- Move: `AI-companion-mvp-front/.github/workflows/memory-highlights-e2e.yml` → `.github/workflows/memory-highlights-e2e.yml` (update working directory to `frontend/` and `npm` → `pnpm`)
- Modify: `.github/copilot-instructions.md` — update frontend sections to describe Sophia

**Approach:**
- PowerShell scripts: search-replace `AI-companion-mvp-front` → `frontend`, `npm run` → `pnpm run`
- Remove the empty `frontend/src/core/sophia/` directory marker if it still exists (R32)
- E2E workflow: update `working-directory` to `frontend`, change `npm ci` → `pnpm install --frozen-lockfile`, `npm run` → `pnpm run`

**Patterns to follow:**
- Existing `scripts/serve.sh` pattern (already uses `frontend/` + `pnpm`)

**Test scenarios:**
- Happy path: `scripts/sophia-dev.ps1` starts all services including frontend from `frontend/`
- Happy path: `.github/workflows/memory-highlights-e2e.yml` YAML is valid (lint)
- Edge case: No remaining references to `AI-companion-mvp-front` in scripts/

**Verification:**
- `sophia-dev.ps1` starts frontend correctly
- `grep -r "AI-companion-mvp-front" scripts/` returns nothing

---

- [ ] **Unit 7: Merge next.config.js security headers and Capacitor support**

**Goal:** Produce a final `next.config.js` that combines DeerFlow's security headers with Sophia's Capacitor build logic.

**Requirements:** R19, R21

**Dependencies:** Unit 3 complete (can run in parallel with Phase 4)

**Files:**
- Modify: `frontend/next.config.js` — merge security headers from DeerFlow's config into Sophia's config

**Approach:**
- Start from Sophia's `next.config.js` (has Capacitor conditional logic, `optimizePackageImports`)
- Add DeerFlow's security headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- Update CSP `connect-src` to include Sophia's required domains (Cartesia, Mem0, Stream Video, TURN/STUN, Deepgram)
- Keep Sophia's webpack aliases (axios) and webpack ignoreWarnings
- Keep `removeConsole` compiler option for production
- Preserve Capacitor conditional: `output: 'export'` when `CAPACITOR_BUILD=true`

**Patterns to follow:**
- DeerFlow's `frontend/next.config.js` security header format
- Sophia's `AI-companion-mvp-front/next.config.js` Capacitor logic

**Test scenarios:**
- Happy path: `pnpm run build` succeeds with merged config
- Happy path: Security headers present in response (check with `curl -I localhost:3000`)
- Happy path: `CAPACITOR_BUILD=true pnpm run build` produces static export
- Edge case: CSP does not block Cartesia WebSocket, Stream Video, or Supabase/Better Auth domains
- Edge case: Capacitor static export (`output: 'export'`) must not import server-only APIs (`cookies()`, `headers()`) — verify no server component breaks in export mode

**Verification:**
- Build succeeds in both normal and Capacitor modes
- Security headers visible in browser dev tools Network tab

---

- [ ] **Unit 8: Update tsconfig.json and ESLint config**

**Goal:** Modernize TypeScript and ESLint configs to match DeerFlow standards (except `strict: true`).

**Requirements:** R22, R23

**Dependencies:** Unit 2 complete (can run in parallel with Phase 3)

**Files:**
- Modify: `frontend/tsconfig.json` — es2022 target, Bundler module resolution, Capacitor exclusions
- Modify: `frontend/eslint.config.js` — adapt DeerFlow's flat config for Sophia's codebase

**Approach:**
- `tsconfig.json`: set `target: "es2022"`, `module: "ESNext"`, `moduleResolution: "Bundler"`, keep `strict: false`, add `exclude: ["node_modules", "ios", "android", "capacitor-cordova-android-plugins"]`, keep `paths: { "@/*": ["./src/*"] }`
- `eslint.config.js`: use DeerFlow's flat config structure but relax rules as needed for Sophia's patterns. Ignore `src/components/ui/**` and `*.js`.

**Patterns to follow:**
- DeerFlow's `frontend/tsconfig.json` structure
- DeerFlow's `frontend/eslint.config.js` structure

**Test scenarios:**
- Happy path: `pnpm typecheck` passes (may require fixing some type errors from stricter settings)
- Happy path: `pnpm lint` passes (may require some eslint-disable comments or rule relaxations)

**Verification:**
- `pnpm typecheck` clean
- `pnpm lint` clean (or clean with documented suppressions)

---

- [ ] **Unit 9: Update documentation and delete AI-companion-mvp-front/**

**Goal:** Final cleanup — update all docs to reflect single-frontend reality, delete old directory.

**Requirements:** R24, R25, R26, R28, R29, R35, R36, R37

**Dependencies:** All previous units complete

**Files:**
- Update: `frontend/CLAUDE.md` — describe Sophia frontend, not DeerFlow
- Update: `frontend/AGENTS.md` — describe Sophia frontend
- Update: `frontend/README.md` — describe Sophia frontend
- Update: root `CLAUDE.md` — remove `AI-companion-mvp-front/` from repository structure, update frontend references
- Create: `frontend/.env.example` — all required Sophia env vars
- Delete: `AI-companion-mvp-front/` (entire directory)

**Approach:**
- Write `frontend/CLAUDE.md` describing: Sophia companion frontend, Next.js 16 + React 19, Tailwind 4, Better Auth, Capacitor, Zustand stores, key routes
- Write `frontend/.env.example` with: `BETTER_AUTH_SECRET`, `BETTER_AUTH_DISCORD_CLIENT_ID`, `BETTER_AUTH_DISCORD_CLIENT_SECRET`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GATEWAY_URL`, `NEXT_PUBLIC_DEV_BYPASS_AUTH`
- Update root `CLAUDE.md` repository structure to remove AI-companion-mvp-front/ and describe frontend/ as Sophia
- Delete `AI-companion-mvp-front/`
- Run full grep to verify no remaining references to `AI-companion-mvp-front`

**Test scenarios:**
- Happy path: `grep -r "AI-companion-mvp-front" --include="*.md" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.ps1" --include="*.sh" .` returns zero results (excluding git history)
- Happy path: `make dev` starts successfully with single frontend
- Integration: Docker build succeeds — `docker compose -f docker/docker-compose-dev.yaml build frontend`

**Verification:**
- Zero references to `AI-companion-mvp-front` in the codebase
- `make dev` works end-to-end
- Docker build completes
- All success criteria from the requirements document pass

## System-Wide Impact

- **Interaction graph:** Makefile, Docker Compose, serve.sh, sophia-dev.ps1, start-all.ps1 all wire to `frontend/`. After consolidation, these continue to work unchanged (Phases 1-4) or with updated paths (Phase 6).
- **Error propagation:** Build failures in any phase are caught by the verification step before proceeding. Phases are independently revertible.
- **State lifecycle risks:** Better Auth introduces a new SQLite database file (`better-auth.db` or similar). This needs to be gitignored. The `sophia-backend-token` httpOnly cookie (30-day expiry) must be preserved — it is the sole auth mechanism for all frontend→backend API calls including the voice connection proxy.
- **Auth token propagation (critical):** Two distinct token paths exist and must both work after migration:
  - *Client-side path:* `authClient.getSession()` → `Authorization: Bearer {token}` header on API calls (replaces `supabase.auth.getSession()`)
  - *Server-side path:* `cookies().get('sophia-backend-token')` → `Authorization: Bearer {token}` on backend proxy calls (unchanged — reads same cookie, just set by different auth provider)
  - *Voice path:* Next.js API route `/api/sophia/[userId]/voice/connect` reads `sophia-backend-token` cookie server-side and forwards to the Vision Agents server. The voice server itself does no auth — it trusts the Next.js gateway. This path is unaffected as long as the cookie contract is preserved.
  - *Zustand sync:* `useBackendTokenSync` hook mirrors the httpOnly cookie to Zustand (`sophia-backend-auth` localStorage key) for client-side code that needs to check token existence (e.g., `useConversationHistory`, settings logout). This hook must be rewritten to source from Better Auth instead of Supabase.
- **API surface parity:** Backend API endpoints are unchanged. The backend `/api/v1/auth/discord/login` endpoint receives `{discord_id, email, username}` and returns `{api_token, ...user}` — this contract is provider-agnostic and works with any OAuth source.
- **Unchanged invariants:** Backend, voice server, skills, and user data are completely untouched. The frontend-to-backend API contract (all `/api/sophia/*` routes, `/api/v1/auth/discord/login`) is preserved.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `@stream-io/video-react-sdk` incompatible with React 19 | Test in Phase 3. If fails, use `--legacy-peer-deps` or check for updated SDK. Worst case: stay on React 18. |
| Tailwind 4 border-width default breaks layout | Batch-fix ~20 `border` classes in Phase 4. Low risk — explicit widths only. |
| Better Auth Discord OAuth flow differs from Supabase | Supabase handled OAuth redirect + token exchange. Better Auth handles this natively. The critical custom piece is the post-login hook that calls `/api/v1/auth/discord/login` and sets `sophia-backend-token`. |
| Better Auth `afterCallback` hook timing | The backend token must be set before the redirect to `/`. If Better Auth's hook system doesn't support async server-side cookie setting, use a dedicated `/api/auth/post-login` route that the callback redirects through. |
| Backend token cookie not set → all API calls fail silently | Add explicit error handling: if `/api/v1/auth/discord/login` fails during OAuth callback, show an error page instead of redirecting to `/` with no token. Log the failure. |
| Better Auth DB needs production strategy | SQLite for local dev, PostgreSQL for production. Deferred to deployment planning. |
| 5 simultaneous breaking changes | Phased approach — each phase verified independently. Any phase can be reverted without affecting others. |
| Large number of files moved (160+ .tsx) | One bulk copy operation, verified by build + existing tests. No modifications in Phase 1. |
| Better Auth migration fails or is incomplete | **Rollback strategy:** Phases 1-4 do not touch auth. If Phase 5 fails, the app still builds and runs with Supabase auth from `AI-companion-mvp-front/`. Worst case: revert Phase 5-6 commits, keep Supabase, and address Better Auth in a follow-up. The phased structure makes this safe. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-04-frontend-consolidation-requirements.md](docs/brainstorms/2026-04-04-frontend-consolidation-requirements.md)
- DeerFlow frontend infra: `frontend/Dockerfile`, `frontend/eslint.config.js`, `frontend/src/env.js`
- DeerFlow TW4 config: `frontend/src/styles/globals.css`
- DeerFlow Better Auth scaffolding: `frontend/src/server/better-auth/`
- Sophia auth system: `AI-companion-mvp-front/src/app/components/AuthGate.tsx`, `AI-companion-mvp-front/src/app/lib/auth/`
- Sophia Tailwind config: `AI-companion-mvp-front/tailwind.config.ts`, `AI-companion-mvp-front/src/app/globals.css`
