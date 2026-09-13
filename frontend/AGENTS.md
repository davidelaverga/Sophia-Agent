# Agents Architecture

## Overview

DeerFlow is built on a sophisticated agent-based architecture using the [LangGraph SDK](https://github.com/langchain-ai/langgraph) to enable intelligent, stateful AI interactions. This document outlines the agent system architecture, patterns, and best practices for working with agents in the frontend application.

## Architecture Overview

### Core Components

```
┌────────────────────────────────────────────────────────┐
│                    Frontend (Next.js)                  │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────┐  │
│  │ UI Components│───▶│ Thread Hooks │───▶│ LangGraph│  │
│  │              │    │              │    │   SDK    │  │
│  └──────────────┘    └──────────────┘    └──────────┘  │
│         │                    │                  │      │
│         │                    ▼                  │      │
│         │            ┌──────────────┐           │      │
│         └───────────▶│ Thread State │◀──────────┘      │
│                      │  Management  │                  │
│                      └──────────────┘                  │
└────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────┐
│              LangGraph Backend (lead_agent)            │
│  ┌────────────┐  ┌──────────┐  ┌───────────────────┐   │
│  │Main Agent  │─▶│Sub-Agents│─▶│  Tools & Skills   │   │
│  └────────────┘  └──────────┘  └───────────────────┘   │
└────────────────────────────────────────────────────────┘
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

### Technology Stack

- **LangGraph SDK** (`@langchain/langgraph-sdk@1.5.3`) - Agent orchestration and streaming
- **LangChain Core** (`@langchain/core@1.1.15`) - Fundamental AI building blocks
- **TanStack Query** (`@tanstack/react-query@5.90.17`) - Server state management
- **React Hooks** - Thread lifecycle and state management
- **Shadcn UI** - UI components
- **MagicUI** - Magic UI components
- **React Bits** - React bits components

### Interaction Ownership

- `useVoiceLabControlAdapter` retains only unexpired server authorization across
  readiness pauses. An expired resolved request is not reusable authority; the
  next eligible mount must obtain a fresh server decision before claiming or
  publishing an authorized action. Valid in-flight remount sharing and exact-once
  control-epoch claims remain document-scoped.
  Already-invoked asynchronous callbacks may publish completion/failure only
  while their mounted action owner is current. Unmount or action replacement
  revokes that publication authority; ordinary readiness changes do not cancel
  the callback or erase its legitimate result. This is an evidence fence, not
  independent resource cancellation or a new activation path.

- `useStreamVoiceSession` fences startup publication by its existing request
  generation. A superseded bootstrap may close only its own returned connection;
  it cannot overwrite the replacement controller's telemetry. Gemini setup
  readiness is current state: reconnect/closing/loss invalidates it, and only a
  current-owner setup transition may restore it. Historical ready events are not
  current readiness proof. All transport callbacks use that same owner predicate
  before interpreting payloads or publishing telemetry, capture or tool ledgers;
  replacement, terminal loss and unmount invalidate publication authority.

- Recap display cache is not source authority. `useRecapArtifactsLoader` revalidates the authenticated recap source on every entry/retry before rendering actionable data; HTTP/provider uncertainty cannot reuse persisted candidates. A source404 invalidates only that session's artifacts, decisions and commit status. Recent-End hints may schedule bounded empty retries but cannot restore a missing source. Async responses from an obsolete load must not publish state.

- Recap debug export reads `/api/memory/observability` on demand. The proxy binds the ordinary authenticated owner; Gateway additionally restricts it to the memory-certification principal. `memory-observability.ts` validates and strips unknown fields before portable export. Unavailable metrics never block product memory actions or masquerade as a clean certification.

- `src/app/workspace/chats/[thread_id]/page.tsx` owns composer busy-state wiring.
- `src/core/threads/hooks.ts` owns pre-submit upload state and thread submission.
- `src/hooks/usePoseStream.ts` is a passive store selector; global WebSocket lifecycle stays in `App.tsx`.
- `src/app/session/useSessionExitFlow.ts` owns truthful End outcomes: an HTTP or
  network failure retains the session for retry and cannot write ended history,
  enter recap emergence, or tear down the session as if finalization succeeded.
  Its retry dialog carries `end_unconfirmed`, distinct from a responding guard,
  and explicitly offers Retry End rather than falsely claiming active generation.

## Resources

- [LangGraph Documentation](https://langchain-ai.github.io/langgraph/)
- [LangChain Core Concepts](https://js.langchain.com/docs/concepts)
- [TanStack Query Documentation](https://tanstack.com/query/latest)
- [Next.js App Router](https://nextjs.org/docs/app)

## Contributing

When adding new agent features:

1. Follow the established project structure
2. Add comprehensive TypeScript types
3. Implement proper error handling
4. Write tests for new functionality
5. Update this documentation
6. Follow the code style guide (ESLint + Prettier)

## License

This agent architecture is part of the DeerFlow project.
