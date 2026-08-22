-- FC01-R1 / M01-C2: stale transcript snapshots are read-only conflicts.
--
-- Forward replacement for 2026_08_21_fc01_m01_c1_session_message_revision.sql.
-- A stale browser snapshot must never insert, update, or delete rows: doing so
-- could resurrect a message that a newer revision intentionally removed.

BEGIN;

CREATE OR REPLACE FUNCTION public.sophia_replace_session_messages(
    p_user_id TEXT,
    p_session_id TEXT,
    p_expected_revision BIGINT,
    p_messages JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    current_revision BIGINT;
    next_revision BIGINT;
    upserted_count INTEGER := 0;
    deleted_count INTEGER := 0;
    changed BOOLEAN := FALSE;
BEGIN
    SELECT message_revision
      INTO current_revision
      FROM public.sophia_sessions
     WHERE id = p_session_id AND user_id = p_user_id
     FOR UPDATE;

    IF current_revision IS NULL THEN
        RAISE EXCEPTION 'session_not_found';
    END IF;

    IF current_revision <> p_expected_revision THEN
        RETURN jsonb_build_object(
            'accepted', FALSE,
            'duplicate', FALSE,
            'conflict', TRUE,
            'rejection_reason', 'revision_conflict',
            'previous_revision', current_revision,
            'current_revision', current_revision,
            'deleted_count', 0
        );
    END IF;

    INSERT INTO public.sophia_session_messages (
        id, message_id, session_id, user_id, thread_id, role, content,
        source, final, approximate, turn_id, provider_event_id, sequence,
        created_at, metadata
    )
    SELECT
        item->>'id', item->>'message_id', p_session_id, p_user_id,
        item->>'thread_id', item->>'role', item->>'content',
        COALESCE(item->>'source', 'text'), COALESCE((item->>'final')::BOOLEAN, TRUE),
        COALESCE((item->>'approximate')::BOOLEAN, FALSE), item->>'turn_id',
        item->>'provider_event_id', COALESCE((item->>'sequence')::INTEGER, 0),
        COALESCE((item->>'created_at')::TIMESTAMPTZ, now()),
        COALESCE(item->'metadata', '{}'::JSONB)
    FROM jsonb_array_elements(COALESCE(p_messages, '[]'::JSONB)) AS item
    ON CONFLICT (id) DO UPDATE SET
        thread_id = EXCLUDED.thread_id,
        role = EXCLUDED.role,
        content = EXCLUDED.content,
        source = EXCLUDED.source,
        final = EXCLUDED.final,
        approximate = EXCLUDED.approximate,
        turn_id = EXCLUDED.turn_id,
        provider_event_id = EXCLUDED.provider_event_id,
        sequence = EXCLUDED.sequence,
        created_at = EXCLUDED.created_at,
        metadata = EXCLUDED.metadata
    WHERE public.sophia_session_messages.thread_id IS DISTINCT FROM EXCLUDED.thread_id
       OR public.sophia_session_messages.role IS DISTINCT FROM EXCLUDED.role
       OR public.sophia_session_messages.content IS DISTINCT FROM EXCLUDED.content
       OR public.sophia_session_messages.source IS DISTINCT FROM EXCLUDED.source
       OR public.sophia_session_messages.final IS DISTINCT FROM EXCLUDED.final
       OR public.sophia_session_messages.approximate IS DISTINCT FROM EXCLUDED.approximate
       OR public.sophia_session_messages.turn_id IS DISTINCT FROM EXCLUDED.turn_id
       OR public.sophia_session_messages.provider_event_id IS DISTINCT FROM EXCLUDED.provider_event_id
       OR public.sophia_session_messages.sequence IS DISTINCT FROM EXCLUDED.sequence
       OR public.sophia_session_messages.created_at IS DISTINCT FROM EXCLUDED.created_at
       OR public.sophia_session_messages.metadata IS DISTINCT FROM EXCLUDED.metadata;
    GET DIAGNOSTICS upserted_count = ROW_COUNT;

    DELETE FROM public.sophia_session_messages existing
     WHERE existing.session_id = p_session_id
       AND existing.user_id = p_user_id
       AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(p_messages, '[]'::JSONB)) AS item
            WHERE item->>'id' = existing.id
       );
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    changed := upserted_count > 0 OR deleted_count > 0;
    IF NOT changed THEN
        RETURN jsonb_build_object(
            'accepted', TRUE,
            'duplicate', TRUE,
            'conflict', FALSE,
            'rejection_reason', NULL,
            'previous_revision', current_revision,
            'current_revision', current_revision,
            'deleted_count', 0
        );
    END IF;

    next_revision := current_revision + 1;
    UPDATE public.sophia_sessions
       SET message_revision = next_revision,
           transcript_available = EXISTS (
               SELECT 1
                 FROM public.sophia_session_messages
                WHERE session_id = p_session_id AND user_id = p_user_id
           ),
           updated_at = now()
     WHERE id = p_session_id AND user_id = p_user_id;

    RETURN jsonb_build_object(
        'accepted', TRUE,
        'duplicate', FALSE,
        'conflict', FALSE,
        'rejection_reason', NULL,
        'previous_revision', current_revision,
        'current_revision', next_revision,
        'deleted_count', deleted_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.sophia_replace_session_messages(TEXT, TEXT, BIGINT, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_replace_session_messages(TEXT, TEXT, BIGINT, JSONB)
    TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
