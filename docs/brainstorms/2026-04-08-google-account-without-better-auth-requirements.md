---
date: 2026-04-08
topic: google-account-without-better-auth
---

# Google Account Auth Without Better Auth

## Problem Frame

The current Sophia frontend auth stack is built around Better Auth plus Discord OAuth, not around a provider-neutral identity layer.

Today the coupling is visible in multiple places:

- `frontend/src/server/better-auth/config.ts` declares Discord as the only social provider
- `frontend/src/app/components/AuthGate.tsx` renders a Discord-specific login button and calls `authClient.signIn.social({ provider: "discord" })`
- `frontend/src/app/api/auth/sync-backend/route.ts` reads the linked Better Auth account with `providerId === "discord"`
- `frontend/src/app/lib/auth/backend-auth.ts` calls a Discord-named backend endpoint: `/api/v1/auth/discord/login`
- `frontend/src/env.js` and `frontend/.env.example` are modeled around `BETTER_AUTH_*` and `DISCORD_*` variables
- copy and product text across locales refer to Discord as the auth provider

If the product goal is "sign in with Google account" and the platform goal is "move away from Better Auth", then this is not a provider swap. It is a full auth-layer replacement plus a backend-token bridge redesign.

The target state for this brainstorm is:

- Better Auth is no longer part of the runtime auth path
- Google Account is the primary login mechanism
- protected routes and server API handlers still have a first-class session helper
- Sophia still mints and uses the `sophia-backend-token` cookie for backend API calls
- the identity contract stops being Discord-shaped

## Requirements

**Auth Runtime Replacement**

- R1. Better Auth is removed from the frontend runtime path; `frontend/src/server/better-auth/*` is deleted or fully unused
- R2. The replacement auth layer uses Google OAuth and supports both client and server session access in the Next.js App Router
- R3. The replacement must expose the same practical capabilities the app already needs: `useAuth()` on the client, a server session helper for route handlers and server components, and sign-out support
- R4. Existing protected routes and API handlers stop calling `auth.api.getSession(...)` and stop depending on Better Auth-specific APIs like `listUserAccounts(...)`
- R5. The replacement should avoid a frontend-owned SQLite auth database; local auth state should not depend on `sqlite.db` sitting beside the app

**Google Account Login**

- R6. The login CTA becomes Google-first, not Discord-first
- R7. Login failure, callback failure, and cancelled-login states are handled explicitly and surface a coherent user-facing error
- R8. The auth flow supports the current web app shell and does not break the existing dev bypass mode
- R9. The initial implementation targets one provider only: Google. Multi-provider account linking is out of scope for the first pass

**Backend Token Bridge**

- R10. The two-token model remains intact unless deliberately redesigned: frontend session cookie plus backend `sophia-backend-token` cookie
- R11. After Google login succeeds, the frontend must still sync to the Sophia backend and set `sophia-backend-token` as an httpOnly cookie
- R12. The backend sync contract becomes provider-neutral. The frontend should stop sending `discord_id` as its canonical external identity field
- R13. The preferred backend target is a new provider-neutral endpoint such as `/api/v1/auth/oauth/login` or `/api/v1/auth/external/login`, carrying `{ provider, provider_user_id, email, username, avatar_url? }`
- R14. If the backend must remain backward compatible for a transition window, the old Discord-named endpoint may remain as a temporary alias, but new frontend code must not encode Discord semantics into its types or control flow

**Frontend Data Model Cleanup**

- R15. Auth-related frontend types stop using `discord_id` as a core field name
- R16. Stores, session bridges, and backend-auth helpers become provider-neutral, for example `provider`, `providerUserId`, or `externalAccountId`
- R17. Comments, route headers, and docs inside the frontend stop describing the auth flow as `Discord Login -> Consent Gate -> ...`

**UI and Copy Updates**

- R18. `AuthGate` branding, copy, icons, and button colors are updated from Discord to Google
- R19. Locale files in `frontend/src/app/copy/locales/` stop referring to Discord for login-related strings
- R20. Any user-facing references that are truly about community sharing on Discord remain untouched; only auth-related Discord references are changed

**Environment and Config**

- R21. `frontend/.env.example` and `frontend/src/env.js` remove Better Auth and Discord-specific requirements from the auth path
- R22. The replacement env contract is explicit, for example `AUTH_SECRET`, `AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- R23. Production build behavior must remain predictable; auth env validation should fail fast when required Google credentials are missing
- R24. Dev bypass remains available through `NEXT_PUBLIC_DEV_BYPASS_AUTH` and `NEXT_PUBLIC_SOPHIA_USER_ID`

**Migration and Compatibility**

- R25. Existing Better Auth session cookies can be allowed to expire naturally; no cross-library session migration is required
- R26. Existing local Better Auth account/session storage can be discarded unless there is a hard requirement to preserve linked accounts across the cutover
- R27. If backend users are keyed only by Discord identity today, the implementation must define a migration policy for existing users before release
- R28. If preserving existing user continuity matters, the backend must support mapping a Google account to an existing Sophia user record without creating duplicates

**Validation**

- R29. `pnpm lint`, `pnpm typecheck`, and production build all pass from `frontend/`
- R30. Live login works with a real Google OAuth app in local or staging
- R31. Protected API routes still reject unauthenticated requests server-side
- R32. Backend sync succeeds and `sophia-backend-token` is present after successful login
- R33. Dev bypass, sign-out, and route protection continue to work after the auth replacement

## Success Criteria

- A new user can sign in with Google and reach the dashboard without Better Auth in the request path
- A returning user can refresh protected pages and remain authenticated via the replacement session layer
- The frontend can still call Sophia backend routes using the minted `sophia-backend-token`
- No runtime code imports from `better-auth` or `@/server/better-auth`
- No auth-critical code path requires a Discord-linked account
- `frontend/.env.example` no longer tells operators to configure Discord OAuth for sign-in

## Scope Boundaries

- Voice runtime, recap logic, memory review, and Sophia conversation flows are not redesigned here
- The existing dev bypass stays in place
- Community-sharing features that explicitly target Discord are not replaced as part of auth migration unless they break because of removed identity assumptions
- Native Capacitor packaging is not redesigned here, but the chosen auth flow must remain compatible with web-based OAuth redirects used by the app shell

## Key Decisions

- **Use Auth.js for the replacement, not a custom Google-only auth stack.**
Auth.js gives the app the same class of primitives it currently relies on: server session access, client session hooks, route-handler integration, and Google OAuth support, without forcing Sophia to keep Better Auth.

- **Use JWT session strategy for the first pass.**
This avoids introducing a new auth database just to replace Better Auth, which would otherwise swap one library-owned persistence layer for another.

- **Make the backend bridge provider-neutral now, not later.**
If the frontend removes Better Auth but still posts `discord_id` to a Discord-named endpoint, the codebase remains semantically wrong and the next provider migration will hurt again.

- **Ship Google as the only login provider in phase one.**
The goal is simplification. Carrying Discord and Google simultaneously increases account-linking complexity and slows the migration.

## Lower-Scope Alternative

If the real priority is only "support Google login soon" and not "remove Better Auth", then the fastest path is:

- keep Better Auth
- replace the configured social provider from Discord to Google in `frontend/src/server/better-auth/config.ts`
- update `AuthGate`, copy, env vars, and sync-backend account lookup from `discord` to `google`
- keep the rest of the session model intact

That path is much smaller. It does not satisfy the goal of leaving Better Auth behind, but it is the shortest route to a working Google sign-in.

## Dependencies / Assumptions

- A Google Cloud OAuth client will be created with correct redirect URIs for local and production environments
- The app is allowed to treat Google as the source of truth for identity going forward
- The current backend token issuer can either be updated or wrapped with a provider-neutral alias
- There is no requirement to preserve Better Auth's linked-account model or local auth database contents

## Outstanding Questions

- [Affects R11-R14][Critical] Where is the actual implementation of `/api/v1/auth/discord/login` in this fork? The frontend references it, but it is not obvious from the current `backend/` tree scan. Implementation should confirm the real owner of `sophia-backend-token` issuance before migration.
- [Affects R27-R28][Critical] Are current Sophia users uniquely keyed by `discord_id` in backend storage, or is email already enough to reconcile identities?
- [Affects R6-R8][Product] Is Google sign-in enough, or is Google One Tap also desired?
- [Affects R19-R20][Product] Which Discord mentions are auth-related and should disappear, and which are community-related and should remain?
- [Affects R25-R28][Launch] Is there a requirement to preserve access for existing Discord-authenticated users, or can this be a clean auth reset?

## Next Steps

→ `ce:plan` for a phased implementation plan.
