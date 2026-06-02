# Artifact Review Visual UX Audit

Date: 2026-06-02
Branch: `test/coreview-still-review-on-codex-stream`
Scope: generated artifact review experience in the session UI.
Status: audit and implementation plan only. No code implementation in this task.

## Goal

Make generated artifacts feel native, premium, and coherent in both text mode and voice mode.

The desired product is a document/canvas review surface, not a debug fixture and not a transport demo. A user should see the artifact as a real object on a premium stage, understand whether Sophia is looking at it, understand whether the visible frame is fresh or stale, and understand whether exact text is available for precise words, numbers, citations, and table values.

## Current UI Inventory

### Text Mode

Current layout:

- `frontend/src/app/session/page.tsx` keeps the conversation pane as the main surface when `focusMode === "text"`.
- `SessionConversationPane` fills the primary viewport.
- `PresenceArtifactPanel` is mounted inline above the composer when `showArtifacts` is true.
- `BuilderCompletionCard`, `BuilderTaskNotice`, and `BuilderReadyPill` appear above the composer when the builder has progress or a deliverable.
- `ModeToggle` sits near the composer and carries the insight/artifact indicator.
- `VoiceMetricsPanel` is mounted even in text mode as a floating telemetry toggle.

What the user sees:

- Chat remains dominant.
- Artifacts appear as a compact panel or pill near the composer.
- Builder deliverables are summarized and can be opened or downloaded.
- There is no persistent document viewer, page viewport, page rail, zoom control, pan control, or in-session rendered file preview.

### Voice Mode

Current layout:

- `frontend/src/app/session/page.tsx` hides the conversation pane when `focusMode !== "text"` but keeps it mounted.
- `VoiceCaption`, `WhisperIndicator`, `ReflectionOverlay`, `ModeToggle`, and `VoiceFirstComposer` occupy the main voice experience.
- `PresenceArtifactPanel` floats above the mic/composer region at `bottom-[155px]`, `max-w-[440px]`.
- Builder completion and builder task notices appear as fixed overlays around `bottom: 180px`.
- The voice artifact panel auto-dismisses after 18 seconds for companion artifacts, but not when builder deliverables or DOM artifact co-review are present.

What the user sees:

- The artifact is an accessory overlay, not the main stage.
- Voice captions are pushed up with `.voice-caption-raised` when artifacts are open.
- Builder deliverables can overlap the same lower-middle stage as voice controls.
- Sophia's listening/speaking presence remains primary; the generated artifact does not become the room's focal object.

### Artifact Panel

Primary files:

- `frontend/src/app/components/session/PresenceArtifactPanel.tsx`
- `frontend/src/app/components/session/ArtifactsPanel.tsx`
- `frontend/src/app/session/artifacts.ts`
- `frontend/src/app/companion-runtime/artifacts-runtime.ts`

Current behavior:

- `PresenceArtifactPanel` renders companion artifact content as atmospheric text: takeaway, reflection prompt, and memory candidates.
- `ArtifactsPanel` renders a compact "artifacts" drawer with progress dots for takeaway, reflection, and memories.
- `BuilderDeliverableCard` renders metadata: artifact type, steps, title, summary, decisions, sources, next action, and file links.
- `BuilderDocumentLibrary` renders a list of saved builder files with Open and Download links.
- Artifact readiness is modeled as three local statuses: `waiting`, `capturing`, and `ready`.

Current limits:

- No generated document is embedded as the reviewed object.
- Builder file content is not rendered inside the session UI.
- One-page documents, multi-page PDFs, reports, and slide-like artifacts all collapse into metadata and links.
- Existing panels are expressive and atmospheric, but not document-native.

### Builder Canvas

Primary files:

- `frontend/src/app/types/builder-canvas.ts`
- `frontend/src/app/session/builder-canvas-completion.ts`
- `frontend/src/app/components/session/BuilderTaskNotice.tsx`
- `frontend/src/app/components/session/BuilderActivityLog.tsx`
- `frontend/src/app/session/useSessionBuilderArtifactLibrary.ts`
- `frontend/src/app/api/sophia/builder/threads/[parentThreadId]/canvas/*`

Current behavior:

- Builder canvas means builder task progress: phase, activity, terminal completion, recent events, active task snapshot.
- The UI shows live builder progress, todos, activity entries, stuck state, completed state, and a ready pill.
- `completionFromTerminalCanvasTask` can synthesize a completion event from a terminal canvas task and available builder artifact metadata.
- `useSessionBuilderArtifactLibrary` polls `/api/threads/{threadId}/artifacts` for saved files.

Current limits:

- Builder canvas does not provide a visual artifact page viewport.
- It does not model page count, zoom, pan, annotation, or visual review status.
- The progress canvas and the artifact review canvas are currently separate concepts in the UI.

### Generated Artifact Rendering

Primary files:

- `frontend/src/app/lib/builder-artifacts.ts`
- `frontend/src/app/api/threads/[threadId]/artifacts/[...artifactPath]/route.ts`
- `frontend/src/app/api/threads/[threadId]/artifacts/route.ts`
- `frontend/src/app/components/session/ArtifactsPanel.tsx`
- `frontend/src/app/components/session/PresenceArtifactPanel.tsx`

Current behavior:

- Generated builder files are fetched through a same-origin proxy route.
- `buildThreadArtifactHref` returns Open and Download URLs.
- File metadata is normalized into `BuilderArtifactV1` and `BuilderArtifactLibraryItemV1`.
- `.docx`, `.pptx`, `.xlsx`, PDFs, Markdown, reports, and other outputs are not normalized into a common viewer surface.
- Some download-first extensions are detected in `BuilderCompletionCard`, but the current UX still exposes a file-action card rather than a native viewer.

Current limits:

- No iframe/object/embed preview.
- No PDF renderer or page rail.
- No Markdown/report renderer in the artifact stage.
- No slide-like page model.
- No artifact renderer capability model by MIME type or extension.

### Coreview Controls

Primary files:

- `frontend/src/app/components/session/CoReviewControls.tsx`
- `frontend/src/app/hooks/useArtifactCoReview.ts`
- `frontend/src/app/lib/co-review-transport.ts`
- `frontend/src/app/lib/co-review-still-frame-transport.ts`
- `frontend/src/app/lib/co-review-capture.ts`
- `frontend/src/app/lib/co-review-frame.ts`
- `frontend/src/app/lib/coreview-artifact-text.ts`
- `frontend/src/app/components/session/CoreviewRealArtifactCanvas.tsx`
- `frontend/src/app/components/session/CoreviewCompanionArtifactCanvas.tsx`

Current behavior:

- `CoReviewControls` renders Looking or Not Looking, a Review with Sophia / Stop Looking button, and text status items.
- Status items include Frame sent, Exact text available, Visual may be stale, Frame unavailable, and Visual missing.
- `useArtifactCoReview` resolves an artifact canvas, sends a still frame, records safe telemetry, and exposes `startReview`, `stopReview`, and `refreshReview`.
- Refresh exists in the hook and state machine, but `PresenceArtifactPanel` only wires start/stop. `canRefresh` currently returns `false`.
- Coreview visual capture is canvas-only.
- `CoreviewRealArtifactCanvas` draws a hidden metadata-only builder overview canvas.
- `CoreviewCompanionArtifactCanvas` draws a hidden companion artifact overview canvas.
- `registerCoreviewArtifactText` registers exact text sideband for trusted text reads.

Current limits:

- The visible artifact and the captured Coreview canvas are not the same product surface.
- Builder file contents are intentionally excluded from the Coreview metadata canvas.
- Exact text exists for metadata and companion artifact text, not arbitrary deliverable file contents.
- Status language is product-friendly in places, but some failure text can expose internal names such as `sendArtifactFrame missing` or `artifact_frame_refresh_failed`.
- The Review with Sophia control is attached to a compact panel, not elevated to the document stage.

### Telemetry Controls

Primary files:

- `frontend/src/app/components/session/VoiceMetricsPanel.tsx`
- `frontend/src/app/lib/voice-runtime-metrics.ts`
- `frontend/src/app/lib/voice-telemetry-report.ts`

Current behavior:

- `VoiceMetricsPanel` is mounted in the session page with `layout="floating"`.
- The toggle is fixed on the right side: bottom on mobile, top-right on desktop.
- Expanded telemetry includes Copy JSON, Export JSON, Reset, Collapse, Close, and a resize handle.
- Gemini runtime details include Coreview frame counts, exact text status, builder metrics, artifact counts, and event counters.

Current limits:

- Telemetry is visually prominent for a user-facing session surface.
- It competes with the artifact stage location, especially in voice mode.
- Product review state and developer telemetry are not visually separated.
- The panel label "Telemetry" is acceptable for development but should not be part of the premium artifact review UI.

### Design Tokens, Components, And Styles

Primary files:

- `frontend/src/app/globals.css`
- `frontend/src/app/theme.ts`
- `frontend/components.json`

Current assets:

- Tailwind v4 CSS-first setup via `@import "tailwindcss"` and `@theme extend`.
- Theme tokens include `--sophia-purple`, `--sophia-glow`, `--bg`, `--text`, `--text-2`, `--card-bg`, `--card-border`.
- Cosmic tokens include `--cosmic-panel-soft`, `--cosmic-panel`, `--cosmic-panel-strong`, `--cosmic-border-soft`, `--cosmic-border`, `--cosmic-text-*`, `--cosmic-teal`, and `--cosmic-amber`.
- Reusable classes include `cosmic-chrome-button`, `cosmic-surface-panel`, `cosmic-surface-panel-strong`, `cosmic-accent-pill`, `cosmic-ghost-pill`, `cosmic-focus-ring`, `cosmic-reading-corridor`, and `text-mode-elevated`.
- Visual-tier fallbacks exist through `html[data-visual-tier="1"]` and `html[data-visual-tier="2"]`.

Design implication:

- The artifact review UI should reuse the existing cosmic tokens and visual-tier system.
- A premium document viewer should feel quieter and more material than the current floating artifact aura, especially for long-form reports and PDFs.

## Target Product Experience

### Generated Artifact Ready State

When an artifact is ready:

- The UI promotes it from a builder ready pill into a visible artifact stage.
- The stage shows the artifact title, file type, page count if known, primary action, and review status.
- The primary action is not "open in a new tab" by default. The artifact appears in-session first.
- Open in new tab and Download remain secondary actions.
- The stage should support a generating state, ready state, failed state, and unavailable preview state.

### One-page Document

Target behavior:

- A one-page artifact appears centered in a premium page viewport.
- Toolbar controls include zoom in/out, fit width/page, reset view, refresh view, open, and download.
- The page can be panned when zoomed.
- Sophia's looking status appears near the Review with Sophia action, not buried in debug text.
- Exact text availability is visible as a small badge.

### Multi-page PDF Or Report

Target behavior:

- A page rail or compact page navigator appears when the artifact has multiple pages.
- Users can move between pages with previous/next buttons, page number input, keyboard shortcuts, and rail thumbnails when feasible.
- The stage supports fit to page and fit to width.
- The review frame should know the current page and zoom/pan context.
- Exact text sideband should support current page and whole-document modes once the trusted reader exists.

### Slide-like Artifacts

Target behavior:

- Slide decks and visual reports feel like paged scenes, not generic downloads.
- Page rail labels should become Slide 1, Slide 2, etc. when the artifact type is presentation-like.
- Fit page should be the default for slide-like artifacts.
- Review with Sophia should send the current visible slide/frame.

### Voice-mode Artifact Stage

Target behavior:

- When an artifact is open in voice mode, the artifact becomes the main stage.
- Sophia's presence moves into stage chrome: listening/speaking state, caption, and review status.
- The mic/composer remains accessible but secondary.
- The artifact can stay open without auto-dismiss while review is active or while the user is inspecting it.
- Voice captions should not cover the artifact page.
- Builder progress can become a compact side/status strip instead of competing with the document.

### Review With Sophia States

Target states should be visible and human-readable:

- Not Looking: Sophia is not currently using a visual frame from the artifact.
- Capturing: the UI is preparing or sending the still frame.
- Looking: Sophia has a fresh artifact frame for the current view.
- Frame Sent: the frame was accepted by the frontend transport path.
- Stale: the user changed page, zoom, pan, or artifact content after the last frame.
- Failed: the frame could not be sent; give a short safe reason.
- Exact Text Available: Sophia can use trusted text for precise words/numbers.
- Exact Text Unavailable: Sophia can still visually discuss layout but should not pretend to read exact values.

## Gap Analysis

| Gap | Current behavior | Target behavior | Likely files/components | Risk | Suggested slice |
|---|---|---|---|---|---|
| No native artifact stage | Artifacts render as compact cards, pills, and file links. | A visible `ArtifactStage` renders the artifact as the main object. | `session/page.tsx`, `PresenceArtifactPanel.tsx`, `ArtifactsPanel.tsx`, new stage components. | Medium: layout and state ownership. | Slice 1 |
| Builder files are not embedded | Open/Download links proxy files out of session. | Primary deliverable renders in-session when previewable. | `builder-artifacts.ts`, artifact proxy routes, new renderer capability map. | Medium-high: MIME handling and browser security. | Slice 1, then Slice 3 |
| Voice mode treats artifacts as overlay | `PresenceArtifactPanel` floats above mic at a small max width. | Artifact becomes main stage with Sophia controls around it. | `session/page.tsx`, `PresenceArtifactPanel.tsx`, `VoiceCaption`, `VoiceFirstComposer`, `ModeToggle`. | High: voice layout, safe areas, captions, mobile. | Slice 4 |
| No page model | Artifact UI has no page count, page index, thumbnails, or page nav. | Single and multipage artifacts share a page model. | New `ArtifactPageRail`, `ArtifactCanvasViewport`, PDF/report renderer. | High: renderer dependency and document parsing. | Slice 3 |
| No zoom/pan model | No zoom, fit, pan, or reset controls exist. | Toolbar supports zoom, fit, pan, reset view. | New `ArtifactToolbar`, `ArtifactCanvasViewport`. | Medium: interaction complexity and mobile gestures. | Slice 1 for shell, Slice 3 for full behavior |
| Refresh View not visible | `refreshReview` exists but `canRefresh` is false and no button is wired. | Refresh View is visible while Looking or Stale. | `useArtifactCoReview.ts`, `CoReviewControls.tsx`, `PresenceArtifactPanel.tsx`. | Medium: state machine already has most plumbing. | Slice 2 |
| Stale state is coarse | `Visual may be stale` appears after a frame is sent while live. It does not react to page/zoom/pan changes. | Stale is tied to current view changes after last sent frame. | New stage state, `CoReviewControls`, `useArtifactCoReview`. | Medium: needs view signature/version. | Slice 2, Slice 3 |
| Captured canvas differs from visible artifact | Hidden Coreview canvases draw metadata overview, not the actual artifact page. | Still frame comes from the visible artifact viewport or a faithful offscreen page renderer. | `CoreviewRealArtifactCanvas.tsx`, `CoreviewCompanionArtifactCanvas.tsx`, `co-review-capture.ts`, new viewport renderer. | High: faithful rendering and privacy constraints. | Slice 2 for metadata, Slice 3 for file pages |
| Exact text is metadata-limited | Exact text sideband covers companion artifact text and builder metadata, not file contents. | Exact text badge reflects trusted artifact text availability for the selected file/page. | `coreview-artifact-text.ts`, backend `read_artifact_text`, file text extraction service. | High: backend trust and file parsing. | Slice 2 badge, later trusted reader |
| Status chips are too small | Looking/Not Looking and status items are inline text chips in compact panel. | Review status is a first-class stage element. | `CoReviewControls.tsx`, new `ArtifactReviewStatus`, `SophiaLookingChip`, `ExactTextBadge`. | Low-medium. | Slice 1, Slice 2 |
| Internal failure strings can leak | `coReviewErrorText` can show internal transport strings. | Product-safe failure copy only. | `CoReviewControls.tsx`, `useArtifactCoReview.ts`. | Low. | Slice 2 |
| Telemetry competes with product UI | Floating telemetry toggle and drawer sit over the session UI. | Developer telemetry is hidden behind a dev-only affordance or moved away from artifact controls. | `VoiceMetricsPanel.tsx`, `session/page.tsx`. | Medium: debugging workflow may rely on it. | Slice 5 |
| Builder progress and artifact review compete | Builder task notices, ready pills, completion cards, and artifact panel all occupy lower center space. | Builder progress collapses once the artifact stage is open. | `BuilderTaskNotice`, `BuilderReadyPill`, `BuilderCompletionCard`, `session/page.tsx`. | Medium. | Slice 1, Slice 4 |
| No annotation affordance model | No highlight/comment/annotation shell. | Later annotation layer can attach to page coordinates and exact text ranges. | New annotation model, page viewport. | High, but future. | Later |

## Proposed Component Model

### `ArtifactStage`

Top-level product surface for generated artifacts.

Responsibilities:

- Own artifact shell state: generating, ready, failed, preview unavailable.
- Coordinate title, type, current renderer, review status, and toolbar.
- Decide text mode vs voice mode layout variants.
- Receive builder file metadata and companion artifact content through normalized props.

### `ArtifactCanvasViewport`

The central page/document viewport.

Responsibilities:

- Render one page or current page.
- Manage zoom, pan, fit mode, viewport size, and stale view signature.
- Expose a canvas or offscreen-render source for still-frame capture.
- Provide a stable DOM root for Coreview capture lookup.

### `ArtifactToolbar`

Document controls.

Responsibilities:

- Previous/next page.
- Page count and page input.
- Zoom out, zoom in, fit page, fit width, reset view.
- Refresh View.
- Open in new tab and Download.
- Use lucide icons with accessible labels/tooltips.

### `ArtifactPageRail`

Multipage navigation.

Responsibilities:

- Show page thumbnails where available.
- Fall back to compact page numbers when thumbnails are unavailable.
- Mark current page.
- Use "Page" or "Slide" labels based on artifact type.

### `ArtifactReviewStatus`

Review state summary.

Responsibilities:

- Combine looking state, frame status, stale state, and exact text status.
- Render safe product copy only.
- Provide aria-live updates for status changes.

### `SophiaLookingChip`

Compact stage chrome for Looking / Not Looking / Capturing.

Responsibilities:

- Use Eye/EyeOff/Loader icons.
- Never mention Coreview, Gemini, frames, transport, or video.
- Use "Looking", "Not looking", and "Preparing view" style labels.

### `ExactTextBadge`

Trusted-text availability indicator.

Responsibilities:

- Show "Exact text available" or "Exact text unavailable".
- Explain through tooltip/copy that exact text is used for precise words/numbers.
- Avoid exposing sideband implementation details to normal users.

### `ReviewWithSophiaButton`

Primary review action.

Responsibilities:

- Start review when idle.
- Stop review when looking.
- Disable with safe reason when no capture source or exact text is unavailable.
- Pair with Refresh View while looking/stale.

### `VoiceArtifactStage`

Voice-specific stage wrapper.

Responsibilities:

- Promote `ArtifactStage` to the main scene in voice mode.
- Place mic/composer controls below or beside the stage.
- Keep Sophia's listening/speaking state visible without obscuring the artifact.
- Keep review status always visible.

### `ArtifactRenderer`

Renderer capability layer.

Responsibilities:

- Choose renderer by MIME/extension/type: PDF, Markdown/report, image, HTML/webpage, slide deck fallback, unsupported/download-only.
- Produce preview metadata: page count, page status, exact text availability, capture source status.
- Defer risky formats to download-first behavior until safe rendering exists.

## State Model

Product-level state should be explicit and separate from lower-level transport state.

```ts
type ArtifactStatus = "generating" | "ready" | "failed";
type ReviewStatus = "idle" | "capturing" | "looking" | "stale" | "failed";
type ExactTextStatus = "available" | "unavailable";
type PageStatus = "single" | "multipage";
type VoiceMode = "text" | "voice";

type ArtifactReviewViewState = {
  artifactStatus: ArtifactStatus;
  reviewStatus: ReviewStatus;
  exactTextStatus: ExactTextStatus;
  pageStatus: PageStatus;
  voiceMode: VoiceMode;
  pageIndex: number;
  pageCount: number | null;
  zoom: number;
  fitMode: "page" | "width" | "custom";
  viewVersion: number;
  lastReviewedViewVersion: number | null;
};
```

Mapping guidance:

- `artifactStatus: "generating"` maps from active builder task running or artifact cards still capturing.
- `artifactStatus: "ready"` maps from builder artifact/library file or real companion artifact content.
- `artifactStatus: "failed"` maps from builder completion error/timeout/cancelled or preview fetch failure.
- `reviewStatus: "idle"` maps from `normal_voice` / `normal_voice_restored` with no active frame.
- `reviewStatus: "capturing"` maps from `co_review_starting` or `refreshFrameInProgress`.
- `reviewStatus: "looking"` maps from `co_review_live`, `visualInputStatus === "live"`, and current `viewVersion === lastReviewedViewVersion`.
- `reviewStatus: "stale"` maps from `co_review_live` when page, zoom, pan, or content changed after the last frame.
- `reviewStatus: "failed"` maps from `co_review_error` or frame send failure.
- `exactTextStatus: "available"` maps from registered trusted text source for the selected artifact/page.
- `pageStatus: "single"` maps from `pageCount <= 1` or unknown single-page renderer.
- `pageStatus: "multipage"` maps from `pageCount > 1`.
- `voiceMode` maps from `focusMode === "text" ? "text" : "voice"`.

## Implementation Slices

### Slice 1: UI Shell Only, No Behavior Changes

Goal:

- Introduce the artifact stage visually without changing Coreview, builder APIs, or artifact fetch behavior.

Work:

- Add `ArtifactStage`, `ArtifactCanvasViewport`, `ArtifactToolbar`, `ArtifactReviewStatus`, `SophiaLookingChip`, `ExactTextBadge`, and `ReviewWithSophiaButton` as UI shell components.
- Use existing builder metadata and file links as the initial content.
- In text mode, replace the compact artifact drawer for builder deliverables with a stage above or beside the conversation depending on viewport.
- In voice mode, keep current overlay behavior until Slice 4, but allow shell preview behind a feature flag or local branch guard.
- Reuse existing cosmic tokens and visual-tier fallbacks.

Acceptance:

- No behavior changes.
- Open and Download still work.
- Existing Coreview start/stop still work if enabled.
- The artifact looks like a native object, even before file preview is wired.

### Slice 2: Still-frame Review Controls Wired

Goal:

- Make Review with Sophia obvious and complete for the current still-frame path.

Work:

- Wire Refresh View from `useArtifactCoReview.refreshReview` into `CoReviewControls` or new `ReviewWithSophiaButton`.
- Change `canRefresh` from a hard false to a real computed value.
- Add safe product copy for failure reasons.
- Move status rendering into `ArtifactReviewStatus`.
- Track `viewVersion` and mark review stale when current view changes after a frame.
- Keep using the existing hidden metadata canvas until real page rendering is ready.

Acceptance:

- Review with Sophia starts/stops reliably.
- Refresh View is visible when useful.
- Looking / Not Looking / Frame sent / Stale / Exact text available are clear.
- No internal transport terms are visible.

### Slice 3: Multi-page PDF And Page Rail

Goal:

- Make PDFs/reports/slides reviewable as paged artifacts.

Work:

- Add renderer capability detection by file extension and content type.
- Add a PDF/page renderer or server-rendered page image strategy.
- Add `ArtifactPageRail` and page navigation.
- Add zoom/pan/fit/reset behavior.
- Ensure still-frame capture uses the current rendered page.
- Start with PDFs and Markdown/report outputs before `.pptx`/`.docx` native preview.

Acceptance:

- Single-page artifacts render as one centered page.
- Multipage artifacts show page navigation.
- Current page is reflected in review stale/fresh state.
- Non-previewable files fall back to a polished unavailable-preview state with Download.

### Slice 4: Voice-mode Artifact Stage

Goal:

- Make artifacts the primary stage during voice review.

Work:

- Add `VoiceArtifactStage` layout.
- Move mic/composer, captions, and Sophia presence around the artifact instead of over it.
- Convert builder progress into a compact status strip while an artifact is open.
- Keep review controls reachable by touch on mobile.
- Avoid auto-dismiss while inspecting or reviewing an artifact.

Acceptance:

- Voice mode feels like Sophia and the user are looking at the same object.
- Artifact remains visible while Sophia listens/speaks.
- Captions and controls do not cover the document.
- Layout works across desktop and mobile safe areas.

### Slice 5: Polish, Accessibility, And Responsive Behavior

Goal:

- Make the viewer production-grade.

Work:

- Add keyboard navigation for page and zoom controls.
- Add tooltips for icon-only controls.
- Add aria-live status updates for review state.
- Validate reduced-motion and visual-tier fallbacks.
- Move or gate developer telemetry so it does not compete with the artifact stage.
- Tune empty, failed, and unavailable-preview states.

Acceptance:

- Status is clear to screen readers.
- Text does not overflow controls.
- Controls remain tappable on mobile.
- Developer diagnostics do not look like product UI.

### Later: Annotations, Highlights, Comments

Deferred work:

- Annotation layer.
- Highlight selection.
- Comment pins.
- Text-range anchoring through trusted exact-text extraction.
- Page-coordinate anchoring.
- Sophia-generated review notes.

## Non-goals

This plan explicitly excludes:

- Liveframes.
- Dynamic fixture.
- Continuous video.
- Stream/Vision Agents changes.
- Direct-video terminology in the product UI.
- Provider, VAD, or voice turn-taking changes.
- M3, M4.4, or a full-control arbiter.
- Whole-window capture, `getDisplayMedia`, DOM capture, or tab capture.
- Raw frame telemetry.
- Raw artifact text in telemetry.
- Raw provider payloads in telemetry.
- Any change to builder delegation, builder task types, or async lifecycle behavior.

## Acceptance Criteria

The implementation should be considered successful when:

- The artifact viewer looks native and premium.
- Review with Sophia is obvious and reachable.
- Looking / Not Looking / Capturing / Stale / Failed status is clear.
- Frame sent status is clear without exposing internals.
- Exact text availability is clear.
- Text mode and voice mode feel like coherent variants of the same product.
- Voice mode can show the artifact as the main stage while Sophia listens or speaks.
- One-page artifacts render cleanly.
- Multipage artifacts have clear page navigation.
- Zoom, pan, fit, reset, refresh, open, and download controls are available where appropriate.
- No debug terminology is visible in the product review UI.
- No Coreview internals are exposed to the user.
- Existing telemetry remains available for development without competing with the artifact stage.

## Recommended First Slice

Start with Slice 1.

Reasoning:

- The largest product gap is not the still-frame transport. It is the absence of a native artifact stage.
- A UI shell can reuse existing file metadata, current open/download links, and current review controls without changing behavior.
- It gives later slices a stable home for page rendering, refresh, stale state, exact text status, and voice-mode staging.
- It reduces risk by separating visual hierarchy from renderer and transport work.

The first implementation should avoid PDF dependencies and avoid changing Coreview logic. Build the stage around current data, then wire behavior into it slice by slice.

## Key Files To Change In Implementation

Likely first files:

- `frontend/src/app/session/page.tsx`
- `frontend/src/app/components/session/PresenceArtifactPanel.tsx`
- `frontend/src/app/components/session/ArtifactsPanel.tsx`
- `frontend/src/app/components/session/CoReviewControls.tsx`
- `frontend/src/app/hooks/useArtifactCoReview.ts`
- `frontend/src/app/lib/builder-artifacts.ts`
- `frontend/src/app/lib/coreview-artifact-text.ts`
- `frontend/src/app/lib/co-review-capture.ts`
- `frontend/src/app/lib/co-review-frame.ts`
- `frontend/src/app/components/session/VoiceMetricsPanel.tsx`
- `frontend/src/app/globals.css`

Likely new components:

- `frontend/src/app/components/session/ArtifactStage.tsx`
- `frontend/src/app/components/session/ArtifactCanvasViewport.tsx`
- `frontend/src/app/components/session/ArtifactToolbar.tsx`
- `frontend/src/app/components/session/ArtifactPageRail.tsx`
- `frontend/src/app/components/session/ArtifactReviewStatus.tsx`
- `frontend/src/app/components/session/SophiaLookingChip.tsx`
- `frontend/src/app/components/session/ExactTextBadge.tsx`
- `frontend/src/app/components/session/ReviewWithSophiaButton.tsx`
- `frontend/src/app/components/session/VoiceArtifactStage.tsx`

## Risks

- File preview risk: PDFs, `.docx`, `.pptx`, `.xlsx`, HTML, Markdown, and images need different rendering strategies.
- Trust risk: exact text must come from trusted text extraction, not visual guessing.
- Layout risk: voice mode already has dense bottom chrome, captions, builder notices, telemetry, and mic controls.
- State risk: artifact status, builder status, review status, and exact text status currently live in separate systems.
- Privacy risk: still-frame capture must stay artifact-scoped and canvas-only.
- Regression risk: builder progress UI and artifact availability recovery are already solving real production problems and should not be removed abruptly.
- Debug UI risk: telemetry is useful, but user-facing review UX should not inherit telemetry language or placement.

## Product Copy Guidance

Use:

- `Review with Sophia`
- `Looking`
- `Not looking`
- `Preparing view`
- `Frame sent`
- `View changed`
- `Refresh view`
- `Exact text available`
- `Exact text unavailable`
- `Preview unavailable`

Avoid in user-facing UI:

- `Coreview`
- `Gemini`
- `transport`
- `websocket`
- `still-frame mode`
- `video`
- `fixture`
- `liveframes`
- raw safe-reason strings such as `artifact_frame_refresh_failed`
