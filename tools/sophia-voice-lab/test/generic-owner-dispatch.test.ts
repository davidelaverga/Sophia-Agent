import { it } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { verifyGenericOwnerDispatch } from "./generic-owner-dispatch-helper.js";
it("consumes one exact owner dispatch once across concurrent retries and content purge", async () => {
  await verifyGenericOwnerDispatch(new MemoryVoiceLabLedger("test"), []);
});
