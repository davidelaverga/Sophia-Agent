-- MEM00: keep transcript chronology around recorded source rows.
--
-- Forward replacement for 2026_09_29_mem00_recorded_source_anchor.sql (same
-- signature, owner, search_path and grants). Only the sequence planning for
-- sessions with recorded rows changes; everything else is identical.
--
-- Why: recorded rows keep their sequence, and the other snapshot rows were
-- renumbered from 1 in snapshot order, skipping recorded sequences. When a
-- snapshot omitted the recorded row and an earlier row, a row that came after
-- the anchor could be renumbered below it (anchor 3, later row 4 -> 2),
-- reversing the request/correction order that transcript reads and memory
-- extraction sort by.
--
-- Contract (in addition to 2026_09_29):
--   * A recorded row present in the snapshot is an anchor for snapshot order,
--     exactly as before: rows listed after it are placed after it.
--   * For a recorded row the snapshot omits, every other row keeps its side:
--     a row already stored after it stays after it (by stored sequence), and a
--     new row created at or after it (created_at, defaulting to now()) goes
--     after it.
--   * Rows keep snapshot order among themselves.
--   * Sessions without recorded rows are processed exactly as before.
-- No row, receipt, trigger or version is modified by this migration.

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
    recorded_ids TEXT[];
    recorded_message_ids TEXT[];
    recorded_sequences INTEGER[];
    planned JSONB;
    planned_items JSONB[] := '{}';
    snapshot_item JSONB;
    recorded_index INTEGER;
    cursor_sequence INTEGER := 0;
    candidate INTEGER;
    existing_ids TEXT[];
    existing_sequences INTEGER[];
    existing_index INTEGER;
    anchor_floor INTEGER;
    recorded_created_ats TIMESTAMPTZ[];
    recorded_present BOOLEAN[];
    item_created_at TIMESTAMPTZ;
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

    -- Source intake takes the same session row lock, so this set is stable
    -- for the rest of the call.
    SELECT coalesce(array_agg(m.id ORDER BY m.sequence, m.id), '{}'),
           coalesce(array_agg(m.message_id ORDER BY m.sequence, m.id), '{}'),
           coalesce(array_agg(m.sequence ORDER BY m.sequence, m.id), '{}'),
           coalesce(array_agg(m.created_at ORDER BY m.sequence, m.id), '{}')
      INTO recorded_ids, recorded_message_ids, recorded_sequences, recorded_created_ats
      FROM public.sophia_session_messages m
     WHERE m.session_id = p_session_id
       AND m.user_id = p_user_id
       AND EXISTS (
           SELECT 1
             FROM public.sophia_memory_governance_events e
            WHERE e.source_intake_receipt IS NOT NULL
              AND e.source_intake_receipt->>'source_row_id' = m.id
              AND e.user_id = p_user_id
       );

    IF cardinality(recorded_ids) = 0 THEN
        planned := COALESCE(p_messages, '[]'::JSONB);
    ELSE
        -- Current sequences of this session's other rows: they tell which side
        -- of each recorded anchor a row was on, even when the snapshot omits
        -- the anchor itself.
        SELECT coalesce(array_agg(m.id), '{}'), coalesce(array_agg(m.sequence), '{}')
          INTO existing_ids, existing_sequences
          FROM public.sophia_session_messages m
         WHERE m.session_id = p_session_id
           AND m.user_id = p_user_id
           AND NOT (m.id = ANY(recorded_ids));
        -- Recorded rows the snapshot lists order it themselves; only omitted
        -- ones need the side rule below.
        recorded_present := array_fill(FALSE, ARRAY[cardinality(recorded_ids)]);
        FOR snapshot_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_messages, '[]'::JSONB)) LOOP
            recorded_index := coalesce(
                array_position(recorded_ids, snapshot_item->>'id'),
                array_position(recorded_message_ids, snapshot_item->>'message_id')
            );
            IF recorded_index IS NOT NULL THEN
                recorded_present[recorded_index] := TRUE;
            END IF;
        END LOOP;
        FOR snapshot_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_messages, '[]'::JSONB)) LOOP
            recorded_index := coalesce(
                array_position(recorded_ids, snapshot_item->>'id'),
                array_position(recorded_message_ids, snapshot_item->>'message_id')
            );
            IF recorded_index IS NOT NULL THEN
                cursor_sequence := GREATEST(cursor_sequence, recorded_sequences[recorded_index]);
                CONTINUE;
            END IF;
            -- Keep this row on its side of every omitted recorded row: a stored
            -- row by its stored sequence, a new row by its creation time.
            existing_index := array_position(existing_ids, snapshot_item->>'id');
            item_created_at := COALESCE((snapshot_item->>'created_at')::TIMESTAMPTZ, now());
            SELECT max(anchor.seq) INTO anchor_floor
              FROM unnest(recorded_sequences, recorded_created_ats, recorded_present) AS anchor(seq, created, present)
             WHERE NOT anchor.present
               AND CASE WHEN existing_index IS NOT NULL
                        THEN anchor.seq < existing_sequences[existing_index]
                        ELSE anchor.created <= item_created_at
                   END;
            cursor_sequence := GREATEST(cursor_sequence, coalesce(anchor_floor, 0));
            candidate := cursor_sequence + 1;
            WHILE candidate = ANY(recorded_sequences) LOOP
                candidate := candidate + 1;
            END LOOP;
            cursor_sequence := candidate;
            planned_items := array_append(planned_items, snapshot_item || jsonb_build_object('sequence', candidate));
        END LOOP;
        planned := to_jsonb(planned_items);
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
    FROM jsonb_array_elements(planned) AS item
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
    WHERE public.sophia_session_messages.session_id = p_session_id
      AND public.sophia_session_messages.user_id = p_user_id
      AND NOT (public.sophia_session_messages.id = ANY(recorded_ids))
      AND (public.sophia_session_messages.thread_id IS DISTINCT FROM EXCLUDED.thread_id
       OR public.sophia_session_messages.role IS DISTINCT FROM EXCLUDED.role
       OR public.sophia_session_messages.content IS DISTINCT FROM EXCLUDED.content
       OR public.sophia_session_messages.source IS DISTINCT FROM EXCLUDED.source
       OR public.sophia_session_messages.final IS DISTINCT FROM EXCLUDED.final
       OR public.sophia_session_messages.approximate IS DISTINCT FROM EXCLUDED.approximate
       OR public.sophia_session_messages.turn_id IS DISTINCT FROM EXCLUDED.turn_id
       OR public.sophia_session_messages.provider_event_id IS DISTINCT FROM EXCLUDED.provider_event_id
       OR public.sophia_session_messages.sequence IS DISTINCT FROM EXCLUDED.sequence
       OR public.sophia_session_messages.created_at IS DISTINCT FROM EXCLUDED.created_at
       OR public.sophia_session_messages.metadata IS DISTINCT FROM EXCLUDED.metadata);
    GET DIAGNOSTICS upserted_count = ROW_COUNT;

    DELETE FROM public.sophia_session_messages existing
     WHERE existing.session_id = p_session_id
       AND existing.user_id = p_user_id
       AND NOT (existing.id = ANY(recorded_ids))
       AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(planned) AS item
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
