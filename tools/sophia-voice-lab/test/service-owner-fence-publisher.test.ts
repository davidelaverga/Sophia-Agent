import { expect, it } from "vitest";
import { publishServiceOwnerFence } from "../scripts/external-attestations/service-owner-fence-publisher.js";
import { serviceOwnerFenceFixture } from "./service-owner-fence-fixture.js";
import { ingestGenericOwnerLoss } from "../src/generic-owner-loss.js";
import { GENERIC_RECOVERY_ORIGIN } from "../scripts/external-attestations/generic-worker-preflight.js";

function fixture(mode: "ok" | "lost-after-commit" | "lost-before-commit" = "ok") {
  const f = serviceOwnerFenceFixture();
  let control = structuredClone(f.input.control);
  let time = f.input.acceptedAt;
  const actions: string[] = [];
  const fetchImpl: typeof fetch = async (raw, init) => {
    expect(String(raw)).toBe(`${GENERIC_RECOVERY_ORIGIN}/internal/voice-lab/recovery/owner-dispatch`);
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body)); actions.push(body.action);
    if (body.action === "ingest_service_fence") {
      if (mode === "lost-before-commit") throw new Error("synthetic transport failure");
      const result = ingestGenericOwnerLoss(control, { ...f.input, ...body }, time);
      control = { ...control, genericOwnerLoss: result.proof, version: result.version };
      if (mode === "lost-after-commit") throw new Error("synthetic lost response");
    } else expect(body.action).toBe("inspect");
    return new Response(JSON.stringify({ dispatchAllowed: false, workerServiceId: "srv-0123456789abcdefghij", control }));
  };
  const input = { runId: control.binding.runId, workerServiceId: "srv-0123456789abcdefghij", voiceLabOrigin: GENERIC_RECOVERY_ORIGIN,
    receipt: f.input.receipt, expectedLabSha: f.unsigned.expectedLabSha, expectedLangGraphSha: f.unsigned.expectedLangGraphSha,
    expectedRecoveryDeployment: f.unsigned.expectedRecoveryDeployment, publicConfig: { deployment_control: f.input.authority },
    deploymentBearer: "synthetic-deployment-bearer", fetchImpl, now: () => time };
  return { input, actions, settle: () => { control.liveCleanupComplete = true; }, expire: () => { time = f.at(1000000); } };
}
it("publishes once and verifies settled post-expiry replay by inspection only", async () => {
  const f = fixture();
  const result = await publishServiceOwnerFence(f.input);
  expect(result).toMatchObject({ status: "ingested", replay: false, cleanupProven: false });
  f.settle(); f.expire();
  expect(await publishServiceOwnerFence(f.input)).toEqual({ ...result, replay: true });
  expect(f.actions).toEqual(["inspect", "ingest_service_fence", "inspect"]);
});
it("recovers a lost post-commit response using only inspection", async () => {
  const f = fixture("lost-after-commit");
  expect(await publishServiceOwnerFence(f.input)).toMatchObject({ status: "ingested", replay: true });
  expect(f.actions).toEqual(["inspect", "ingest_service_fence", "inspect"]);
});
it("leaves an uncommitted lost request unconfirmed without mutation retry", async () => {
  const f = fixture("lost-before-commit");
  expect(await publishServiceOwnerFence(f.input)).toMatchObject({ status: "unconfirmed", proofSha256: null, cleanupProven: false });
  expect(f.actions).toEqual(["inspect", "ingest_service_fence", "inspect"]);
});
it("rejects expired first publication and changed pins before sending ingestion", async () => {
  const f = fixture(); f.expire();
  await expect(publishServiceOwnerFence(f.input)).rejects.toThrow();
  expect(f.actions).toEqual(["inspect"]);
  const g = fixture();
  await expect(publishServiceOwnerFence({ ...g.input, expectedLabSha: "f".repeat(40) })).rejects.toThrow();
  expect(g.actions).toEqual(["inspect"]);
});
it.each(["dispatch-permit", "wrong-service", "wrong-control", "malformed"] as const)("rejects %s inspection before publication", async mode => {
  const f = fixture();
  const fetchImpl: typeof fetch = async (raw, init) => {
    const response = await f.input.fetchImpl(raw, init);
    if (mode === "malformed") return new Response("{");
    const value = await response.json();
    if (mode === "dispatch-permit") value.dispatchAllowed = true;
    if (mode === "wrong-service") value.workerServiceId = "srv-abcdefghij0123456789";
    if (mode === "wrong-control") value.control.binding.runId = "00000000-0000-4000-8000-000000000000";
    return new Response(JSON.stringify(value));
  };
  await expect(publishServiceOwnerFence({ ...f.input, fetchImpl })).rejects.toThrow();
  expect(f.actions).toEqual(["inspect"]);
});
it("does not accept a corrupted persisted proof or send a replacement mutation", async () => {
  const f = fixture();
  await publishServiceOwnerFence(f.input);
  f.actions.length = 0;
  const fetchImpl: typeof fetch = async (raw, init) => {
    const value = await (await f.input.fetchImpl(raw, init)).json();
    value.control.genericOwnerLoss.proofSha256 = "0".repeat(64);
    return new Response(JSON.stringify(value));
  };
  await expect(publishServiceOwnerFence({ ...f.input, fetchImpl })).rejects.toThrow();
  expect(f.actions).toEqual(["inspect"]);
});
