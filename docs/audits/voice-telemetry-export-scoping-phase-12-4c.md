# Voice Telemetry Export Scoping - Phase 12.4C

Date: 2026-05-20
Status: implemented
Runtime default: `legacy_cascade`
Source branch: `fix/gemini-production-reliability-phase-12-4b`
Implementation branch: `fix/voice-telemetry-export-scoping-phase-12-4c`

## Scope

This phase fixes the Session voice telemetry download before the next Gemini production reliability smoke test. The goal is a current-run diagnostic report that preserves Phase 12.4B correlation evidence without silently exporting unrelated persisted app history.

Non-goals:

- No Gemini runtime behavior changes.
- No prompt/tool behavior changes.
- No deletion or migration of persisted app data.
- No Session UI redesign.
- No next production smoke test execution.

## Root Cause

The default telemetry download is built by `VoiceMetricsPanel` via the Session telemetry panel's JSON copy/export actions. Before this phase, the report payload was:

```text
reportType
version
source
exportedAt
summary
metrics
captureBundle: window.__sophiaCapture.export()
```

The final unwanted history came from `captureBundle.snapshot`, built by `session-capture.ts`.

Problematic snapshot fields:

- `snapshot.storage` serialized broad localStorage keys: `sophia-session-store`, `sophia-recap`, `sophia.message-metadata.v1`, `sophia-conversation-store`, `sophia-session-history`, `sophia-session`, `sophia-conversation-history`, and pending interrupt state.
- `snapshot.transcript.chatMessages` and `snapshot.transcript.voiceMessages` serialized the current in-memory message stores, which may contain restored or historical messages unrelated to the current telemetry run.
- `snapshot.artifacts.sessionArtifacts` and `snapshot.artifacts.recapArtifacts` serialized current store artifact objects, including persisted recap state.
- `snapshot.transcript.dom.articles` and artifact DOM text serialized rendered text that could include non-current history.
- `metrics.sessionTelemetry.gemini.websocketUrl` could contain a Gemini Live `access_token=auth_tokens/...` query value.

The broad snapshot was originally useful as a one-click developer forensic dump when the live telemetry panel was first added. For Phase 12.4B production reliability, that convenience became counterproductive: it mixed current diagnostics with older conversations, recap history, and credential-shaped transport material.

## Export Section Audit

| Export section | Keep? | Why? | Contains personal/history data? |
|---|---|---|---|
| `reportType`, `version`, `source`, `exportedAt` | Yes | Identifies the file as a voice telemetry report and records schema/source/time. | No. |
| `summary` | Yes | Compact runtime, health, bottleneck, regression, timing, and builder summary. | Low; no broad history. |
| `metrics` | Yes, sanitized | Main diagnostic surface for runtime/session health, Gemini counters, tool ledger, public event counts, and timing analysis. | Current-run identifiers and latest current-run transcript fields may be present; auth-bearing URLs are redacted. |
| `captureBundle.events` | Yes, scoped | Needed for provider -> relay -> normalizer -> SSE correlation, cancellation timelines, microphone/audio evidence, and artifact/builder continuity. | Current-run event payloads only by default; older run events are excluded. |
| `captureBundle.scope` | Yes | Explains how the event window was selected and how many earlier capture events were omitted. | No. |
| `captureBundle.snapshot.session` | Yes, minimized | Keeps active session/thread/status/message count for correlation. | Current session ids only. |
| `captureBundle.snapshot.harness.microphone` | Yes | Needed for mic/audio telemetry and manual mute/audio evidence. | No conversation history; device labels may still be browser-provided diagnostics. |
| `captureBundle.snapshot.debug` | Yes, sanitized | Compact status ids and stream/commit state help correlate UI state with telemetry. | Current diagnostic state only. |
| `captureBundle.snapshot.metadata` | Yes, minimized | Keeps current session/thread/run ids; removes emotional weather payload. | Current ids only. |
| `captureBundle.snapshot.transcript.chatMessages` | No | Full message arrays are not required; current transcript evidence is in scoped capture events and metrics. | Yes; removed. |
| `captureBundle.snapshot.transcript.voiceMessages` | No | Full voice store arrays can include older conversations. | Yes; removed. |
| `captureBundle.snapshot.transcript.dom.articles` | No | Rendered text is redundant for the diagnostic export and may include history. | Yes; removed while preserving article count. |
| `captureBundle.snapshot.artifacts.sessionArtifacts` | No | Current artifact evidence is available through scoped `sophia.artifact` events and counters. | Potentially; removed. |
| `captureBundle.snapshot.artifacts.recapArtifacts` | No | Recap state is persisted history, not current-run voice telemetry. | Yes; removed. |
| `captureBundle.snapshot.artifacts.dom` text fields | No | Rendered artifact text is not required for Phase 12.4B counters. | Yes; text removed while preserving visibility/label. |
| `captureBundle.snapshot.storage` | No | This was the accidental broad app-state dump. | Yes; replaced with `{}`. |

## Default Schema After Phase 12.4C

The default report is now schema version `2`:

```text
reportType: "voice-telemetry-report"
version: 2
source: "session-ui"
exportedAt
summary
metrics                sanitized current runtime/session diagnostics
captureBundle:
  startedAt            first exported current-run event when available
  exportedAt
  eventCount           exported current-run event count
  events               scoped, capped diagnostic events
  scope                current-run selection metadata
  snapshot             minimized diagnostic snapshot
```

`captureBundle.scope.strategy` records one of:

- `last-start-event`: the normal path, using the last `voice-session/start-talking-requested` event onward.
- `current-session-id`: fallback when no start event is present but events mention the current session id.
- `recent-capture-window`: bounded final fallback when neither marker exists.

## Privacy And Credential Hygiene

Phase 12.4C removes unrelated persisted history from the default report and redacts credential-shaped values during JSON construction.

Redacted by default:

- URL query values named `access_token`, `token`, `api_key`, `key`, `secret`, `client_secret`, `auth`, or `authorization`.
- `auth_tokens/...` path/query segments.
- `Bearer ...` strings.
- Object fields whose names contain token/secret/authorization/api-key/client-secret/credential/password patterns.

The Gemini WebSocket URL is sensitive because the `access_token=auth_tokens/...` value is an ephemeral credential for the Live API transport. The export keeps the URL's protocol/host/path and the fact that an `access_token` parameter existed, but replaces the token value.

## Advanced Export Mode Decision

No advanced full-debug export mode was added in this phase.

Reason: the previous broad snapshot did have developer convenience, but this phase is specifically about production reliability smoke-test hygiene. Keeping a second full-history download in the same panel would risk the wrong button being used again. A future debug-only full snapshot can be reintroduced behind an explicit developer affordance and warning if a concrete workflow needs it.

## Before And After

Before:

```text
current voice telemetry
+ full capture snapshot
+ persisted Session store
+ persisted recap store
+ session history/conversation history stores
+ old message arrays/rendered text
+ auth-bearing Gemini WebSocket URL
```

After:

```text
current-run diagnostic report
+ runtime summary/metrics
+ Phase 12.4B correlation counters and ledgers
+ scoped current-run capture events
+ minimized current session/microphone/debug snapshot
+ redacted credential-shaped transport values
```

## Validation

Focused tests added:

- `frontend/src/__tests__/lib/voice-telemetry-report.test.ts`
- `frontend/src/__tests__/session/VoiceMetricsPanel.test.tsx`

Coverage includes:

- Report metadata and schema version.
- Current summary/metrics/capture bundle retention.
- Phase 12.4B `gemini-provider-event-correlation`, `gemini-relay-trace`, and `gemini-tool-call-ledger` retention.
- Exclusion of archived event text, persisted Session store data, persisted `sophia-recap` state, message arrays, rendered transcript text, and artifact snapshot payloads.
- Redaction of Gemini WebSocket access tokens, bearer tokens, ephemeral token fields, and auth-bearing page/query values.
- Default panel copy/export path using the clean report builder.

Manual verification for the next smoke should inspect a freshly downloaded Session report and confirm the file contains `summary`, `metrics`, `captureBundle`, and Phase 12.4B diagnostics, but does not contain older Session records, prior conversation arrays, `sophia-recap` persisted artifacts, or broad localStorage snapshots.