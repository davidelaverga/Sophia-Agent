import { it } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { verifyD02JournalDurability } from "./d02-journal-helper.js";
it("atomically retains D02 dispatch authority through raw content purge", async () => {
  await verifyD02JournalDurability(new MemoryVoiceLabLedger("test"));
});
