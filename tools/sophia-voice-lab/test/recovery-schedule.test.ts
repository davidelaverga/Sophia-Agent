import { it, vi } from "vitest";
import { RETAINED_RECOVERY_RETRY_MS } from "../src/recovery-control.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { verifyRestartRecoverySchedule } from "./recovery-schedule-helper.js";

it("advances retained scheduling across worker restarts without claiming cleanup", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await verifyRestartRecoverySchedule(new MemoryVoiceLabLedger("test"), undefined, async () => {
      vi.setSystemTime(Date.now() + RETAINED_RECOVERY_RETRY_MS + 1);
    });
  } finally { vi.useRealTimers(); }
});
