import { describe, expect, it } from "vitest";

import {
  normalizeDatabaseUrlForExplicitTls,
  resolveDatabaseTls,
} from "@/server/better-auth/database";

const SUPABASE_URL =
  "postgresql://better_auth_app.project:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&application_name=sophia";
const TEST_CA =
  "-----BEGIN CERTIFICATE-----\nverified-test-ca\n-----END CERTIFICATE-----";

describe("Better Auth database TLS configuration", () => {
  it("uses the explicit Supabase CA with hostname verification", () => {
    const resolved = resolveDatabaseTls({
      databaseUrl: SUPABASE_URL,
      modeRaw: "verify-full",
      caPemRaw: TEST_CA,
      environmentRaw: "production",
    });
    const normalized = new URL(resolved.connectionString);

    expect(resolved.mode).toBe("verify-full");
    expect(resolved.ssl).toEqual({
      ca: `${TEST_CA}\n`,
      rejectUnauthorized: true,
    });
    expect(normalized.searchParams.has("sslmode")).toBe(false);
    expect(normalized.searchParams.get("application_name")).toBe("sophia");
  });

  it("removes every URL certificate parameter that could replace the verified ssl object", () => {
    const original =
      "postgresql://user:secret@db.example.com/postgres?sslmode=verify-full&sslrootcert=%2Ftmp%2Froot.crt&sslcert=%2Ftmp%2Fclient.crt&sslkey=%2Ftmp%2Fclient.key&ssl=true";

    const normalized = new URL(normalizeDatabaseUrlForExplicitTls(original));

    expect(normalized.searchParams.has("ssl")).toBe(false);
    expect(normalized.searchParams.has("sslmode")).toBe(false);
    expect(normalized.searchParams.has("sslrootcert")).toBe(false);
    expect(normalized.searchParams.has("sslcert")).toBe(false);
    expect(normalized.searchParams.has("sslkey")).toBe(false);
  });

  it("fails closed when production Supabase has no CA", () => {
    expect(() => resolveDatabaseTls({
      databaseUrl: SUPABASE_URL,
      modeRaw: "verify-full",
      environmentRaw: "production",
    })).toThrow("database_tls_ca_required");
  });

  it.each(["disable", "no-verify"])(
    "forbids the %s mode in production",
    (modeRaw) => {
      expect(() => resolveDatabaseTls({
        databaseUrl: SUPABASE_URL,
        modeRaw,
        caPemRaw: TEST_CA,
        environmentRaw: "production",
      })).toThrow("database_tls_insecure_mode_forbidden");
    },
  );

  it("rejects an insecure URL flag in production even when application mode is auto", () => {
    expect(() => resolveDatabaseTls({
      databaseUrl: "postgresql://user:secret@db.example.com/postgres?sslmode=disable",
      modeRaw: "auto",
      environmentRaw: "production",
    })).toThrow("database_tls_insecure_url_forbidden");
  });

  it("allows an explicit non-production no-verify diagnostic without URL precedence", () => {
    const resolved = resolveDatabaseTls({
      databaseUrl: SUPABASE_URL,
      modeRaw: "no-verify",
      environmentRaw: "test",
    });
    const normalized = new URL(resolved.connectionString);

    expect(resolved.ssl).toEqual({ rejectUnauthorized: false });
    expect(normalized.searchParams.has("sslmode")).toBe(false);
  });

  it("leaves a generic auto-mode URL unchanged when TLS was not requested", () => {
    const original = "postgresql://user:secret@localhost/postgres?application_name=sophia";
    const resolved = resolveDatabaseTls({
      databaseUrl: original,
      modeRaw: "auto",
      environmentRaw: "test",
    });

    expect(resolved.connectionString).toBe(original);
    expect(resolved.ssl).toBeUndefined();
  });

  it("rejects malformed CA material", () => {
    expect(() => resolveDatabaseTls({
      databaseUrl: SUPABASE_URL,
      modeRaw: "verify-full",
      caPemRaw: "not a certificate",
      environmentRaw: "production",
    })).toThrow("database_tls_ca_invalid");
  });
});
