-- MEM00-C1: additive, monotonic owner authority. Does NOT enroll any owner.
-- Existing rows become unknown until an explicitly approved declaration.
-- Apply only with a compatible serving profile; old binaries cannot infer this
-- boundary. Operator-only declaration is intentionally unavailable to app roles.
BEGIN;

ALTER TABLE public.sophia_memory_user_governance
    ADD COLUMN IF NOT EXISTS authority_state text NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS authority_epoch bigint,
    ADD COLUMN IF NOT EXISTS authority_declared_at timestamptz,
    ADD COLUMN IF NOT EXISTS authority_receipts jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $constraints$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sophia_memory_user_governance'::regclass AND conname='memory_owner_authority_shape') THEN
        ALTER TABLE public.sophia_memory_user_governance ADD CONSTRAINT memory_owner_authority_shape CHECK (
            (authority_state='unknown' AND authority_epoch IS NULL AND authority_declared_at IS NULL AND authority_receipts='[]'::jsonb)
            OR (authority_state IN ('legacy','governed') AND authority_epoch>0 AND authority_declared_at IS NOT NULL
                AND jsonb_typeof(authority_receipts)='array' AND jsonb_array_length(authority_receipts)>0)
        );
    END IF;
END
$constraints$;

CREATE OR REPLACE FUNCTION public.sophia_memory_owner_authority_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='memory_owner_authority_is_durable';
    END IF;
    IF NEW.user_id<>OLD.user_id OR NEW.provider_subject<>OLD.provider_subject
       OR (OLD.authority_state='governed' AND NEW.authority_state<>'governed')
       OR (OLD.authority_state='legacy' AND NEW.authority_state='unknown')
       OR (OLD.authority_epoch IS NOT NULL AND (NEW.authority_epoch IS NULL OR NEW.authority_epoch<OLD.authority_epoch))
       OR (OLD.authority_declared_at IS NOT NULL AND NEW.authority_declared_at IS DISTINCT FROM OLD.authority_declared_at)
       OR NOT (NEW.authority_receipts @> OLD.authority_receipts) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='memory_owner_authority_rollback_denied';
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS sophia_memory_owner_authority_fence ON public.sophia_memory_user_governance;
CREATE TRIGGER sophia_memory_owner_authority_fence BEFORE UPDATE OR DELETE ON public.sophia_memory_user_governance
FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_owner_authority_fence();
DROP TRIGGER IF EXISTS sophia_memory_owner_authority_truncate_fence ON public.sophia_memory_user_governance;
CREATE TRIGGER sophia_memory_owner_authority_truncate_fence BEFORE TRUNCATE ON public.sophia_memory_user_governance
FOR EACH STATEMENT EXECUTE FUNCTION public.sophia_memory_owner_authority_fence();

CREATE OR REPLACE FUNCTION public.sophia_memory_declare_owner_authority(
    p_user_id text, p_expected_state text, p_target_state text, p_contract_epoch bigint, p_approval_ref text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE
    owner_row public.sophia_memory_user_governance;
    receipt jsonb;
    existing jsonb;
BEGIN
    IF p_user_id IS NULL OR p_user_id='' OR p_user_id<>btrim(p_user_id)
       OR p_expected_state IS NULL OR p_target_state IS NULL
       OR p_expected_state NOT IN ('unknown','legacy') OR p_target_state NOT IN ('legacy','governed')
       OR p_contract_epoch IS NULL OR p_contract_epoch<1
       OR p_approval_ref IS NULL OR p_approval_ref !~ '^hmac-sha256:[a-zA-Z0-9:_-]{16,200}$' THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='memory_owner_declaration_invalid';
    END IF;
    PERFORM 1 FROM public.sophia_memory_contract WHERE singleton AND contract_epoch=p_contract_epoch FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='memory_owner_contract_incompatible';
    END IF;
    INSERT INTO public.sophia_memory_user_governance(user_id,provider_subject)
    VALUES(p_user_id,'sophia-memory-v2-'||replace(gen_random_uuid()::text,'-','')) ON CONFLICT(user_id) DO NOTHING;
    SELECT * INTO STRICT owner_row FROM public.sophia_memory_user_governance WHERE user_id=p_user_id FOR UPDATE;
    SELECT value INTO existing FROM jsonb_array_elements(owner_row.authority_receipts)
    WHERE value->>'approval_ref'=p_approval_ref;
    IF existing IS NOT NULL THEN
        IF existing->>'expected_state'<>p_expected_state OR existing->>'target_state'<>p_target_state
           OR (existing->>'contract_epoch')::bigint<>p_contract_epoch THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='memory_owner_declaration_conflict';
        END IF;
        RETURN existing;
    END IF;
    IF owner_row.authority_state<>p_expected_state OR p_expected_state=p_target_state THEN
        RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='memory_owner_declaration_conflict';
    END IF;
    -- Existing canonical/extraction history cannot be classified as pre-cutover.
    IF p_target_state='legacy' AND (owner_row.user_catalog_generation<>0 OR owner_row.user_revocation_epoch<>0
        OR EXISTS(SELECT 1 FROM public.sophia_memory_extraction_runs WHERE user_id=p_user_id)
        OR EXISTS(SELECT 1 FROM public.sophia_memory_governance_events WHERE user_id=p_user_id)
        OR EXISTS(SELECT 1 FROM public.sophia_memories WHERE user_id=p_user_id)) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='memory_owner_has_canonical_history';
    END IF;
    receipt=jsonb_build_object('schema','mem00.owner-authority.v1','approval_ref',p_approval_ref,
        'expected_state',p_expected_state,'target_state',p_target_state,'contract_epoch',p_contract_epoch,'declared_at',statement_timestamp());
    UPDATE public.sophia_memory_user_governance SET authority_state=p_target_state,authority_epoch=p_contract_epoch,
        authority_declared_at=coalesce(authority_declared_at,statement_timestamp()),authority_receipts=authority_receipts||jsonb_build_array(receipt)
    WHERE user_id=p_user_id;
    RETURN receipt;
END
$function$;

-- Existing canonical RPCs already serialize through this helper. Missing or
-- unknown ownership must not become implicit enrollment, including on old RPCs.
CREATE OR REPLACE FUNCTION public.sophia_memory_ensure_governance(p_user_id text)
RETURNS public.sophia_memory_user_governance
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE result public.sophia_memory_user_governance;
BEGIN
    SELECT * INTO result FROM public.sophia_memory_user_governance WHERE user_id=p_user_id FOR UPDATE;
    IF NOT FOUND OR result.authority_state<>'governed' OR NOT EXISTS (
        SELECT 1 FROM public.sophia_memory_contract WHERE singleton AND contract_epoch=result.authority_epoch
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='memory_owner_authority_required';
    END IF;
    RETURN result;
END
$function$;

REVOKE ALL ON FUNCTION public.sophia_memory_declare_owner_authority(text,text,text,bigint,text) FROM PUBLIC,anon,authenticated,service_role;

-- The installed prompt-admission RPC locks governance directly rather than
-- calling ensure_governance. Fence its actual write, including an empty manifest
-- and direct inserts by privileged application roles. This is an ownership
-- fence, not the C1 final-payload/one-use admission permit implementation.
CREATE OR REPLACE FUNCTION public.sophia_memory_prompt_owner_authority_fence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE owner_row public.sophia_memory_user_governance;
BEGIN
    SELECT * INTO owner_row FROM public.sophia_memory_user_governance WHERE user_id=NEW.user_id FOR SHARE;
    IF NOT FOUND OR owner_row.authority_state<>'governed' OR NOT EXISTS (
        SELECT 1 FROM public.sophia_memory_contract WHERE singleton AND contract_epoch=owner_row.authority_epoch
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='memory_owner_authority_required';
    END IF;
    RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS sophia_memory_prompt_owner_authority_fence ON public.sophia_memory_prompt_admissions;
CREATE TRIGGER sophia_memory_prompt_owner_authority_fence BEFORE INSERT OR UPDATE ON public.sophia_memory_prompt_admissions
FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_prompt_owner_authority_fence();
REVOKE ALL ON FUNCTION public.sophia_memory_prompt_owner_authority_fence() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION public.sophia_memory_owner_authority_fence() FROM PUBLIC,anon,authenticated,service_role;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.sophia_memory_user_governance FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.sophia_memory_user_governance TO service_role;
COMMIT;
