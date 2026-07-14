-- Complete the Sophia production target with Better Auth's PostgreSQL schema
-- and the private builder artifact bucket. Better Auth 1.5.6's migration
-- generator owns these four model shapes; this SQL is the idempotent Supabase
-- SQL Editor equivalent for a fresh target.

BEGIN;

CREATE TABLE IF NOT EXISTS public."user" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL UNIQUE,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public."session" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES public."user"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON public."session" ("userId");

CREATE TABLE IF NOT EXISTS public."account" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES public."user"("id") ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "account_userId_idx" ON public."account" ("userId");

CREATE TABLE IF NOT EXISTS public."verification" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "verification_identifier_idx"
    ON public."verification" ("identifier");

REVOKE ALL ON TABLE public."user" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."session" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."account" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public."verification" FROM PUBLIC, anon, authenticated, service_role;

-- Better Auth uses a dedicated pooled PostgreSQL role. The migration creates
-- the role without a credential; production provisioning must set LOGIN and a
-- generated password out of band, then place that connection string only in
-- Vercel's encrypted Production environment.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'better_auth_app') THEN
        CREATE ROLE better_auth_app
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOINHERIT;
    END IF;
END
$$;

GRANT CONNECT ON DATABASE postgres TO better_auth_app;
GRANT USAGE ON SCHEMA public TO better_auth_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public."user",
    public."session",
    public."account",
    public."verification"
TO better_auth_app;

INSERT INTO storage.buckets (id, name, public)
VALUES ('sophia-builder-artifacts', 'sophia-builder-artifacts', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Keep these policies scoped to the builder bucket so the target project's
-- existing audio buckets and policies remain untouched.
DROP POLICY IF EXISTS "sophia_builder_artifacts_service_role_select" ON storage.objects;
CREATE POLICY "sophia_builder_artifacts_service_role_select"
    ON storage.objects FOR SELECT TO service_role
    USING (bucket_id = 'sophia-builder-artifacts');

DROP POLICY IF EXISTS "sophia_builder_artifacts_service_role_insert" ON storage.objects;
CREATE POLICY "sophia_builder_artifacts_service_role_insert"
    ON storage.objects FOR INSERT TO service_role
    WITH CHECK (bucket_id = 'sophia-builder-artifacts');

DROP POLICY IF EXISTS "sophia_builder_artifacts_service_role_update" ON storage.objects;
CREATE POLICY "sophia_builder_artifacts_service_role_update"
    ON storage.objects FOR UPDATE TO service_role
    USING (bucket_id = 'sophia-builder-artifacts')
    WITH CHECK (bucket_id = 'sophia-builder-artifacts');

DROP POLICY IF EXISTS "sophia_builder_artifacts_service_role_delete" ON storage.objects;
CREATE POLICY "sophia_builder_artifacts_service_role_delete"
    ON storage.objects FOR DELETE TO service_role
    USING (bucket_id = 'sophia-builder-artifacts');

NOTIFY pgrst, 'reload schema';

COMMIT;
