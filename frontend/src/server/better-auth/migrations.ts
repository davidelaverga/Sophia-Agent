import { getMigrations } from "better-auth/db/migration";

import { auth } from "./config";

let migrationPromise: Promise<void> | null = null;

async function runBetterAuthMigrations() {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);

  if (toBeCreated.length === 0 && toBeAdded.length === 0) {
    return;
  }

  await runMigrations();
}

export async function ensureBetterAuthSchema() {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  migrationPromise ??= runBetterAuthMigrations().catch((error) => {
    migrationPromise = null;
    throw error;
  });

  await migrationPromise;
}