"use client";

import { useChatStore } from "../stores/chat-store";
import { useMessageMetadataStore } from "../stores/message-metadata-store";
import { useSessionSnapshotStore } from "../stores/session-snapshot-store";

const PENDING_INTERRUPT_STORAGE_KEY = "sophia_pending_interrupt";
const BOOTSTRAP_STORAGE_KEY = "sophia-session-bootstrap";

export function teardownSessionClientState(sessionId?: string): void {
  const chat = useChatStore.getState();
  if (chat.cancelStream) {
    chat.cancelStream();
  }
  chat.clearSession();

  if (sessionId) {
    useMessageMetadataStore.getState().clearSession(sessionId);
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(PENDING_INTERRUPT_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          delete parsed[sessionId];
          window.localStorage.setItem(PENDING_INTERRUPT_STORAGE_KEY, JSON.stringify(parsed));
        }
      } catch {
        // ignore
      }
    }
  } else {
    useMessageMetadataStore.getState().clearAll();
  }

  useSessionSnapshotStore.getState().clearSnapshot();

  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(BOOTSTRAP_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
