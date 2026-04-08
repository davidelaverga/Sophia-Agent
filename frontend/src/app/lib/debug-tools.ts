"use client";

import { useChatStore } from "../stores/chat-store";
import { useConnectivityStore } from "../stores/connectivity-store";
import { useConversationStore } from "../stores/conversation-store";
import { useMessageMetadataStore } from "../stores/message-metadata-store";
import { useRecapStore } from "../stores/recap-store";
import { useSessionHistoryStore } from "../stores/session-history-store";
import { useSessionSnapshotStore } from "../stores/session-snapshot-store";
import { useSessionStore } from "../stores/session-store";
import { SESSION_SNAPSHOT_STORAGE_KEY } from "../types/session-snapshot";

const PENDING_INTERRUPT_STORAGE_KEY = "sophia_pending_interrupt";
const SESSION_STORAGE_KEY = "sophia-session";
const CONVERSATION_HISTORY_KEY = "sophia-conversation-history";

const LOCAL_STORAGE_KEYS = [
  SESSION_SNAPSHOT_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  CONVERSATION_HISTORY_KEY,
  "sophia-session-store",
  "sophia-session-history",
  "sophia-recap",
  "sophia.message-metadata.v1",
  "sophia.feedback.v1",
  "sophia-consent",
  "sophia-connectivity",
  "sophia-conversation-store",
  PENDING_INTERRUPT_STORAGE_KEY,
];

export type DebugSnapshot = {
  conversationId?: string;
  session_id?: string | null;
  thread_id?: string | null;
  activeReplyId?: string;
  lastCompletedTurnId?: string;
  streamStatus?: string;
  streamAttempt?: number;
  pendingInterrupt?: boolean;
  pendingInterruptCount?: number;
  artifactsStatus?: string | null;
  memoryCommitStatus?: string | null;
  connectivityStatus?: string;
};

export function getDebugSnapshot(): DebugSnapshot {
  const chat = useChatStore.getState();
  const session = useSessionStore.getState().session;
  const metadataStore = useMessageMetadataStore.getState();
  const recapStore = useRecapStore.getState();
  const connectivity = useConnectivityStore.getState();

  const sessionId = session?.sessionId ?? metadataStore.currentSessionId ?? null;
  const threadId = session?.threadId ?? metadataStore.currentThreadId ?? null;

  let artifactsStatus: string | null = null;
  const lastMeta = chat.lastCompletedTurnId
    ? metadataStore.metadataByMessage[chat.lastCompletedTurnId]
    : undefined;
  artifactsStatus = (lastMeta?.artifacts_status as string | undefined) ?? null;

  const memoryCommitStatus = sessionId
    ? recapStore.getCommitStatus(sessionId)
    : null;

  let pendingInterrupt = false;
  let pendingInterruptCount = 0;
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(PENDING_INTERRUPT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        pendingInterruptCount = Object.keys(parsed).length;
        if (sessionId && parsed[sessionId]) {
          pendingInterrupt = true;
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    conversationId: chat.conversationId,
    session_id: sessionId,
    thread_id: threadId,
    activeReplyId: chat.activeReplyId,
    lastCompletedTurnId: chat.lastCompletedTurnId,
    streamStatus: chat.streamStatus,
    streamAttempt: chat.streamAttempt,
    pendingInterrupt,
    pendingInterruptCount,
    artifactsStatus,
    memoryCommitStatus,
    connectivityStatus: connectivity.status,
  };
}

export function clearLocalSessionData(): void {
  if (typeof window !== "undefined") {
    LOCAL_STORAGE_KEYS.forEach((key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // ignore
      }
    });
  }

  useChatStore.setState({
    messages: [],
    composerValue: "",
    isLocked: false,
    conversationId: undefined,
    activeReplyId: undefined,
    lastError: undefined,
    feedbackGate: undefined,
    sessionFeedback: { open: false },
    lastCompletedTurnId: undefined,
    abortController: undefined,
    isLoadingHistory: false,
    streamStatus: "idle",
    streamAttempt: 0,
    lastUserTurnId: undefined,
  });

  useSessionStore.getState().clearSession();
  useSessionHistoryStore.getState().clearHistory();
  useSessionSnapshotStore.getState().clearSnapshot();

  useMessageMetadataStore.getState().clearAll();

  useRecapStore.setState({
    artifacts: {},
    decisions: {},
    commitStatus: {},
  });

  useConnectivityStore.setState({
    status: "online",
    lastChecked: null,
    lastOnline: null,
    messageQueue: [],
    failedAttempts: 0,
  });

  useConversationStore.setState({
    conversations: [],
    listLoadingState: "idle",
    listError: null,
    hasMore: false,
    nextCursor: null,
    loadingConversationId: null,
    conversationLoadingState: "idle",
    conversationError: null,
    lastViewedConversationId: null,
    lastRecapSessionId: null,
  });
}
