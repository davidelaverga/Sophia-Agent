# Sophia Frontend - Complete Architecture Documentation

## 📋 Overview

**Project**: Sophia AI Companion Frontend  
**Framework**: Next.js 14 (App Router)  
**Language**: TypeScript  
**Styling**: Tailwind CSS  
**State Management**: Zustand  
**Authentication**: Supabase Auth  
**Mobile**: Capacitor (iOS/Android)  

**Total Source Files**: 134 TypeScript/React files  
**Total Lines**: ~15,000+ lines of code

## P4 Alignment Snapshot (2026-03-02)

This snapshot supersedes older coarse counts above for active refactor planning.

- `src/app/api`: 42 TS/TSX files
- `src/app/components`: 98 TS/TSX files
- `src/app/copy`: 10 TS/TSX files
- `src/app/hooks`: 42 TS/TSX files
- `src/app/lib`: 56 TS/TSX files
- `src/app/session`: 31 TS/TSX files
- `src/app/stores`: 22 TS/TSX files
- `src/app/types`: 8 TS/TSX files

Primary size hotspots at kickoff:
- `src/app/session/page.tsx` (1312)
- `src/app/hooks/useVoiceLoop.ts` (1036)
- `src/app/stores/chat-store.ts` (753)
- `src/app/api/chat/_lib/stream-transformers.ts` (543)

Reference baseline: `docs/P4_ARCHITECTURE_BASELINE_2026-03-02.md`.

## Runtime Modes and Ownership (2026-03-03)

To avoid regressions while shipping, the frontend supports two product modes with explicit ownership boundaries:

- Ritual session mode: `/session`
   - Source of truth for ritual session state: `src/app/stores/session-store.ts`
   - Streaming runtime: `src/app/session/useSessionChatRuntime.ts` (`useChat` + `/api/chat`)
   - Stream contract normalization: `src/app/session/useSessionStreamContract.ts` + `stream-contract-adapters.ts`

- Ritual-less chat mode: `/chat`
   - Supported free-form chat experience
   - Runtime ownership: `chat-store`-centric orchestration (`src/app/components/ConversationView.tsx`)

- Auth/BFF rule (both modes):
   - Client routes call local Next API routes
   - Server-side routes read `httpOnly` cookie and attach backend auth

Guardrail: keep mode boundaries explicit. New ritual features should be implemented in `/session`; ritual-less chat enhancements should be implemented in `/chat`. Avoid implicit cross-dependencies between the two ownership paths.

Phase 0 convergence references:
- `docs/P0_ROUTE_OWNERSHIP_BASELINE_2026-03-03.md`
- `docs/P0_SESSION_CANONICAL_CONTRACT_2026-03-03.md`
- `docs/CHAT_STREAM_PROTOCOL_GUARDRAILS.md`

### Mode Matrix (Quick Reference)

| Mode | Primary Route | Primary Container | State Owner | Streaming Owner | Intended Scope |
| --- | --- | --- | --- | --- | --- |
| Ritual Session | `/session` | `src/app/session/page.tsx` | `session-store` (`src/app/stores/session-store.ts`) | `useSessionChatRuntime` (`src/app/session/useSessionChatRuntime.ts`) | Ritual flows, artifacts, recap, structured session lifecycle |
| Ritual-less Chat | `/chat` | `src/app/components/ConversationView.tsx` | `chat-store` (`src/app/stores/chat-store.ts`) | `useChat` (AI SDK) runtime bridge (`src/app/chat/useChatAiRuntime.ts` + `/api/chat`) | Free-form chat without ritual/session structure |

### Audit Classification Guardrail (2026-03-03)

`/chat` is a supported product mode for non-ritual sessions and must not be classified as legacy.

Classification rules for future reviews:
- Mark as **supported (non-legacy)**: `src/app/chat/page.tsx`, `src/app/components/ConversationView.tsx`, `src/app/stores/chat-store.ts`, and related `/chat` runtime paths.
- Mark as **legacy** only when code is under legacy namespaces (`src/hooks/*`, `src/lib/*`, `src/types/*`, `src/helpers/*`) or explicitly tagged as archived/deprecated.
- Treat `/session` and `/chat` as parallel owned modes (different scope), not duplicate accidental paths.

Reviewer note: if an audit flags `/chat` as legacy, classify it as a documentation mismatch and correct the report.

---

## 🏗️ Project Structure

```
sophia-frontend/
├── public/                     # Static assets
│   ├── favicon.ico
│   ├── icon.png, icon-192.png, icon-512.png
│   ├── apple-icon.png
│   └── manifest.json          # PWA manifest
│
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── api/              # API routes (15 routes)
│   │   ├── components/       # React components (60+ components)
│   │   ├── copy/             # Internationalization system
│   │   ├── hooks/            # Custom React hooks (15+ hooks)
│   │   ├── lib/              # Utility libraries (20+ utilities)
│   │   ├── stores/           # Zustand state stores (9 stores)
│   │   ├── types/            # TypeScript type definitions
│   │   ├── layout.tsx        # Root layout
│   │   ├── page.tsx          # Home page
│   │   ├── providers.tsx     # Context providers
│   │   └── globals.css       # Global styles & theme variables
│   │
│   ├── helpers/              # Legacy helper utilities
│   ├── hooks/                # Legacy hooks (useVoiceChat, useTextChat)
│   ├── lib/                  # Legacy library utilities
│   └── types/                # Legacy type definitions
│
├── docs/                      # Documentation
│   ├── CAPACITOR_SETUP.md
│   └── I18N_IMPLEMENTATION_PLAN.md
│
├── capacitor.config.ts        # Capacitor mobile configuration
├── middleware.ts              # Next.js middleware (locale detection)
├── next.config.js            # Next.js configuration
├── tailwind.config.ts        # Tailwind CSS configuration
├── tsconfig.json             # TypeScript configuration
├── package.json              # Dependencies & scripts
└── .env.example              # Environment variables template
```

---

## 🔧 Configuration Files

### Next.js Configuration (`next.config.js`)
- **Static Export**: Conditional for Capacitor mobile builds
- **Image Optimization**: Disabled for Capacitor
- **Environment Variables**: Supabase & API URLs
- **Performance**: Package import optimization (lucide-react, zustand, supabase)
- **Production**: Console removal (except error/warn)
- **OpenTelemetry**: Warning suppression for instrumentation

### Tailwind Configuration (`tailwind.config.ts`)
- **Dark Mode**: Class-based theme switching
- **Custom Breakpoints**: xs(400px), sm(640px), md(768px), lg(1024px), xl(1280px), 2xl(1536px)
- **Custom Colors**: Sophia purple theme system with CSS variables
- **Custom Animations**: 20+ animations (breathe, pulse, glow, shimmer, confetti, heartbeat, etc.)
- **Safelist**: Dynamic Sophia theme classes

### TypeScript Configuration (`tsconfig.json`)
- **Strict Mode**: Disabled (false)
- **Module**: ESNext with Node resolution
- **Exclude**: iOS/Android/Capacitor directories

### Capacitor Configuration (`capacitor.config.ts`)
- **App ID**: `com.sophia.companion`
- **Development Server**: Live reload support
- **Allowed Navigation**: Supabase, Discord, Backend API
- **Plugins**: SplashScreen, StatusBar, Haptics
- **Android**: Mixed content allowed, web debugging enabled

### Middleware (`middleware.ts`)
- **Locale Detection**: Auto-detect from `Accept-Language` header
- **Cookie Management**: `sophia-locale` and `sophia-locale-manual` cookies
- **Debug Route Protection**: Block `/debug` in production
- **Default Locale**: English (en)

---

## 🎨 Theming System

### CSS Variables (4 Theme Variants)

1. **Light Theme** (default)
   - Background: `#f8f7fa`
   - Text: `#2d2833` (WCAG AA compliant)
   - Purple: `#7c5caa`
   - Cards: `#ffffff`

2. **Accessible Indigo** (dark)
   - Background: `#1e1b2e`
   - Text: `#f5f3ff` (WCAG AAA compliant)
   - Purple: `#a78bfa`
   - Cards: `#2a2740`

3. **Accessible Slate** (dark)
   - Background: `#1e293b`
   - Text: `#f1f5f9` (WCAG AAA compliant)
   - Purple: `#c084fc`
   - Cards: `#2d3748`

4. **Accessible Charcoal** (dark)
   - Similar structure to other dark themes

### Theme Bootstrap
- **localStorage**: `sophia-theme` key
- **Pre-render Script**: Prevents FOUC (Flash of Unstyled Content)
- **Dynamic Variables**: All colors use CSS custom properties
- **Component**: `ThemeBootstrap.tsx` manages theme state

---

## 📦 Dependencies

### Core Framework
- **next**: 14.2.35 (App Router)
- **react**: 18.3.0
- **react-dom**: 18.3.0

### Authentication & Backend
- **@supabase/supabase-js**: 2.57.4
- **@supabase/auth-helpers-nextjs**: 0.10.0
- **@supabase/auth-helpers-react**: 0.5.0
- **@supabase/ssr**: 0.8.0

### Mobile (Capacitor)
- **@capacitor/core**: 8.0.0
- **@capacitor/android**: 8.0.0
- **@capacitor/ios**: 8.0.0
- **@capacitor/haptics**: 8.0.0
- **@capacitor/splash-screen**: 8.0.0
- **@capacitor/status-bar**: 8.0.0

### State Management
- **zustand**: 4.4.7 (lightweight state management)

### UI & Styling
- **tailwindcss**: 3.3.6
- **autoprefixer**: 10.4.16
- **postcss**: 8.4.32
- **lucide-react**: 0.294.0 (icon library)
- **@heroicons/react**: 2.2.0
- **clsx**: 2.0.0 (class name utility)
- **tailwind-merge**: 2.1.0

### Monitoring
- **@sentry/nextjs**: 10.27.0 (error tracking)

### Development
- **typescript**: 5.3.3
- **eslint**: 8.56.0
- **dotenv-cli**: 11.0.0
- **cross-env**: 10.1.0

---

## 🗂️ State Management (Zustand Stores)

### 1. `chat-store.ts` (463 lines) - Chat Conversation Management
**Purpose**: Manages text-based chat conversations with Sophia

**State**:
- `messages`: ChatMessage[] - Conversation history
- `composerValue`: string - Current input text
- `isLocked`: boolean - UI lock during streaming
- `conversationId`: string - Unique conversation session ID
- `activeReplyId`: string - Currently streaming message ID
- `lastError`: string - Error message display
- `feedbackGate`: FeedbackGate - Feedback prompt control
- `sessionFeedback`: object - Session feedback modal state
- `lastCompletedTurnId`: string - Last completed message ID
- `abortController`: AbortController - Stream cancellation

**Actions**:
- `sendMessage()` - Send text message and stream response
- `cancelStream()` - Cancel ongoing message stream
- `applyQuickPrompt()` - Apply quick suggestion to composer
- `addVoiceMessage()` - Add voice message to chat history
- `addUserVoiceMessage()` - Add user voice input to chat
- `setFeedbackGate()` - Control feedback prompt display
- `acknowledgeFeedback()` - Mark feedback as acknowledged
- `openSessionFeedback()` / `closeSessionFeedback()` - Session feedback modal

**Features**:
- Streaming response handling via Server-Sent Events (SSE)
- Usage limit enforcement (blocks at 100%)
- Progressive usage alerts (50%, 80%, 100%)
- Abort controller for cancellation
- Event bus integration for telemetry
- Automatic retry with exponential backoff
- Presence indicator synchronization

### 2. `presence-store.ts` (218 lines) - Sophia's Presence State
**Purpose**: Manages Sophia's animated presence indicator

**State**:
- `status`: "resting" | "listening" | "thinking" | "speaking"
- `detail`: string - Additional status detail
- `emotion`: string - Current emotion display
- `isListening`: boolean - Listening indicator
- `isSpeaking`: boolean - Speaking indicator

**Actions**:
- `setListening()` / `setSpeaking()` - Set presence state
- `setMetaStage()` - Set presence from backend meta
- `settleToRestingSoon()` - Smooth transition to resting
- `reset()` - Reset to default state

**Features**:
- Smooth state transitions
- Debounced updates to prevent flickering
- Backend synchronization

### 3. `usage-limit-store.ts` (105 lines) - Usage Limit Management
**Purpose**: Manages free tier usage limits and alerts

**State**:
- `currentUsage`: object - Current usage statistics (text/voice)
- `isOpen`: boolean - Limit modal visibility
- `limitInfo`: UsageLimitInfo - Limit details
- `toastInfo`: object - Gentle toast display (80-99%)
- `hintInfo`: object - Subtle hint display (50-79%)
- `isAtLimit`: boolean - Computed: is user at 100%?

**Actions**:
- `showModal()` - Show limit reached modal (100%)
- `showToast()` - Show gentle usage toast (80-99%)
- `showHint()` - Show subtle usage hint (50-79%)
- `updateUsage()` - Update current usage stats
- `closeModal()` / `closeToast()` / `closeHint()` - Dismiss alerts

**Features**:
- Three-tier alert system (hint → toast → modal)
- Progressive disclosure of limit warnings
- Real-time usage tracking

### 4. `focus-mode-store.ts` (49 lines) - Focus Mode Management
**Purpose**: Controls UI focus mode (voice/text/full view)

**State**:
- `mode`: "voice" | "text" | "full"
- `isManualOverride`: boolean - User manually selected mode

**Actions**:
- `setMode()` - Change focus mode
- `setManualOverride()` - Toggle manual override

**Features**:
- Auto-switching based on user interaction
- Manual override support
- Smooth view transitions

### 5. `auth-token-store.ts` (146 lines) - Backend Token Management
**Purpose**: Manages backend JWT token for API authentication

**State**:
- `token`: string | null - Backend JWT token
- `isSyncing`: boolean - Token sync in progress
- `lastSyncError`: string | null - Sync error message

**Actions**:
- `setToken()` - Store backend token
- `clearToken()` - Clear token on logout
- `syncFromSupabase()` - Sync token from Supabase session

**Features**:
- Automatic token refresh
- localStorage persistence
- Supabase integration

### 6. `voice-history-store.ts` (38 lines) - Voice Message History
**Purpose**: Stores voice conversation history separately from chat

**State**:
- `messages`: VoiceMessage[] - Voice message history

**Actions**:
- `addMessage()` - Add voice message to history

### 7. `voice-fallback-store.ts` (66 lines) - Voice Fallback Detection
**Purpose**: Tracks voice failures and auto-switches to text

**State**:
- `failureCount`: number - Consecutive voice failures
- `lastFailureTime`: number - Timestamp of last failure
- `lastFailureReason`: string - Reason for failure

**Actions**:
- `setVoiceFailed()` - Record voice failure
- `resetFailures()` - Reset failure counter
- `shouldAutoFallback()` - Check if should fallback to text

**Features**:
- Failure threshold detection (3+ failures)
- Time-based reset (5 minutes)
- Automatic text mode suggestion

### 8. `onboarding-store.ts` (36 lines) - Onboarding Flow
**Purpose**: Tracks first-time user onboarding completion

**State**:
- `completed`: boolean - Onboarding completed
- `currentStep`: number - Current onboarding step

**Actions**:
- `markCompleted()` - Mark onboarding as done
- `reset()` - Reset onboarding state

### 9. `locale-store.ts` (53 lines) - Internationalization
**Purpose**: Client-side locale management

**State**:
- `locale`: "en" | "es" | "it" - Current language
- `isManual`: boolean - User manually selected language

**Actions**:
- `setLocale()` - Change language
- `setManualSelection()` - Mark as manually selected

**Features**:
- Cookie synchronization
- Auto-detection from browser
- Manual override support

---

## 🎣 Custom Hooks

### Voice-Related Hooks

#### `useVoiceLoop.ts` (670 lines) - Main Voice Orchestrator
**Purpose**: Orchestrates real-time voice conversations with WebSocket

**Features**:
- WebSocket connection management
- Audio recording (PCM/WAV format)
- Audio playback with streaming chunks
- State management (idle → connecting → listening → thinking → speaking)
- Barge-in support (interrupt Sophia)
- Microphone permission handling
- Usage limit enforcement
- Error handling and fallback

**Sub-Hooks** (Modular Architecture):
1. **`useVoiceState.ts`** - Stage and error state management
2. **`useVoiceWebSocket.ts`** - WebSocket connection lifecycle
3. **`useVoiceRecording.ts`** - MediaRecorder audio capture
4. **`useAudioPlayback.ts`** - Audio chunk playback queue

**Voice Stages**:
1. `idle` - Not active
2. `connecting` - Establishing WebSocket
3. `listening` - Recording user audio
4. `thinking` - Processing response
5. `speaking` - Playing Sophia's audio
6. `error` - Error state

**WebSocket Message Types**:
- `connected` - Connection established
- `response_start` - Response beginning (V5 backend)
- `audio_chunk` - Streaming audio data (base64 Float32 PCM @ 44100Hz)
- `response_end` - Response complete
- `response` - Complete response (V4 legacy)
- `barge_in_ack` - Barge-in acknowledged
- `error` - Error message
- `meta` - Metadata updates
- `token` - Text token streaming
- `reply_done` - Reply complete

#### `useAudioPlayback.ts` - Audio Playback Management
**Features**:
- Web Audio API integration
- PCM chunk decoding and playback
- Audio queue management
- Stream-ended detection
- Prebuffer override for low latency

#### `useVoiceRecording.ts` - Audio Recording
**Features**:
- MediaRecorder API integration
- PCM audio capture (for STT)
- WAV format encoding
- Audio context unlock for iOS
- Recording cleanup

#### `useVoiceWebSocket.ts` - WebSocket Management
**Features**:
- WebSocket lifecycle (connect/disconnect)
- Binary and text message sending
- Message handler callbacks
- Connection state tracking
- Auto-reconnect support

### Chat-Related Hooks

#### `useTextChat.tsx` (Legacy)
**Purpose**: Text chat functionality (legacy, superseded by chat-store)

#### `useBackendAuth.ts` - Backend Authentication
**Purpose**: Manages backend JWT token exchange

**Features**:
- Token exchange from Supabase
- Token storage in localStorage
- Token refresh logic

#### `useBackendTokenSync.ts` - Automatic Token Sync
**Purpose**: Syncs backend token when missing

**Features**:
- Automatic token recovery
- Handles OAuth callback edge cases
- Silent synchronization

### UI-Related Hooks

#### `useModeSwitch.ts` - Focus Mode Auto-Switching
**Purpose**: Determines when to auto-switch between voice/text/full modes

**Features**:
- User interaction detection
- Voice activity monitoring
- Manual override support
- Smooth transitions

#### `useSessionPersistence.ts` - Session Persistence
**Purpose**: Saves and restores conversation state

**Features**:
- localStorage persistence
- Conversation ID restoration
- Message history restoration

#### `useReflectionPrompt.ts` - Reflection Prompts
**Purpose**: Shows reflection prompts after conversations (TEMPORARILY DISABLED)

#### `useUsageMonitor.ts` - Usage Tracking
**Purpose**: Monitors and displays usage alerts

**Features**:
- Real-time usage polling
- Event-based refresh
- Progressive alerts (50% → 80% → 100%)

### Mobile-Related Hooks

#### `useCapacitor.ts` - Capacitor Platform Detection
**Purpose**: Detects if running in Capacitor mobile app

**Returns**:
- `isCapacitor`: boolean
- `platform`: "ios" | "android" | "web"

#### `useHaptics.ts` - Haptic Feedback
**Purpose**: Provides haptic feedback on mobile

**Features**:
- Impact feedback (light, medium, heavy)
- Notification feedback (success, warning, error)
- Platform detection

### Utility Hooks

#### `useFocusTrap.ts` - Focus Management
**Purpose**: Traps focus within modals and dialogs

#### `useSwipeToDismiss.ts` - Swipe Gestures
**Purpose**: Implements swipe-to-dismiss for mobile drawers/sheets

---

## 🧩 Component Architecture

### Layout Components

#### `AppShell.tsx` - Main Layout Container
**Purpose**: Provides consistent layout structure with header and action bar

**Features**:
- Responsive padding
- Mobile optimization
- Action bar positioning
- Header integration
- Auth gate wrapper
- Consent gate wrapper
- Onboarding flow integration

#### `Header.tsx` - Top Navigation Bar
**Features**:
- Branding
- Settings button
- History drawer toggle
- Theme toggle
- Mobile-optimized

#### `ConversationView.tsx` - Main Conversation Interface
**Purpose**: Orchestrates voice and text chat views

**Features**:
- Focus mode management (voice/text/full)
- Auto-mode switching
- Voice state integration
- Microphone support detection
- Session persistence
- Usage monitoring
- Lazy loading for performance

**View Modes**:
1. **Voice Focus** - Full-screen voice interaction
2. **Text Focus** - Chat transcript with collapsed voice
3. **Full View** - Voice panel + chat transcript

### Voice Components

#### `VoiceFocusView.tsx` - Voice Full-Screen Interface
**Features**:
- Large circular voice recorder button
- Animated waveform visualization
- Voice stage indicators
- Partial/final reply display
- Error handling
- Barge-in support

#### `VoicePanel.tsx` - Voice Panel (Full View)
**Features**:
- Compact voice recorder
- Waveform visualization
- Stage indicators
- Reply display

#### `VoiceCollapsed.tsx` - Collapsed Voice Card
**Features**:
- Minimized voice interface
- Quick access button
- Current stage display
- Expand to voice mode

#### `VoiceRecorder.tsx` - Voice Recording Button
**Features**:
- Push-to-talk interaction
- Visual feedback (pulse, glow)
- Stage-aware styling
- Error display
- Haptic feedback

#### `VoiceTranscript.tsx` - Voice Reply Display
**Features**:
- Streaming text display
- Final reply highlighting
- Typing animation

#### `Waveform.tsx` - Audio Waveform Visualization
**Features**:
- Real-time audio level display
- Animated bars
- Stage-aware colors
- Smooth transitions

### Chat Components

#### `chat/Transcript.tsx` - Chat Message List
**Features**:
- Virtualized scrolling for performance
- Auto-scroll to bottom
- Message grouping
- Empty state
- Quick prompt suggestions

#### `chat/MessageBubble.tsx` - Individual Message
**Features**:
- User vs Sophia styling
- Markdown rendering
- Audio playback button (for voice messages)
- Timestamp display
- Streaming indicator
- Error state

#### `chat/Composer.tsx` - Message Input
**Features**:
- Auto-expanding textarea
- Submit on Enter (Shift+Enter for newline)
- Character count
- Locked state during streaming
- Cancel button
- Focus management

#### `chat/EmptyState.tsx` - Empty Chat State
**Features**:
- Welcome message
- Quick prompt suggestions
- Time-based greeting

#### `chat/StreamingIndicator.tsx` - Typing Indicator
**Features**:
- Animated dots
- Loading message
- Thinking state

### UI Components

#### `EmotionDisplay.tsx` - Emotion Indicator
**Features**:
- Emoji-based emotion display
- Confidence level
- Smooth transitions

#### `PresenceIndicator.tsx` - Sophia's Status
**Features**:
- Animated status badge
- Status text (resting, listening, thinking, speaking)
- Detail text
- Breathing animation

#### `ActiveModeIndicator.tsx` - Focus Mode Display
**Features**:
- Shows current mode (voice/text/full)
- Mode switching buttons

#### `InputModeIndicator.tsx` - Input Mode Badge
**Features**:
- Voice/text mode indicator
- Quick switch button

### Modal/Drawer Components

#### `SettingsSheet.tsx` - Settings Drawer
**Features**:
- Theme selector
- Language selector
- Privacy settings link
- About information
- Founding supporter link

#### `HistoryDrawer.tsx` - Conversation History
**Features**:
- Past conversation list
- Search/filter
- Delete conversations
- Load conversation

#### `UsageLimitModal.tsx` - Usage Limit Reached Modal
**Features**:
- Usage statistics display
- Upgrade prompt
- Founding supporter offer

#### `GentleUsageToast.tsx` - Usage Warning Toast (80-99%)
**Features**:
- Non-intrusive notification
- Usage percentage
- Auto-dismiss
- Link to founding supporter

#### `UsageHint.tsx` - Usage Hint (50-79%)
**Features**:
- Subtle hint display
- Compact notification
- Dismissible

#### `ConsentModal.tsx` - Privacy Consent
**Features**:
- First-time consent prompt
- Privacy policy link
- Accept/decline buttons

#### `OnboardingFlow.tsx` - First-Time Onboarding
**Features**:
- Multi-step introduction
- Feature highlights
- Skip option

#### `ReflectionModal.tsx` - Reflection Prompts (DISABLED)
**Features**:
- Post-conversation reflection
- Guided prompts
- Skip option

### Feedback Components

#### `FeedbackStrip.tsx` - Inline Feedback Buttons
**Features**:
- Thumbs up/down
- Appears after specific messages
- One-time feedback gate

#### `SessionFeedbackToast.tsx` - Session Feedback Prompt
**Features**:
- End-of-session feedback
- Rating prompt
- Dismissible

### UI Elements

#### `ThemeToggle.tsx` - Theme Switcher
**Features**:
- Light/dark mode toggle
- Theme preview
- Smooth transition

#### `LocaleSelector.tsx` - Language Switcher
**Features**:
- Language dropdown
- Flag icons
- Cookie persistence

#### `FoundingSupporterBadge.tsx` - Supporter Badge
**Features**:
- Animated badge for supporters
- Confetti effect
- Glow animation

### Gate Components

#### `AuthGate.tsx` - Authentication Gate
**Purpose**: Blocks access until user is authenticated

**Features**:
- Supabase auth check
- Discord OAuth integration
- Loading state
- Sign-in prompt

#### `ConsentGate.tsx` - Consent Gate
**Purpose**: Blocks access until privacy consent is given

**Features**:
- Consent check
- Consent modal trigger
- localStorage tracking

### Error Handling

#### `ErrorBoundary.tsx` - React Error Boundary
**Features**:
- Catches React errors
- Error logging to Sentry
- Fallback UI

#### `ErrorFallback.tsx` - Error Display Component
**Features**:
- User-friendly error message
- Retry button
- Report issue link

### Mobile Components

#### `CapacitorInit.tsx` - Capacitor Initialization
**Features**:
- Platform detection
- Status bar configuration
- Splash screen management
- Haptics initialization

---

## 🛣️ API Routes (Next.js API Routes)

### Authentication
- **`/api/auth/[...nextauth]/route.ts`** - NextAuth.js handler

### Conversation
- **`/api/conversation/respond`** - Stream text chat response
- **`/api/conversation/[sessionId]/cancel`** - Cancel ongoing stream
- **`/api/conversation/feedback`** - Submit message feedback

### Consent
- **`/api/consent/accept`** - Accept privacy consent
- **`/api/consent/check`** - Check consent status

### Privacy
- **`/api/privacy/consent`** - Get privacy consent details
- **`/api/privacy/delete`** - Request data deletion
- **`/api/privacy/export`** - Request data export
- **`/api/privacy/status`** - Get privacy request status

### Reflections
- **`/api/reflections/create`** - Create reflection entry
- **`/api/reflections/prompt`** - Get reflection prompt

### Usage
- **`/api/usage/check`** - Check current usage limits

### Community (Future Feature)
- **`/api/community/latest-learning`** - Get latest community insights
- **`/api/community/user-impact`** - Get user impact statistics

---

## 📚 Library Utilities

### API Client (`lib/`)
- **`api.ts`** - HTTP API client helpers
- **`stream-conversation.ts`** - SSE conversation streaming
- **`websocket.ts`** - WebSocket utility functions

### Authentication (`lib/auth/`)
- **`backend-auth.ts`** - Backend JWT token management
- **`server-auth.ts`** - Server-side auth utilities
- **`index.ts`** - Auth utility exports

### Error Handling
- **`error-logger.ts`** - Centralized error logging with Sentry
- **`error-messages.ts`** - Error message translations

### Events
- **`events.ts`** - Event bus for cross-component communication

**Event Types**:
- `chat:message:sent` - User sent text message
- `chat:message:received` - Sophia replied
- `chat:stream:start` - Stream started
- `chat:stream:chunk` - Stream chunk received
- `chat:stream:complete` - Stream completed
- `chat:stream:error` - Stream error
- `voice:recording:start` - Voice recording started
- `voice:recording:stop` - Voice recording stopped
- `voice:playback:complete` - Voice playback finished

### Telemetry
- **`telemetry.ts`** - Analytics event tracking

### Utilities
- **`format-time.ts`** - Time formatting utilities
- **`time-greetings.ts`** - Time-based greeting messages
- **`conversation-history.ts`** - Conversation persistence
- **`session-persistence.ts`** - Session state management
- **`mode-switching.ts`** - Focus mode auto-switch logic
- **`usage-tracker.ts`** - Usage limit tracking

### Microphone
- **`microphone-permissions.ts`** - Permission checking
- **`microphone-debug.ts`** - Microphone diagnostics

### Capacitor
- **`capacitor-api.ts`** - Capacitor platform utilities

### Debugging
- **`debug.ts`** - Debug utilities and logging

---

## 🌍 Internationalization (i18n)

### Architecture
- **Framework**: Custom i18n system (not react-i18next)
- **Supported Languages**: English (en), Spanish (es), Italian (it)
- **Detection**: Automatic from `Accept-Language` header
- **Manual Override**: User can manually select language
- **Persistence**: Cookie-based (`sophia-locale`, `sophia-locale-manual`)

### Files
- **`copy/config.ts`** - i18n configuration
- **`copy/core.ts`** - Core i18n logic
- **`copy/server.ts`** - Server-side i18n utilities
- **`copy/locale-context.tsx`** - Client-side context
- **`copy/index.ts`** - Unified exports
- **`copy/types.ts`** - Type definitions
- **`copy/locales/en.ts`** - English translations (~500+ strings)
- **`copy/locales/es.ts`** - Spanish translations
- **`copy/locales/it.ts`** - Italian translations

### Usage Pattern
```typescript
// Client-side
import { useTranslation } from "@/app/copy"

function Component() {
  const { t } = useTranslation()
  return <p>{t("welcome.title")}</p>
}

// Server-side
import { getServerCopy } from "@/app/copy/server"

const copy = getServerCopy("en")
console.log(copy.welcome.title)
```

### Translation Structure
```typescript
{
  brand: { name, tagline },
  auth: { title, subtitle, ... },
  chat: { composer, send, cancel, ... },
  voiceRecorder: { errors, stages, ... },
  usageLimit: { modalTitle, ... },
  settings: { theme, language, ... },
  // ... 50+ namespaces
}
```

---

## 🎭 Features

### 1. Voice Chat System
- **Real-time Voice Conversations**: WebSocket-based bidirectional audio streaming
- **Speech-to-Text**: User audio sent as PCM/WAV to backend
- **Text-to-Speech**: Sophia's audio streamed as Float32 PCM chunks
- **Push-to-Talk**: Hold button to record
- **Barge-in**: Interrupt Sophia mid-response
- **Waveform Visualization**: Real-time audio level display
- **Voice Fallback**: Auto-switch to text after repeated failures
- **Microphone Diagnostics**: Detailed permission and support detection

### 2. Text Chat System
- **Streaming Responses**: Server-Sent Events (SSE) for real-time text streaming
- **Message History**: Persistent conversation history
- **Quick Prompts**: Suggested conversation starters
- **Rich Formatting**: Markdown support in messages
- **Cancel Stream**: Stop Sophia mid-response
- **Audio Playback**: Play voice message audio from chat

### 3. Authentication System
- **Supabase Auth**: OAuth with Discord
- **Backend Token**: JWT token for API authentication
- **Automatic Sync**: Token refresh and recovery
- **Guest Mode**: Allow limited usage without auth (future)

### 4. Usage Limit System
- **Free Tier Limits**: Track text and voice usage separately
- **Progressive Alerts**:
  - 50-79%: Subtle hint
  - 80-99%: Gentle toast
  - 100%: Modal block
- **Real-time Tracking**: Usage updates after each interaction
- **Founding Supporter**: Unlimited usage for early supporters

### 5. Focus Mode System
- **Three Modes**:
  - **Voice Focus**: Full-screen voice interface
  - **Text Focus**: Chat transcript with collapsed voice
  - **Full View**: Voice panel + chat transcript
- **Auto-Switching**: Intelligent mode switching based on user interaction
- **Manual Override**: User can manually select mode
- **Smooth Transitions**: Animated mode changes

### 6. Theme System
- **4 Theme Variants**: Light, Accessible Indigo, Accessible Slate, Accessible Charcoal
- **WCAG Compliance**: AA/AAA contrast ratios
- **Smooth Transitions**: CSS transitions between themes
- **Persistence**: localStorage-based theme saving
- **No FOUC**: Pre-render script prevents flash

### 7. Mobile Support
- **Capacitor**: Native iOS and Android apps
- **PWA**: Progressive Web App with offline support
- **Haptic Feedback**: Tactile feedback on supported devices
- **Mobile Gestures**: Swipe-to-dismiss for drawers
- **Responsive Design**: Mobile-first layout
- **Touch Optimization**: 300ms delay removal, proper touch targets

### 8. Internationalization
- **3 Languages**: English, Spanish, Italian
- **Auto-Detection**: From browser Accept-Language
- **Manual Selection**: User can override
- **500+ Strings**: Comprehensive translation coverage
- **RTL Support**: Ready for future RTL languages

### 9. Privacy Features
- **Consent Gate**: Required privacy consent
- **Data Export**: Request user data export
- **Data Deletion**: Request account deletion
- **Privacy Dashboard**: Manage privacy settings
- **GDPR Compliant**: Privacy-first design

### 10. Feedback System
- **Message Feedback**: Thumbs up/down per message
- **Session Feedback**: End-of-conversation rating
- **Feedback Gate**: One-time feedback per message
- **Anonymous Option**: Optional feedback

### 11. Error Handling
- **Error Boundary**: Catches React errors
- **Sentry Integration**: Error logging and tracking
- **User-Friendly Messages**: Clear error explanations
- **Retry Logic**: Automatic retry for transient failures
- **Fallback UI**: Graceful degradation

### 12. Performance Optimization
- **Lazy Loading**: Code splitting for heavy components
- **Virtual Scrolling**: Efficient message list rendering
- **Debounced Updates**: Prevent excessive re-renders
- **Memoization**: React.memo for expensive components
- **Bundle Size**: Optimized package imports
- **Image Optimization**: Next.js image optimization (non-Capacitor)

### 13. Accessibility
- **Keyboard Navigation**: Full keyboard support
- **Screen Reader**: ARIA labels and landmarks
- **Focus Management**: Proper focus trapping
- **Color Contrast**: WCAG AA/AAA compliance
- **Font Scaling**: Supports browser font size changes

### 14. Analytics & Telemetry
- **Event Tracking**: Custom event system
- **Usage Metrics**: Track feature usage
- **Error Tracking**: Sentry integration
- **Performance Monitoring**: Core Web Vitals
- **Privacy-Respecting**: No PII tracking

---

## 🔐 Authentication Flow

### OAuth Flow (Discord)
1. User clicks "Sign in with Discord"
2. Redirect to Supabase OAuth endpoint
3. Supabase redirects to Discord OAuth
4. User authorizes on Discord
5. Discord redirects back to Supabase with code
6. Supabase exchanges code for tokens
7. Supabase redirects to `/auth/callback`
8. Frontend receives Supabase session
9. Frontend exchanges Supabase token for backend JWT
10. Backend JWT stored in localStorage
11. Backend JWT sent with all API requests

### Token Management
- **Supabase Token**: Managed by Supabase client
- **Backend JWT**: Stored in localStorage (`sophia_backend_token`)
- **Token Refresh**: Automatic on expiration
- **Token Sync**: Auto-sync if missing after OAuth

---

## 🔄 Data Flow

### Text Chat Flow
1. User types message in Composer
2. `chat-store.sendMessage()` called
3. Usage limit checked (block if at 100%)
4. User message added to chat
5. POST to `/api/conversation/respond`
6. Backend streams SSE events:
   - `event: meta` - Metadata updates
   - `event: token` - Text tokens (not displayed)
   - `event: done` - Final complete response
   - `event: error` - Error occurred
7. Presence indicator updated from meta events
8. Final response displayed when done
9. Usage stats refreshed
10. Feedback gate checked

### Voice Chat Flow
1. User presses voice button
2. `useVoiceLoop.startTalking()` called
3. Microphone permission requested
4. WebSocket connected to backend
5. MediaRecorder starts capturing audio
6. User speaks (audio recorded as PCM/WAV)
7. User releases button
8. Audio sent as binary WebSocket message
9. Backend processes audio (STT + LLM + TTS)
10. Backend sends response:
    - `response_start` - Transcript + text response
    - `audio_chunk` (multiple) - Audio data
    - `response_end` - Stream complete
11. Audio chunks decoded and played immediately
12. Text transcript added to chat
13. Usage stats refreshed

### Focus Mode Auto-Switch Flow
1. `ConversationView` monitors user interaction
2. Voice activity detected → Switch to "voice" mode
3. Composer focused → Switch to "text" mode
4. Both inactive → Stay in current mode or "full"
5. Manual override → Disable auto-switch for 30s
6. User interaction resets manual override

---

## 📱 Mobile-Specific Features

### Capacitor Integration
- **Live Reload**: Development server accessible on device
- **Native Plugins**: Haptics, StatusBar, SplashScreen
- **Deep Links**: Handle oauth callbacks
- **File System**: Offline storage support
- **Camera/Microphone**: Native permission handling

### Platform Detection
```typescript
const { isCapacitor, platform } = useCapacitor()
// platform: "ios" | "android" | "web"
```

### Haptic Feedback
```typescript
const { impact, notification } = useHaptics()

impact("medium") // Light, medium, heavy
notification("success") // Success, warning, error
```

### Mobile Optimizations
- **Touch Targets**: Minimum 44x44px
- **Viewport**: Properly configured viewport meta tag
- **Safe Areas**: iOS safe area insets respected
- **Orientation**: Portrait lock optional
- **Keyboard**: Virtual keyboard handling

---

## 🧪 Development Workflow

### Scripts
```bash
# Development
npm run dev              # Start Next.js dev server (localhost:3000)
npm run dev:mobile       # Start dev server on 0.0.0.0 for mobile

# Production
npm run build            # Build for production
npm run build:dev        # Build with .env.dev
npm start                # Start production server

# Quality
npm run lint             # Run ESLint
npm run type-check       # TypeScript check

# Capacitor
npm run cap:sync         # Sync web assets to native
npm run cap:android      # Open Android Studio
npm run cap:ios          # Open Xcode
npm run cap:android:run  # Build and run Android
npm run cap:ios:run      # Build and run iOS
```

### Environment Variables
```bash
# Required
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=xxx
NEXT_PUBLIC_API_URL=http://localhost:8000

# Optional
NEXT_PUBLIC_BACKEND_WS_URL=ws://localhost:8000
```

### Debug Mode
- **Route**: `/debug` (blocked in production)
- **Features**: Store inspector, usage tester, event logger

---

## 🐛 Error Handling Strategy

### Error Levels
1. **User Errors**: Invalid input, permission denied
2. **Network Errors**: Failed requests, timeout
3. **Backend Errors**: Server errors, rate limits
4. **Client Errors**: React errors, state issues

### Error Handling Layers
1. **Component Level**: Try-catch in event handlers
2. **Error Boundary**: React Error Boundary for render errors
3. **API Level**: Retry logic for transient failures
4. **Store Level**: Error state in Zustand stores
5. **Global Level**: Sentry for unhandled errors

### Error Display
- **Toast**: Temporary error notification
- **Modal**: Blocking error (e.g., usage limit)
- **Inline**: Error message in component
- **Fallback UI**: Error boundary fallback

---

## 🚀 Performance Considerations

### Bundle Size
- **Initial Load**: ~300KB (gzipped)
- **Lazy Loaded**: Voice components (~50KB)
- **Vendor**: React, Next.js, Supabase (~200KB)

### Optimization Techniques
1. **Code Splitting**: Lazy load heavy components
2. **Tree Shaking**: Remove unused code
3. **Package Optimization**: Import only needed modules
4. **Image Optimization**: Next.js image component
5. **Font Optimization**: Variable fonts with subset
6. **CSS Optimization**: Tailwind CSS purging

### Runtime Performance
- **Virtual Scrolling**: Efficient message list
- **Debouncing**: Input handlers debounced
- **Memoization**: React.memo for expensive renders
- **Event Delegation**: Efficient event handling

---

## 🔮 Future Features (Disabled/Planned)

### Reflections System (DISABLED)
- **Status**: Code present but feature flag disabled
- **Purpose**: Post-conversation reflection prompts
- **Files**: `ReflectionModal.tsx`, `useReflectionPrompt.ts`
- **Enable**: Set `ENABLE_REFLECTIONS = true`

### Community Features (Planned)
- **Latest Learning**: Community insights
- **User Impact**: Statistics dashboard
- **Routes**: `/api/community/*`

### Founding Supporter Program
- **Badge**: Animated supporter badge
- **Benefits**: Unlimited usage, exclusive features
- **Pages**: `/founding-supporter`, `/founding-supporter/success`

---

## 📊 Key Metrics

### Code Statistics
- **Total Files**: 134 source files
- **Total Lines**: ~15,000+ lines
- **Components**: 60+ React components
- **Hooks**: 15+ custom hooks
- **Stores**: 9 Zustand stores
- **API Routes**: 15 Next.js API routes
- **Languages**: 3 (English, Spanish, Italian)
- **Themes**: 4 color schemes

### Component Breakdown
- **UI Components**: 60% (message display, inputs, modals)
- **Feature Components**: 25% (voice, chat, auth)
- **Layout Components**: 10% (shell, header, drawers)
- **Utility Components**: 5% (error boundaries, providers)

---

## 🏆 Best Practices Implemented

### Code Quality
- **TypeScript**: Full type safety
- **ESLint**: Code linting and formatting
- **Component Structure**: Logical file organization
- **Naming Conventions**: Clear, descriptive names
- **Comments**: Inline documentation for complex logic

### Performance
- **Lazy Loading**: Code splitting
- **Memoization**: Prevent unnecessary re-renders
- **Debouncing**: Input and event handler optimization
- **Virtual Scrolling**: Efficient list rendering

### Accessibility
- **WCAG AA/AAA**: Color contrast compliance
- **Keyboard Navigation**: Full keyboard support
- **Screen Readers**: ARIA labels and semantic HTML
- **Focus Management**: Proper focus trapping

### Security
- **Environment Variables**: Sensitive data in env vars
- **XSS Protection**: React's built-in escaping
- **CSRF Protection**: SameSite cookies
- **Auth Tokens**: Secure token management

### User Experience
- **Progressive Enhancement**: Works without JS (limited)
- **Error Recovery**: Graceful error handling
- **Loading States**: Clear loading indicators
- **Feedback**: Immediate user feedback

---

## 🔍 Technical Debt & Known Issues

### Technical Debt
1. **Dual Hook Systems**: Legacy hooks (`src/hooks/`) and new hooks (`src/app/hooks/`)
2. **Dual Library Systems**: Legacy lib (`src/lib/`) and new lib (`src/app/lib/`)
3. **i18n System**: Custom system instead of standard library
4. **TypeScript Strict Mode**: Disabled for faster development
5. **Error Handling**: Inconsistent error handling patterns

### Known Issues
1. **Microphone Support**: Some browsers have quirks
2. **iOS Audio**: Web Audio API limitations on iOS
3. **WebSocket Reconnect**: Manual reconnect required
4. **Voice Fallback**: Not all failures trigger fallback
5. **Session Restoration**: Limited conversation history

### Improvement Opportunities
1. **Testing**: Add comprehensive test coverage
2. **Storybook**: Component documentation
3. **Performance Monitoring**: Real User Monitoring (RUM)
4. **A/B Testing**: Feature flag system
5. **Observability**: Enhanced logging and tracing

---

## 📝 Summary

This is a **production-ready, feature-rich AI companion frontend** built with modern web technologies. It provides:

- ✅ **Real-time voice conversations** with WebSocket streaming
- ✅ **Text chat** with SSE streaming responses
- ✅ **Mobile apps** via Capacitor (iOS/Android)
- ✅ **Internationalization** (3 languages)
- ✅ **Usage limits** with progressive alerts
- ✅ **Authentication** via Supabase + Discord OAuth
- ✅ **Theming** with 4 color schemes
- ✅ **Privacy-first** design with GDPR compliance
- ✅ **Error handling** with Sentry integration
- ✅ **Performance optimized** with lazy loading and code splitting
- ✅ **Accessibility** with WCAG AA/AAA compliance

The codebase is well-structured, modular, and maintainable with clear separation of concerns using Zustand stores, custom hooks, and reusable components.

---

## 📚 Related Documentation

- **`README.md`**: Quick start guide
- **`FRONTEND_SETUP.md`**: Setup instructions
- **`docs/CAPACITOR_SETUP.md`**: Mobile app setup
- **`docs/I18N_IMPLEMENTATION_PLAN.md`**: i18n architecture
- **`.env.example`**: Environment variables template

---

**Generated**: 2026-01-03  
**Framework**: Next.js 14.2.35  
**React**: 18.3.0  
**TypeScript**: 5.3.3
