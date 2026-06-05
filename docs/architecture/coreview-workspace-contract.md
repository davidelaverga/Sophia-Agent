# Coreview Workspace Contract

## Phase 1 Scope

Coreview is the artifact workspace control plane for Sophia Workspace. It owns the shared contract for artifact identity, renderer capability, current view, annotations, safe telemetry, and future workspace events. Renderers and extractors adapt into that contract; they do not decide global truth on their own.

Phase 1 adds the contract and capability matrix without adding OCR, native PPTX canvas rendering, backend collaboration sync, liveframes, dynamic fixtures, provider model changes, or PDF builder output changes.

## Coreview As Control Plane

Coreview keeps the workspace state that Sophia and the manual UI both need:

- Stable artifact identity.
- Renderer kind and render mode.
- Current page, zoom, fit mode, and view signature.
- Capability truth for controls and tools.
- Annotation state ownership through the Coreview annotation store.
- Safe result summaries for Coreview tools.
- Local event vocabulary for future sharing and collaboration.

The important rule is that UI buttons and Sophia tools must ask the same capability question before acting. A toolbar button, a keyboard shortcut, a voice fallback, and a Gemini Coreview tool response should not each invent their own answer for whether pages, zoom, annotations, OCR, or PPTX native rendering are available.

## Renderer Adapter Model

Renderers are adapters. The Phase 1 adapter contract describes:

- `rendererKind`
- `canRender(artifact)`
- `getCapabilities(artifact)`
- `getCurrentView()`
- `setView()`
- `focusAnchor()`
- `captureFrame()`
- `getTextExtractionState()`
- `getLayoutIndexState()`
- `getAnnotations()`
- `exportAnnotatedCopy()`

The global matrix decides which actions are available. A renderer adapter still owns local mechanics such as PDF page rendering, zoom math, text layout lookup, canvas capture, pointer interactions, and iframe or markdown preview loading.

## Extraction Adapter Model

Extraction is also an adapter surface. Phase 1 introduces `CoreviewLayoutIndexState` and `CoreviewLayoutAnchor` as placeholders for future extraction and layout index providers:

- PDF text layout can report bounding boxes when the existing PDF text extraction succeeds.
- Markdown can provide text without page boxes.
- HTML can eventually provide DOM text and anchors.
- DOCX, PPTX, and OCR are future sources only.

This slice does not parse DOCX or PPTX content and does not implement OCR.

## Capability Matrix

The centralized matrix lives in `frontend/src/app/lib/coreview-artifact-capabilities.ts`.

Current truth:

- PDF uses canvas rendering. It supports pages, the page rail, zoom, pan, still-frame capture, comments, highlights, underlines, and arrows. Free draw and annotated export remain unavailable. Text extraction and layout anchors are true only when existing PDF text layout is available. OCR is not available.
- Markdown uses the markdown renderer. It supports text extraction and still-frame capture, but not pages, layout anchors, or visual annotations.
- HTML uses the HTML preview. DOM text is treated as accessible when preview text is available, but visual annotations are not available yet.
- DOCX uses metadata fallback with original download/open support. Native document canvas rendering, annotations, and text extraction are not available in this slice.
- PPTX uses metadata fallback with original download/open support. Native PPTX canvas rendering, annotations, OCR, and text extraction are not available in this slice.
- Images use metadata fallback with original download/open support. OCR is required for image text extraction, but OCR is not available yet.

User-facing truth strings must be truthful and avoid internal terms such as debug states, renderer enum names, fixtures, transport details, and provider details.

## Annotation Ownership

Annotations are Coreview workspace objects. The manual UI tools and Sophia/Coreview tools both call into the same Coreview annotation store. The renderer displays annotation overlays and creates local geometry, but the store owns durable state, counts, persistence, and identity. This preserves the current behavior where PDF annotations survive close, reopen, and refresh.

## Actor And Event Model

Phase 1 adds a local-first workspace event log for future collaboration. Events are client-side only and are persisted in localStorage by workspace key. They are shaped as append-friendly records with:

- `id`
- `type`
- `workspaceKey`
- optional `artifactKey`
- `actor`
- `createdAt`
- `version`
- `payload`

The workspace key is:

```text
user:{userId|unknown}|thread:{threadId|unknown}
```

The artifact key is the normalized `stableArtifactIdentity`. It normalizes artifact path variants before persistence. It does not use `voiceAgentSessionId`, Gemini runtime session ids, websocket ids, or DOM ids.

Phase 1 event types:

- `artifact.opened`
- `artifact.closed`
- `view.changed`
- `annotation.created`
- `annotation.updated`
- `annotation.deleted`
- `tool.changed`
- `export.requested`
- `share.requested`
- `participant.joined`
- `participant.left`

Actors are `user`, `sophia`, `system`, and `collaborator_future`.

Actor ids:

- Manual UI actions: `user:{userId|unknown}`.
- Sophia personal actions: `sophia:personal:{userId|unknown}`.
- Sophia room actions for future collaboration: `sophia:room:{threadId|unknown}`.
- Restore and migration actions: `system`.

Manual UI annotation actions and Sophia/Coreview annotation tools emit the same annotation event types after the shared Coreview annotation store confirms the mutation. Coreview view tools and manual page or zoom controls emit `view.changed` from the same reported view-state boundary. Event telemetry reports counts, last type, actor kind, persistence result, and share status only; it does not expose raw comment text, raw artifact text, or raw frame data.

These event types are contract groundwork only. They do not start realtime sync, participant presence, share links, permissions, or backend collaboration storage.

## Share-Ready Metadata

Phase 1 defines local share metadata without enabling sharing:

```ts
type CoreviewWorkspaceShareState = {
  status: "unavailable" | "ready_future" | "requested_local"
  workspaceKey: string
  artifactKey?: string | null
  permissionsModel: "not_implemented"
  participants: []
  userFacingTruth: "Sharing is not available yet."
}
```

The default status is `unavailable`. A local placeholder request can be represented as `requested_local`, but no backend call, share link, permission enforcement, or participant sync exists in this phase. Any UI surface must truthfully say: "Sharing is not available yet."

## Preparation For Sharing And Collaboration

The contract prepares Workspace by making artifact state portable:

- Capabilities can be serialized without raw artifact text, raw frames, or raw comment text.
- View changes and annotations have common action/event names for manual UI and Sophia tools.
- Actors distinguish manual user actions, Sophia actions, restore/migration actions, and future collaborators.
- The local event log can be replayed or synced later without changing renderer action names.
- Share-ready metadata can be surfaced later without changing the truthful Phase 1 disabled state.
- Renderer adapters can join later without changing Sophia tool semantics.
- Future collaborators can share the same artifact identity and action vocabulary.
- Backend sync can persist events later without changing Phase 1 UI capability truth.

## Intentionally Unsupported

The following remain intentionally unsupported in Phase 1:

- OCR implementation.
- Full PPTX renderer.
- Backend or cloud workspace sync.
- Share links and permissions.
- Realtime collaboration.
- Liveframes.
- Dynamic fixture.
- Broad VAD or arbiter rewrite.
