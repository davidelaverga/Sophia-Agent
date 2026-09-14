import { expect, it, vi } from "vitest";
import type pg from "pg";
import { parseServiceFenceUpgradeIntent, serviceFenceInventory, upgradeServiceFenceSchema } from "../src/service-fence-upgrade.js";

const valid = { SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_APPROVED: "YES", SOPHIA_VOICE_LAB_KILL_SWITCH: "true",
  SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_EXPECTED_COMMIT: "a".repeat(40), COMMIT_SHA: "a".repeat(40),
  SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_INVENTORY_SHA256: "b".repeat(64) };
it("requires explicit closed exact-commit inventory intent", () => {
  expect(parseServiceFenceUpgradeIntent(valid)).toEqual({ commit: "a".repeat(40), inventorySha256: "b".repeat(64) });
  for (const key of Object.keys(valid)) expect(() => parseServiceFenceUpgradeIntent({ ...valid, [key]: "wrong" })).toThrow(/INTENT/);
  expect(() => parseServiceFenceUpgradeIntent({ ...valid, RENDER_GIT_COMMIT: "c".repeat(40) })).toThrow(/INTENT/);
});
it("refuses altered source bytes before acquiring a database connection", async () => {
  const connect = vi.fn();
  await expect(upgradeServiceFenceSchema({ connect } as unknown as pg.Pool, parseServiceFenceUpgradeIntent(valid), Buffer.from("altered"), Buffer.alloc(0), Buffer.alloc(0))).rejects.toThrow(/checksum/);
  expect(connect).not.toHaveBeenCalled();
});
it("commits to retained ownership rows without returning their contents", async () => {
  let value = "private-control-identity";
  const query = vi.fn(async () => ({ rows: [{ value }] }));
  const client = { query } as unknown as pg.PoolClient;
  const before = await serviceFenceInventory(client);
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  expect(query).toHaveBeenCalledTimes(5);
  for (const call of query.mock.calls) expect(call).toBeDefined();
  value = "changed-private-control-identity";
  expect(await serviceFenceInventory(client)).not.toBe(before);
});
it("refuses truncated ownership inventory", async () => {
  const query = vi.fn(async () => ({ rows: Array.from({ length: 10001 }, () => ({ value: "{}" })) }));
  await expect(serviceFenceInventory({ query } as unknown as pg.PoolClient)).rejects.toThrow(/BOUND/);
});
