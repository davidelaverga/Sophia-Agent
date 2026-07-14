import { describe, expect, it } from "vitest";

import {
  supabaseProjectRef,
  validateBetterAuthDatabaseProject,
} from "@/server/better-auth/project-ref";

const target = "vlxnwmyvhchwbousrdzc";

describe("Better Auth Supabase project guard", () => {
  it("recognizes direct and pooler connection strings", () => {
    expect(
      supabaseProjectRef(`postgresql://postgres:secret@db.${target}.supabase.co:5432/postgres`),
    ).toBe(target);
    expect(
      supabaseProjectRef(
        `postgresql://postgres.${target}:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres`,
      ),
    ).toBe(target);
  });

  it("rejects divergent aliases and a mismatched project", () => {
    const targetUrl = `postgresql://postgres.${target}:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres`;
    expect(() =>
      validateBetterAuthDatabaseProject(targetUrl, "postgresql://different/db", target),
    ).toThrow(/same database/);
    expect(() =>
      validateBetterAuthDatabaseProject(
        "postgresql://postgres.qtyqgvdkbhjfmnfkxyvm:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres",
        undefined,
        target,
      ),
    ).toThrow(/expected Supabase project/);
  });

  it("accepts one verified target connection", () => {
    const targetUrl = `postgresql://postgres.${target}:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres`;
    expect(() => validateBetterAuthDatabaseProject(targetUrl, targetUrl, target)).not.toThrow();
  });
});
