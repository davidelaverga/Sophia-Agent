-- Recorded source rows survive browser transcript snapshots (disposable PostgreSQL only).
-- The harness installs every production migration, including
-- 2026_09_29_mem00_recorded_source_anchor.sql and
-- 2026_10_02_mem00_recorded_source_chronology.sql, runs this file inside a
-- transaction and rolls it back. No statement targets production.

DO $test$
DECLARE
    thread_a CONSTANT TEXT := '11111111-1111-4111-8111-111111111111';
    receipt JSONB;
    receipt_two JSONB;
    result JSONB;
    snapshot JSONB;
    source_row public.sophia_session_messages;
    revision BIGINT;
    raised BOOLEAN;
BEGIN
    INSERT INTO public.sophia_memory_contract(singleton, contract_epoch, schema_version, mode)
    VALUES (true, 1, 'mem00.v1', 'enforced')
    ON CONFLICT (singleton) DO UPDATE SET contract_epoch = 1, schema_version = 'mem00.v1', mode = 'enforced';
    INSERT INTO public.sophia_memory_user_governance(user_id, provider_subject, authority_state, authority_epoch, authority_declared_at, authority_receipts)
    VALUES ('anchor-owner', 'anchor-subject', 'governed', 1, now(), '[{"fixture":true}]'),
           ('anchor-legacy', 'anchor-legacy-subject', 'legacy', 1, now(), '[{"fixture":true}]');
    INSERT INTO public.sophia_sessions(id, user_id, thread_id, mode, status, message_revision)
    VALUES ('anchor-session', 'anchor-owner', thread_a, 'voice', 'active', 0),
           ('anchor-plain', 'anchor-owner', '22222222-2222-4222-8222-222222222222', 'text', 'active', 0);

    -- Existing voice rows, written through the snapshot RPC like the browser does.
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', 0, jsonb_build_array(
        jsonb_build_object('id', 'anchor-v1', 'message_id', 'voice-user-1', 'thread_id', thread_a, 'role', 'user',
            'content', 'Research batteries.', 'source', 'voice', 'sequence', 1, 'created_at', '2026-09-28T23:49:30.123Z'),
        jsonb_build_object('id', 'anchor-v2', 'message_id', 'voice-assistant-2', 'thread_id', thread_a, 'role', 'assistant',
            'content', 'Starting.', 'source', 'voice', 'sequence', 2, 'created_at', '2026-09-28T23:49:33.456Z')));
    IF (result->>'accepted')::boolean IS NOT TRUE OR (result->>'current_revision')::bigint <> 1 THEN
        RAISE EXCEPTION 'seed snapshot was not accepted: %', result;
    END IF;

    receipt := public.sophia_memory_accept_source_action('anchor-owner', 'anchor-session', thread_a, 'anchor-source-0001',
        '33333333-3333-4333-8333-333333333333'::uuid, E'[Voice build request]\nBrief: batteries', 0, 'anchor-command-0001',
        'hmac-sha256:request:' || repeat('a', 64), 'hmac-sha256:source-action-content:' || repeat('b', 64));
    IF (receipt->>'sequence')::int <> 3 OR (receipt->>'transcript_revision')::bigint <> 2 THEN
        RAISE EXCEPTION 'unexpected intake receipt: %', receipt;
    END IF;

    -- 1. A stale snapshot is still a read-only conflict.
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', 1, '[]'::jsonb);
    IF (result->>'conflict')::boolean IS NOT TRUE
       OR NOT EXISTS (SELECT 1 FROM public.sophia_session_messages WHERE id = 'anchor-v1') THEN
        RAISE EXCEPTION 'stale snapshot wrote rows: %', result;
    END IF;

    -- 2. The 2026-09-28 rebase: GET copy (ms created_at, other values changed too)
    --    plus a new local voice row. The recorded row must not change.
    SELECT message_revision INTO revision FROM public.sophia_sessions WHERE id = 'anchor-session';
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', 'anchor-v1', 'message_id', 'voice-user-1', 'thread_id', thread_a, 'role', 'user',
            'content', 'Research batteries.', 'source', 'voice', 'sequence', 1, 'created_at', '2026-09-28T23:49:30.123Z'),
        jsonb_build_object('id', 'anchor-v2', 'message_id', 'voice-assistant-2', 'thread_id', thread_a, 'role', 'assistant',
            'content', 'Starting.', 'source', 'voice', 'sequence', 2, 'created_at', '2026-09-28T23:49:33.456Z'),
        jsonb_build_object('id', '33333333-3333-4333-8333-333333333333', 'message_id', 'anchor-source-0001', 'thread_id', thread_a,
            'role', 'user', 'content', '[Voice build request]', 'source', 'voice', 'sequence', 9,
            'created_at', to_char(((receipt->>'created_at')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'metadata', '{"view":"model"}'::jsonb),
        jsonb_build_object('id', 'anchor-v3', 'message_id', 'voice-user-3', 'thread_id', thread_a, 'role', 'user',
            'content', 'As a PDF.', 'source', 'voice', 'sequence', 4, 'created_at', '2026-09-28T23:49:40.001Z')));
    SELECT * INTO STRICT source_row FROM public.sophia_session_messages WHERE id = '33333333-3333-4333-8333-333333333333';
    IF source_row.memory_source_version::text <> receipt->>'source_version'
       OR source_row.sequence <> 3
       OR source_row.created_at <> (receipt->>'created_at')::timestamptz
       OR source_row.content <> E'[Voice build request]\nBrief: batteries'
       OR source_row.source <> 'text'
       OR source_row.metadata <> '{"redaction_level":"none"}'::jsonb THEN
        RAISE EXCEPTION 'recorded row changed by snapshot: %', to_jsonb(source_row);
    END IF;
    IF (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v3') <> 4 THEN
        RAISE EXCEPTION 'new voice row did not follow the recorded row';
    END IF;

    -- 3. Omitting the recorded row does not delete it; other omitted rows still go.
    SELECT message_revision INTO revision FROM public.sophia_sessions WHERE id = 'anchor-session';
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', 'anchor-v1', 'message_id', 'voice-user-1', 'thread_id', thread_a, 'role', 'user',
            'content', 'Research batteries.', 'source', 'voice', 'sequence', 1, 'created_at', '2026-09-28T23:49:30.123Z'),
        jsonb_build_object('id', 'anchor-v3', 'message_id', 'voice-user-3', 'thread_id', thread_a, 'role', 'user',
            'content', 'As a PDF.', 'source', 'voice', 'sequence', 2, 'created_at', '2026-09-28T23:49:40.001Z')));
    IF NOT EXISTS (SELECT 1 FROM public.sophia_session_messages WHERE id = '33333333-3333-4333-8333-333333333333')
       OR EXISTS (SELECT 1 FROM public.sophia_session_messages WHERE id = 'anchor-v2')
       OR (result->>'deleted_count')::int <> 1 THEN
        RAISE EXCEPTION 'omission handling wrong: %', result;
    END IF;
    -- Chronology survives the omission: anchor-v3 followed the recorded row
    -- (sequence 4) and stays after it, even though the snapshot dropped both
    -- the anchor and the row before it. anchor-v1 stays before it.
    IF (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v3') <= 3
       OR (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v1') >= 3 THEN
        RAISE EXCEPTION 'chronology around the recorded row reversed: %',
            (SELECT jsonb_object_agg(id, sequence) FROM public.sophia_session_messages WHERE session_id = 'anchor-session');
    END IF;

    -- 3b. A new row keeps its side of an omitted recorded row by creation time:
    --     one created after it follows it. (A missing created_at means now(),
    --     which is after every earlier intake; this file runs in one
    --     transaction, so it passes an explicit later time instead.)
    SELECT message_revision INTO revision FROM public.sophia_sessions WHERE id = 'anchor-session';
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', 'anchor-v1', 'message_id', 'voice-user-1', 'thread_id', thread_a, 'role', 'user',
            'content', 'Research batteries.', 'source', 'voice', 'sequence', 1, 'created_at', '2026-09-28T23:49:30.123Z'),
        jsonb_build_object('id', 'anchor-v5', 'message_id', 'voice-late-5', 'thread_id', thread_a, 'role', 'assistant',
            'content', 'On it.', 'source', 'voice', 'sequence', 4,
            'created_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
    -- Nothing stored after the recorded row precedes anchor-v5 here, so only
    -- its creation time can keep it after the recorded row (it would be 2).
    IF NOT ((SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v1') < 3
            AND (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v5') > 3) THEN
        RAISE EXCEPTION 'new or stored rows crossed an omitted recorded row: %',
            (SELECT jsonb_object_agg(id, sequence) FROM public.sophia_session_messages WHERE session_id = 'anchor-session');
    END IF;

    -- 3c. A recorded row the snapshot lists orders new rows itself: a new row
    --     listed before it stays before it, whatever its creation time. A
    --     stored row that followed it stays after it even when listed before it.
    SELECT message_revision INTO revision FROM public.sophia_sessions WHERE id = 'anchor-session';
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', 'anchor-v1', 'message_id', 'voice-user-1', 'thread_id', thread_a, 'role', 'user',
            'content', 'Research batteries.', 'source', 'voice', 'sequence', 1, 'created_at', '2026-09-28T23:49:30.123Z'),
        jsonb_build_object('id', 'anchor-v6', 'message_id', 'voice-listed-6', 'thread_id', thread_a, 'role', 'user',
            'content', 'Listed first.', 'source', 'voice', 'sequence', 2),
        jsonb_build_object('id', 'anchor-v5', 'message_id', 'voice-late-5', 'thread_id', thread_a, 'role', 'assistant',
            'content', 'On it.', 'source', 'voice', 'sequence', 3),
        jsonb_build_object('id', '33333333-3333-4333-8333-333333333333', 'message_id', 'anchor-source-0001', 'thread_id', thread_a,
            'role', 'user', 'content', 'ignored', 'sequence', 4),
        jsonb_build_object('id', 'anchor-v3', 'message_id', 'voice-user-3', 'thread_id', thread_a, 'role', 'user',
            'content', 'As a PDF.', 'source', 'voice', 'sequence', 5, 'created_at', '2026-09-28T23:49:40.001Z')));
    IF (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v6') >= 3
       OR (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v5') <= 3
       OR (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v3') <= 3 THEN
        RAISE EXCEPTION 'listed recorded row did not order the snapshot: %',
            (SELECT jsonb_object_agg(id, sequence) FROM public.sophia_session_messages WHERE session_id = 'anchor-session');
    END IF;

    -- 4. Voice rows ordered before the recorded row never take its sequence,
    --    and a reused message_id under another row id is ignored.
    SELECT message_revision INTO revision FROM public.sophia_sessions WHERE id = 'anchor-session';
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', 'anchor-v1', 'message_id', 'voice-user-1', 'thread_id', thread_a, 'role', 'user',
            'content', 'Research batteries.', 'source', 'voice', 'sequence', 1, 'created_at', '2026-09-28T23:49:30.123Z'),
        jsonb_build_object('id', 'anchor-v3', 'message_id', 'voice-user-3', 'thread_id', thread_a, 'role', 'user',
            'content', 'As a PDF.', 'source', 'voice', 'sequence', 2, 'created_at', '2026-09-28T23:49:40.001Z'),
        jsonb_build_object('id', 'anchor-v4', 'message_id', 'voice-assistant-4', 'thread_id', thread_a, 'role', 'assistant',
            'content', 'Got it.', 'source', 'voice', 'sequence', 3,
            'created_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
        jsonb_build_object('id', 'anchor-duplicate', 'message_id', 'anchor-source-0001', 'thread_id', thread_a, 'role', 'user',
            'content', 'shadow copy', 'source', 'text', 'sequence', 4, 'created_at', '2026-09-28T23:49:42.001Z')));
    IF (result->>'accepted')::boolean IS NOT TRUE
       OR (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v4') = 3
       OR (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v4')
          <= (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v3')
       OR EXISTS (SELECT 1 FROM public.sophia_session_messages WHERE id = 'anchor-duplicate')
       OR (SELECT count(*) FROM public.sophia_session_messages WHERE session_id = 'anchor-session' AND message_id = 'anchor-source-0001') <> 1 THEN
        RAISE EXCEPTION 'sequence or message identity collided with the recorded row';
    END IF;

    -- 4b. A stored row that followed the recorded row stays after it even when
    --     a copy reusing the recorded message_id is listed after that row.
    SELECT message_revision INTO revision FROM public.sophia_sessions WHERE id = 'anchor-session';
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', 'anchor-v4', 'message_id', 'voice-assistant-4', 'thread_id', thread_a, 'role', 'assistant',
            'content', 'Got it.', 'source', 'voice', 'sequence', 1,
            'created_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
        jsonb_build_object('id', 'anchor-duplicate-2', 'message_id', 'anchor-source-0001', 'thread_id', thread_a, 'role', 'user',
            'content', 'shadow copy', 'source', 'text', 'sequence', 2, 'created_at', '2026-09-28T23:49:42.001Z')));
    IF (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v4') <= 3
       OR EXISTS (SELECT 1 FROM public.sophia_session_messages WHERE id = 'anchor-duplicate-2') THEN
        RAISE EXCEPTION 'a stored row crossed the recorded row around a message_id copy: %',
            (SELECT jsonb_object_agg(id, sequence) FROM public.sophia_session_messages WHERE session_id = 'anchor-session');
    END IF;

    -- 4c. No room before an omitted recorded row: rows created before the
    --     recorded row at 3 need sequences 1, 2 and 3, but 3 is taken. The
    --     snapshot is refused and nothing is written; the client then refetches
    --     and resends with the recorded row listed.
    SELECT message_revision INTO revision FROM public.sophia_sessions WHERE id = 'anchor-session';
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', 'anchor-p1', 'message_id', 'voice-early-p1', 'thread_id', thread_a, 'role', 'user',
            'content', 'One.', 'source', 'voice', 'sequence', 1, 'created_at', '2026-09-28T23:49:30.001Z'),
        jsonb_build_object('id', 'anchor-p2', 'message_id', 'voice-early-p2', 'thread_id', thread_a, 'role', 'assistant',
            'content', 'Two.', 'source', 'voice', 'sequence', 2, 'created_at', '2026-09-28T23:49:30.002Z'),
        jsonb_build_object('id', 'anchor-p3', 'message_id', 'voice-early-p3', 'thread_id', thread_a, 'role', 'user',
            'content', 'Three.', 'source', 'voice', 'sequence', 3, 'created_at', '2026-09-28T23:49:30.003Z'),
        jsonb_build_object('id', 'anchor-v4', 'message_id', 'voice-assistant-4', 'thread_id', thread_a, 'role', 'assistant',
            'content', 'Got it.', 'source', 'voice', 'sequence', 4)));
    IF (result->>'accepted')::boolean IS NOT FALSE
       OR (result->>'conflict')::boolean IS NOT FALSE
       OR result->>'rejection_reason' <> 'recorded_source_order_unrepresentable'
       OR (result->>'current_revision')::bigint <> revision
       OR (SELECT message_revision FROM public.sophia_sessions WHERE id = 'anchor-session') <> revision
       OR EXISTS (SELECT 1 FROM public.sophia_session_messages WHERE id IN ('anchor-p1', 'anchor-p2', 'anchor-p3')) THEN
        RAISE EXCEPTION 'unrepresentable order was not refused cleanly: %', result;
    END IF;
    -- The same rows resent with the recorded row listed (the client's refetch
    -- and rebase) are accepted: client order around a listed row is kept.
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', '33333333-3333-4333-8333-333333333333', 'message_id', 'anchor-source-0001', 'thread_id', thread_a,
            'role', 'user', 'content', 'ignored', 'sequence', 3),
        jsonb_build_object('id', 'anchor-v4', 'message_id', 'voice-assistant-4', 'thread_id', thread_a, 'role', 'assistant',
            'content', 'Got it.', 'source', 'voice', 'sequence', 4),
        jsonb_build_object('id', 'anchor-p1', 'message_id', 'voice-early-p1', 'thread_id', thread_a, 'role', 'user',
            'content', 'One.', 'source', 'voice', 'sequence', 5, 'created_at', '2026-09-28T23:49:30.001Z')));
    IF (result->>'accepted')::boolean IS NOT TRUE
       OR (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-p1')
          <= (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v4') THEN
        RAISE EXCEPTION 'rebased snapshot with the recorded row listed was not accepted: %', result;
    END IF;

    -- 4d. A copy reusing the recorded message_id positions nothing: a stored row
    --     before the recorded row stays before it when listed after the copy.
    SELECT message_revision INTO revision FROM public.sophia_sessions WHERE id = 'anchor-session';
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', 'anchor-v0', 'message_id', 'voice-first-0', 'thread_id', thread_a, 'role', 'user',
            'content', 'Before.', 'source', 'voice', 'sequence', 1),
        jsonb_build_object('id', '33333333-3333-4333-8333-333333333333', 'message_id', 'anchor-source-0001', 'thread_id', thread_a,
            'role', 'user', 'content', 'ignored', 'sequence', 2)));
    IF (result->>'accepted')::boolean IS NOT TRUE
       OR (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v0') <> 1 THEN
        RAISE EXCEPTION 'row listed before the recorded row was not placed before it: %', result;
    END IF;
    SELECT message_revision INTO revision FROM public.sophia_sessions WHERE id = 'anchor-session';
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-session', revision, jsonb_build_array(
        jsonb_build_object('id', 'anchor-duplicate-3', 'message_id', 'anchor-source-0001', 'thread_id', thread_a, 'role', 'user',
            'content', 'shadow copy', 'source', 'text', 'sequence', 1),
        jsonb_build_object('id', 'anchor-v0', 'message_id', 'voice-first-0', 'thread_id', thread_a, 'role', 'user',
            'content', 'Before.', 'source', 'voice', 'sequence', 2)));
    IF (result->>'accepted')::boolean IS NOT TRUE
       OR (SELECT sequence FROM public.sophia_session_messages WHERE id = 'anchor-v0') >= 3
       OR EXISTS (SELECT 1 FROM public.sophia_session_messages WHERE id = 'anchor-duplicate-3') THEN
        RAISE EXCEPTION 'a message_id copy moved a stored row across the recorded row: %',
            (SELECT jsonb_object_agg(id, sequence) FROM public.sophia_session_messages WHERE session_id = 'anchor-session');
    END IF;

    -- 5. The source snapshot accepts the partition and reports the row eligible
    --    with the receipt's exact version and sequence.
    snapshot := public.sophia_memory_source_snapshot('anchor-owner', 'anchor-session', thread_a);
    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(snapshot->'sources') s
         WHERE s->>'message_id' = 'anchor-source-0001' AND s->>'eligibility' = 'eligible'
           AND s->>'source_version' = receipt->>'source_version' AND (s->>'sequence')::int = 3) THEN
        RAISE EXCEPTION 'snapshot does not prove the recorded row: %', snapshot;
    END IF;

    -- 6. A second intake after interleaving gets a unique, later sequence.
    receipt_two := public.sophia_memory_accept_source_action('anchor-owner', 'anchor-session', thread_a, 'anchor-source-0002',
        '44444444-4444-4444-8444-444444444444'::uuid, 'Make it shorter.', 0, 'anchor-command-0002',
        'hmac-sha256:request:' || repeat('c', 64), 'hmac-sha256:source-action-content:' || repeat('d', 64));
    snapshot := public.sophia_memory_source_snapshot('anchor-owner', 'anchor-session', thread_a);
    IF (SELECT count(*) FROM jsonb_array_elements(snapshot->'sources') s WHERE s->>'eligibility' = 'eligible'
          AND s->>'message_id' IN ('anchor-source-0001', 'anchor-source-0002')) <> 2 THEN
        RAISE EXCEPTION 'second intake broke the partition: %', snapshot;
    END IF;

    -- 7. Pending-input recovery lookup: exact receipt, owner and session scoped.
    result := public.sophia_memory_lookup_source_action_by_message('anchor-owner', 'anchor-session', 'anchor-source-0001');
    IF result - 'idempotent_replay' <> receipt - 'idempotent_replay' OR (result->>'idempotent_replay')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'by-message lookup returned another receipt: %', result;
    END IF;
    IF public.sophia_memory_lookup_source_action_by_message('anchor-owner', 'anchor-plain', 'anchor-source-0001') IS NOT NULL THEN
        RAISE EXCEPTION 'by-message lookup crossed sessions';
    END IF;
    raised := false;
    BEGIN
        PERFORM public.sophia_memory_lookup_source_action_by_message('anchor-legacy', 'anchor-session', 'anchor-source-0001');
    EXCEPTION WHEN insufficient_privilege THEN raised := true;
    END;
    IF NOT raised THEN RAISE EXCEPTION 'by-message lookup served a non-governed owner'; END IF;

    -- 8. A session without recorded rows keeps the snapshot's own sequences.
    result := public.sophia_replace_session_messages('anchor-owner', 'anchor-plain', 0, jsonb_build_array(
        jsonb_build_object('id', 'plain-1', 'message_id', 'plain-1', 'thread_id', '22222222-2222-4222-8222-222222222222',
            'role', 'user', 'content', 'Hello', 'sequence', 5, 'created_at', '2026-09-28T10:00:00.000Z'),
        jsonb_build_object('id', 'plain-2', 'message_id', 'plain-2', 'thread_id', '22222222-2222-4222-8222-222222222222',
            'role', 'assistant', 'content', 'Hi', 'sequence', 9, 'created_at', '2026-09-28T10:00:01.000Z')));
    IF (SELECT array_agg(sequence ORDER BY id) FROM public.sophia_session_messages WHERE session_id = 'anchor-plain') <> ARRAY[5, 9] THEN
        RAISE EXCEPTION 'legacy session sequences were rewritten';
    END IF;

    -- 9. Deleting the session still removes every row, recorded ones included.
    DELETE FROM public.sophia_sessions WHERE id = 'anchor-session';
    IF EXISTS (SELECT 1 FROM public.sophia_session_messages WHERE session_id = 'anchor-session') THEN
        RAISE EXCEPTION 'session delete left rows behind';
    END IF;
END
$test$;
