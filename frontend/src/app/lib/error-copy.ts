export const errorCopy = {
  connectionInterrupted: "Connection interrupted. Retry?",
  couldntReachSophia: "Couldn’t reach Sophia. Check your connection.",
  couldntSaveMemories: "Couldn’t save memories — try again.",
  offerExpired: "This offer expired.",
  recapLoadFailed: "Couldn’t load recap. Retry?",
  resumeFailed: "Couldn’t resume. Retry?",
  responseInterrupted: "Response interrupted.",
  responseCancelled: "Response cancelled.",
  sessionEnded: "Session ended",
} as const;

export type ErrorCopyKey = keyof typeof errorCopy;
