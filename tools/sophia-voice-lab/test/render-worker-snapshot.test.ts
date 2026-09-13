import { describe, expect, it, vi } from "vitest";
import { readRenderWorkerSnapshot } from "../scripts/external-attestations/render-worker-controller.js";
import { RenderInventoryError, retryableRenderObservation } from "../scripts/external-attestations/render-inventory.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";

const serviceId = "srv-0123456789abcdefghij";
const controller = { render_api_origin: "https://api.render.com", render_worker_service_id: serviceId };
const before = "2026-09-13T10:00:00.000Z", after = "2026-09-13T11:00:00.000Z";
function source(instances: unknown[]) {
  return vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const value = path.endsWith("/instances") ? instances : path.endsWith("/deploys")
      ? [{ deploy: { id: "dep-0123456789abcdefghij", status: "live", createdAt: before, updatedAt: before, finishedAt: before } }]
      : { id: serviceId, name: "sophia-voice-lab-worker", type: "background_worker" };
    return new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Render worker instance source integrity", () => {
  it("keeps each creation timestamp joined to its ID after canonical ordering", async () => {
    const result = await readRenderWorkerSnapshot(controller, "synthetic-only", source([
      { instance: { id: "worker-z-new", createdAt: after } },
      { instance: { id: "worker-a-old", createdAt: before } },
    ]), null);
    expect(result.instanceIds).toEqual(["worker-a-old", "worker-z-new"]);
    expect(result.instanceCreatedAt.map(date => date.toISOString())).toEqual([before, after]);
    expect(result.instanceSetSha256).toBe(canonicalRequestHash(result.instanceIds.map(sha256).sort()));
  });

  it("cannot conceal duplicate source owners by retrying a later subset", async () => {
    const read = readRenderWorkerSnapshot(controller, "synthetic-only", source([
      { instance: { id: "worker-duplicate", createdAt: before } },
      { instance: { id: "worker-duplicate", createdAt: after } },
    ]), null);
    await expect(read).rejects.toBeInstanceOf(RenderInventoryError);
    await expect(read.catch(retryableRenderObservation)).rejects.toBeInstanceOf(RenderInventoryError);
  });

  it("keeps an empty transitioning inventory retryable without claiming owner loss", async () => {
    const result = await readRenderWorkerSnapshot(controller, "synthetic-only", source([]), null).catch(retryableRenderObservation);
    expect(result).toBeNull();
  });
});
