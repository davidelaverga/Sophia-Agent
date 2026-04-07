export type ChatStreamProtocol = 'data';

/**
 * Enforce AI SDK UI message data-stream protocol as the single supported path.
 */
export function resolveChatStreamProtocol(headerValue?: string | null): ChatStreamProtocol {
  void headerValue;
  return 'data';
}
