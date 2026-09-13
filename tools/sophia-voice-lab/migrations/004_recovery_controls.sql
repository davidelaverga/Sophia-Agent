-- C4 recovery control extension. Only the checksum-pinned migration pipeline
-- may apply this file. Existing releases require an independently attested
-- upgrade/backfill; runtime code must never create tables.
create table sophia_voice_lab.recovery_controls (
  run_id uuid primary key,
  test_run_id uuid not null unique,
  cleanup_obligation_id uuid not null unique,
  binding jsonb not null,
  browser_allocation_ever boolean not null default false,
  generic_recovery_settlement jsonb check (generic_recovery_settlement is null or (
    generic_owner_loss is not null and live_cleanup_complete
    and jsonb_typeof(generic_recovery_settlement) = 'object'
    and octet_length(generic_recovery_settlement::text) <= 4096
    and generic_recovery_settlement->>'schema' = 'sophia.voice-lab.retained-generic-recovery.v1'
    and generic_recovery_settlement->>'proofSha256' ~ '^[a-f0-9]{64}$'
    and generic_recovery_settlement->>'ownerLossProofSha256' = generic_owner_loss->>'proofSha256'
    and generic_recovery_settlement->>'workerIdSha256' = generic_owner_loss->>'workerIdSha256'
    and generic_recovery_settlement->'ready' = 'true'::jsonb
  ) is true),
  generic_owner_loss jsonb check (generic_owner_loss is null or (
    browser_allocation_ever and browser_allocation_binding is not null
    and generic_owner_dispatch is not null
    and generic_owner_dispatch->>'consumedAt' is not null
    and binding->>'scenarioId' is distinct from 'V-D02'
    and jsonb_typeof(generic_owner_loss) = 'object'
    and octet_length(generic_owner_loss::text) <= 4096
    and generic_owner_loss->>'schema' = 'sophia.voice-lab.verified-generic-owner-loss.v1'
    and generic_owner_loss->>'proofSha256' ~ '^[a-f0-9]{64}$'
    and generic_owner_loss->>'dispatchClaimSha256' = generic_owner_dispatch->>'proofSha256'
    and generic_owner_loss->>'workerIdSha256' = browser_allocation_binding->>'browser_worker_id_sha256'
    and generic_owner_loss->'providerCleanupProven' = 'false'::jsonb
    and generic_owner_loss->'liveResourcesZeroProven' = 'false'::jsonb
  ) is true),
  generic_owner_dispatch jsonb check (generic_owner_dispatch is null or (
    browser_allocation_ever and browser_allocation_binding is not null
    and binding->>'scenarioId' is distinct from 'V-D02'
    and jsonb_typeof(generic_owner_dispatch) = 'object'
    and octet_length(generic_owner_dispatch::text) <= 4096
    and generic_owner_dispatch->>'schema' = 'sophia.voice-lab.generic-owner-dispatch.v1'
    and generic_owner_dispatch->>'proofSha256' ~ '^[a-f0-9]{64}$'
    and generic_owner_dispatch->>'workerServiceIdSha256' ~ '^[a-f0-9]{64}$'
    and generic_owner_dispatch->>'workerIdSha256' = browser_allocation_binding->>'browser_worker_id_sha256'
  ) is true),
  d02_journal jsonb check (d02_journal is null or (
    jsonb_typeof(d02_journal) = 'object'
    and octet_length(d02_journal::text) <= 4096
    and d02_journal->>'schema' = 'sophia.voice-lab.d02-recovery-journal.v1'
    and d02_journal->>'proofSha256' ~ '^[a-f0-9]{64}$'
    and binding->>'scenarioId' = 'V-D02'
  ) is true),
  execution_ownership jsonb check (execution_ownership is null or (
    browser_allocation_ever and jsonb_typeof(execution_ownership) = 'object'
    and octet_length(execution_ownership::text) <= 2048
    and execution_ownership->>'schema' = 'sophia.voice-lab.execution-ownership.v1'
    and execution_ownership->>'proofSha256' ~ '^[a-f0-9]{64}$'
  ) is true),
  d02_owner_death jsonb check (d02_owner_death is null or (
    browser_allocation_ever and d02_journal is not null and execution_ownership is not null
    and jsonb_typeof(d02_owner_death) = 'object'
    and octet_length(d02_owner_death::text) <= 4096
    and d02_owner_death->>'schema' = 'sophia.voice-lab.verified-d02-owner-death.v1'
    and d02_owner_death->>'proofSha256' ~ '^[a-f0-9]{64}$'
    and d02_owner_death->'providerCleanupProven' = 'false'::jsonb
    and d02_owner_death->'liveResourcesZeroProven' = 'false'::jsonb
  ) is true),
  execution_cleanup_proof jsonb check (execution_cleanup_proof is null or (
    browser_allocation_ever and jsonb_typeof(execution_cleanup_proof) = 'object'
    and octet_length(execution_cleanup_proof::text) <= 2048
    and execution_cleanup_proof->>'ready' = 'true'
    and execution_cleanup_proof->>'proofSha256' ~ '^[a-f0-9]{64}$'
  ) is true),
  d02_provider_settlement jsonb check (d02_provider_settlement is null or (
    d02_owner_death is not null and jsonb_typeof(d02_provider_settlement) = 'object'
    and octet_length(d02_provider_settlement::text) <= 2048
    and d02_provider_settlement->>'schema' = 'sophia.voice-lab.retained-d02-provider-settlement.v1'
    and d02_provider_settlement->>'proofSha256' ~ '^[a-f0-9]{64}$'
    and d02_provider_settlement->'providerCleanupProven' = 'true'::jsonb
    and d02_provider_settlement->'authCleanupProven' = 'false'::jsonb
    and d02_provider_settlement->'builderCleanupProven' = 'false'::jsonb
    and d02_provider_settlement->'liveResourcesZeroProven' = 'false'::jsonb
  ) is true),
  -- Reservation intent is separate from successful driver attestation.
  d02_recovery_settlement jsonb check (d02_recovery_settlement is null or (
    d02_owner_death is not null and d02_provider_settlement is not null
    and jsonb_typeof(d02_recovery_settlement) = 'object'
    and octet_length(d02_recovery_settlement::text) <= 2048
    and d02_recovery_settlement->>'schema' = 'sophia.voice-lab.retained-d02-recovery.v1'
    and d02_recovery_settlement->>'proofSha256' ~ '^[a-f0-9]{64}$'
    and d02_recovery_settlement->'ready' = 'true'::jsonb
  ) is true),
  browser_allocation_binding jsonb,
  constraint recovery_browser_allocation_shape check (browser_allocation_binding is null or (
    jsonb_typeof(browser_allocation_binding) = 'object'
    and octet_length(browser_allocation_binding::text) <= 1024
    and browser_allocation_binding->>'voice_lab_run_id_sha256' ~ '^[a-f0-9]{64}$'
    and browser_allocation_binding->>'browser_worker_id_sha256' ~ '^[a-f0-9]{64}$'
    and browser_allocation_binding->>'browser_context_id_sha256' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(browser_allocation_binding->'browser_lease_epoch') = 'number'
    and (browser_allocation_binding->>'browser_lease_epoch')::numeric between 1 and 9007199254740991
    and trunc((browser_allocation_binding->>'browser_lease_epoch')::numeric) = (browser_allocation_binding->>'browser_lease_epoch')::numeric
  ) is true),
  browser_context_binding jsonb,
  constraint recovery_browser_binding_shape check (browser_context_binding is null or (
    jsonb_typeof(browser_context_binding) = 'object'
    and octet_length(browser_context_binding::text) <= 1024
    and binding->>'scenarioId' = 'V-D02'
    and browser_context_binding->>'voice_lab_run_id_sha256' ~ '^[a-f0-9]{64}$'
    and browser_context_binding->>'browser_worker_id_sha256' ~ '^[a-f0-9]{64}$'
    and browser_context_binding->>'browser_context_id_sha256' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(browser_context_binding->'browser_lease_epoch') = 'number'
    and (browser_context_binding->>'browser_lease_epoch')::numeric between 1 and 9007199254740991
    and trunc((browser_context_binding->>'browser_lease_epoch')::numeric) = (browser_context_binding->>'browser_lease_epoch')::numeric
  ) is true),
  version bigint not null check (version > 0),
  live_cleanup_complete boolean not null,
  remote_purge_complete boolean not null,
  retention_purge_due_at timestamptz,
  content_purged_at timestamptz,
  recovery_scheduled_at timestamptz,
  retention_lookup_hmac text check (retention_lookup_hmac ~ '^[a-f0-9]{64}$'),
  last_settlement_from_version bigint,
  last_settlement_event_sha256 text,
  last_settlement_receipt_sha256 text,
  constraint recovery_binding_identity check ((
    jsonb_typeof(binding) = 'object'
    and octet_length(binding::text) <= 4096
    and binding->>'schema' = 'sophia.voice-lab.recovery-control.v1'
    and binding->>'runId' = run_id::text
    and binding->>'testRunId' = test_run_id::text
    and binding->>'cleanupObligationId' = cleanup_obligation_id::text
  ) is true),
  constraint recovery_settlement_shape check ((
    (last_settlement_from_version is null and last_settlement_event_sha256 is null and last_settlement_receipt_sha256 is null)
    or (last_settlement_from_version > 0 and last_settlement_from_version < version
      and last_settlement_event_sha256 ~ '^[a-f0-9]{64}$'
      and last_settlement_receipt_sha256 ~ '^[a-f0-9]{64}$')
  ) is true)
);
-- Deliberately no FK to runs: transcript/run deletion cannot cascade authority.
create unique index recovery_generic_owner_dispatch_once_idx on sophia_voice_lab.recovery_controls
  ((generic_owner_dispatch->>'workerServiceIdSha256'), (generic_owner_dispatch->>'workerIdSha256'))
  where generic_owner_dispatch is not null;
create index recovery_controls_outstanding_idx on sophia_voice_lab.recovery_controls (run_id)
  where not live_cleanup_complete or not remote_purge_complete;
revoke all on sophia_voice_lab.recovery_controls from public;
create index recovery_controls_schedule_idx on sophia_voice_lab.recovery_controls
  (recovery_scheduled_at nulls first, run_id) where content_purged_at is not null;

-- Erased v3 identities have no recoverable run/owner binding. Preserve their
-- opaque control locators without treating remote purge as live settlement.
-- An explicit operator acceptance may waive admission blocking, never cleanup.
create table sophia_voice_lab.historical_quarantine (
  lookup_id_hmac text primary key check (lookup_id_hmac ~ '^[a-f0-9]{64}$'),
  recovery_id_hmac text not null check (recovery_id_hmac ~ '^[a-f0-9]{64}$'),
  inventory_sha256 text not null check (inventory_sha256 ~ '^[a-f0-9]{64}$'),
  remote_purge_status text not null check (remote_purge_status in ('confirmed','unconfirmed')),
  source_purged_at timestamptz not null,
  source_control_expires_at timestamptz not null,
  quarantined_at timestamptz not null default now(),
  check (source_control_expires_at > source_purged_at)
);
revoke all on sophia_voice_lab.historical_quarantine from public;
create function sophia_voice_lab.preserve_historical_quarantine() returns trigger
language plpgsql as $$ begin
  raise exception 'HISTORICAL_QUARANTINE_IMMUTABLE' using errcode='55000';
end $$;
create trigger historical_quarantine_immutable
before update or delete or truncate on sophia_voice_lab.historical_quarantine
for each statement execute function sophia_voice_lab.preserve_historical_quarantine();
create table sophia_voice_lab.historical_admission_exceptions (
  lookup_id_hmac text primary key references sophia_voice_lab.historical_quarantine(lookup_id_hmac),
  inventory_sha256 text not null check (inventory_sha256 ~ '^[a-f0-9]{64}$'),
  authorization_sha256 text not null check (authorization_sha256 ~ '^[a-f0-9]{64}$'),
  disposition text not null default 'operator_accepted_unverified_history'
    check (disposition = 'operator_accepted_unverified_history'),
  accepted_at timestamptz not null default now()
);
revoke all on sophia_voice_lab.historical_admission_exceptions from public;
create trigger historical_admission_exceptions_immutable
before update or delete or truncate on sophia_voice_lab.historical_admission_exceptions
for each statement execute function sophia_voice_lab.preserve_historical_quarantine();
create function sophia_voice_lab.fence_historical_quarantine() returns trigger
language plpgsql as $$ begin
  if exists(select 1 from sophia_voice_lab.historical_quarantine q
    where not exists(select 1 from sophia_voice_lab.historical_admission_exceptions e
      where e.lookup_id_hmac=q.lookup_id_hmac and e.inventory_sha256=q.inventory_sha256)) then
    raise exception 'HISTORICAL_RECOVERY_QUARANTINED' using errcode='55000';
  end if;
  return new;
end $$;
create trigger historical_quarantine_run_admission before insert on sophia_voice_lab.runs
for each row execute function sophia_voice_lab.fence_historical_quarantine();
create trigger historical_quarantine_suite_admission before insert on sophia_voice_lab.suite_runs
for each row execute function sophia_voice_lab.fence_historical_quarantine();
create trigger historical_quarantine_browser_admission before insert on sophia_voice_lab.browser_leases
for each row execute function sophia_voice_lab.fence_historical_quarantine();
create trigger historical_quarantine_operation_admission before insert or update on sophia_voice_lab.operations
for each row when (new.type <> 'end') execute function sophia_voice_lab.fence_historical_quarantine();
revoke all on function sophia_voice_lab.preserve_historical_quarantine() from public;
revoke all on function sophia_voice_lab.fence_historical_quarantine() from public;

-- Browser allocations belong to durable control, never to expiring content.
alter table sophia_voice_lab.browser_leases drop constraint browser_leases_run_id_fkey;
alter table sophia_voice_lab.browser_leases add constraint browser_leases_recovery_control_fkey
  foreign key (run_id) references sophia_voice_lab.recovery_controls(run_id);
