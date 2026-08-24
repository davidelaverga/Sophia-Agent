# VT00 exact-baseline record

Status: `GATE_VT00_0_PASSED`

Recorded: 2026-08-23

## Source and deployment identity

- Target branch: `codex/sophia-observability-v1`
- Exact fetched source SHA: `41a9b127af780bbe9d88acf34566a6aaf443e6b0`
- Inspected reference SHA: `41a9b127af780bbe9d88acf34566a6aaf443e6b0`
- Candidate worktree: isolated operator worktree (host-local path intentionally omitted)
- Frontend production: build `41a9b127af780bbe9d88acf34566a6aaf443e6b0`, Vercel deployment `dpl_6wBPTSS8YAFUPmEQxW6KugkEgebb`, unique URL `sophia-agent-front-aeqbry6r8-sophia-30911edf.vercel.app`
- Gateway production: Render service `srv-d7be5s9r0fns7397l4g0`, deploy `dep-da4qtr0jo6nc73drj6ng`, public `/version` SHA `41a9b127af780bbe9d88acf34566a6aaf443e6b0`
- LangGraph production: Render service `srv-d7be5s9r0fns7397l4fg`, deploy `dep-da4qtrbtqb8s738lff8g`, `/ok` healthy
- Voice production: Render service `srv-d7be5s9r0fns7397l4f0`, deploy `dep-da4qt9rtqb8s738ldt80`, dashboard source SHA `41a9b127af780bbe9d88acf34566a6aaf443e6b0`, `/health` and `/ready` healthy

The frontend, Gateway, LangGraph, and Voice tiers therefore agree on the inspected branch head. Voice must gain a public non-secret build identity in VT00 because the current endpoint does not expose one.

## Rollback points

- Repository rollback SHA: `a793100008f7ccb5a25e9e018f896e7ec9dc2a3d`
- Frontend prior production deployment: `dpl_7WFUuPa8QTX9SZQPS8DK1XSPCLSF`
- Gateway rollback deploy: `dep-da4br1m1egvs73bfprk0`
- LangGraph rollback deploy: `dep-da4brdv10e5c73ala3t0`
- Voice rollback deploy: `dep-da4m52btqb8s7389ri80`
- Fast voice-path rollback: set `SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED=false`

Render auto-deploy is disabled for the three existing services. Vercel production tracks `main`, while this mission is explicitly restricted to the target branch. Each candidate therefore requires explicit Render deploys and promotion of the verified target-branch Vercel preview; VT00 will not merge `main`.

## Existing smoke result

The existing fixed fake-WAV browser E2E was rerun unchanged against `https://www.sophia-ei.com` with Playwright Chromium. The isolated context was redirected to Google sign-in and timed out before microphone acquisition. The result is classified as `authorization_failure`, not as a voice-product failure and not as an audio-path pass.

Preserved local failure artifacts:

- `frontend/test-results/voice-webrtc-voice-route-a-b91e2-ts-transcript-plus-artifact-chromium/test-failed-1.png`
- `frontend/test-results/voice-webrtc-voice-route-a-b91e2-ts-transcript-plus-artifact-chromium/video.webm`
- `frontend/test-results/voice-webrtc-voice-route-a-b91e2-ts-transcript-plus-artifact-chromium/error-context.md`

The smoke remains a deterministic fixed-fixture regression. It does not satisfy the adaptive-audio, output-realization, deployment-join, or fresh-agent gates.

## Exact-head backend regression floor

On 2026-08-23, the six files implicated by the candidate's full backend sweep
were rerun in a clean detached worktree at exact SHA
`41a9b127af780bbe9d88acf34566a6aaf443e6b0`, using the same Python 3.12
workspace environment as the candidate. The result was `46 failed, 236 passed,
2 skipped`. The same 46 node IDs and failure signatures occur on the candidate
and are confined to pre-existing deck build/design-lift/prepare/local-sandbox
and deck-quality smoke tests. They are therefore recorded as the exact-head
regression floor, not reclassified as VT00 passes.

The candidate's first full sweep additionally exposed five VT00 capability
matrix cases whose fixed signed-token timestamp expired during the four-minute
suite. Those are candidate test defects and must be repaired and rerun; they are
not covered by this baseline exception.

## Baseline matrix

| Class | Finding | VT00 disposition |
|---|---|---|
| Available | Existing fixed `map_01_grief.wav` E2E and text/voice ID-continuity smoke | Preserve as deterministic regressions; do not turn them into the adaptive runner |
| Available | Playwright can install a `getUserMedia` substitute before the app bundle, and production uses that same dependency seam | Use an isolated page-owned `MediaStreamAudioDestinationNode`; add no production query switch |
| Available | Normal product input converts page audio to PCM16 at 16 kHz and sends it over the real Gemini browser socket | Require page scheduling plus correlated PCM/provider receipts before accepting an utterance |
| Available | Provider output transcript/chunk/schedule/drop/flush diagnostics, governed stereo recorder, and global browser capture bridge | Preserve these as separate evidence channels |
| Available | Backend issues `langsmith_trace_id`; `/api/app-version` exposes frontend build identity | Propagate the trace as supplemental evidence and join exact identities before interaction/export |
| Missing | Dedicated noninteractive test identity and server-side synthetic capability | Add a short-lived, allowlisted signed grant; reject before provider resource creation |
| Missing | Adaptive media scheduling, per-utterance identity/idempotency, and generated TTS | Implement in the isolated runner with deterministic fixtures and page-side receipts |
| Missing | Natural playback start/completion evidence | Add stable realization receipts; never infer playback from transcript or received chunks |
| Missing | Incremental capture drain and overflow metadata | Add monotonic cursor/generation metadata and persist deduplicated drains outside the page |
| Missing | Frontend trace propagation, provider-epoch joins, and exact backend/voice build joins | Add explicit joined values or typed `*_unavailable` reasons |
| Missing | Durable runner, remote MCP, private plugin, installation, fresh-agent certification, cleanup archive | Implement in ordered VT00.1 through VT00.8 gates |
| Changed | None from the spec's inspected reference | Current exact head is the referenced source |
| Blocked | Standalone canonical M01/M02/M03/M04/M06 mission files are absent from the repository and Downloads | Use the available FC01/current architecture contracts and preserve VT00's explicit non-scope; do not claim those missing product contracts reconciled |
| Security gap | Public Voice production/dogfood session endpoints have no request authentication dependency | Add internal service authentication and negative pre-provider tests as part of the protected test boundary |

The missing mission files are a documented source gap, not a stop condition: VT00's contract explicitly forbids implementing M01/M03/M04/M06 product primitives in the harness, and the current FC01 mission says those broader surfaces remain deferred.

## Plugin/MCP standards decision

Official OpenAI documentation was rechecked on 2026-08-23. The supported primary acceptance surface is **Codex desktop**, with **Codex CLI/direct MCP** as the secondary diagnostic surface. The Codex IDE extension is not a required plugin surface.

The implementation will use:

- a repository plugin with required `.codex-plugin/plugin.json`;
- a thin workflow skill plus a registered `.app.json` mapping to an authenticated streamable-HTTP remote MCP app;
- a stable HTTPS remote MCP service with explicit schemas, annotations, and structured results;
- OAuth 2.1 authorization code with S256 PKCE, protected-resource metadata, pinned ChatGPT client metadata, short-lived scoped access tokens, refresh rotation, and revocation for the registered-app lane;
- repository-local marketplace metadata for private team installation and repeatable cold-session tests;
- a separately scoped static bearer only for direct diagnostic preflight, with no secret embedded in the plugin.

The registered remote app is the primary acceptance surface shared by the supported ChatGPT Work/Codex desktop plugin experience. A local `.mcp.json`, Codex CLI connection, or static bearer is a secondary diagnostic surface and may not be substituted for V-P01 registered-app installation and fresh-task provenance.

## Gate conclusion

VT00.0 passed because the exact clone, production identities, rollback points, existing smoke outcome, current voice seams, current official plugin/MCP surface, selected acceptance client, and known source/security gaps are all recorded. Implementation begins from this baseline without weakening the mission's later production gates.
