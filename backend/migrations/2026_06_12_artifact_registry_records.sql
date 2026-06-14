-- Durable Artifact Library metadata.
--
-- Run once in Supabase SQL editor before setting
-- SOPHIA_ARTIFACT_REGISTRY_STORE=supabase or hybrid.
--
-- The gateway uses SUPABASE_SERVICE_ROLE_KEY through PostgREST. Browser
-- clients must continue using /api/artifacts; do not expose this table for
-- direct anon/client writes.

CREATE TABLE IF NOT EXISTS public.artifact_registry_records (
    artifact_id          TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL,
    thread_id            TEXT NOT NULL,
    session_id           TEXT,
    parent_thread_id     TEXT,
    task_id              TEXT,
    run_id               TEXT,
    trace_id             TEXT,
    logical_artifact_id  TEXT NOT NULL,
    version_id           TEXT NOT NULL,
    parent_version_id    TEXT,
    title                TEXT NOT NULL,
    filename             TEXT NOT NULL,
    artifact_type        TEXT NOT NULL,
    renderer_kind        TEXT NOT NULL,
    mime_type            TEXT,
    safe_summary         TEXT,
    source               TEXT NOT NULL CHECK (
        source IN ('builder', 'upload', 'quick_edit', 'coreview_version', 'file_library_backfill', 'backfill')
    ),
    local_path           TEXT NOT NULL,
    storage_provider     TEXT NOT NULL DEFAULT 'local' CHECK (storage_provider IN ('local', 'supabase', 'hybrid')),
    storage_bucket       TEXT,
    storage_object_path  TEXT,
    size_bytes           BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
    content_hash         TEXT,
    storage_status       TEXT NOT NULL DEFAULT 'available',
    artifact_role        TEXT NOT NULL DEFAULT 'primary' CHECK (artifact_role IN ('primary', 'wrapper', 'support', 'internal')),
    is_library_visible   BOOLEAN NOT NULL DEFAULT true,
    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,
    deleted_at           TIMESTAMPTZ,
    last_opened_at       TIMESTAMPTZ,
    opened_count         INTEGER NOT NULL DEFAULT 0 CHECK (opened_count >= 0),
    raw_content_excluded BOOLEAN NOT NULL DEFAULT true,
    signed_url_excluded  BOOLEAN NOT NULL DEFAULT true,
    record_payload       JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.artifact_registry_records
    ADD COLUMN IF NOT EXISTS record_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS artifact_registry_user_updated_idx
    ON public.artifact_registry_records (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS artifact_registry_user_created_idx
    ON public.artifact_registry_records (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS artifact_registry_user_thread_idx
    ON public.artifact_registry_records (user_id, thread_id);

CREATE INDEX IF NOT EXISTS artifact_registry_user_session_idx
    ON public.artifact_registry_records (user_id, session_id)
    WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS artifact_registry_user_visibility_idx
    ON public.artifact_registry_records (user_id, is_library_visible, deleted_at);

CREATE INDEX IF NOT EXISTS artifact_registry_user_logical_version_idx
    ON public.artifact_registry_records (user_id, logical_artifact_id, version_id);
