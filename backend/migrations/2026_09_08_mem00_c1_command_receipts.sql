-- C1 staged, additive RPC repair. Requires explicit production approval.
-- No plaintext backfill, provider/configuration change or new memory authority.
BEGIN;

CREATE OR REPLACE FUNCTION public.sophia_memory_command_receipt(
    p_user_id text, p_idempotency_key text, p_original jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
DECLARE
    event public.sophia_memory_governance_events;
    result jsonb;
    deleted_id uuid;
BEGIN
    SELECT * INTO STRICT event FROM public.sophia_memory_governance_events
     WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
    result := jsonb_build_object(
        'event_id',event.event_id,'operation_id',event.operation_id,
        'candidate_id',event.candidate_id,'memory_id',event.memory_id,
        'event_type',event.event_type,'resulting_lifecycle',event.resulting_lifecycle,
        'content_revision',event.content_revision,
        'memory_governance_revision',event.memory_governance_revision,
        'user_catalog_generation',event.user_catalog_generation,
        'user_revocation_epoch',event.user_revocation_epoch,
        'idempotent_replay',p_original->'idempotent_replay'
    );
    IF event.event_type='memory_tombstoned' THEN
        SELECT tombstone_id INTO STRICT deleted_id FROM public.sophia_memory_tombstones
         WHERE user_id=p_user_id AND memory_id=event.memory_id
           AND tombstone_governance_revision=event.memory_governance_revision;
        -- Historical accepted/fenced outcome, never a claim about current purge.
        result := result || jsonb_build_object('status','accepted_and_fenced',
            'tombstone_id',deleted_id,'provider_purge','purge_pending');
    END IF;
    RETURN result;
END
$function$;
REVOKE ALL ON FUNCTION public.sophia_memory_command_receipt(text,text,jsonb)
    FROM PUBLIC,anon,authenticated,service_role;

-- Patch only the seven pinned command bodies; fail if their structure differs.
-- Their existing owner helper locks the durable row FOR UPDATE. Taking it before
-- the first receipt lookup serializes first submissions and receipt replays with
-- all existing canonical mutators, without a second authority or lock table.
DO $migration$
DECLARE name text; definition text; rewritten text; count_returns integer;
BEGIN
    FOREACH name IN ARRAY ARRAY['approve_candidate','reject_candidate','manual_create','edit','forget','restore','tombstone'] LOOP
        SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
         WHERE p.pronamespace='public'::regnamespace AND p.proname='sophia_memory_'||name;
        IF position('-- MEM00_C1_RECEIPT_SERIALIZED' IN definition)>0 THEN CONTINUE; END IF;
        IF position('SELECT * INTO event FROM public.sophia_memory_governance_events' IN definition)=0
           OR position('governance := public.sophia_memory_ensure_governance(p_user_id);' IN definition)=0 THEN
            RAISE EXCEPTION 'memory_command_migration_baseline_mismatch';
        END IF;
        SELECT count(*) INTO count_returns FROM regexp_matches(definition,'RETURN (jsonb_build_object\([^;]*\));','g');
        IF count_returns<>2 THEN RAISE EXCEPTION 'memory_command_migration_return_mismatch'; END IF;
        rewritten := replace(definition,E'\nBEGIN\n',E'\nBEGIN\n    -- MEM00_C1_RECEIPT_SERIALIZED\n    PERFORM public.sophia_memory_ensure_governance(p_user_id);\n');
        rewritten := regexp_replace(rewritten,'RETURN (jsonb_build_object\([^;]*\));',
            'RETURN public.sophia_memory_command_receipt(p_user_id,p_idempotency_key,\1);','g');
        IF rewritten=definition THEN RAISE EXCEPTION 'memory_command_migration_no_change'; END IF;
        EXECUTE rewritten;
    END LOOP;
END
$migration$;

-- Read-only recovery takes the existing owner serialization lock. A command
-- already holding that lock finishes before absence can be reported. No owner,
-- command, receipt or provider effect is created by this lookup.
CREATE OR REPLACE FUNCTION public.sophia_memory_lookup_command_receipt(
    p_user_id text, p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public AS $lookup$
DECLARE receipt jsonb;
BEGIN
    IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
        RAISE EXCEPTION 'memory_command_key_invalid';
    END IF;
    PERFORM g.user_id FROM public.sophia_memory_user_governance g
      JOIN public.sophia_memory_contract c ON c.singleton AND c.contract_epoch=g.authority_epoch
      WHERE g.user_id=p_user_id AND g.authority_state='governed' AND g.authority_epoch=1
        AND c.schema_version='mem00.v1' AND c.mode IN ('shadow','enforced')
      FOR SHARE OF g;
    IF NOT FOUND THEN RAISE EXCEPTION 'memory_command_authority_unavailable'; END IF;
    IF EXISTS(SELECT 1 FROM public.sophia_memory_governance_events
              WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key) THEN
        receipt := public.sophia_memory_command_receipt(p_user_id,p_idempotency_key,
            jsonb_build_object('idempotent_replay',true));
    END IF;
    RETURN jsonb_build_object('schema','mem00.command-status.v1','owner_id',p_user_id,
        'command_key',p_idempotency_key,'status',CASE WHEN receipt IS NULL THEN 'not_found' ELSE 'committed' END,
        'historical_result_only',true,'receipt',receipt);
END $lookup$;
REVOKE ALL ON FUNCTION public.sophia_memory_lookup_command_receipt(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_lookup_command_receipt(text,text) TO service_role;

COMMIT;
