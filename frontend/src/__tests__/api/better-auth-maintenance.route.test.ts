import { afterEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/auth/[...all]/route";

const originalMaintenanceMode = process.env.SOPHIA_MIGRATION_MAINTENANCE_MODE;

afterEach(() => {
  if (originalMaintenanceMode === undefined) {
    delete process.env.SOPHIA_MIGRATION_MAINTENANCE_MODE;
  } else {
    process.env.SOPHIA_MIGRATION_MAINTENANCE_MODE = originalMaintenanceMode;
  }
});

describe("Better Auth migration maintenance", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
  ])("blocks %s requests before Better Auth handles them", async (_method, handler) => {
    process.env.SOPHIA_MIGRATION_MAINTENANCE_MODE = "true";

    const response = await handler(new Request("https://www.sophia-ei.com/api/auth/callback/google"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: "Authentication is temporarily read-only during a database migration.",
    });
  });
});
