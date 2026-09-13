import { it } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { verifyPreservedExecutionCleanup } from "./recovery-execution-persistence-helper.js";

it("preserves only validated execution cleanup across content deletion", async () => {
  await verifyPreservedExecutionCleanup(new MemoryVoiceLabLedger("test"));
});
