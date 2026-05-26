-- Sophia session metadata + hot-path transcript persistence.
--
-- Production source of truth for chat history. Run once in Supabase SQL
-- editor before setting SOPHIA_SESSION_STORE=supabase on Render.
--
-- IDs are TEXT rather than UUID because the current web/voice/provider
-- message ids are not all UUID-shaped. The backend still creates UUID
-- session ids for new web sessions, but keeping TEXT preserves legacy and
-- channel-originated sessions without lossy rewriting.

CREATE TABLE IF NOT EXISTS public.sophia_sessions (
    id                       TEXT PRIMARY KEY,
    user_id                  TEXT NOT NULL,
    thread_id                TEXT NOT NULL,
    run_id                   TEXT,
    mode                     TEXT NOT NULL CHECK (mode IN ('text', 'voice', 'mixed')),
    status                   TEXT NOT NULL CHECK (
        status IN ('active', 'ended', 'abandoned', 'interrupted', 'resumable')
    ),
    title                    TEXT,
    preview                  TEXT,
    message_count            INTEGER NOT NULL DEFAULT 0,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at          TIMESTAMPTZ,
    ended_at                 TIMESTAMPTZ,
    recap_status             TEXT,
    checkpointer_available   BOOLEAN,
    transcript_available     BOOLEAN NOT NULL DEFAULT false,
    metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sophia_sessions_user_updated_idx
    ON public.sophia_sessions (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS sophia_sessions_thread_idx
    ON public.sophia_sessions (thread_id);

CREATE TABLE IF NOT EXISTS public.sophia_session_messages (
    id                  TEXT PRIMARY KEY,
    message_id          TEXT NOT NULL,
    session_id          TEXT NOT NULL REFERENCES public.sophia_sessions(id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL,
    thread_id           TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool', 'artifact')),
    content             TEXT NOT NULL,
    source              TEXT NOT NULL DEFAULT 'text',
    final               BOOLEAN NOT NULL DEFAULT true,
    approximate         BOOLEAN NOT NULL DEFAULT false,
    turn_id             TEXT,
    provider_event_id   TEXT,
    sequence            INTEGER NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sophia_session_messages_session_seq_idx
    ON public.sophia_session_messages (session_id, sequence, created_at);

CREATE INDEX IF NOT EXISTS sophia_session_messages_user_created_idx
    ON public.sophia_session_messages (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sophia_session_messages_provider_event_idx
    ON public.sophia_session_messages (provider_event_id)
    WHERE provider_event_id IS NOT NULL;

-- The gateway uses SUPABASE_SERVICE_ROLE_KEY and PostgREST, so RLS is not
-- required for backend-only access. If RLS is enabled later, policies must
-- allow only trusted backend/service-role access; do not expose these tables
-- directly to anon or browser clients.
