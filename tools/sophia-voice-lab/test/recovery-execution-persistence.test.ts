import { it } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { verifyPreservedExecutionCleanup } from "./recovery-execution-persistence-helper.js";
import { verifyRecoveredLeaseRelease } from "./recovered-lease-helper.js";

it("preserves only validated execution cleanup across content deletion", async () => {
  await verifyPreservedExecutionCleanup(new MemoryVoiceLabLedger("test"));
});

it("releases only an expired exact dead execution using preserved cleanup proof", async () => {
  await verifyRecoveredLeaseRelease(new MemoryVoiceLabLedger("test"));
});
