import { it, vi } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { ingestGenericOwnerLoss } from "../src/generic-owner-loss.js";
import { serviceOwnerFenceFixture } from "./service-owner-fence-fixture.js";
import { verifyServiceFenceHttp } from "./service-fence-http-helper.js";

it("keeps HTTP authorization and signature checks across an exact-receipt verifier repair", async () => {
  const f = serviceOwnerFenceFixture(new Date(Date.now() - 370000));
  const ledger = new MemoryVoiceLabLedger("test");
  let control = structuredClone(f.input.control);
  // Supply a retained fixture; admission still runs the production verifier.
  vi.spyOn(ledger, "getRecoveryControl").mockImplementation(async () => structuredClone(control));
  vi.spyOn(ledger, "persistGenericOwnerLoss").mockImplementation(async input => {
    const result = ingestGenericOwnerLoss(control, input, new Date());
    if (!result.replay) control = { ...control, version: result.version, genericOwnerLoss: result.proof };
    return result;
  });
  await verifyServiceFenceHttp(ledger, f);
});
