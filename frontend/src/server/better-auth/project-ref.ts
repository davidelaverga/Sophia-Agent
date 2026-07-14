export function supabaseProjectRef(databaseUrl: string): string | null {
  const parsed = new URL(databaseUrl);
  const hostname = parsed.hostname.toLowerCase();
  const directMatch = hostname.match(/^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/);
  if (directMatch) {
    return directMatch[1] ?? null;
  }
  if (hostname.endsWith(".pooler.supabase.com") || hostname.endsWith(".pooler.supabase.co")) {
    const username = decodeURIComponent(parsed.username);
    const separator = username.lastIndexOf(".");
    return separator >= 0 ? username.slice(separator + 1).toLowerCase() : null;
  }
  return null;
}

export function validateBetterAuthDatabaseProject(
  primaryUrl: string,
  fallbackUrl: string | undefined,
  expectedRef: string | undefined,
) {
  if (fallbackUrl && fallbackUrl !== primaryUrl) {
    throw new Error("BETTER_AUTH_DATABASE_URL and DATABASE_URL must identify the same database.");
  }
  const expected = expectedRef?.trim().toLowerCase();
  if (!expected) {
    return;
  }
  const actual = supabaseProjectRef(primaryUrl);
  if (actual !== expected) {
    throw new Error("Better Auth database does not match the expected Supabase project.");
  }
}
