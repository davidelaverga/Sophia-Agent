-- Additive C4 recovery proof format upgrade for the v2 service-owner fence.
-- Apply only through the independently attested, quiescent upgrade path.
-- The v1 and generic clauses are carried verbatim; v2 adds its own shape.
do $service_fence_v2_upgrade$
declare
  target_constraint text;
  target_count integer;
begin
  select count(*), min(c.conname)
    into target_count, target_constraint
    from pg_constraint c
    where c.conrelid = 'sophia_voice_lab.recovery_controls'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%sophia.voice-lab.verified-service-owner-fence.v1%';
  if target_count <> 1 then
    raise exception 'SERVICE_FENCE_V2_SOURCE_CONSTRAINT_INVALID';
  end if;
  execute format('alter table sophia_voice_lab.recovery_controls drop constraint %I', target_constraint);
  execute format($constraint$
    alter table sophia_voice_lab.recovery_controls add constraint %I check (
      generic_owner_loss is null or (
        browser_allocation_ever and browser_allocation_binding is not null
        and generic_owner_dispatch is not null
        and generic_owner_dispatch->>'consumedAt' is not null
        and binding->>'scenarioId' is distinct from 'V-D02'
        and jsonb_typeof(generic_owner_loss) = 'object'
        and octet_length(generic_owner_loss::text) <= 4096
        and (
          generic_owner_loss->>'schema' = 'sophia.voice-lab.verified-generic-owner-loss.v1'
          or (
            generic_owner_loss->>'schema' = 'sophia.voice-lab.verified-service-owner-fence.v1'
            and generic_owner_loss->>'recoveryDeploymentSha256' ~ '^[a-f0-9]{64}$'
          )
          or (
            generic_owner_loss->>'schema' = 'sophia.voice-lab.verified-service-owner-fence.v2'
            and generic_owner_loss->>'recoveryDeploymentSha256' ~ '^[a-f0-9]{64}$'
            and generic_owner_loss->>'executionOwnershipProofSha256' ~ '^[a-f0-9]{64}$'
            and generic_owner_loss->>'executionEpochSha256' ~ '^[a-f0-9]{64}$'
            and (generic_owner_loss->'originalOwnerPreAction' is null
              or generic_owner_loss->>'originalOwnerPreAction' = 'absent')
          )
        )
        and generic_owner_loss->>'proofSha256' ~ '^[a-f0-9]{64}$'
        and generic_owner_loss->>'dispatchClaimSha256' = generic_owner_dispatch->>'proofSha256'
        and generic_owner_loss->>'workerIdSha256' = browser_allocation_binding->>'browser_worker_id_sha256'
        and generic_owner_loss->'providerCleanupProven' = 'false'::jsonb
        and generic_owner_loss->'liveResourcesZeroProven' = 'false'::jsonb
      ) is true
    )
  $constraint$, target_constraint);
end
$service_fence_v2_upgrade$;
