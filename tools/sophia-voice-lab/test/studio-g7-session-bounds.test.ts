import { describe, expect, it } from "vitest";

import { passwordGrant } from "../src/studio-g7/supabase-session.js";
import { FAKE_EMAIL, FAKE_PASSWORD, FAKE_PUBLISHABLE_KEY, PRINCIPAL_UUID } from "./studio-g7-helpers.js";

/**
 * The bounds of a Supabase session body the Lab accepts, each on both sides:
 * the access and refresh token lengths, a positive lifetime, an expiry still
 * in the future. A session outside them is refused (STUDIO_AUTH_SESSION_INVALID).
 * The suites reach these only far from their edges; these pin every edge.
 */
const NOW = 1_791_590_000;
const target = { supabaseUrl: "http://abc.supabase.test", publishableKey: FAKE_PUBLISHABLE_KEY };

async function grant(overrides: Record<string, unknown>): Promise<string> {
  const body = { access_token: "a".repeat(32), refresh_token: "r".repeat(16), token_type: "bearer", expires_in: 3_600, expires_at: NOW + 3_600, user: { id: PRINCIPAL_UUID }, ...overrides };
  const fetchImpl = async (input: URL | string) => new URL(String(input)).pathname === "/auth/v1/logout"
    ? new Response(null, { status: 204 })
    : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return passwordGrant(target, { email: FAKE_EMAIL, password: FAKE_PASSWORD }, { fetchImpl, expectedUserId: PRINCIPAL_UUID, nowSeconds: () => NOW })
    .then(() => "accepted", (error: { detail?: { code?: string } }) => error.detail?.code ?? "error");
}

describe("Supabase session body bounds (each edge, both sides)", () => {
  it("the access token is 16 to 16 384 characters", async () => {
    expect(await grant({ access_token: "a".repeat(15) })).toBe("STUDIO_AUTH_SESSION_INVALID");
    expect(await grant({ access_token: "a".repeat(16) })).toBe("accepted");
    expect(await grant({ access_token: "a".repeat(17) })).toBe("accepted");
    expect(await grant({ access_token: "a".repeat(16_383) })).toBe("accepted");
    expect(await grant({ access_token: "a".repeat(16_384) })).toBe("accepted");
    expect(await grant({ access_token: "a".repeat(16_385) })).toBe("STUDIO_AUTH_SESSION_INVALID");
  });

  it("the refresh token is 8 to 4 096 characters", async () => {
    expect(await grant({ refresh_token: "r".repeat(7) })).toBe("STUDIO_AUTH_SESSION_INVALID");
    expect(await grant({ refresh_token: "r".repeat(8) })).toBe("accepted");
    expect(await grant({ refresh_token: "r".repeat(9) })).toBe("accepted");
    expect(await grant({ refresh_token: "r".repeat(4_095) })).toBe("accepted");
    expect(await grant({ refresh_token: "r".repeat(4_096) })).toBe("accepted");
    expect(await grant({ refresh_token: "r".repeat(4_097) })).toBe("STUDIO_AUTH_SESSION_INVALID");
  });

  it("the lifetime is a positive integer", async () => {
    expect(await grant({ expires_in: 0 })).toBe("STUDIO_AUTH_SESSION_INVALID");
    expect(await grant({ expires_in: 1 })).toBe("accepted");
    expect(await grant({ expires_in: 1.5 })).toBe("STUDIO_AUTH_SESSION_INVALID");
  });

  it("the expiry is an integer strictly after now", async () => {
    expect(await grant({ expires_at: NOW - 1 })).toBe("STUDIO_AUTH_SESSION_INVALID");
    expect(await grant({ expires_at: NOW })).toBe("STUDIO_AUTH_SESSION_INVALID");
    expect(await grant({ expires_at: NOW + 1 })).toBe("accepted");
    expect(await grant({ expires_at: NOW + 1.5 })).toBe("STUDIO_AUTH_SESSION_INVALID");
  });
});
