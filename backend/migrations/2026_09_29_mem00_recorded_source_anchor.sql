-- MEM00: a recorded source row is write-once for transcript snapshots.
--
-- Forward replacement for 2026_08_22_fc01_m01_c2_reject_stale_session_snapshots.sql
-- (same signature, owner, search_path and grants), plus the by-message receipt
-- lookup that pending-input recovery already calls.
--
-- Why: sophia_memory_accept_source_action inserts the governed source row and
-- records an immutable receipt of its sequence and memory_source_version.
-- LangGraph admission (create_run and before_agent) rechecks that exact
-- version. A browser transcript snapshot could still rewrite the row (a
-- millisecond created_at copied from GET, a position-based sequence, a view-model
-- content cut) or delete it by omission. Any column change rotates
-- memory_source_version, so the receipt stopped proving the row and every later
-- admission of that input was refused. Observed in production on 2026-09-22
-- (text) and 2026-09-28 (voice Builder requests).
--
-- Contract:
--   * A row whose id is the source_row_id of an intake receipt ("recorded row")
--     is never updated or deleted by sophia_replace_session_messages. The row
--     written by sophia_memory_accept_source_action is the authority; snapshot
--     values for it are ignored. A snapshot item that reuses a recorded
--     message_id under another row id is ignored too.
--   * Other rows keep the previous semantics. While a session has recorded
--     rows, their sequences follow snapshot order and never reuse a recorded
--     row's sequence, so the source snapshot partition stays unique.
--   * Sessions without recorded rows are processed exactly as before.
--   * No trigger is added: this RPC is the only function that updates
--     sophia_session_messages, and the Voice Lab ledger pins the table's exact
--     trigger set. Session deletion and Voice Lab cleanup are unchanged.
-- No existing row, receipt, trigger or version is modified by this migration.

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
        FOR snapshot_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_messages, '[]'::JSONB)) LOOP
            recorded_index := coalesce(
                array_position(recorded_ids, snapshot_item->>'id'),
                array_position(recorded_message_ids, snapshot_item->>'message_id')
            );
            IF recorded_index IS NOT NULL THEN
                cursor_sequence := GREATEST(cursor_sequence, recorded_sequences[recorded_index]);
                CONTINUE;
            END IF;
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

-- Pending-input recovery: find the immutable receipt for a checkpointed
-- message. Read evidence only; the caller still rechecks the current row.
-- NULL means no receipt; the store refuses it with a named reason.
CREATE OR REPLACE FUNCTION public.sophia_memory_lookup_source_action_by_message(p_user_id text,p_session_id text,p_message_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; receipt jsonb;
BEGIN
  SELECT * INTO governance FROM public.sophia_memory_user_governance WHERE user_id=p_user_id FOR SHARE;
  IF NOT FOUND OR governance.authority_state<>'governed' OR NOT EXISTS(SELECT 1 FROM public.sophia_memory_contract
    WHERE singleton AND schema_version='mem00.v1' AND contract_epoch=governance.authority_epoch AND mode IN ('shadow','enforced')) THEN
    RAISE EXCEPTION 'memory_source_authority_unavailable' USING ERRCODE='42501';
  END IF;
  SELECT source_intake_receipt INTO receipt FROM public.sophia_memory_governance_events
    WHERE user_id=p_user_id AND source_session_id=p_session_id AND source_intake_receipt IS NOT NULL
      AND source_intake_receipt->>'message_id'=p_message_id AND event_type='memory_source_action_accepted';
  IF receipt IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN receipt||jsonb_build_object('idempotent_replay',true);
END $fn$;

REVOKE ALL ON FUNCTION public.sophia_memory_lookup_source_action_by_message(text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_lookup_source_action_by_message(text,text,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
