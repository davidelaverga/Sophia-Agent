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
--   * Each other row's place among the recorded rows (the gap it sits in) is
--     decided before any sequence is assigned:
--       - a stored row stays in the gap it is stored in, whatever the snapshot
--         lists or how it orders it. A row the snapshot re-keys under a new id
--         is recognised by its message_id;
--       - a new row follows a recorded row the snapshot lists by its exact row
--         id if it is listed after it, and always follows a recorded row the
--         snapshot does not list by exact id: the server first sees the new row
--         now, after that row was recorded. Client created_at values are never
--         used for ordering (browser clocks may be skewed).
--   * A row reusing a recorded row's message_id under another id is a copy: it
--     is never written and positions nothing.
--   * Rows in the same gap keep snapshot order and take the free sequences
--     there, counting up from the recorded row below them.
--   * If a new row's places contradict each other, or more rows belong in a
--     gap below a recorded row than it has free sequences, the whole snapshot
--     is refused with rejection_reason 'recorded_source_order_unrepresentable'
--     and nothing is written. The web client then refetches the transcript,
--     which lists every recorded row in sequence order, and resends its new
--     rows after it. That resend is never refused: new rows go after the last
--     recorded row, and stored rows already fit their gaps because no two of
--     a session's rows share a sequence (every writer assigns distinct ones;
--     the deploy preflight checks this).
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
    recorded_positions INTEGER[];
    planned JSONB;
    snapshot_item JSONB;
    item_ordinal INTEGER;
    recorded_index INTEGER;
    existing_ids TEXT[];
    existing_message_ids TEXT[];
    existing_sequences INTEGER[];
    existing_index INTEGER;
    lowest_gap INTEGER;
    highest_gap INTEGER;
    plan_items JSONB[] := '{}';
    plan_gaps INTEGER[] := '{}';
    plan_ordinals INTEGER[] := '{}';
    over_capacity BOOLEAN;
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
           coalesce(array_agg(m.sequence ORDER BY m.sequence, m.id), '{}')
      INTO recorded_ids, recorded_message_ids, recorded_sequences
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
        -- Gaps are numbered by how many recorded rows (in sequence order) lie
        -- below them: gap 0 is before the first recorded row, gap n is between
        -- recorded rows n and n + 1.
        SELECT coalesce(array_agg(m.id ORDER BY m.sequence, m.id), '{}'),
               coalesce(array_agg(m.message_id ORDER BY m.sequence, m.id), '{}'),
               coalesce(array_agg(m.sequence ORDER BY m.sequence, m.id), '{}')
          INTO existing_ids, existing_message_ids, existing_sequences
          FROM public.sophia_session_messages m
         WHERE m.session_id = p_session_id
           AND m.user_id = p_user_id
           AND NOT (m.id = ANY(recorded_ids));
        -- Where the snapshot lists each recorded row by its exact row id.
        recorded_positions := array_fill(NULL::INTEGER, ARRAY[cardinality(recorded_ids)]);
        FOR snapshot_item, item_ordinal IN
            SELECT e.value, e.ordinality::INTEGER
              FROM jsonb_array_elements(COALESCE(p_messages, '[]'::JSONB)) WITH ORDINALITY AS e(value, ordinality)
        LOOP
            recorded_index := array_position(recorded_ids, snapshot_item->>'id');
            IF recorded_index IS NOT NULL AND recorded_positions[recorded_index] IS NULL THEN
                recorded_positions[recorded_index] := item_ordinal;
            END IF;
        END LOOP;
        FOR snapshot_item, item_ordinal IN
            SELECT e.value, e.ordinality::INTEGER
              FROM jsonb_array_elements(COALESCE(p_messages, '[]'::JSONB)) WITH ORDINALITY AS e(value, ordinality)
        LOOP
            -- Recorded rows are never rewritten, and a copy reusing a recorded
            -- row's message_id is discarded without positioning anything.
            IF snapshot_item->>'id' = ANY(recorded_ids)
               OR snapshot_item->>'message_id' = ANY(recorded_message_ids) THEN
                CONTINUE;
            END IF;
            existing_index := coalesce(
                array_position(existing_ids, snapshot_item->>'id'),
                CASE WHEN snapshot_item->>'message_id' IS NOT NULL
                     THEN array_position(existing_message_ids, snapshot_item->>'message_id')
                END
            );
            IF existing_index IS NOT NULL THEN
                -- A stored row stays in the gap it is stored in.
                SELECT count(*)::INTEGER INTO lowest_gap
                  FROM unnest(recorded_sequences) AS anchor(seq)
                 WHERE anchor.seq < existing_sequences[existing_index];
            ELSE
                -- A new row follows a listed recorded row it is listed after, and
                -- every recorded row the snapshot does not list by exact id.
                SELECT coalesce(max(anchor.n) FILTER (WHERE anchor.follows), 0)::INTEGER,
                       coalesce(min(anchor.n) FILTER (WHERE NOT anchor.follows) - 1, cardinality(recorded_ids))::INTEGER
                  INTO lowest_gap, highest_gap
                  FROM (
                      SELECT a.n, a.listed_at IS NULL OR a.listed_at < item_ordinal AS follows
                        FROM unnest(recorded_positions) WITH ORDINALITY AS a(listed_at, n)
                  ) anchor;
                IF lowest_gap > highest_gap THEN
                    RETURN jsonb_build_object(
                        'accepted', FALSE,
                        'duplicate', FALSE,
                        'conflict', FALSE,
                        'rejection_reason', 'recorded_source_order_unrepresentable',
                        'previous_revision', current_revision,
                        'current_revision', current_revision,
                        'deleted_count', 0
                    );
                END IF;
            END IF;
            plan_items := array_append(plan_items, snapshot_item);
            plan_gaps := array_append(plan_gaps, lowest_gap);
            plan_ordinals := array_append(plan_ordinals, item_ordinal);
        END LOOP;
        -- Each gap's rows, in snapshot order, take the sequences above the
        -- recorded row below the gap; a gap below a recorded row must not
        -- reach that row's sequence.
        SELECT coalesce(jsonb_agg(p.item || jsonb_build_object('sequence', p.seq) ORDER BY p.seq), '[]'::JSONB),
               coalesce(bool_or(p.gap < cardinality(recorded_ids) AND p.seq >= recorded_sequences[p.gap + 1]), FALSE)
          INTO planned, over_capacity
          FROM (
              SELECT g.item, g.gap,
                     (CASE WHEN g.gap = 0 THEN 0 ELSE recorded_sequences[g.gap] END
                      + row_number() OVER (PARTITION BY g.gap ORDER BY g.ordinal))::INTEGER AS seq
                FROM unnest(plan_items, plan_gaps, plan_ordinals) AS g(item, gap, ordinal)
          ) p;
        IF over_capacity THEN
            RETURN jsonb_build_object(
                'accepted', FALSE,
                'duplicate', FALSE,
                'conflict', FALSE,
                'rejection_reason', 'recorded_source_order_unrepresentable',
                'previous_revision', current_revision,
                'current_revision', current_revision,
                'deleted_count', 0
            );
        END IF;
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
