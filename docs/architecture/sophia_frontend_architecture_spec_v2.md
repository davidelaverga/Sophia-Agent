# Sophia Frontend Architecture Spec v2.0

**Status:** Draft for review
**Version:** 2.0 · May 2026
**Author:** Davide (architecture) · Claude (drafting)
**Implementation target:** ~5-6 weeks frontend across phased PRs
**Supersedes:**
- `sophia_frontend_streaming_architecture_plan_v1.md` — fully replaced (pre-v3 streaming, side-panel framing, transformation-layer assumptions all rethought)

**Related specs (composed with, unchanged):**
- `sophia_telegram_architecture_spec_v1.md` — establishes gateway fanout with `BuilderEventFanout` that this spec consumes via SSE
- `sophia_gpt_realtime_experiment_spec_v1_3.md` — voice runtime + §5.14 Looking Together + §11 frontend contract this spec implements
- `sophia_memory_upgrades_spec_v2.md` — memory state surfaced selectively
- `sophia_session_log_spec_v1_2.md` — session log streamed visually in voice mode
- `sophia_builder_gateway_routing_spec.md` — to be revised against v3 streaming separately
- `sophia_workspace_and_multimodal_spec_v1_1.md` — artifact types this spec renders

---

## 1. Purpose

Define the architecture for Sophia's web and mobile frontend: how it renders the conversation, how it visualizes async builder work, how it composes voice and text modes, how it renders artifacts of every type, and how it composes with the gateway fanout backend infrastructure from the Telegram spec.

This is v2 because v1 made three assumptions that turned out to be wrong:
- It assumed v2 streaming, which the Telegram spec replaces with v3 typed projections.
- It assumed a "side panel" framing for builder visibility, which on inspection doesn't fit voice mode (no chat to compete with) and arguably doesn't fit text mode either when the work is the central thing happening.
- It assumed a Vercel AI SDK UI Message Stream transformation layer, which v3 + `useStream` from `@langchain/react` makes unnecessary.

The replacement: a **spatial adaptive canvas** that reacts to what's important right now, with Sophia's presence as the persistent anchor and work emerging from the conversation rather than being relegated to a panel. Same architecture across voice and text mode, parameterized by which channel is primary.

## 2. Scope

### In scope

- Web frontend (Next.js + React + canvas layer)
- Voice mode visualization (presence + adaptive work canvas)
- Text mode visualization (chat thread + adaptive work canvas)
- Mode toggle between voice and text (same session, different lens)
- Artifact renderer matrix for all artifact types
- Subscription to two stream sources: companion messages (`useStream`) and builder events (gateway SSE)
- Voice runtime SSE consumption (events from `sophia_gpt_realtime_experiment_spec_v1_3.md` §11.2)
- Mobile responsive (phone in hand, phone in pocket/screen off)
- Visual rendering of Looking Together (per voice spec §5.14)
- Auth proxy to LangGraph Server
- Performance targets for streaming, canvas, and animation

### Out of scope

- iOS native app (potential v3)
- Backend changes (specified in their respective specs)
- Telegram client UI (we don't control it)
- Marketing site
- Admin / debugging UI
- The voice runtime itself (lives in `sophia_gpt_realtime_experiment_spec_v1_3.md`)
- Identity binding flow (existing, unchanged)
- Memory state browsing UI (potential future spec)

### Explicit non-goals

- We do NOT show every builder tool action. Selective visibility per the same logic applied to companion tools in the prompt — show meaningful work, hide internal cognition.
- We do NOT use a side panel as the dominant builder visibility surface. The canvas adapts; nothing is in a perpetual "auxiliary" position.
- We do NOT build a custom state management layer for builder events when `useStream` covers it natively for the companion stream.
- We do NOT show camera-based vision of the user. Shared sight is one-way (Sophia sees artifacts via injection, never user video).
- We do NOT mock or simulate streaming. All visible activity reflects real backend events.

---

## 3. Architectural Principles

These are the principles that hold this spec together. When implementation decisions arise that aren't directly answered by the spec, defer to these.

### 3.1 The relationship is the substrate; work emerges from it

The user's primary experience is the conversation with Sophia. Async work isn't a separate event — it's something that emerged from time spent together. UI that puts work in a "panel" implicitly demotes it; UI that lets work appear *of the conversation*, visible but not interrupting, preserves the relational frame.

### 3.2 Spatial adaptive canvas, not fixed regions

The screen has one primary canvas slot that reacts to what's important now, plus a persistent presence anchor (the orb in voice, the chat in text). The canvas adapts. Default state: presence/chat dominant. Active work: the work moves to the canvas center; presence anchors at the edge. This is "looking at something together" rendered spatially.

### 3.3 Two complementary streams, one session

The frontend subscribes to two streams that serve different lifecycles:

1. **Companion stream** — Sophia's own conversation thread. One subscription. Lifecycle bound to session. Consumed via `@langchain/react`'s `useStream` direct.
2. **Builder events stream** — Zero-to-N async builder tasks running in parallel. Per-user subscription via Server-Sent Events backed by the gateway's `WebSSESink`. Tasks come and go independently.

They merge into one visual timeline but stay separate in state. Trying to multiplex them through one transformation layer (as v1 did) entangles lifecycles that have different shapes.

### 3.4 Voice and text are toggleable lenses on the same session

A session has multiple "views" of itself. Voice view emphasizes presence + ambient activity. Text view emphasizes conversation + inline activity. The user toggles based on how they want to engage. The underlying state is shared; the rendering layer differs.

The implication: no separate "voice app" and "text app." One frontend, two layouts, the same data.

### 3.5 Minimalism as a feature

The existing aesthetic Davide built — the cosmic ground, the breathing orb, the minimal chrome — is a competitive moat. Productivity-app vocabulary (notification badges, progress bars, hard-edged cards, status text everywhere) breaks the spell. New visual elements (seeds, lanterns, blooms) must feel of the same world.

### 3.6 Platform-native idioms

Telegram has multi-bot primitives and a chat client we don't control. Web has a canvas we fully control. Voice mode has audio as the primary channel. Each platform uses its native affordances rather than forcing a cross-platform consistency that loses what each does best. The backend state (memory, builder, session log) is consistent; the presentation differs intentionally.

### 3.7 Mobile-first

Voice usage is overwhelmingly mobile. Text usage on mobile is comparable to desktop. All canvas states, all artifact viewers, all transitions must work on a 375px viewport before they're considered done.

### 3.8 Real-time, recoverable

Streams reconnect on network blips. Page reloads hydrate state from the latest events. Closing the screen while a task is running doesn't lose the result. Push notifications fire for completions that matter (builder done, scheduled check moment). The frontend is recoverable, not a thin live cache.

---

## 4. Architectural Decisions (locked)

Each decision below traces back to design conversations. Challenge in isolation rather than during implementation.

### D1 — Spatial adaptive canvas as the layout primitive

The screen organizes around one primary canvas slot that adapts to what's important now, plus a persistent anchor for the conversational channel (presence in voice, chat thread in text). No fixed side panel. No fixed panel grid. The canvas is responsive both to *what's happening* (default presence vs active work) and *to the device* (desktop layout vs mobile layout).

**Rejected:** v1's "side panel for builder activity" framing. Cause: implicitly demotes builder work to auxiliary status. The work IS the thing happening when the user asks for something to be built.

### D2 — Sophia presence is persistent but not always central

In default state (no active work), Sophia's presence is the primary visual: the breathing orb in voice, the chat-thread-with-her-messages in text. When work becomes active (builder dispatched, search firing, schedule registered), presence shrinks to a persistent anchor (corner orb in voice; chat thread narrows in text), and the work takes the canvas center. When the work recedes, presence expands back.

This mirrors the physical reality of working with someone: their presence is held, but attention shifts to what you're looking at together.

### D3 — Artifact rendering: typed matrix + OpenUI for interactive

Every artifact carries a `type` (markdown, code, image, image_gallery, pdf, slides, data, interactive, file). The frontend has a renderer per type. OpenUI from Thesys is specifically the renderer for `interactive` (LLM-generated React components, sandboxed); it is NOT a one-size-fits-all replacement for the typed matrix. Markdown is markdown; slides are slides; interactive is OpenUI.

**Rejected:** v1's implicit "render everything as a card" approach. Cause: a 50-page PDF rendered as a card is unusable.

### D4 — Two complementary streams, no transformation layer

The companion stream subscribes via `@langchain/react`'s `useStream` directly against the LangGraph thread. The builder events stream subscribes via Server-Sent Events from a thin SSE endpoint that the gateway's `WebSSESink` feeds. No `UIMessageStream` translation. No Zustand store rebuilding what `useStream` already provides. The hook IS the state.

**Rejected:** v1's Vercel-AI-SDK-UI transformation layer. Cause: v3 typed projections + `useStream`'s typed `subagents` and `messages` make the transformation layer redundant.

### D5 — Voice and text modes share state; toggle is a lens, not a destination

A session has one state. The toggle (existing UI: `voice | text`) switches the rendering lens. Switching does not abandon active builder tasks, does not reset chat history, does not lose memory. State persists across toggles in the same session.

### D6 — Mobile-first responsive, but desktop is first-class

The canvas adapts to viewport. On mobile (≤480px): canvas is full-screen; presence docks to a small bar; chat-mode shows the conversation full-column with cards expanding to full-screen on tap. On desktop (≥1280px): canvas can show presence + work side-by-side; chat-mode shows chat in a centered column with cards expanding to a wider canvas. Tablet sizes adapt fluidly. No "mobile app" vs "desktop app" — one responsive surface.

### D7 — One-way shared sight: Sophia can see artifacts; she cannot see the user

Per voice spec §5.14 and §16.7: Sophia sees images of artifacts when brought into joint view (in scope). She does NOT see the user via camera (deferred — product-significant question). The frontend will never request camera permissions, never display "Sophia can see you," never show a user-camera-on indicator. This is a defining product property, not a future feature.

### D8 — Custom canvas layer for ambient/spatial elements; React for focused content

The cosmic ground, the breathing orb, the seeds, the lanterns, the lights — these are ambient spatial elements that benefit from a dedicated canvas/WebGL or Canvas2D layer. They animate smoothly, compose with each other, and don't trigger React re-renders for every motion frame.

The artifact viewers, the chat messages, the controls — these are focused content that benefits from React's component model.

Two layers, composed:
- Ambient layer: `<canvas>` element (technology TBD; see Open Questions §16)
- Focused layer: standard React component tree, positioned above canvas

The layers communicate via a shared event bus (events fire on canvas events; React reads canvas state when focusing).

---

## 5. The Adaptive Canvas Model

The central UX primitive. This section defines how the canvas behaves across states; later sections (voice mode §9, text mode §10) specify how each surface implements it.

### 5.1 The five canvas states

**State A — Presence dominant (default).**
No active work, no active artifact in focus. The conversational channel fills the canvas: orb breathing in voice mode; chat thread holding the column in text mode. The cosmic ground is fully visible. Nothing demands attention.

**State B — Activity emerging.**
A new builder task was just dispatched, OR a web search just fired, OR a schedule check was just registered. A new visual element (seed, light, lantern) appears in the space near the conversational channel. Doesn't take over the canvas; it occupies a peripheral position. Presence/chat remains dominant.

**State C — Activity ambient.**
Builder tasks are running, schedule checks are pending, search results have been integrated. Multiple visual elements coexist in the canvas, each in their position. The conversational channel continues; the activity is *with* it, not over it.

**State D — Artifact focused.**
User taps an artifact (a bloomed seed, a card in chat) OR Sophia calls `attach_artifact_view` (voice). The artifact moves from periphery to center. Presence/chat shrinks to an anchor position. The artifact is now the primary visual. User and Sophia are looking at it together.

**State E — Multi-artifact view.**
Multiple artifacts in different states (gestating, bloomed, focused). The canvas shows them as a constellation in voice mode, or as a stack/tabs in text mode. The user can browse between them; one can be in focus while others remain peripheral.

### 5.2 State transitions

Transitions are *meaningful motion*, not instant snaps. Each transition has a duration on the order of 300-600ms with appropriate easing. The motion language is the same across all transitions:

| Transition | Motion | Duration |
|---|---|---|
| A → B (work emerging) | Seed/light fades in at peripheral position; cosmic ground subtly intensifies | ~400ms |
| B → C (work growing) | Seeds grow over time (real-time gestation); no discrete transition | continuous |
| C → D (focus shift to artifact) | Artifact moves from periphery to center; presence/chat docks to anchor position; canvas reorganizes | ~500ms |
| D → C (defocus) | Artifact recedes to periphery; presence/chat expands back | ~500ms |
| D ↔ D (focus shift between artifacts) | Current artifact recedes; new artifact emerges to center | ~400ms |
| Any → A (everything completed/dismissed) | Activity elements fade; presence reclaims canvas | ~600ms (gentler return to rest) |
| Crisis triggered | Canvas collapses to minimum; activity fades; presence simplifies (see §9.6) | ~300ms (firm) |

### 5.3 Multi-task handling

When multiple builder tasks run in parallel:

- Voice mode: each task is a seed in the space, positioned by emergence time (newer above older, or arranged as a constellation). Each gestates independently. Tapping any seed brings that task's progress detail or final artifact into focus.
- Text mode: each task gets its own pill marker inline in the chat where it was dispatched. The current artifact-in-focus (if any) lives in the adaptive canvas above or beside the chat. Tabs or a stack handle multiple focused artifacts.

The user can move freely between tasks. The system never forces them to wait or choose.

### 5.4 Mobile adaptation

On phone-sized viewports (≤480px):

- The canvas takes the full screen. Presence docks to a top or bottom bar (~60px) when work is active. Activity elements stack vertically. Artifact-in-focus takes over the entire screen with a small "back to chat/voice" indicator.
- Chat mode: chat column is the entire viewport; pills appear inline; tapping a pill opens the artifact full-screen.
- Voice mode: orb fills the upper portion; activity stacks below; full-screen takeover for focused artifacts; presence anchor returns when artifact is dismissed.

Hands-free voice: the screen-off case is bound by push notifications for builder completions and scheduled wakeups. State is preserved; reopening hydrates from the latest events.

### 5.5 Aesthetic continuity with the existing design

The current Sophia visual identity (cosmic ground, breathing orb, voice/text toggle, minimal chrome) is the constant. Every new visual element introduced by this spec must feel of this same world. Specifically:

- Soft edges, ambient glow, translucency over hard borders and shadows
- Color palette: the existing dark purple cosmic ground + warmer accents for state (see §6 for the specific motion vocabulary)
- Motion: organic, breath-like, never mechanical. Avoid linear easing; favor ease-out for emergence and ease-in for recession.
- Type: minimal text. Where text appears, it's spoken content (Sophia's words, transcripts, user input), not UI labels. Labels are visual states, not text.

---

## 6. Visual Language

The vocabulary of visual elements that the canvas uses. Each is described in terms of what it represents, how it appears, and what state it can be in.

### 6.1 Sophia presence — the breathing orb

What you already built. Persistent. The visual anchor of the relationship.

State variants:
- *Speaking* — full waveform animation, color reflecting tone band (cool blues for grief/shutdown, warm tones for engagement)
- *Listening* — attentive, gentle motion, no waveform
- *Holding silence* — distinct from listening: slower, more held; signals "this is being honored, not waiting"
- *Thinking* (rare, ≤500ms between user turn end and Sophia's first audio) — minimal cue, no motion
- *Crisis* — simplified, single color, no decoration; pulls no attention to itself

Position variants:
- *Centered* (default, State A)
- *Anchored* (when work is in focus; small, corner or edge position)

The orb is the same component across all states; what changes is animation speed, color, and position.

### 6.2 Cosmic ground

The dark purple background with subtle particle motion already present. Slightly responsive to activity: when nothing is happening, the ground is at rest. When work is gestating, the ground is faintly alive (particles move slightly). When an artifact is in focus, the ground recedes (darker, slower) so the artifact has visual room.

Never use the ground for UI elements. It's the *world*, not a surface to draw on.

### 6.3 Seeds — the gestation of async work

When Sophia delegates to the builder (`start_builder_task` fires), a seed appears in the space near the orb (voice mode) or as an inline pill in the chat (text mode, slightly different rendering but same semantic element).

Visual: small, slightly luminous form. Default state: a softly glowing point with a faint structural suggestion (could be a stylized seed shape, or just a centered light with a halo). Color: from the warmer end of the cosmic palette to distinguish from the cooler ambient ground.

Lifecycle:
- *Just planted* (0-30 seconds after dispatch): small, gentle pulse
- *Gestating* (30 seconds - until completion): grows slowly, internal motion visible if observed closely
- *Bloomed* (completed): a brief visual moment — flower opens, light brightens, the form resolves into a card or icon representing the artifact
- *Fading* (after user has engaged with artifact and dismissed it): returns to periphery as a smaller, dimmer representation that remains tap-able for later

Phase transitions within gestation (researching → drafting → finalizing) optionally cause a subtle color shift or rhythm change. The user doesn't need labels; they sense the change.

When tapped during gestation: the canvas focuses the seed and reveals the activity stream (tool calls, message deltas — see §5 for the rendering). When tapped after blooming: the artifact opens for viewing.

### 6.4 Lanterns — schedule checks

When `schedule_check` fires (voice spec §9), a lantern appears: a softly glowing form with a slow rhythm. Holds a faint indicator of time remaining (a thin ring that depletes, or an inner light that dims as the moment approaches).

Lifecycle:
- *Set* (lantern appears): gentle pulse
- *Holding* (waiting until the scheduled moment): slow, regular rhythm
- *Signaling* (the scheduled time arrives, scheduler fires synthetic wakeup): brightening, brief warm pulse
- *Fading* (Sophia has spoken her wakeup response): dims and dissolves

The lantern is positioned where the schedule was set; multiple lanterns can coexist if multiple schedules are active.

### 6.5 Inquiry lights — web searches and fetches

When `web_search` or `web_fetch` fires, a small inquiry light appears: minimal, ephemeral. Faint pulse while the search is in flight (typically 1-3 seconds per voice spec). When results arrive, the light resolves into a small card containing the query and a brief result excerpt.

Lifecycle:
- *Inquiring* (search firing): brief pulse, ~1-3 seconds
- *Resolved* (result available): expands to small card; remains tap-able for source detail
- *Fading* (after Sophia integrates the result and conversation moves on): card recedes to a peripheral position; remains accessible

If the user taps the resolved card: source URL opens (or the full fetch content displays for `web_fetch`).

### 6.6 Memory traces — optional

When Sophia calls `retrieve_memories` and the result materially influences her next response, a brief shape can appear: a faint star catching light momentarily, then dissolving. The metaphor: she's pulling something from memory.

This is *optional* visual nice-to-have. Risk: too much "she's thinking" theatricality can break the relational frame. Default OFF; enable as a setting for users who want visibility into when memory is invoked. Most users will never notice and that's fine.

### 6.7 Crisis mode visual collapse

When Sophia's `consult_skill("crisis_redirect")` fires (voice spec §5.13), the canvas visually collapses:

- All activity elements (seeds, lanterns, inquiry lights) fade to inactive states (no motion, dimmed)
- The cosmic ground stills
- The orb simplifies to single-color, slow rhythm
- The canvas draws no attention to itself

This is a SAFETY property. A user in crisis should not have visual noise pulling attention from the voice anchor. The visual collapse signals to anyone watching (including the user themselves) "this is the moment to be here." It's also functionally a sign that helps avoid surprises — if the user was mid-engagement with an artifact and crisis triggers, the canvas reducing to minimum signals the shift.

The collapse is automatic, triggered by the SSE event for `consult_skill("crisis_redirect")`. It persists until either the conversation visibly moves to a non-crisis state OR a configurable timeout (default 5 minutes of no crisis signals).

---

## 7. Data Sources and Stream Subscriptions

The frontend subscribes to three data sources, each serving a different concern. Together they drive the canvas state.

### 7.1 Companion stream via `@langchain/react` `useStream`

Sophia's conversation thread. Subscribed once per session.

```tsx
// In CompanionProvider or similar root context
const companion = useStream<SophiaCompanionState, {
  UpdateType: CompanionUpdate,
  CustomEventType: CompanionCustomEvent,
}>({
  apiUrl: '/api/lg-proxy',                  // thin Next.js auth proxy
  assistantId: 'sophia_companion',
  threadId: sessionThreadId,
});

// companion.messages → chat thread + voice transcript content
// companion.values → state snapshot (skills, memory refs, etc.)
// companion.isLoading → speaking/thinking indicators
// companion.error → reconnection or auth failure handling
```

The hook handles:
- Reconnect on network blips
- Replay on page reload (the v3 SDK pulls thread history)
- Typed projections (no custom transformation needed)

This data drives: the chat thread in text mode, the transcript in voice mode (when toggled on), the orb's tone-band color in voice mode (when companion's state.tone_estimate updates), the crisis state across the canvas.

### 7.2 Builder events stream via WebSSESink

Zero-to-N builder tasks running asynchronously. Per-user subscription.

```tsx
const builderEvents = useBuilderEvents({
  userId: currentUser.id,
});

// builderEvents.activeTasks → seeds in the canvas
// builderEvents.taskById(taskId) → focused task detail
// builderEvents.completedArtifacts → bloomed seeds, ready for viewing
```

The hook subscribes to `GET /api/builder-events/stream` (SSE endpoint, session-authenticated). The endpoint resolves the session to a `user_id` and registers with the gateway's `WebSSESink` (per Telegram spec §10.3 and frontend spec scope addition).

Events are `BuilderEvent` typed projections (v3-aligned per Telegram spec §10.1). The hook keeps a local cache indexed by `task_id`; events update the cache; React reads from it.

Reconnect: standard EventSource retry semantics. On reconnect, the SSE endpoint replays the last N events per task (TraceSink-backed catch-up); the hook reconciles by sequence number.

Page reload: on mount, the hook reads `GET /api/builder-tasks/active` to fetch currently-running task list, then subscribes to SSE for incremental events. Completed tasks within the session are also fetched via `GET /api/builder-tasks/session/{session_id}` to populate the bloomed-seed constellation.

### 7.3 Voice runtime stream via existing SSE

The voice runtime emits its own SSE events per voice spec §11.2 (`sophia.tool.web_search`, `sophia.tool.schedule_check`, `sophia.artifact.emitted`, `sophia.shared_view.injected`, etc.). The voice spec's frontend contract is the authoritative list.

```tsx
const voiceEvents = useVoiceEvents({
  sessionId: currentSession.id,
  enabled: mode === 'voice',  // only subscribe in voice mode
});

// voiceEvents.activeSchedules → lanterns
// voiceEvents.activeSearches → inquiry lights
// voiceEvents.currentSharedView → ambient view state (sync with backend's <view> block)
// voiceEvents.lastArtifactEmission → state model snapshot (for tone-band color)
```

The voice SSE subscription only activates in voice mode. In text mode, it's idle (the voice runtime isn't running).

### 7.4 Three streams merge into one canvas

The three streams feed independent state slices, but the canvas reads from all three to render its current state:

```
                ┌───────────────────────────┐
                │ Companion stream          │
                │ (useStream)               │
                │ - messages                │
                │ - state.tone_estimate     │
                │ - state.skill_loaded      │
                └────────────┬──────────────┘
                             │
                ┌────────────▼──────────────┐
                │ Canvas state coordinator  │
                │ - which state (A-E)?      │
                │ - what's in focus?        │
                │ - what's gestating?       │     ┌──────────────────────────────┐
                │ - crisis mode?            │◄────│ Builder events stream        │
                │                           │     │ (useBuilderEvents)           │
                │                           │     │ - activeTasks                │
                │                           │     │ - completedArtifacts         │
                │                           │     └──────────────────────────────┘
                │                           │
                │                           │     ┌──────────────────────────────┐
                │                           │◄────│ Voice runtime stream         │
                │                           │     │ (useVoiceEvents, voice mode) │
                └────────────┬──────────────┘     │ - schedules                  │
                             │                    │ - searches                   │
                             │                    │ - shared view                │
                             ▼                    └──────────────────────────────┘
                ┌───────────────────────────┐
                │ Canvas renderer           │
                │ - ambient layer (canvas)  │
                │ - focused layer (React)   │
                └───────────────────────────┘
```

The Canvas state coordinator is the single source of truth for what's on screen. It's a small store (Zustand or context) that subscribes to all three streams and computes derived state for the renderer.

### 7.5 Reconnect and offline behavior

**Network blip (a few seconds):** All three streams retry transparently. The user sees no change. Activity continues to render from cached state during the blip.

**Longer outage (>30 seconds):** The canvas shows a subtle non-alarming indicator (a faint dimming of the ambient ground, or a small reconnect icon at the edge). When reconnection succeeds, replays bring state current; if any state diverged, a "reconciling" moment briefly shows. No alert dialogs, no error toasts — the design accommodates spotty mobile networks.

**Page reload during active task:** Hydration from API endpoints (active tasks + session artifacts) restores the canvas to roughly the right state. The exact mid-flight event stream may have small gaps (subagent state per the page-reload caveat in earlier discussion), but the *outcome* state (task completed, artifact ready) is preserved.

**Closing the screen / app backgrounded:** State preserved on the backend via session log. Push notifications fire for: builder task completion, scheduled wakeup, crisis-redirect from another channel (rare cross-channel signal). The frontend reopens to the latest state.

---

## 8. Artifact Renderer Matrix

Every artifact carries a `type` field (per builder spec). The frontend has a dedicated renderer per type. They share a common shell (header, metadata, save/share controls, dismiss) but differ in their inner content.

### 8.1 Type-based routing

```tsx
function ArtifactRenderer({ artifact }: { artifact: BuilderArtifact }) {
  switch (artifact.type) {
    case 'markdown': return <MarkdownArtifactView {...artifact} />;
    case 'code': return <CodeArtifactView {...artifact} />;
    case 'image':
    case 'image_gallery': return <ImageArtifactView {...artifact} />;
    case 'pdf': return <PdfArtifactView {...artifact} />;
    case 'slides': return <SlidesArtifactView {...artifact} />;
    case 'data': return <DataArtifactView {...artifact} />;
    case 'interactive': return <OpenUIArtifactView {...artifact} />;
    case 'file':
    default: return <FileArtifactView {...artifact} />;
  }
}
```

### 8.2 MarkdownArtifactView

Renders markdown reports, articles, notes. Uses MDX with extensions for: code blocks (syntax-highlighted), tables, math (KaTeX), Mermaid diagrams. Comfortable reading width on desktop (~700px); fluid on mobile.

Library: `react-markdown` + `remark-gfm` + `rehype-highlight` + `remark-math` + `rehype-katex` + a Mermaid renderer. Standard stack.

### 8.3 CodeArtifactView

Read-only Monaco editor (or simpler syntax-highlighted view for smaller artifacts). Language auto-detected from file extension or carried in metadata. Copy button; line numbers; collapsible regions for long files.

Library: Monaco Editor (worth the bundle cost for the editor experience) OR Shiki for static rendering (smaller bundle if we don't need editing affordances). Decide based on whether v1 supports inline editing (probably not — artifacts are read-only by default; revision happens via `update_async_task`).

### 8.4 ImageArtifactView and ImageArtifactGallery

Single image: full-width display with download. Multiple images (`image_gallery`): grid with lightbox for individual viewing; arrow keys for navigation; thumbnail strip.

Library: standard `<img>` for single; `yet-another-react-lightbox` or similar for gallery.

### 8.5 PdfArtifactView

Inline PDF preview with pagination. Use `pdf.js` (the standard) for browser rendering. Toolbar: page nav, zoom, download. Search-within-PDF if pdf.js supports it (it does).

Mobile: pinch-to-zoom; swipe between pages.

### 8.6 SlidesArtifactView

For artifacts produced via the `pptx` skill (or any slide deck). Two backend paths:

1. **Backend-converted (v1 default):** When `emit_builder_artifact` fires with `type=slides`, a backend post-processor (headless LibreOffice or `python-pptx` + matplotlib) converts each slide to a PNG. The artifact metadata becomes `{type: "slides", slides: [{image_url, notes, title}, ...]}`.

2. **Native HTML (deferred to v2 of this spec):** Slides emitted as semantic HTML/CSS; frontend renders with native zoom and navigation. Better quality, allows search-in-slides, but substantially more implementation effort. Out of scope for v1.

V1 renderer: image carousel with notes below. Swipe (mobile) or arrow keys (desktop) for navigation. Thumbnail strip at the bottom on desktop. Full-screen presentation mode on press.

### 8.7 DataArtifactView

For CSV, JSON, XLSX, or any tabular data. Renders as a sortable, filterable table using TanStack Table. Column types inferred from data; numeric columns sortable; search box for filtering.

For very large datasets (>10k rows): virtualized rendering. Pagination at the very large end.

Library: TanStack Table + a parser per format (`papaparse` for CSV, native JSON, `xlsx` library for Excel).

### 8.8 OpenUIArtifactView

For `interactive` artifacts: LLM-generated React components or UI trees. Uses OpenUI from Thesys (`thesysdev/openui`) for sandboxed rendering.

Implementation considerations:
- Sandboxed iframe or Web Worker for execution isolation
- Restricted React component primitives (no arbitrary JS execution at user level)
- Theme integration with our cosmic aesthetic (OpenUI primitives should adopt our color palette)
- Error boundary so a broken component doesn't crash the canvas

Library: OpenUI's React renderer + a sandboxing layer. Security review required before enabling in production.

This is the renderer with the highest implementation cost. Plan ~5 days dedicated to integration + security review.

### 8.9 FileArtifactView (fallback)

For unknown types or types we don't render natively: a download card with file metadata (name, size, type, created-at) and a download button. Always available; never the wrong answer.

### 8.10 Composition with the canvas

The renderer doesn't decide where it appears on screen — the canvas state coordinator does (per §5). Each renderer is just a content component:

```tsx
<AdaptiveCanvas>
  <PresenceAnchor /> {/* always present, position varies */}
  {focusedArtifact && (
    <CanvasFocus>
      <ArtifactRenderer artifact={focusedArtifact} />
    </CanvasFocus>
  )}
  {!focusedArtifact && peripheralArtifacts.map(a => (
    <CanvasPeripheral key={a.id}>
      <ArtifactSeed artifact={a} />
    </CanvasPeripheral>
  ))}
</AdaptiveCanvas>
```

Renderers can implement their own internal navigation (slides paging, PDF pagination) without involving the canvas. The canvas handles the *outer* state (focused/peripheral/dismissed); renderers handle the *inner* state.

---

## 9. Voice Mode

Voice mode is presence-dominant by default. Sophia's orb is the primary visual element; activity emerges in the surrounding space.

### 9.1 Presence state machine

The orb has six states, each with its own animation profile:

| State | Trigger | Visual |
|---|---|---|
| Idle/listening | Default; user hasn't spoken yet, or pause between turns | Slow, gentle rhythm; cool tone |
| Sophia speaking | TTS audio is playing | Full waveform; tone-band-colored |
| Sophia thinking | Between user turn end and first audio chunk (~<500ms typical) | Brief, minimal cue; no full waveform |
| Holding silence | Sophia chose not to respond; user is in a moment | Slower, denser rhythm; distinct from idle listening |
| Speaking with shared view | Sophia is speaking while an artifact is in joint sight | Same as speaking, with subtle reference indicator (a line of light from orb to artifact) |
| Crisis | Crisis-redirect fired | Simplified to single color, minimum motion |

The orb component reads its state from the canvas state coordinator. State transitions are smooth (200-400ms).

The "holding silence" state is particularly important. Per voice spec §5.11 and §9.4: silence has presence. The visual signals to the user that the silence is intentional — Sophia is *with* them in it, not waiting for input. This is different from idle listening (which says "I'm here, speak when ready"). The distinction matters in moments of vulnerability.

### 9.2 Work emerging during conversation

Per §5 canvas states. When Sophia delegates to the builder:

1. State A → State B transition (~400ms)
2. A seed appears in the space, slightly off-center from the orb (peripheral position)
3. The seed shows minimal activity at first (planting pulse)
4. Over the next minutes (typical builder task: 1-3 minutes with interpreter+PTC), the seed gestates: grows slowly, color slightly shifts as phases transition (researching → drafting → finalizing)
5. When the builder emits the artifact, the seed blooms: visual moment of completion
6. Sophia, in her next conversational opening, speaks the integration ("Workshop came back...")
7. The user can engage with the artifact (tapping the bloomed seed) or continue conversation (leaving it peripheral)

Throughout: the orb continues normally. The user is still in conversation with Sophia. The seed is *with* them, not interrupting.

### 9.3 Shared sight integration (voice spec §5.14)

When the user taps a bloomed seed (or when Sophia calls `attach_artifact_view`), shared-sight mechanics engage:

1. The artifact moves to center of canvas (State C → State D)
2. The orb shrinks to its anchor position (corner of screen)
3. The backend `shared_view_manager` injects the artifact image into Sophia's Realtime session (per voice spec §3.5)
4. The `<view>` ambient block updates in her next turn's context
5. Sophia speaks naturally about what she sees, referencing specific visual elements

The user perceives: "I tapped this; the artifact got bigger; Sophia started talking about it specifically." The complex backend choreography is invisible.

A subtle visual flourish for shared-sight moments: a thin line of light briefly connects the orb to the artifact when injection completes, indicating "we're looking at this together now." Fades quickly (~1 second). Optional; could be too theatrical for some.

### 9.4 Schedule check countdown

Per voice spec §9: when Sophia calls `schedule_check`, a lantern appears in the space. The lantern shows:
- The reason Sophia stated when scheduling (small text, only visible on hover/tap)
- A subtle time-remaining indicator (a thin ring depleting, or an inner light dimming)
- The current state (waiting / approaching / signaling / fading)

User can tap the lantern at any time to see details: original reason, exact scheduled time, time remaining. This is useful for accountability ("did I actually commit to that?") and visibility into Sophia's understanding.

When the scheduled moment arrives, the lantern brightens; Sophia's voice fires the wakeup. The lantern then dims and dissolves.

### 9.5 Transcript toggle

The existing voice/text toggle hints at this, but the transcript here is finer-grained: a setting that, when enabled in voice mode, shows live transcription of Sophia's speech and the user's audio.

Default: OFF. Reason: voice is the primary channel; reading along can fragment the experience for many users.

Enable conditions:
- User-toggleable setting (persistent per user)
- Accessibility: a separate toggle that's more discoverable for users with hearing impairment
- Force-enabled when device audio output is unavailable (system-level check)

When enabled, transcript appears as soft floating text in the canvas: Sophia's words appear as she speaks, user's words appear as they're transcribed (with confidence indicator if STT is uncertain). Text fades after ~30 seconds or when scrolled past. Can be tapped to "save" a phrase to be findable later (deferred — v2 of this spec).

### 9.6 Crisis mode

Per §6.7. When `consult_skill("crisis_redirect")` fires:

1. State change to "crisis" across all visual elements
2. The orb simplifies (single color, slow rhythm)
3. All activity elements fade to minimum states
4. The cosmic ground stills
5. Transcript (if active) continues but visually softens
6. New artifact emissions are silent (no bloom animation, no seed sounds)
7. Sophia's voice carries the entire experience

The visual collapse persists until either:
- The voice runtime emits non-crisis events for >5 minutes (auto-recovery)
- The user explicitly toggles out (deferred — v2)

This is a safety property. Visual stillness supports the relational anchor.

### 9.7 Mobile considerations

On phone:
- Orb fills upper third of screen
- Activity elements stack below the orb
- Tapping any element brings it full-screen (artifact viewer takes over)
- Bottom: voice/text toggle + microphone button (existing)
- Settings/back button at top-left (existing)
- Push notifications for: builder completion when app backgrounded, scheduled wakeup when screen off

The screen-off case: voice continues to work (audio); state preserved. When user picks up the phone, they see the canvas reflecting all events that occurred while away.

---

## 10. Text Mode

Text mode is chat-dominant by default. The conversation thread fills the column; activity appears inline and expands to canvas on focus.

### 10.1 Chat thread layout

Standard chat-style layout, adapted to Sophia's aesthetic:

- Cosmic ground (preserved)
- Sophia's messages: soft, ambient appearance from upper-left; no avatar box (her presence is the whole experience, not a profile picture)
- User's messages: aligned right; lighter cosmic accent
- Input at bottom (existing "Say more..." with send button)
- Voice/text toggle (existing)
- Auto-scroll to most recent message (with "scroll up to see history" preserved)

Messages stream in via `useStream`. Sophia's messages appear character-by-character as the model produces them; this is now native to the v3 protocol.

### 10.2 Pill marker for builder delegations

When Sophia calls `start_builder_task` (visible via the companion stream's tool calls), a compact pill appears inline in the chat at that turn's position:

```
[ 🔨 Workshop · researching · 2m · view → ]
```

The pill:
- Static visual by default — doesn't update on every event (would create motion noise in the chat)
- Updates on phase transitions: "researching" → "drafting" → "finalizing" → "done"
- Updates on terminal state: "done" with a brief celebratory pulse
- Always tappable; tap opens the artifact in the adaptive canvas

The pill is the text-mode equivalent of the voice-mode seed. Different rendering for the different medium; same semantic role.

Multiple parallel tasks: each gets its own pill. They stack in chat history naturally.

### 10.3 Inline card expansion to canvas

When user taps a pill:

1. The chat column narrows (or, on mobile, slides aside)
2. The artifact opens in the adaptive canvas (State D)
3. Sophia's presence shifts: in text mode, she doesn't have a visible orb, but the chat-thread-narrowing serves the same function (her conversational channel is anchored, not central)
4. User can browse the artifact, ask Sophia about it (chat continues, narrower), close it to return to State A

Dismissing the artifact (close button or swipe-back): canvas returns to State A; chat expands back to full column.

### 10.4 Multi-task chat

Multiple pills in the chat at the same time = multiple parallel tasks. When user taps one, that's the focused artifact. To switch between active artifacts, user navigates to the other pill in chat OR uses a tab strip in the canvas (when one artifact is in focus, the canvas shows tabs/breadcrumbs to other tasks).

This is the text-mode equivalent of the voice-mode "constellation" — different rendering, same idea.

### 10.5 Mobile

On phone:
- Chat fills the column (default)
- Pills appear inline; tappable
- Tap takes over the entire screen with the artifact (canvas state D = full-screen overlay)
- Back gesture or close button returns to chat
- Multiple pills navigated by scrolling back in chat history

---

## 11. Mode Toggle

The voice ↔ text toggle (already exists in the UI) is the primary mode switcher. Its behavior:

### 11.1 Same session, different lens

Toggling does NOT:
- Start a new session
- Reset memory or chat history
- Cancel active builder tasks
- Disconnect Sophia

Toggling DOES:
- Switch which conversational channel is primary (voice ↔ text)
- Switch which canvas layout is rendered (presence-anchored vs chat-anchored)
- Connect/disconnect the voice runtime SSE subscription (only active in voice mode)
- Activate/deactivate the microphone (only in voice mode)

### 11.2 State persistence across modes

All state survives:
- Active builder tasks (continue to emit events, render as seeds or pills depending on current mode)
- Conversation history (re-rendered in the new mode's idiom)
- Memory state
- Currently focused artifact (if any — moves with the user)
- Session log

If the user is mid-conversation in voice and toggles to text, the most recent exchange appears at the bottom of the chat. The user can then type the next message OR toggle back to voice.

### 11.3 Implementation

The toggle dispatches to a session-level state field. All UI components read from this field:

```tsx
const mode = useSessionMode();  // 'voice' | 'text'

// In components:
{mode === 'voice' && <VoiceModeCanvas />}
{mode === 'text' && <TextModeCanvas />}
```

Stream subscriptions check mode: voice runtime SSE only subscribes when `mode === 'voice'`. Companion useStream and builder events SSE subscribe always.

### 11.4 Read-only artifact view (deferred)

A potential third mode: "artifact view" where the user can focus entirely on browsing/reading what was made, with conversation collapsed. Could be useful for users who want to reference past artifacts without re-engaging Sophia.

Deferred to v2. Implementation cost is low (it's already covered by the canvas in State D, just with conversation channel hidden); the question is whether it deserves a third toggle position or stays as an implicit state.

---

## 12. Identity and Onboarding

The existing identity binding flow (Sophia EI bot Telegram /start, web sign-in) is unchanged. This section covers the frontend-specific aspects.

### 12.1 First-time experience

On first session, the canvas shows the existing welcome ("Opening a gentle space..."). After binding, the orb appears in default state; Sophia introduces herself in voice or text per the user's first choice.

No tutorial overlay. The interface is meant to be discovered by use. The voice/text toggle, the microphone, the back button are familiar enough not to require explanation.

### 12.2 Shared sight disclosure

Important: before the first time Sophia uses shared sight (the first focus event or `attach_artifact_view` call in a user's history), show a brief one-time disclosure:

> "Sophia can see what you're looking at when you bring an artifact forward. This lets her discuss specifics with you. Images are shared with the AI provider for the duration of your conversation."

One-time, dismissible, doesn't appear again for that user. Privacy is a real concern with vision; explicit disclosure builds trust.

### 12.3 Settings discoverability

Settings (existing gear icon top-right) houses:
- Voice/transcript toggle (separate from mode toggle; controls auto-transcription within voice mode)
- Accessibility options (motion reduction, transcript always-on, etc.)
- Memory visibility (what Sophia remembers — deferred to memory UI spec)
- Logout / session controls

---

## 13. Implementation Architecture

### 13.1 Component tree (high level)

```
<SophiaApp>
  <SessionProvider>
    <ModeProvider>           {/* 'voice' | 'text' */}
      <StreamProvider>       {/* useStream + builder SSE + voice SSE */}
        <CanvasStateProvider>{/* derived canvas state */}

          <AmbientCanvas /> {/* WebGL/Canvas2D for cosmic ground, orb, seeds */}

          {mode === 'voice' && (
            <VoiceLayer>
              <PresenceOrb />
              <ActivityElements />  {/* seeds, lanterns, lights */}
              <FocusedArtifact />   {/* when applicable */}
              <TranscriptOverlay /> {/* when enabled */}
              <VoiceControls />     {/* mic, toggle */}
            </VoiceLayer>
          )}

          {mode === 'text' && (
            <TextLayer>
              <ChatThread />
              <FocusedArtifact />   {/* when applicable */}
              <TextInput />
            </TextLayer>
          )}

          <Chrome>
            <BackButton />
            <ModeToggle />
            <SettingsButton />
          </Chrome>

        </CanvasStateProvider>
      </StreamProvider>
    </ModeProvider>
  </SessionProvider>
</SophiaApp>
```

### 13.2 State management

Three layers:

1. **Stream state** — handled by `useStream` (companion) and custom hooks (`useBuilderEvents`, `useVoiceEvents`). Each hook owns its data.

2. **Derived canvas state** — a small Zustand store reading from the three streams, computing canvas state A/B/C/D/E, focused artifact id, active task list. This is the *coordinator* (§7.4).

3. **UI state** — local React state for modal open/closed, hover states, etc. Standard component state.

No Redux. No global event bus beyond the canvas state store.

### 13.3 Routing

Next.js app router:

- `/session/[sessionId]` — main session UI (current `sophia-ei.com/session`)
- `/api/lg-proxy/*` — auth proxy to LangGraph Server (companion stream)
- `/api/builder-events/stream` — SSE endpoint for builder events
- `/api/builder-tasks/active` — hydration endpoint for active tasks on reload
- `/api/builder-tasks/session/:sessionId` — hydration for session artifacts
- `/api/voice-events/stream` — voice runtime SSE proxy
- `/login`, `/onboarding`, etc. — existing auth flows unchanged

### 13.4 Auth proxy

The LangGraph Server endpoint and gateway SSE endpoint both require backend tokens that shouldn't reach the browser. A thin Next.js middleware:

```tsx
// app/api/lg-proxy/[...path]/route.ts
export async function GET(req: NextRequest, { params }) {
  const session = await getServerSession();
  if (!session) return new Response('Unauthorized', { status: 401 });

  const upstream = await fetch(
    `${process.env.LANGGRAPH_SERVER_URL}/${params.path.join('/')}`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.SOPHIA_BACKEND_TOKEN}`,
        'X-Sophia-User-Id': session.userId,
      },
    }
  );

  return new Response(upstream.body, {
    headers: upstream.headers,
    status: upstream.status,
  });
}
```

Same pattern for SSE endpoints. The proxy validates the user session, attaches backend auth, forwards the request. Pure pass-through — no transformation.

### 13.5 Canvas vs DOM performance

The ambient layer (cosmic ground, orb animation, seed gestation, lantern rhythm, etc.) is a single `<canvas>` element with all elements rendered there. Reasons:

- Smooth animation at 60fps without React reconciliation overhead
- No layout thrashing from many concurrent DOM animations
- Composition: elements naturally layer in the canvas (lanterns near orb, etc.)
- Mobile performance: canvas with GPU compositing is faster than many animated DOM elements

The focused layer (artifact renderers, chat messages, controls) is standard React DOM. These don't animate continuously; they're either visible or not.

The two layers communicate:
- Canvas listens to canvas state from the store
- React UI overlays the canvas
- Tap events on canvas elements are translated to events handled by React (canvas does hit-testing internally)

### 13.6 Build and bundling

Estimate of bundle size impact per major addition:
- Canvas library (TBD, see Open Questions): 50-150KB
- Monaco editor (if used for code): ~700KB (lazy-loaded)
- pdf.js: ~300KB (lazy-loaded)
- TanStack Table: ~30KB
- OpenUI integration: TBD, expect 100-300KB
- Markdown stack (react-markdown + plugins): ~100KB

Strategy: critical path (chat, voice, canvas) loaded eagerly; artifact renderers code-split and lazy-loaded per artifact type. Initial bundle should stay under 500KB gzipped.

---

## 14. Implementation Phasing

Total estimated effort: ~5-6 weeks frontend work, depending on parallelization and design iteration cycles.

### Phase A — Companion `useStream` foundation (~3 days)

- Replace existing companion message rendering (whatever currently powers `/session`'s text mode) with `@langchain/react`'s `useStream` against a Next.js auth proxy
- Verify reconnect/replay behavior with deliberate disconnection tests
- Existing chat UI continues to work; just streaming-native now

No user-visible change. Lands without depending on backend changes from the Telegram spec.

### Phase B — Builder events plumbing (~3 days)

- Build `useBuilderEvents` hook subscribing to `/api/builder-events/stream` (SSE)
- The SSE endpoint requires Telegram spec Phase 1's `WebSSESink` to be merged — verify before starting
- Data layer only; no UI yet
- Page reload hydration via `/api/builder-tasks/active`

Behind feature flag `WEB_BUILDER_STREAMING_ENABLED=false`.

### Phase C — Text mode adaptive canvas (~6 days)

- Build the AmbientCanvas + canvas state coordinator
- Implement pill marker for builder delegations in chat
- Implement inline → canvas expansion for focused artifacts
- Chat narrowing when artifact in focus; chat re-expansion on close
- Mobile responsiveness for text mode

Does NOT yet require all artifact renderers — uses simple "view raw" fallback for unsupported types.

### Phase D — Artifact renderer matrix (~6-7 days)

- MarkdownArtifactView (1 day)
- CodeArtifactView with Shiki or Monaco (1.5 days)
- ImageArtifactView (0.5 days)
- PdfArtifactView with pdf.js (1 day)
- SlidesArtifactView with backend PNG conversion (1.5 days, includes backend PPTX→PNG implementation)
- DataArtifactView with TanStack Table (1 day)
- FileArtifactView fallback (0.25 days)
- OpenUIArtifactView with Thesys OpenUI + sandbox + security review (5 days, can parallelize with other phases — biggest effort)

Note: artifact renderer matrix can land progressively. Markdown + code + image first; PDF and slides next; OpenUI last.

### Phase E — Voice mode adaptive canvas (~6-8 days)

- Implement presence orb state machine (extending the existing orb)
- Seed gestation rendering (canvas layer)
- Lantern, inquiry light visual elements
- Shared sight integration (focus → backend signals → image injection — coordinate with voice spec implementation)
- Schedule check visualization
- Transcript overlay (optional, default off)
- Crisis mode collapse
- Mobile considerations (especially screen-off behavior)

Depends on voice spec Phase 2 being implementable (artifact rendering service, shared view manager).

### Phase F — Mode toggle infrastructure (~2 days)

- Session-level mode state
- Toggle handler that gracefully transitions UI without state loss
- Stream subscription gating (voice runtime SSE only active in voice mode)
- Persistence of mode preference per user

### Phase G — Polish, animation refinement, accessibility (~5 days)

- Motion design pass: every transition tuned for feel
- Accessibility audit: screen reader labels, motion-reduced mode, keyboard navigation
- Performance pass: canvas frame timing on low-end mobile
- Push notification setup
- Cross-browser testing
- Beta rollout to Davide + first internal users

### Sequencing relative to other work

```
Week 1: Frontend Phase A (companion useStream)
        ‖
        Telegram spec Phase 1 (foundation) — needed for Phase B

Week 2: Frontend Phase B (builder events plumbing)
        ‖
        Telegram spec Phase 2 (Telegram-side activation)
        ‖
        Frontend Phase C starts (text mode canvas)

Week 3: Frontend Phase C continues; Phase D starts (renderer matrix in parallel)

Week 4: Frontend Phase D continues; Phase E starts (voice mode canvas)
        ‖
        Voice spec Phase 2 implementation (provides shared sight backend)

Week 5: Frontend Phase E continues; Phase F (mode toggle)

Week 6: Frontend Phase G (polish, accessibility, beta)
```

The critical path: Phase B → Phase C requires gateway fanout (Telegram spec Phase 1 — first dependency). Phase E requires voice spec Phase 2 implementation for shared sight to work end-to-end.

Phase D (renderer matrix) can happen anytime Phase C is started, in parallel.

---

## 15. Risks and Trade-offs

### 15.1 Custom canvas layer has higher implementation cost than panel approach

Risk: a custom WebGL or Canvas2D layer is substantially more work than a panel-based UI. Animation, motion design, and cross-device performance all require dedicated attention.

Mitigation:
- Phase G is dedicated polish time
- Start with simpler Canvas2D, upgrade to WebGL only if needed for performance
- Library choice (Open Question §16) heavily influences complexity

Trade-off accepted: the differentiation is worth the cost. The cosmic-ground + adaptive-canvas aesthetic is what makes Sophia visually distinct from every productivity-app voice/chat product. Falling back to panels would commodify the interface.

### 15.2 Motion design needs studies before locking

Risk: the motion vocabulary (seed gestation, bloom, lantern signal, orb state transitions) lives or dies on feel. Specifications can't fully capture this.

Mitigation:
- Before Phase E, dedicate ~3 days to motion studies — prototype the 4-5 key transitions in code, get them right viscerally
- Iterate with Davide directly on feel; this is design work, not pure engineering
- Animation library choice should support fluid motion (Framer Motion, GSAP, etc.)

### 15.3 Identity coherence on first impression

Risk: a first-time visitor sees the cosmic interface and may not immediately understand they're meeting Sophia, the relational AI companion. Productivity-app cues (login, settings, microphone) are present but the rest is unfamiliar.

Mitigation:
- The "Opening a gentle space..." loading message already sets tone
- The orb appearing with Sophia's first words ("I'm here with you. What's on your mind?") establishes immediate presence
- No tutorial; the interface is meant to feel like meeting a person, not opening an app

### 15.4 Accessibility considerations

Risk: heavy reliance on visual + audio modalities can exclude users with sensory impairments. Custom canvas elements may not be screen-reader-friendly by default.

Mitigation:
- Phase G includes accessibility audit as scope, not as afterthought
- Transcript toggle is screen-reader-essential for hearing-impaired users
- ARIA labels on all interactive canvas elements
- Motion-reduced mode (system pref `prefers-reduced-motion`) honored throughout
- Keyboard navigation for all focusable interactions

This is a real concern, not a nice-to-have. Sophia's relational positioning means we can't gate access to users with sensory needs.

### 15.5 Mobile performance

Risk: continuous canvas animation on lower-end mobile devices may cause heat, battery drain, or jank.

Mitigation:
- Target 60fps on mid-tier mobile (iPhone 12-ish, Android 2-year-old flagship); 30fps acceptable on older devices
- Aggressive frame-rate adaptation (animate slower when device signals it)
- Battery API checks: reduce motion when battery low
- Pause animations when app is backgrounded

### 15.6 OpenUI sandboxing security

Risk: OpenUI's generated React components execute in the browser. Without proper sandboxing, a malicious or buggy generation could exfiltrate state, hang the page, or attempt other browser attacks.

Mitigation:
- Sandboxed iframe with strict CSP for OpenUI rendering
- No access to global window state or our session
- Component primitives whitelisted (no arbitrary `<script>` or `<iframe>` from OpenUI output)
- Security review before Phase D OpenUI integration ships to production

### 15.7 Cross-mode state persistence edge cases

Risk: toggling voice ↔ text mid-streaming could drop messages, lose mid-flight tool calls, or create stale UI state.

Mitigation:
- Mode toggle is debounced (can't fire faster than 500ms)
- Voice runtime SSE disconnect is explicit and acknowledged
- State coordinator handles mode change cleanly: deactivates voice subscriptions, preserves everything else
- Tests for the edge: toggle mid-streaming, toggle right after sending a message, etc.

---

## 16. Open Questions

**OQ1 — Canvas library choice.**

Options:
- Plain Canvas2D + RAF — minimal dependencies, full control, more implementation work
- PixiJS — Canvas2D + WebGL hybrid, well-suited to particle-style ambient elements, ~150KB
- three.js — WebGL only, overkill for our needs, ~600KB
- Framer Motion or similar — React-driven motion, but limits us to DOM elements which doesn't fit ambient layer well

Recommendation tentatively: PixiJS for ambient layer; Framer Motion for focused-layer React transitions. Decide after a 1-day prototype in Phase E kickoff.

**OQ2 — Specific animation easing curves and timing.**

The values in §5.2 transitions table are first-pass estimates. Motion studies in Phase G will refine. Don't lock these without testing.

**OQ3 — OpenUI sandbox model.**

Iframe vs Worker vs limited React reconciler? Each has trade-offs. Defer to Phase D OpenUI integration; security review answers this.

**OQ4 — Voice transcript default behavior.**

Currently spec says default OFF. Worth revisiting after first 10 users — if many enable it on first use, default ON might be the right call. Measure usage.

**OQ5 — Artifact versioning visibility.**

When Sophia revises an artifact (`update_async_task`), does the previous version remain accessible in the canvas? Currently spec implies "latest only" but doesn't address it. Probably needs a per-artifact version history that's accessible but not foregrounded. Defer to v2; clarify with first usage.

**OQ6 — Cross-mode persistence policy edge cases.**

What if user toggles to text mode while Sophia is mid-utterance in voice mode? Current spec: toggle gracefully truncates audio playback; text mode shows what was said up to that point. Edge worth testing.

**OQ7 — Push notifications scope.**

For builder completion when screen off: yes. For scheduled wakeups when screen off: yes. For other events (memory updates, new sessions for the same user): probably not. Where's the line? Defer to first usage; over-notifying erodes trust faster than under-notifying.

**OQ8 — Web mode parity with iOS app (future).**

When/if an iOS native app is built, does it share this architecture (web view) or render natively? Out of scope here, but worth flagging.

---

## 17. Appendices

### Appendix A — Wireframe descriptions for key states

For designer reference. Not exhaustive; intended as starting points for motion prototypes.

**State A (default presence, voice mode, desktop):**
- Centered orb, ~30% of viewport height
- Cosmic ground with subtle particle motion
- Bottom: voice/text toggle ("voice" selected), microphone button
- Top: back arrow (left), share/exit (right), settings (right)

**State A (default chat, text mode, desktop):**
- Center column ~700px, holds chat thread
- Sophia's most recent message visible near top: "I'm here with you. What's on your mind?"
- Bottom: input ("Say more..." with send button)
- Voice/text toggle above input
- Cosmic ground behind chat column

**State B (work emerging, voice mode):**
- Orb still centered, but slightly off-center (~10% shift)
- Seed appears at peripheral position, soft glow
- Subtle visual link (cosmic ground intensifies slightly)
- Orb rhythm continues unchanged

**State D (artifact focused, voice mode):**
- Orb shrinks to ~15% size, docks to lower-right corner
- Artifact takes center: occupies ~70% of viewport
- Artifact has soft edges, ambient glow, no hard frame
- Cosmic ground darkens slightly to give artifact visual room
- A thin line of light briefly connects orb to artifact (~1s) at the moment shared sight engages

**State D (artifact focused, text mode):**
- Chat column narrows to ~30% (right side)
- Artifact takes left ~70%
- Chat continues to scroll with new messages
- Cosmic ground unchanged

**State E (multi-task constellation, voice mode):**
- Orb centered as in State A or anchored as in State D depending on whether one is in focus
- Multiple seeds visible in different positions, in different states of gestation
- Tapping one brings it forward; others remain peripheral

### Appendix B — Performance targets

- Canvas frame rate: 60fps on iPhone 13+, mid-tier Android 2024+; 30fps minimum on iPhone 11, Android 2022
- Initial page load: <2 seconds to first paint on broadband
- Initial bundle size: <500KB gzipped (excluding lazy-loaded renderers)
- Stream reconnect latency: <2 seconds for transient network blips
- Time to focus an artifact (tap → fully rendered): <500ms for typed artifacts; <2 seconds for lazy-loaded renderers (PDF, Monaco, OpenUI)
- Voice mode TTFA visual feedback (user stops speaking → orb shows "Sophia speaking"): <200ms (waveform animation initiates as audio chunks arrive)

### Appendix C — Library candidates (subject to OQ1 and final selection)

| Concern | Candidates |
|---|---|
| Ambient canvas | PixiJS, Canvas2D + RAF |
| Focused layer animations | Framer Motion, React Spring |
| Markdown rendering | react-markdown + remark/rehype plugins |
| Code rendering | Shiki (read-only) or Monaco Editor (with edit affordances) |
| PDF rendering | pdf.js |
| Slides | Backend PPTX→PNG; frontend image carousel |
| Data tables | TanStack Table |
| Interactive UI | Thesys OpenUI |
| State management | Zustand (canvas coordinator), useStream (companion), custom hooks (builder/voice) |

### Appendix D — References

- `@langchain/react` `useStream` — https://docs.langchain.com (v3 streaming hooks)
- Thesys OpenUI — https://github.com/thesysdev/openui
- pdf.js — https://mozilla.github.io/pdf.js/
- TanStack Table — https://tanstack.com/table
- Framer Motion — https://www.framer.com/motion/
- PixiJS — https://pixijs.com/

---

## End of Spec v2.0

The frontend lives or dies on aesthetic execution. The architectural decisions in §4 set the boundaries; the visual language in §6 sets the vocabulary; the phasing in §14 sets the order of work. But the *feel* of the seeds gestating, the orb breathing, the artifacts blooming — those need motion design iteration with Davide directly, not just specifications.

This spec is the technical foundation. The aesthetic refinement happens in Phase E + Phase G with prototyping in code, not on paper.
