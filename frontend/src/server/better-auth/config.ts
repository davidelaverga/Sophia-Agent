import { betterAuth } from "better-auth";
import Database from "better-sqlite3";

// Vercel is serverless — no writable filesystem for SQLite.
// Use in-memory DB in production (auth is bypassed via DEV_BYPASS_AUTH anyway).
const isServerless = process.env.VERCEL === "1" || process.env.NEXT_RUNTIME === "nodejs";
const db = new Database(isServerless ? ":memory:" : "./sqlite.db");

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  database: db,
  socialProviders: {
    discord: {
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
    },
  },
});

export type Session = typeof auth.$Infer.Session;
