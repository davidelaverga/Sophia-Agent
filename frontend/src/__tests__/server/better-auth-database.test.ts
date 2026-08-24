import { describe, expect, it } from "vitest";

import { applyBetterAuthSslModeToDatabaseUrl } from "@/server/better-auth/database";

describe("Better Auth database TLS configuration", () => {
  it("makes the explicit no-verify mode authoritative over URL SSL parameters", () => {
    const original =
      "postgresql://better_auth_app.project:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&application_name=sophia";

    const normalized = new URL(applyBetterAuthSslModeToDatabaseUrl(original, "no-verify"));

    expect(normalized.searchParams.get("ssl")).toBe("no-verify");
    expect(normalized.searchParams.has("sslmode")).toBe(false);
    expect(normalized.searchParams.get("application_name")).toBe("sophia");
  });

  it("removes certificate parameters that would override no-verify in node-postgres", () => {
    const original =
      "postgresql://user:secret@db.example.com/postgres?sslmode=verify-full&sslrootcert=%2Ftmp%2Froot.crt&sslcert=%2Ftmp%2Fclient.crt&sslkey=%2Ftmp%2Fclient.key";

    const normalized = new URL(applyBetterAuthSslModeToDatabaseUrl(original, "no-verify"));

    expect(normalized.searchParams.get("ssl")).toBe("no-verify");
    expect(normalized.searchParams.has("sslmode")).toBe(false);
    expect(normalized.searchParams.has("sslrootcert")).toBe(false);
    expect(normalized.searchParams.has("sslcert")).toBe(false);
    expect(normalized.searchParams.has("sslkey")).toBe(false);
  });

  it("leaves connection strings unchanged for every other application mode", () => {
    const original =
      "postgresql://user:secret@db.example.com/postgres?sslmode=verify-full";

    expect(applyBetterAuthSslModeToDatabaseUrl(original, "auto")).toBe(original);
    expect(applyBetterAuthSslModeToDatabaseUrl(original, "require")).toBe(original);
    expect(applyBetterAuthSslModeToDatabaseUrl(original, "disable")).toBe(original);
  });
});
