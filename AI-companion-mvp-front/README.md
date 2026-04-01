# Sophia Frontend - Next.js Web App

Modern web interface for Sophia AI Companion with voice and text chat.

## Features

- ✅ Voice Chat (WebSocket with real-time audio)
- ✅ Text Chat (REST API with AI SDK streaming)
- ✅ Session Management (Start/End/Resume via Sessions API)
- ✅ Memory Highlights (personalized greetings)
- ✅ Recap Screen (takeaway, reflection, memory approval)
- ✅ Emotion Detection & Interrupts
- ✅ Debrief Flow with nudge timer
- ✅ Conversation History
- ✅ Beautiful UI with Tailwind CSS
- ✅ TypeScript for type safety
- ✅ Responsive Design (mobile-friendly)
- ✅ Capacitor ready (iOS/Android builds)

## Mode Decision Rule

- Use `/session` for ritual flows (artifacts, recap, structured session lifecycle).
- Use `/chat` for ritual-less free-form chat.
- Keep ownership boundaries explicit: ritual features should not be implemented on `/chat`, and ritual-less UX changes should not couple to `/session` orchestration.

## Security Notes

- Frontend BFF security guardrails are documented in [docs/SECURITY_NOTES.md](docs/SECURITY_NOTES.md).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env.local

# 3. Edit .env.local with your values:
#    - NEXT_PUBLIC_API_URL (backend URL)
#    - NEXT_PUBLIC_SUPABASE_URL (auth)
#    - NEXT_PUBLIC_SUPABASE_ANON_KEY (auth)

# 4. Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend FastAPI URL | `http://localhost:8000` |
| `NEXT_PUBLIC_WS_URL` | WebSocket URL | `ws://localhost:8000` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | `eyJ...` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `RENDER_BACKEND_URL` | Server-side backend URL | (same as API_URL) |
| `USE_MOCK_BOOTSTRAP` | Force mock data (offline dev) | `false` |
| `NEXT_PUBLIC_DEBUG` | Enable verbose logging | `false` |
| `CAPACITOR_BUILD` | Building for mobile | `false` |

## Backend Connection

The frontend connects to these backend endpoints:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/sessions/start` | Start/resume session |
| `POST /api/v1/sessions/end` | End session, get recap |
| `GET /api/v1/sessions/active` | Check active session |
| `POST /api/v1/sessions/micro-briefing` | Nudge/interrupt text |
| `POST /api/v1/chat/text` | Main chat streaming |
| `POST /api/v1/memory/commit-candidates` | Save approved memories |

**Important:** Set `NEXT_PUBLIC_API_URL` to your backend. Without it, some features use mock fallbacks.

## Project Structure

```
src/app/
├── api/              # Next.js API routes (proxies to backend)
├── components/       # React components
│   ├── session/      # Chat UI components
│   ├── recap/        # Recap screen components
│   └── ui/           # Shared UI components
├── hooks/            # Custom React hooks
├── lib/              # Utilities and API clients
│   └── api/          # Backend API functions
├── stores/           # Zustand state stores
├── types/            # TypeScript types
├── session/          # /session page (chat)
├── recap/            # /recap/[sessionId] page
└── page.tsx          # Home page
```

## Scripts

```bash
npm run dev           # Development server
npm run build         # Production build
npm run start         # Start production server
npm run type-check    # TypeScript validation
npm run lint          # ESLint

# Mobile (Capacitor)
npm run cap:sync      # Sync web assets to native
npm run cap:android   # Open Android Studio
npm run cap:ios       # Open Xcode
```

## Production Build

```bash
npm run build
npm start
```

## Docker

```bash
docker build -t sophia-frontend .
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_API_URL=https://your-backend.com \
  -e NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... \
  sophia-frontend
```

## Mobile Builds (Capacitor)

See [docs/CAPACITOR_SETUP.md](docs/CAPACITOR_SETUP.md) for iOS/Android setup.

```bash
# Build and sync
CAPACITOR_BUILD=true npm run build
npm run cap:sync

# Open native IDE
npm run cap:android  # or cap:ios
```

