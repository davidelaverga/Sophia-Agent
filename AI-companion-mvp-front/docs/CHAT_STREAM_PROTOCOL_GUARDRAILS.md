# Chat Stream Protocol Guardrails

## Canonical Contract
- Frontend chat transport is **data-stream only**.
- Server responses for chat streaming must use:
  - `Content-Type: text/event-stream; charset=utf-8`
  - `x-vercel-ai-ui-message-stream: v1`
- Legacy protocol routing (`text` / `legacy`) is retired and must not be reintroduced.

## Required Event Envelope
For UI message streams, events must preserve the AI SDK shape:
1. `start`
2. `text-start`
3. one or more `text-delta`
4. `text-end`
5. optional data events (`data-artifactsV1`, `data-sophia_meta`, `data-interrupt`)
6. `finish`
7. SSE terminator `data: [DONE]`

## Backend -> Frontend Mapping Rules
- Backend SSE `token` events map to UI `text-delta`.
- Backend metadata/artifacts (`response_complete`, `artifacts_complete`) must be emitted as data events, never as inline plaintext markers.
- Leakage-like prompt labels (`USER_MESSAGE:`, `SYSTEM:`, etc.) must be filtered from token output.

## Regression Guard Checklist
Before merging changes that touch chat transport or streaming:
- Run `npm run type-check`
- Run `npm run test -- stream-protocol stream-transformers chat-request`
- Run `npm run smoke:stream-auth`

## Do / Don’t
- **Do** keep `resolveChatStreamProtocol` pinned to `data`.
- **Do** keep `createSSEToUIMessageStream` and `createUIMessageStreamFromText` as the only stream shaping paths.
- **Don’t** add `text/plain` response branches for chat stream payloads.
- **Don’t** re-add env toggles for stream protocol selection.
- **Don’t** depend on `x-sophia-stream-protocol` values for server behavior.
