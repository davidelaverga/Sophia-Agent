-- Telegram <-> webapp user identity bindings.
--
-- Backs the gateway's in-memory store at
-- backend/app/gateway/telegram_link_store.py so chat -> canonical user
-- bindings survive gateway restarts/deploys.
--
-- Run this once in the Supabase SQL editor before relying on the
-- /api/sophia/{user_id}/telegram/link flow in production.

BEGIN;

CREATE TABLE IF NOT EXISTS public.telegram_user_bindings (
    channel             TEXT        NOT NULL,
    chat_id             TEXT        NOT NULL,
    user_id             TEXT        NOT NULL,
    telegram_user_id    TEXT,
    telegram_username   TEXT,
    -- Stored as Unix epoch seconds (float). Matches what the Python
    -- store writes via time.time().
    created_at          DOUBLE PRECISION NOT NULL,
    -- Composite PK: one row per (channel, chat_id) pair. Mirrors the
    -- in-memory _bindings_by_chat dict and lets the upsert below use
    -- ?on_conflict=channel,chat_id semantics with Prefer: resolution=merge-duplicates.
    PRIMARY KEY (channel, chat_id)
);

-- Fast lookup of all bindings for a given canonical webapp user (used by
-- get_binding_for_user / unbind_user).
CREATE INDEX IF NOT EXISTS telegram_user_bindings_user_id_idx
    ON public.telegram_user_bindings (user_id);

REVOKE ALL ON TABLE public.telegram_user_bindings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.telegram_user_bindings TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
