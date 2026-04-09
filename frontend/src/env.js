import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Server-side environment variables schema.
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    BETTER_AUTH_SECRET:
      process.env.NODE_ENV === "production"
        ? z.string().min(32)
        : z.string().min(1).default("sophia-local-dev-secret-minimum-32-chars"),
    BETTER_AUTH_URL: z.string().url().optional(),
    BETTER_AUTH_DATABASE_URL: z.string().url().optional(),
    BETTER_AUTH_DATABASE_SSL_MODE: z
      .enum(["auto", "disable", "require", "no-verify"])
      .optional(),
    BETTER_AUTH_DATABASE_POOL_MAX: z.coerce.number().int().positive().optional(),
    BACKEND_API_URL: z.string().url().optional(),
    DATABASE_URL: z.string().url().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    RENDER_BACKEND_URL: z.string().url().optional(),
  },

  /**
   * Client-side environment variables schema.
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    NEXT_PUBLIC_API_URL: z.string().url().optional(),
    NEXT_PUBLIC_GATEWAY_URL: z.string().url().optional(),
    NEXT_PUBLIC_LANGGRAPH_BASE_URL: z.string().url().optional(),
    NEXT_PUBLIC_DEV_BYPASS_AUTH: z.string().optional(),
    NEXT_PUBLIC_SOPHIA_AUTH_BYPASS: z.string().optional(),
    NEXT_PUBLIC_SOPHIA_USER_ID: z.string().optional(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_DATABASE_URL: process.env.BETTER_AUTH_DATABASE_URL,
    BETTER_AUTH_DATABASE_SSL_MODE: process.env.BETTER_AUTH_DATABASE_SSL_MODE,
    BETTER_AUTH_DATABASE_POOL_MAX: process.env.BETTER_AUTH_DATABASE_POOL_MAX,
    BACKEND_API_URL: process.env.BACKEND_API_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    RENDER_BACKEND_URL: process.env.RENDER_BACKEND_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL,
    NEXT_PUBLIC_LANGGRAPH_BASE_URL: process.env.NEXT_PUBLIC_LANGGRAPH_BASE_URL,
    NEXT_PUBLIC_DEV_BYPASS_AUTH: process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH,
    NEXT_PUBLIC_SOPHIA_AUTH_BYPASS: process.env.NEXT_PUBLIC_SOPHIA_AUTH_BYPASS,
    NEXT_PUBLIC_SOPHIA_USER_ID: process.env.NEXT_PUBLIC_SOPHIA_USER_ID,
  },

  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,

  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
