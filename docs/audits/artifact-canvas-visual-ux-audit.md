# Artifact Canvas Visual UX Audit

Date: 2026-06-03
Branch: `test/coreview-still-review-on-codex-stream`
SHA: `e58f2942`
Scope: current artifact canvas, generated artifact review, still-frame co-review, and the visual surface around those flows.
Status: audit only. No runtime behavior changed.

## 1. Executive Summary

The current artifact review experience has moved beyond a pure link/card flow: builder artifacts can now open into a visible `ArtifactStage`, Markdown artifacts can be rendered as a document-like preview, and Coreview can send one artifact-scoped still frame with exact-text sideband support. That is meaningful progress, but the experience still does not yet feel like the premium, immersive Sophia workspace described by the target vision.

The main issue is not one missing style token. The current product surface is still a collection of adjacent surfaces: builder completion cards, ready pills, session-file rows, text-mode split stage, voice-mode floating stage, companion artifact overlays, old `ArtifactsPanel` cards, hidden Coreview canvases, and hard-coded single-page toolbar labels. Those pieces work functionally, but the hierarchy is uneven and the artifact does not always feel like a first-class object.

The strongest next slice should focus on the shell before adding PDF rendering: make the stage feel fully bounded, make the canvas fill intentional, unify status/toolbar/chip placement, and make the Sophia review state visibly integrated with the canvas. PDF and multipage support should come after the shell has a clear page model.

Top visual gaps:

1. The canvas is not yet visually premium or complete enough to carry the artifact as a first-class workspace object.
2. The viewport/page composition can create dead space and a narrow centered document trap on wide layouts.
3. Canvas/background fill is not governed by a clear contract, so black/dark underfill and interior background mismatch can still show through.
4. Review status chips are functional but fragmented across text, voice, and companion flows.
5. Sophia purple is present in buttons and subtle accents, but the active review state often reads teal/status-system instead of Sophia-owned.
6. Text mode and voice mode use the same core stage but different chrome, producing different visual emphasis.
7. The toolbar advertises page and zoom concepts, but page count is hard-coded and zoom/fit controls are disabled.
8. PDFs, slides, docs, spreadsheets, images, and HTML artifacts fall back to metadata or external open/download behavior.
9. Multiple artifact surfaces remain visually inconsistent: `PresenceArtifactPanel`, `ArtifactStage`, `ArtifactsPanel`, `BuilderCompletionCard`, `BuilderReadyPill`, recap/onboarding deliverable cards, and session-file rows.
10. Stale visual state is not tied to a page/zoom/pan/view signature, which will become more visible once multipage review exists.

## 2. Current Surface Inventory

### Text-Mode Generated Artifact Stage

Primary files:

- `frontend/src/app/session/page.tsx`
- `frontend/src/app/components/session/PresenceArtifactPanel.tsx`
- `frontend/src/app/components/session/ArtifactStage.tsx`
- `frontend/src/app/components/session/ArtifactCanvasViewport.tsx`
- `frontend/src/app/components/session/ArtifactToolbar.tsx`
- `frontend/src/app/components/session/ArtifactReviewStatus.tsx`

Current flow:

- In text mode, `session/page.tsx` creates a two-pane split workspace only when `showArtifacts`, `showArtifactsUi`, and a builder artifact or artifact library are present.
- The conversation area remains on the left/top; the artifact stage area appears on the right on large screens and below the conversation on smaller screens.
- `PresenceArtifactPanel` detects a builder artifact and renders `ArtifactStage`.
- `ArtifactStage` composes a toolbar, `ArtifactCanvasViewport`, and a review footer.
- The visible stage can fill available height through `fillAvailable`, but the document/page inside the viewport stays capped by max-width values.

### Text-Mode Companion Artifact Panel

Primary files:

- `frontend/src/app/session/page.tsx`
- `frontend/src/app/components/session/PresenceArtifactPanel.tsx`
- `frontend/src/app/components/session/CoReviewControls.tsx`
- `frontend/src/app/components/session/CoreviewCompanionArtifactCanvas.tsx`

Current flow:

- When text mode has only companion artifacts and no builder artifact/library, `PresenceArtifactPanel` stays inline above the composer.
- It renders takeaway, reflection, and memory candidate content in an atmospheric text panel.
- If Coreview is enabled and no builder artifact is selected, the companion content can expose a hidden companion artifact canvas and `CoReviewControls`.

### Voice-Mode Artifact Stage

Primary files:

- `frontend/src/app/session/page.tsx`
- `frontend/src/app/components/session/PresenceArtifactPanel.tsx`
- `frontend/src/app/components/session/VoiceArtifactStage.tsx`
- `frontend/src/app/components/session/ArtifactStage.tsx`

Current flow:

- In voice mode, `PresenceArtifactPanel` is fixed in the central voice surface.
- When a builder artifact exists, the panel becomes a large bounded floating stage from roughly below the top chrome to above the mic/composer area.
- `VoiceArtifactStage` wraps `ArtifactStage` with a top status row and a bottom review button.
- `ArtifactStage` is reused inside voice mode with its own review footer disabled.
- Voice mode also raises the voice caption while artifacts are open to avoid overlap.

### Builder-Generated Artifact Open Flow

Primary files:

- `frontend/src/app/session/page.tsx`
- `frontend/src/app/components/session/BuilderCompletionCard.tsx`
- `frontend/src/app/components/session/BuilderReadyPill.tsx`
- `frontend/src/app/components/session/BuilderTaskNotice.tsx`
- `frontend/src/app/session/useSessionBuilderArtifactLibrary.ts`
- `frontend/src/app/lib/builder-artifacts.ts`

Current flow:

- `BuilderCompletionCard` appears after a builder completion event and can show View in canvas, Open in new tab, Download, Retry, or Dismiss depending on completion status and file type.
- `BuilderReadyPill` appears when a builder artifact exists but the full artifacts panel is not open.
- `View in canvas` selects the artifact path, opens the artifacts UI, and lets `PresenceArtifactPanel` render the selected artifact in the stage.
- The session artifact library can list multiple files and switch the selected builder artifact path.

### Review With Sophia Flow

Primary files:

- `frontend/src/app/components/session/ReviewWithSophiaButton.tsx`
- `frontend/src/app/components/session/ArtifactReviewStatus.tsx`
- `frontend/src/app/hooks/useArtifactCoReview.ts`
- `frontend/src/app/lib/co-review-capture.ts`
- `frontend/src/app/lib/co-review-frame.ts`
- `frontend/src/app/lib/co-review-transport.ts`
- `frontend/src/app/lib/co-review-still-frame-transport.ts`

Current flow:

- The stage shows `Review with Sophia` when still-frame review can start from the current transport.
- Starting review calls `useArtifactCoReview.startReview()`.
- The hook resolves a canvas under the artifact root, encodes a capped still frame, and sends it through the co-review transport.
- Confirmed live state depends on `co_review_live`, `visualInputStatus === "live"`, `videoOrFrameMode === "still_frame"`, a positive frame count, and transport support.
- Stopping review clears the co-review state without tearing down the normal voice connection.

### Start Voice And Review Flow

Current flow:

- In text mode, if the artifact visual source is ready but the current transport cannot accept visual input, the review button changes to `Start voice & review`.
- That path delegates to the session's voice-start handler and marks `pendingBuilderArtifactReview`.
- In voice mode, the pending state is represented as `Preparing view`.

### Exact-Text-Only Path

Primary files:

- `frontend/src/app/components/session/ArtifactCanvasViewport.tsx`
- `frontend/src/app/components/session/CoreviewRealArtifactCanvas.tsx`
- `frontend/src/app/lib/coreview-artifact-text.ts`
- `frontend/src/app/components/session/ExactTextBadge.tsx`

Current flow:

- Markdown files are fetched through the same-origin artifact proxy and registered as trusted exact text when available.
- Non-Markdown builder artifacts currently use a metadata canvas and mark exact text available from builder metadata.
- When a Markdown preview fails or is empty, the stage reports that a visual source is not available, while exact text may still be represented depending on the effective capture state.

### Still-Frame Visual Review Path

Current flow:

- Markdown artifacts render an offscreen capture canvas generated from parsed Markdown.
- Non-Markdown builder artifacts use `CoreviewRealArtifactCanvas`, a hidden metadata-only canvas.
- Companion artifacts use `CoreviewCompanionArtifactCanvas`, also hidden.
- `resolveArtifactVisualSource()` searches selected Markdown preview canvases first, then artifact-id canvases, then generic artifact canvas selectors.
- The captured Coreview frame is therefore not always the same thing the user visually perceives as the visible stage.

### Current Page Navigation And Page Count Surface

Current flow:

- `ArtifactToolbar` always receives `Page 1 of 1`.
- `VoiceArtifactStage` adds a second visible `Page 1 of 1` chip above the stage.
- Zoom out, zoom in, and fit-to-view controls exist as disabled buttons.
- There is no page index state, page count state, page rail, page picker, thumbnail model, keyboard navigation, or view signature.

### Open In New Tab And Download Behaviors

Current flow:

- `buildThreadArtifactHref()` builds same-origin artifact proxy links.
- The proxy route preserves content type, content disposition, length, etag, and modified headers.
- Stage toolbar, file library rows, completion cards, ready pills, `ArtifactsPanel`, and recap deliverable cards all expose some combination of open/download actions.
- Some file types such as `.pptx`, `.ppt`, `.docx`, and `.xlsx` are treated as download-first in `BuilderCompletionCard`.

### Secondary And Legacy Artifact Surfaces

Primary files:

- `frontend/src/app/components/session/ArtifactsPanel.tsx`
- `frontend/src/app/components/onboarding/OnboardingSessionExperience.tsx`
- `frontend/src/app/recap/[sessionId]/page.tsx`

Current flow:

- `ArtifactsPanel` is still exported and used by onboarding and recap surfaces.
- It renders `BuilderDeliverableCard`, `BuilderDocumentLibrary`, takeaway, reflection, and memory cards with its own visual language.
- This is not the live session's main artifact stage, but it remains part of the product's artifact vocabulary.

## 3. Current Visual State

### Layout Structure

Text mode uses two different artifact layouts:

- Builder artifacts open a split workspace grid: conversation plus artifact stage.
- Companion-only artifacts stay inline above the composer.

Voice mode uses a fixed floating panel:

- Builder artifact review is a large centered stage.
- Companion-only artifacts are a smaller atmospheric overlay near the lower voice surface.
- Builder completion cards and builder task notices can also occupy lower-center fixed positions.

This gives users several different mental models for "where artifacts live" depending on file type, builder state, and current mode.

### Panel Composition

`ArtifactStage` is a rounded bordered panel with:

- A toolbar header.
- A scrollable viewport.
- A review footer in text mode.

`VoiceArtifactStage` changes that composition:

- Review status moves above the stage.
- Review CTA moves below the stage.
- `ArtifactStage` still contains its own toolbar and page label, so page/status chrome is split across multiple bands.

`PresenceArtifactPanel` adds an outer bloom halo and reveal animation. That works for companion artifacts, but for builder artifacts it can make the document stage feel like it is inside an atmospheric overlay rather than being the primary workspace plane.

### Stage Width And Height Behavior

The split workspace gives the artifact side a meaningful column on large screens. The stage can fill available height. Inside that stage:

- Markdown pages are capped at `max-w-[860px]`.
- Metadata pages are capped at `max-w-[680px]`.
- The scroll area adds horizontal and vertical padding.
- The viewport has a minimum height of 360px.

On wide layouts this can create a narrow centered page with a lot of surrounding dark/soft panel space. On smaller layouts, the split grid can put conversation and artifact into stacked rows, which makes both areas compete for vertical space.

### Overflow And Scroll Behavior

The stage uses nested overflow boundaries:

- Session layout owns the full viewport.
- Split workspace has `overflow-hidden`.
- Conversation and artifact areas are `min-h-0`.
- `ArtifactCanvasViewport` is `overflow-hidden`.
- The internal scroll area uses `overflow-y-auto`.

That containment is functionally sound, but it makes the visible document page and the scrollable canvas feel like separate layers. A user may read this as an embedded preview inside a panel instead of a first-class canvas.

### Background Treatment

The viewport background uses a soft panel fill plus subtle radial purple/teal gradients. The document preview then sits in a lighter card-like page. There is not yet an explicit canvas-bed contract such as:

- Outer stage background.
- Inner canvas surface.
- Page shadow/edge.
- Empty gutter behavior.
- Full-height fill behavior.

Because that contract is missing, the currently observed black/dark underfill and incomplete interior fill issues are not structurally prevented. The code depends on nested panels, padding, max-width pages, and theme variables rather than a deliberate full-canvas composition.

### Chip Treatment

Current review chips include:

- `Not looking`
- `Preparing view`
- `Sophia is looking at this artifact`
- `Frame sent`
- `View may be stale`
- `Start voice to review visually`
- `Visual review not active`
- `Frame not sent yet`
- `Exact text available`
- `Exact text unavailable`

They are readable, but the visual system is split:

- `ArtifactReviewStatus` uses Sophia-themed token classes and `SophiaLookingChip`.
- Companion `CoReviewControls` uses direct white/emerald classes.
- Voice mode shows a top chip row while text mode uses a footer row.
- Active looking is visually coded mostly by teal/emerald status styling instead of Sophia purple as the primary identity cue.

### Toolbar Treatment

The toolbar is compact and functional:

- Title and hard-coded page label on the left.
- Disabled zoom out, zoom in, fit-to-view controls.
- Open and Download actions on the right.

However, disabled zoom controls make the product appear unfinished because they imply a page/zoom model that does not exist yet. The toolbar also has no page selector, page rail toggle, current zoom display, refresh view action, or clear relationship to the review state.

### CTA Placement

In text mode, the review CTA sits in the stage footer. In voice mode, the review CTA sits below the stage, separate from the top review status row and the inner toolbar. In completion/ready states, View in canvas appears in `BuilderCompletionCard`, `BuilderReadyPill`, session-file rows, `ArtifactsPanel`, and recap cards.

The user can get to the artifact, but the actions do not yet feel like one coherent command model.

### Page Navigation Treatment

The UI presents `Page 1 of 1` but does not model a page. In voice mode, this can be visible twice: once in `VoiceArtifactStage` and once in the `ArtifactStage` toolbar. This makes the current page count feel decorative rather than authoritative.

### Empty, Loading, And Error States

Markdown preview states:

- Loading: `Preparing document view`
- Failed or idle: `Preview unavailable`
- Ready: rendered Markdown article

Review states:

- Preparing view
- Start voice to review visually
- Visual review not active
- Frame not sent yet
- Frame unavailable

These states are serviceable but not yet premium. The loading state is a centered card inside the page, which reinforces the embedded-preview feeling. Error states do not guide the user toward the next best artifact action beyond open/download.

### Text Mode Versus Voice Mode

Text mode currently feels more productized because the artifact can occupy a split workspace. Voice mode feels more like a floating artifact overlay inside the existing voice surface. The stage is larger for builder artifacts in voice mode, but its chrome is more fragmented: top status row, inner toolbar, inner viewport, bottom CTA.

The target vision asks for immersive voice review. Current voice review still looks like a document panel bolted into the voice experience rather than a voice-native review room.

### Generated Markdown Artifacts

Markdown artifacts are the strongest current preview path:

- The file is fetched through the artifact proxy.
- A simple Markdown parser handles headings, paragraphs, lists, code fences, and rules.
- The visible preview renders in a document-like card.
- A hidden capture canvas is drawn from Markdown text for still-frame review.

Limitations:

- No tables.
- No images.
- No blockquotes.
- No links as styled artifact affordances beyond inline parsing.
- No code language highlighting.
- No file outline or section navigation.
- No page model.
- The capture canvas and visible Markdown rendering are separate renderers, so visual parity can drift.

### Non-Markdown Generated Artifacts

Non-Markdown artifacts do not render actual content in the stage. They show a metadata page with:

- Type badge.
- Title.
- Summary or "ready to review" copy.
- Primary file card.
- A few decisions.
- Next action.

For PDFs, slides, docs, spreadsheets, images, HTML, and data files, this is not yet a true artifact review experience. It is a well-styled metadata fallback.

## 4. Gaps vs Target Vision

### Premium Stage Gap

The target vision is a premium Sophia workspace where the artifact opens as a first-class canvas. Current stage composition is functional but still reads as a nested preview panel. The page card, toolbar, disabled controls, footer chips, and outer presence overlay do not yet create a single strong artifact room.

Impacted files:

- `frontend/src/app/components/session/ArtifactStage.tsx`
- `frontend/src/app/components/session/ArtifactCanvasViewport.tsx`
- `frontend/src/app/components/session/VoiceArtifactStage.tsx`
- `frontend/src/app/session/page.tsx`

### Canvas Fill And Underfill Gap

The current viewport is not defined around a full-canvas fill model. It has a dark/soft viewport, a centered max-width page, padding, and nested overflow. That allows dead gutters, incomplete interior fill, and black/dark underfill to remain visible, especially when the page is short or the stage is wide.

The fix should not just change one background color. The product needs a canvas shell with stable regions:

- Stage background.
- Canvas bed.
- Page surface.
- Gutter/rail.
- Status/action chrome.

### Sophia Purple Integration Gap

Sophia purple appears in some buttons, glows, ready pills, and accents, but active review status leans teal/emerald. The user should recognize "Sophia is looking" as a Sophia state, not just a generic success state.

Recommended direction:

- Purple-primary active review ring around the canvas.
- Teal only as secondary confirmation/success.
- Preparing state with restrained purple motion.
- Stale state with muted amber/neutral emphasis.

### Conversation Versus Canvas Hierarchy Gap

In text mode, the split grid improves hierarchy, but chat remains visually heavy and the `VoiceMetricsPanel` is still mounted as floating chrome. In voice mode, captions, whisper indicator, builder cards, task notices, artifact overlays, mode toggle, and composer all compete for the same center/lower-center space.

The artifact should become the focus when it is open. Secondary builder cards and telemetry should recede or collapse.

### Text-Mode Versus Voice-Mode Consistency Gap

Text and voice use the same core stage but not the same stage-level contract:

- Text mode: toolbar, viewport, footer status/action.
- Voice mode: top status/page chip, inner toolbar/viewport, bottom action.

This creates inconsistent review affordances. Voice mode should feel immersive, but it should not fork the user's understanding of status, page, and action placement.

### Status Chip Consistency Gap

`ArtifactReviewStatus`, `SophiaLookingChip`, `ExactTextBadge`, `ReviewWithSophiaButton`, and `CoReviewControls` overlap in purpose. Companion artifacts still use `CoReviewControls` with different styling and status text. Builder artifacts use the newer review status components.

The status model should be unified around one review state component that can render compact, stage, and voice variants.

### Review Controls Integration Gap

Review with Sophia is visible and useful, but it still feels attached to the panel. It is not yet integrated with the canvas itself. The active review state should alter the stage perimeter, status rail, or canvas aura so the user knows Sophia's attention is on this exact artifact view.

### PDF And Multipage Architecture Gap

The stage has no renderer capability model beyond Markdown versus metadata. `frontend/package.json` does not currently include a PDF renderer such as pdf.js. The toolbar contains page and zoom hints, but there is no data model behind them.

This blocks:

- Single-page PDFs.
- Multi-page PDFs.
- Slide-like artifacts.
- Page rail thumbnails.
- Page selection.
- Zoom and fit.
- Review freshness tied to page/zoom changes.

### Route And Surface Inconsistency Gap

The product has several artifact surfaces:

- `PresenceArtifactPanel` in live session.
- `ArtifactStage` for current builder artifacts.
- `ArtifactsPanel` in onboarding and recap-adjacent flows.
- `BuilderCompletionCard`.
- `BuilderReadyPill`.
- `BuilderTaskNotice`.
- Recap `BuilderDeliverableCard`.
- Session-file rows inside `PresenceArtifactPanel`.

Each has a slightly different shape for artifact title, type, file actions, selected state, and visual emphasis. This weakens the sense that artifacts are a first-class product object.

### Selected Artifact Clarity Gap

The selected builder artifact path drives which file appears in the stage, but the selected state is mostly expressed through file-row button backgrounds. Once the stage is open, the user does not get a strong "this file is selected, this is the active review target" treatment.

The future stage should show:

- Artifact name and type.
- Current file from a library.
- Selected page.
- Review target state.
- Whether exact text applies to this selected artifact/page.

### Stale State Gap

`View may be stale` currently appears after a frame is live, not because the user changed a tracked view state. Once the user can change page, zoom, pan, or selected file, stale state needs to be tied to a view signature. Without that, Sophia's "looking" status can become misleading.

### Visible Versus Captured Surface Gap

Coreview capture uses hidden canvases:

- Markdown preview has an offscreen capture canvas.
- Non-Markdown builder artifacts use a hidden metadata canvas.
- Companion artifacts use a hidden overview canvas.

This is privacy-conscious and functionally useful, but the visible surface and captured surface can diverge. For a review experience, users should have confidence that Sophia is looking at what they are looking at. The capture renderer should be visibly tied to the current viewport state, even if the frame itself remains private.

## 5. PDF / Multipage Readiness

PDF support should not be bolted onto the current hard-coded `Page 1 of 1` toolbar. The product needs a small page/view architecture first.

### Required Visual Model

The stage should own a stable model like:

```ts
type ArtifactRendererKind =
  | "markdown"
  | "pdf"
  | "image"
  | "html"
  | "metadata"
  | "download_only";

type ArtifactViewState = {
  artifactId: string;
  filePath: string;
  rendererKind: ArtifactRendererKind;
  pageIndex: number;
  pageCount: number;
  zoom: number;
  fitMode: "page" | "width" | "actual";
  scrollX: number;
  scrollY: number;
  version: string | null;
};
```

The exact names can differ, but the stage needs these concepts before page rail, zoom, and stale review state can be reliable.

### Single-Page PDF

Minimum requirements:

- Detect `application/pdf` and `.pdf` in the artifact library.
- Lazy-load a PDF renderer.
- Render page 1 into the same canvas/page bed as Markdown.
- Replace hard-coded `Page 1 of 1` with renderer-provided page count.
- Keep Open and Download actions.
- Expose fit-to-page and fit-to-width as real controls.
- Register exact text separately from visual capture when extracted text is available.

Likely impacted files:

- `frontend/package.json`
- `frontend/src/app/lib/builder-artifacts.ts`
- `frontend/src/app/components/session/ArtifactCanvasViewport.tsx`
- New `ArtifactPdfPreview` or renderer subcomponent.
- `frontend/src/app/components/session/ArtifactToolbar.tsx`

### Multi-Page PDF

Minimum requirements:

- Page index state.
- Previous/next page actions.
- Page picker or compact page input.
- Thumbnail rail on desktop.
- Compact rail or page sheet on mobile.
- Keyboard navigation.
- Loading state per page.
- Error state per page.
- Preserve review status while page changes.
- Mark visual frame stale when page changes after a frame was sent.

### Left Page Rail Or Thumbnail Rail

Recommended behavior:

- Desktop: left rail inside the stage, not a separate page section.
- Mobile: collapsible bottom/side page selector, not a permanent narrow rail.
- Thumbnails should show selected, reviewed, stale, failed-to-render states.
- The rail should not shrink the document into a narrow trap. It should reserve stable width and allow the page bed to recalculate fit.

Likely new files:

- `frontend/src/app/components/session/ArtifactPageRail.tsx`
- `frontend/src/app/components/session/ArtifactPageThumbnail.tsx`

### Page Picker / Page Chip

The current page label should become an interactive page control:

- `Page 3 of 12` as the primary label.
- Previous/next icon buttons.
- Optional direct page number input or popover.
- Disabled states when page count is one.
- No duplicate page label in voice mode.

### Zoom Controls

The current disabled zoom controls should become real controls only when the renderer supports them:

- Zoom out.
- Zoom in.
- Fit page.
- Fit width.
- Actual size or reset.
- Keyboard shortcuts where appropriate.
- Pinch gesture on touch devices.

The toolbar should avoid showing disabled future controls as permanent product chrome. If a renderer does not support zoom yet, hide or simplify those controls.

### Canvas Fit Behavior

The page bed needs stable rules:

- Single page centers with intentional gutters.
- Multi-page page changes do not shift surrounding chrome.
- Short pages still fill or anchor within the canvas bed.
- Wide pages fit without horizontal text traps.
- The scroll container is visibly the canvas, not a card inside a card.

### Review State While Changing Pages

Review status should track the view that was sent:

- Frame sent for current view.
- View stale because page changed.
- View stale because zoom/pan changed enough to matter.
- View stale because selected file changed.
- Frame preparing for current page.
- Exact text available for current artifact/page.

This probably means adding a view signature to `useArtifactCoReview` or to the stage state that feeds it:

```ts
type ArtifactReviewViewSignature = {
  artifactId: string;
  filePath: string;
  rendererKind: string;
  pageIndex: number;
  zoom: number;
  fitMode: string;
  version: string | null;
};
```

### Keeping Sophia Status Visible During Navigation

Sophia's review status should stay visible when the user scrolls or changes pages. Recommended placement:

- Stage-level top toolbar or slim status rail.
- Active review ring on the canvas bed.
- Compact sticky status on mobile.

Avoid hiding the status in a footer below a long page, and avoid duplicating it in voice mode.

## 6. Sophia Visual Language Recommendations

### Purple Highlights

Use Sophia purple as the primary attention signal for review, not just as a CTA color. Suggested hierarchy:

- Purple: Sophia attention, review affordance, active selected artifact.
- Teal: successful frame/exact text confirmation.
- Amber/neutral: stale or waiting.
- Danger: unavailable/error.

### Review Glow / Aura

Add a restrained active-review treatment to the canvas boundary:

- A 1px to 2px purple-tinted ring around the canvas bed.
- A soft outer glow only while looking/preparing.
- Reduced intensity when stale.
- No broad animated glow across the whole page.

This should make "Sophia is looking" visible even before reading chips.

### Active Review Emphasis

When review is live:

- The selected artifact title should read as the active target.
- The page/view chip should show the reviewed view.
- The canvas ring should be active.
- `Frame sent` should confirm that the view was delivered.
- `Exact text available` should sit nearby as a precision affordance.

### Visual Indication Of "Sophia Is Looking"

Current chip text is clear, but it should be reinforced by layout:

- Put the looking state near the artifact title or stage boundary.
- Use an eye icon plus Sophia color treatment.
- Avoid relying only on a small chip in a footer.
- In voice mode, make this status part of the artifact stage, not just another floating voice-control chip.

### Tasteful Premium Cues

Use quieter cues:

- Hairline gradients.
- Subtle page shadow.
- Intentional canvas gutters.
- A consistent status rail.
- One active aura, not multiple competing glows.
- Motion only for preparing/loading.

### Avoid Overdoing The Effect

Do not make every artifact state purple, animated, or glowing. The product already has atmospheric voice visuals. Artifact review should feel calm and precise. Use purple to indicate Sophia attention and selected review target; let document content remain readable and grounded.

## 7. Prioritized Implementation Slices

### Slice 1: Visual Polish, Layout Containment, And Review Chrome

Goal:

- Make the current stage feel deliberate before adding new renderer complexity.

Likely files:

- `frontend/src/app/components/session/ArtifactStage.tsx`
- `frontend/src/app/components/session/ArtifactCanvasViewport.tsx`
- `frontend/src/app/components/session/ArtifactToolbar.tsx`
- `frontend/src/app/components/session/ArtifactReviewStatus.tsx`
- `frontend/src/app/components/session/ReviewWithSophiaButton.tsx`
- `frontend/src/app/components/session/VoiceArtifactStage.tsx`
- `frontend/src/app/session/page.tsx`

Concrete work:

- Define a stage shell with one toolbar/status contract.
- Remove duplicate `Page 1 of 1` in voice mode.
- Decide whether disabled zoom controls should be hidden until functional.
- Make the review status row visually consistent in text and voice.
- Add active/preparing/stale visual treatment to the stage boundary.
- Keep builder completion/ready/task overlays from competing when the stage is open.

### Slice 2: Canvas Background, Fill, And Document Composition Cleanup

Goal:

- Fix the canvas underfill/dead-space problem and make the document page feel intentionally placed.

Likely files:

- `frontend/src/app/components/session/ArtifactCanvasViewport.tsx`
- `frontend/src/app/components/session/ArtifactMarkdownPreview.tsx`
- `frontend/src/app/components/session/CoreviewRealArtifactCanvas.tsx`
- `frontend/src/app/components/session/CoreviewCompanionArtifactCanvas.tsx`

Concrete work:

- Introduce explicit canvas bed and page surface layers.
- Normalize metadata and Markdown page framing.
- Make empty/loading/error states part of the canvas bed, not nested cards.
- Add responsive rules to prevent narrow document traps.
- Keep offscreen capture canvas parity in mind, but do not change transport behavior yet.

### Slice 3: Sophia Purple Highlight Language

Goal:

- Make review attention feel Sophia-owned without creating visual noise.

Likely files:

- `frontend/src/app/components/session/SophiaLookingChip.tsx`
- `frontend/src/app/components/session/ArtifactReviewStatus.tsx`
- `frontend/src/app/components/session/ReviewWithSophiaButton.tsx`
- Global theme/tokens if the current token set is insufficient.

Concrete work:

- Rebalance active looking from teal-primary to Sophia-purple-primary.
- Keep `Frame sent` and `Exact text available` as confirmation states.
- Add reduced-motion-safe preparing treatment.
- Standardize chip tones across builder and companion co-review.

### Slice 4: Unify Voice/Text Artifact Review Surface Further

Goal:

- Make text and voice review feel like mode variants of one artifact stage.

Likely files:

- `frontend/src/app/components/session/PresenceArtifactPanel.tsx`
- `frontend/src/app/components/session/VoiceArtifactStage.tsx`
- `frontend/src/app/components/session/ArtifactStage.tsx`
- `frontend/src/app/session/page.tsx`
- `frontend/src/app/components/session/BuilderCompletionCard.tsx`
- `frontend/src/app/components/session/BuilderReadyPill.tsx`

Concrete work:

- Use one stage chrome model with compact/voice variants.
- Collapse builder ready/completion surfaces when the artifact stage is already active.
- Align file-library selected state with stage active target.
- Decide how companion-only review graduates from atmospheric panel to review canvas.

### Slice 5: PDF Single-Page Support

Goal:

- Render the first page of PDFs as a real reviewable page.

Likely files:

- `frontend/package.json`
- `frontend/src/app/lib/builder-artifacts.ts`
- `frontend/src/app/components/session/ArtifactCanvasViewport.tsx`
- New PDF renderer component.
- Tests under `frontend/src/__tests__/components/session`.

Concrete work:

- Add PDF capability detection.
- Add lazy PDF rendering.
- Feed page count into toolbar.
- Add loading/error handling specific to PDF page rendering.
- Keep exact text separate from visual render.

### Slice 6: Multipage Rail And Navigation

Goal:

- Support multi-page PDFs and future slide/report navigation.

Likely files:

- New `ArtifactPageRail` and related page components.
- `ArtifactToolbar`.
- `ArtifactCanvasViewport`.
- `useArtifactCoReview`.

Concrete work:

- Add page rail/thumbnail model.
- Add page picker and previous/next actions.
- Add view signature and stale state when page/zoom changes.
- Add mobile page navigation.
- Add keyboard navigation.

### Slice 7: Polish, Edge Cases, And Loading States

Goal:

- Make the artifact experience resilient across file types, screen sizes, and review states.

Likely files:

- All stage/review components.
- `ArtifactsPanel` or consumers that still need visual alignment.
- Recap/onboarding deliverable surfaces.

Concrete work:

- Align recap/onboarding artifact cards with the new live-stage grammar.
- Improve unsupported/download-only states.
- Audit touch target sizing and keyboard accessibility.
- Add visual regression coverage where feasible.
- Document the renderer capability matrix.

## 8. Risks / Non-Goals

Do not mix these into the next visual UX implementation slice:

- No liveframes work.
- No Stream/Vision Agents work.
- No provider changes.
- No VAD changes.
- No arbiter, M3, or M4.4 work.
- No unrelated builder backend changes unless a visual UX slice proves a minimal metadata field is required.
- No broad route rewrites beyond the routing consistency changes identified by this audit.
- No continuous watching, screen capture, camera capture, or browser-tab capture.
- No OCR-first product path. Exact words and numbers should keep using trusted text/exact-text sideband paths.
- No PDF renderer dependency in Slice 1; stabilize the shell first.

Risks to track:

- Adding a renderer before the stage shell is stable will lock in awkward page/chrome assumptions.
- Making purple glow too strong will reduce readability and fight the voice environment.
- Keeping disabled controls visible for too long will make the product feel unfinished.
- Letting visible and captured surfaces diverge will make "Sophia is looking" harder to trust.
- Unifying surfaces may reveal tests that assert current placement details rather than product behavior.

## 9. Recommended Next Slice

Recommended next implementation slice: Slice 1, visual polish, layout containment, and review chrome.

Acceptance criteria for that slice:

- Text and voice artifact stages share one coherent toolbar/status/action model.
- The canvas area fills cleanly with no black/dark underfill or incomplete interior background.
- The document page has intentional gutters and does not become a narrow vertical trap on wide screens.
- `Sophia is looking`, `Not looking`, `Frame sent`, `Exact text available`, `Preparing view`, and `Start voice to review visually` use one consistent visual language.
- The stage has a tasteful Sophia-purple review treatment when active.
- Hard-coded or duplicate page chrome is reduced until real page state exists.
- Builder ready/completion chrome does not visually compete with an already open artifact stage.
- The implementation remains frontend/runtime-surface only and does not introduce PDF rendering, provider changes, or liveframe work.

The first implementation should be a visual shell pass, not a renderer pass. Once the artifact stage feels like a real Sophia workspace, PDF single-page support and multipage rail work will have a much better place to land.
