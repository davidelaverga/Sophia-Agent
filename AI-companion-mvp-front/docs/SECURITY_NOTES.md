# Security Notes (Frontend BFF)

This document captures production guardrails for frontend API proxy/security behavior.

## Core Rules

- Auth tokens are stored in `httpOnly` cookies and read server-side by Next.js API routes.
- Client code should not rely on raw backend tokens for normal API calls.
- API routes must avoid logging raw request bodies or sensitive token material.

## BFF Auth Pattern

- Server auth helper: `src/app/lib/auth/server-auth.ts`
- Proxy routes attach auth server-side (example): `src/app/api/sessions/[...path]/route.ts`
- Client routes call local `/api/*` endpoints; backend auth is handled in the BFF layer.

## WebSocket Ticket (`/api/ws-ticket`)

- Endpoint: `src/app/api/ws-ticket/route.ts`
- Returns token only for authenticated requests.
- Response is `Cache-Control: no-store`.
- Rate limited via `apiLimiters.wsTicket` in `src/app/lib/rate-limiter.ts`.
- `429` responses include `Retry-After`.
- Client must use ticket immediately and must not persist it.

## Resume Route Preflight (`/api/resume`)

- Endpoint: `src/app/api/resume/route.ts`
- `OPTIONS` no longer returns wildcard CORS.
- `Access-Control-Allow-Origin` is only returned for configured allowlist origins (`NEXT_PUBLIC_SITE_URL` / `CORS_ALLOWED_ORIGIN`).
- Adds `Vary: Origin` when origin is allowed.

## Logging Hygiene

- Avoid request body logging in proxy routes handling user/session payloads.
- Keep debug output non-sensitive and bounded.

## Contract Tests

- `src/__tests__/api/ws-ticket.route.test.ts`
- `src/__tests__/api/resume.route.test.ts`
- `src/__tests__/api/sessions-proxy.route.test.ts`

Update this file whenever security-sensitive route behavior changes.
