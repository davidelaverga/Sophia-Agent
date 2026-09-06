# DeerFlow Frontend

Like the original DeerFlow 1.0, we would love to give the community a minimalistic and easy-to-use web interface with a more modern and flexible architecture.

## Tech Stack

Sophia reports session completion only after the backend confirms End. If the
request fails or its outcome is unknown, the session remains available and the
End confirmation stays retryable; a local recap is not presented as proof of
durable completion.

- **Framework**: [Next.js 16](https://nextjs.org/) with [App Router](https://nextjs.org/docs/app)
- **UI**: [React 19](https://react.dev/), [Tailwind CSS 4](https://tailwindcss.com/), [Shadcn UI](https://ui.shadcn.com/), [MagicUI](https://magicui.design/) and [React Bits](https://reactbits.dev/)
- **AI Integration**: [LangGraph SDK](https://www.npmjs.com/package/@langchain/langgraph-sdk) and [Vercel AI Elements](https://vercel.com/ai-sdk/ai-elements)

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 10.26.2+

### Installation

```bash
# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env
# Edit .env with your configuration
```

### Development

```bash
# Start development server
pnpm dev

# The app will be available at http://localhost:3000
```

### Build

```bash
# Type check
pnpm typecheck

# Lint
pnpm lint

# Build for production
pnpm build

# Start production server
pnpm start
```

## Site Map

```
├── /                    # Landing page
├── /chats               # Chat list
├── /chats/new           # New chat page
└── /chats/[thread_id]   # A specific chat page
```

## Configuration

### Environment Variables

Key environment variables (see `.env.example` for full list):

Frontend auth runtime note:
- Better Auth in this app is configured against Postgres via `BETTER_AUTH_DATABASE_URL` or `DATABASE_URL`.
- `frontend/pnpm-lock.yaml` can still contain `better-sqlite3` because Better Auth publishes optional adapters; that lockfile entry alone does not mean SQLite is used at runtime.

```bash
# Frontend auth
BETTER_AUTH_URL="http://localhost:3000"

# Backend and gateway URLs for local development
BACKEND_API_URL="http://localhost:8000"
NEXT_PUBLIC_API_URL="http://localhost:8000"
NEXT_PUBLIC_GATEWAY_URL="http://localhost:8001"

# LangGraph URL for chat streaming
NEXT_PUBLIC_LANGGRAPH_BASE_URL="http://localhost:2026/api/langgraph"

# Dev-only auth bypass
NEXT_PUBLIC_DEV_BYPASS_AUTH=true
NEXT_PUBLIC_SOPHIA_USER_ID=dev-user
```

## Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── api/                # API routes
│   ├── workspace/          # Main workspace pages
│   └── mock/               # Mock/demo pages
├── components/             # React components
│   ├── ui/                 # Reusable UI components
│   ├── workspace/          # Workspace-specific components
│   ├── landing/            # Landing page components
│   └── ai-elements/        # AI-related UI elements
├── core/                   # Core business logic
│   ├── api/                # API client & data fetching
│   ├── artifacts/          # Artifact management
│   ├── config/              # App configuration
│   ├── i18n/               # Internationalization
│   ├── mcp/                # MCP integration
│   ├── messages/           # Message handling
│   ├── models/             # Data models & types
│   ├── settings/           # User settings
│   ├── skills/             # Skills system
│   ├── threads/            # Thread management
│   ├── todos/              # Todo system
│   └── utils/              # Utility functions
├── hooks/                  # Custom React hooks
├── lib/                    # Shared libraries & utilities
├── server/                 # Server-side code (Not available yet)
│   └── better-auth/        # Authentication setup (Not available yet)
└── styles/                 # Global styles
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start development server with Turbopack |
| `pnpm build` | Build for production |
| `pnpm start` | Start production server |
| `pnpm lint` | Run ESLint |
| `pnpm lint:fix` | Fix ESLint issues |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm check` | Run both lint and typecheck |

## Development Notes

- Uses pnpm workspaces (see `packageManager` in package.json)
- Turbopack enabled by default in development for faster builds
- Environment validation can be skipped with `SKIP_ENV_VALIDATION=1` (useful for Docker)
- Backend API URLs are optional; nginx proxy is used by default in development

### Gemini browser voice reliability

The direct Gemini browser provider keeps its reliability controls in
`src/app/lib/gemini-browser-live-websocket-dogfood.ts`:

- Output-transcription deltas are assembled per response segment and relayed as
  cumulative snapshots at a maximum cadence of 4 Hz. User transcripts, tool
  calls, cancellations, errors, interruptions, and final turn boundaries stay
  ordered and non-droppable; a final assembled transcript is queued before its
  boundary.
- Transcript assembly deduplicates only adjacent exact fragments and verified
  suffix/prefix overlap. A word or phrase appearing earlier in the response is
  not sufficient reason to discard a later occurrence.
- A same-response repeated-intent gate scores completed provider-transcribed
  questions before far-ahead audio is played. When it detects a near-duplicate
  second question, it flushes queued playback, suppresses later audio for that
  response, and emits a privacy-safe `repeated_intent_gate` diagnostic.
- Playback is capped at 750 ms ahead by default and retains at most 96 unscheduled
  chunks. Exact audio is suppressed only when a stable provider event ID repeats
  or the same response payload is replayed across provider connection epochs;
  matching audio inside one uninterrupted epoch remains playable.
- Microphone capture explicitly requests echo cancellation, noise suppression,
  and automatic gain control. The connection records the browser's effective
  track settings without device identifiers.
- Session transcript writes are revision-seeded and single-flight. Ending a
  session drains the latest snapshot, sends its accepted revision, and lets the
  backend package recap/resumption context from canonical stored rows rather
  than the potentially stale end-session request body.

Run the focused deterministic contract suite with:

```bash
pnpm test -- src/__tests__/gemini-browser-live-websocket-dogfood.test.ts
```

## Validation Status

Validated locally on 2026-04-09 for the current frontend branch state:

- `pnpm test:e2e:auth` passes.
- `pnpm test:e2e:live` passes when the local LangGraph, gateway, voice server, and frontend stack is running.
- `pnpm lint` passes with warnings only (no errors).
- `pnpm typecheck` passes.
- `BETTER_AUTH_SECRET=local-dev-secret pnpm build` passes.

Current known gap:

- `pnpm test` is not fully green at the moment because several UI-unit suites still reflect older component contracts rather than the current implementation. The active failing areas are:
	- `src/__tests__/components/SessionLayoutChromeFade.test.tsx`
	- `src/__tests__/components/SettingsDrawer.test.tsx`
	- `src/__tests__/components/VoiceFirstComposer.test.tsx`
	- `src/__tests__/hooks/useChromeFade.test.tsx`

For deployment-oriented validation (Render/Vercel), the practical production gate on this branch is:

```bash
pnpm lint
pnpm typecheck
BETTER_AUTH_SECRET=local-dev-secret pnpm build
```

Notes:

- Production builds require `BETTER_AUTH_SECRET` to be set.
- Use a high-entropy secret in real Render/Vercel environments; `local-dev-secret` is sufficient only for local validation.
- The live E2E suite depends on the local Sophia service stack; it is not a standalone frontend-only check.

## License

MIT License. See [LICENSE](../LICENSE) for details.
