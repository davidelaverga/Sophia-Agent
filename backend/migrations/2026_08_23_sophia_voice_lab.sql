-- VT00 isolated, durable control/evidence plane. This schema never owns or
-- reimplements the Sophia product runtime.
begin;

create schema if not exists sophia_voice_lab;

create table if not exists sophia_voice_lab.schema_metadata (
  singleton boolean primary key default true check (singleton),
  schema_version integer not null,
  migration_sha256 text,
  catalog_sha256 text,
  updated_at timestamptz not null default now()
);
alter table sophia_voice_lab.schema_metadata add column if not exists migration_sha256 text;
alter table sophia_voice_lab.schema_metadata add column if not exists catalog_sha256 text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='voice_lab_schema_metadata_migration_sha256_check' and conrelid='sophia_voice_lab.schema_metadata'::regclass) then
    alter table sophia_voice_lab.schema_metadata add constraint voice_lab_schema_metadata_migration_sha256_check check (migration_sha256 is null or migration_sha256 ~ '^[a-f0-9]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname='voice_lab_schema_metadata_catalog_sha256_check' and conrelid='sophia_voice_lab.schema_metadata'::regclass) then
    alter table sophia_voice_lab.schema_metadata add constraint voice_lab_schema_metadata_catalog_sha256_check check (catalog_sha256 is null or catalog_sha256 ~ '^[a-f0-9]{64}$');
  end if;
end $$;
insert into sophia_voice_lab.schema_metadata (singleton, schema_version)
values (true, 3)
on conflict (singleton) do update set schema_version=greatest(sophia_voice_lab.schema_metadata.schema_version, excluded.schema_version), updated_at=now();

create table if not exists sophia_voice_lab.runs (
  id uuid primary key,
  caller_id text not null,
  principal_id text not null,
  test_run_id uuid not null unique,
  cleanup_obligation_id uuid not null unique,
  environment text not null check (environment in ('production','staging')),
  scenario_id text,
  scenario_version text,
  state text not null check (state in ('reserved','validating_target','browser_queued','browser_leased','authenticating','opening_app','ready','active','ending','finalizing','exporting','pending_external_evidence','completed','product_failed','invalid_test','inconclusive_provider','failed_harness','authorization_failed','deployment_mismatch','aborted_driver_restart','expired','cancelled')),
  version integer not null default 1 check (version > 0),
  target jsonb not null,
  observed_deployment jsonb not null default '{}'::jsonb,
  capture_policy jsonb not null,
  verdicts jsonb not null,
  canonical_session_id text,
  thread_id text,
  provider_session_id text,
  trace_id text,
  provider_epoch bigint,
  turn_id text,
  latest_cursor bigint not null default 0 check (latest_cursor >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cleanup_complete boolean not null default false,
  retention_purge_due_at timestamptz,
  retention_purge_pending boolean not null default false,
  retention_purge_verified_at timestamptz,
  evidence_purged_at timestamptz,
  terminal_error jsonb
);
alter table sophia_voice_lab.runs add column if not exists evidence_purged_at timestamptz;
alter table sophia_voice_lab.runs drop constraint if exists runs_state_check;
alter table sophia_voice_lab.runs drop constraint if exists voice_lab_runs_state_check;
alter table sophia_voice_lab.runs add constraint voice_lab_runs_state_check check (state in ('reserved','validating_target','browser_queued','browser_leased','authenticating','opening_app','ready','active','ending','finalizing','exporting','pending_external_evidence','completed','product_failed','invalid_test','inconclusive_provider','failed_harness','authorization_failed','deployment_mismatch','aborted_driver_restart','expired','cancelled'));
alter table sophia_voice_lab.runs add column if not exists cleanup_obligation_id uuid;
do $$ begin
  if exists (select 1 from sophia_voice_lab.runs where cleanup_obligation_id is null) then
    raise exception 'Voice Lab cleanup obligation identity cannot be synthesized for pre-existing runs';
  end if;
end $$;
alter table sophia_voice_lab.runs alter column cleanup_obligation_id set not null;
create unique index if not exists voice_lab_runs_cleanup_obligation_idx on sophia_voice_lab.runs (cleanup_obligation_id);
alter table sophia_voice_lab.runs add column if not exists provider_epoch bigint;
alter table sophia_voice_lab.runs add column if not exists turn_id text;
alter table sophia_voice_lab.runs add column if not exists cleanup_complete boolean not null default false;
alter table sophia_voice_lab.runs add column if not exists retention_purge_due_at timestamptz;
alter table sophia_voice_lab.runs add column if not exists retention_purge_pending boolean not null default false;
alter table sophia_voice_lab.runs add column if not exists retention_purge_verified_at timestamptz;
drop index if exists sophia_voice_lab.voice_lab_runs_active_idx;
drop index if exists sophia_voice_lab.voice_lab_runs_expiry_idx;
create index if not exists voice_lab_runs_active_idx on sophia_voice_lab.runs (caller_id, created_at) where cleanup_complete=false or state not in ('pending_external_evidence','completed','product_failed','invalid_test','inconclusive_provider','failed_harness','authorization_failed','deployment_mismatch','aborted_driver_restart','expired','cancelled');
create index voice_lab_runs_expiry_idx on sophia_voice_lab.runs (expires_at) where state not in ('pending_external_evidence','completed','product_failed','invalid_test','inconclusive_provider','failed_harness','authorization_failed','deployment_mismatch','aborted_driver_restart','expired','cancelled');
create index if not exists voice_lab_runs_retention_due_idx on sophia_voice_lab.runs (retention_purge_due_at) where retention_purge_pending=true and evidence_purged_at is null;

-- After the signed retention deadline every raw run/control/evidence row is
-- deleted. Only keyed, content-free tombstones remain briefly so a client can
-- receive a typed retention result without preserving a recoverable identity.
create table if not exists sophia_voice_lab.retention_tombstones (
  lookup_id_hmac text primary key check (lookup_id_hmac ~ '^[a-f0-9]{64}$'),
  recovery_id_hmac text not null unique check (recovery_id_hmac ~ '^[a-f0-9]{64}$'),
  remote_purge_status text not null check (remote_purge_status in ('confirmed','unconfirmed')),
  purged_at timestamptz not null,
  control_expires_at timestamptz not null check (control_expires_at > purged_at)
);
create index if not exists voice_lab_retention_tombstone_expiry_idx on sophia_voice_lab.retention_tombstones (control_expires_at);

create table if not exists sophia_voice_lab.operations (
  id uuid primary key,
  run_id uuid not null references sophia_voice_lab.runs(id) on delete cascade,
  caller_id text not null,
  type text not null check (type in ('start','speak','barge_in','force_socket_rotation','end')),
  state text not null check (state in ('accepted','queued','leased','executing','succeeded','failed','timed_out','cancelled')),
  idempotency_key text not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  error jsonb,
  lease_owner text,
  lease_epoch integer not null default 0 check (lease_epoch >= 0),
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists voice_lab_start_idempotency_idx on sophia_voice_lab.operations (caller_id, type, idempotency_key) where type='start';
create unique index if not exists voice_lab_run_operation_idempotency_idx on sophia_voice_lab.operations (caller_id, run_id, type, idempotency_key) where type<>'start';
create index if not exists voice_lab_operations_claim_idx on sophia_voice_lab.operations (state, lease_expires_at, created_at);
create index if not exists voice_lab_operations_run_idx on sophia_voice_lab.operations (run_id, created_at);

create table if not exists sophia_voice_lab.run_events (
  run_id uuid not null references sophia_voice_lab.runs(id) on delete cascade,
  seq bigint not null check (seq > 0),
  kind text not null,
  source text not null check (source in ('mcp','worker','browser','product','canonical','provider')),
  observed_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  primary key (run_id, seq)
);
create unique index if not exists voice_lab_events_dedupe_idx on sophia_voice_lab.run_events (run_id, dedupe_key) where dedupe_key is not null;

create table if not exists sophia_voice_lab.browser_leases (
  run_id uuid primary key references sophia_voice_lab.runs(id) on delete cascade,
  worker_id text not null,
  lease_epoch integer not null check (lease_epoch > 0),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists voice_lab_browser_lease_expiry_idx on sophia_voice_lab.browser_leases (expires_at);

create table if not exists sophia_voice_lab.worker_heartbeats (
  worker_id text primary key,
  service_version text not null,
  browser_ready boolean not null,
  detail jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now()
);
create index if not exists voice_lab_worker_heartbeat_idx on sophia_voice_lab.worker_heartbeats (observed_at);

-- Content-free, rolling admission reservations. These are charged exactly
-- once per canonical idempotency request and survive web/worker restarts.
create table if not exists sophia_voice_lab.admission_reservations (
  reservation_key text primary key check (reservation_key ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  caller_partition_id text not null constraint voice_lab_admission_caller_partition_check check (caller_partition_id ~ '^cp1:[A-Za-z0-9_-]{1,32}:[a-f0-9]{64}$'),
  environment text not null check (environment in ('production','staging')),
  kind text not null check (kind in ('run','suite','audio')),
  run_starts integer not null default 0 check (run_starts >= 0),
  provider_seconds integer not null default 0 check (provider_seconds >= 0),
  suites integer not null default 0 check (suites >= 0),
  suite_children integer not null default 0 check (suite_children >= 0),
  audio_duration_ms bigint not null default 0 check (audio_duration_ms >= 0),
  audio_bytes bigint not null default 0 check (audio_bytes >= 0),
  observed_at timestamptz not null default now()
);
alter table sophia_voice_lab.admission_reservations add column if not exists caller_partition_id text;
do $$ begin
  if exists (select 1 from sophia_voice_lab.admission_reservations where caller_partition_id is null) then
    raise exception 'Voice Lab rolling admission raw caller rows require an offline keyed-partition migration before service startup';
  end if;
end $$;
alter table sophia_voice_lab.admission_reservations alter column caller_partition_id set not null;
alter table sophia_voice_lab.admission_reservations drop column if exists caller_id;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='voice_lab_admission_caller_partition_check' and conrelid='sophia_voice_lab.admission_reservations'::regclass) then
    alter table sophia_voice_lab.admission_reservations add constraint voice_lab_admission_caller_partition_check check (caller_partition_id ~ '^cp1:[A-Za-z0-9_-]{1,32}:[a-f0-9]{64}$');
  end if;
end $$;
create index if not exists voice_lab_admission_window_idx on sophia_voice_lab.admission_reservations (environment, observed_at);
drop index if exists sophia_voice_lab.voice_lab_admission_caller_window_idx;
create index voice_lab_admission_caller_window_idx on sophia_voice_lab.admission_reservations (environment, caller_partition_id, observed_at);

-- OAuth 2.1 registered-app lane. Only HMAC hashes of opaque authorization
-- codes/tokens are stored; consume/rotation operations are transactionally
-- fenced by the service adapter.
create table if not exists sophia_voice_lab.oauth_authorization_requests (
  request_hash text primary key check (request_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text not null check (csrf_hash ~ '^[a-f0-9]{64}$'),
  client_id text not null,
  redirect_uri text not null,
  resource text not null,
  state text,
  scopes text[] not null,
  code_challenge text not null,
  subject text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > issued_at)
);
create index if not exists voice_lab_oauth_request_expiry_idx on sophia_voice_lab.oauth_authorization_requests (expires_at) where consumed_at is null;

create table if not exists sophia_voice_lab.oauth_authorization_codes (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  client_id text not null,
  redirect_uri text not null,
  resource text not null,
  scopes text[] not null,
  code_challenge text not null,
  subject text not null,
  jti text not null unique,
  family_id text,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > issued_at)
);
alter table sophia_voice_lab.oauth_authorization_codes add column if not exists family_id text;
alter table sophia_voice_lab.oauth_authorization_codes add column if not exists revoked_at timestamptz;
create index if not exists voice_lab_oauth_code_expiry_idx on sophia_voice_lab.oauth_authorization_codes (expires_at) where consumed_at is null;
create index if not exists voice_lab_oauth_code_family_idx on sophia_voice_lab.oauth_authorization_codes (family_id) where family_id is not null;

create table if not exists sophia_voice_lab.oauth_access_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  issuer text not null,
  subject text not null,
  client_id text not null,
  audience text not null,
  resource text not null,
  scopes text[] not null,
  family_id text not null,
  jti text not null unique,
  issued_at timestamptz not null,
  not_before timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > issued_at),
  check (not_before <= issued_at)
);
create index if not exists voice_lab_oauth_access_family_idx on sophia_voice_lab.oauth_access_tokens (family_id);
create index if not exists voice_lab_oauth_access_expiry_idx on sophia_voice_lab.oauth_access_tokens (expires_at) where revoked_at is null;

create table if not exists sophia_voice_lab.oauth_refresh_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  issuer text not null,
  subject text not null,
  client_id text not null,
  audience text not null,
  resource text not null,
  scopes text[] not null,
  family_id text not null,
  parent_token_hash text,
  replacement_token_hash text,
  jti text not null unique,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > issued_at)
);
create index if not exists voice_lab_oauth_refresh_family_idx on sophia_voice_lab.oauth_refresh_tokens (family_id);
create index if not exists voice_lab_oauth_refresh_expiry_idx on sophia_voice_lab.oauth_refresh_tokens (expires_at) where revoked_at is null and used_at is null;

-- OAuth records retain only the same versioned caller partition used by the
-- bounded control ledger. Runtime maps a valid configured partition back to
-- the one configured operator subject after every read; raw subjects are
-- never durable. Existing raw rows require an explicit offline migration so a
-- deploy cannot silently hash or mis-bind live grants.
do $$
declare
  item record;
  has_invalid boolean;
begin
  for item in select * from (values
    ('oauth_authorization_requests','voice_lab_oauth_request_subject_partition_check'),
    ('oauth_authorization_codes','voice_lab_oauth_code_subject_partition_check'),
    ('oauth_access_tokens','voice_lab_oauth_access_subject_partition_check'),
    ('oauth_refresh_tokens','voice_lab_oauth_refresh_subject_partition_check')
  ) as entries(table_name,constraint_name) loop
    execute format(
      'select exists(select 1 from sophia_voice_lab.%I where subject !~ %L)',
      item.table_name,
      '^cp1:[A-Za-z0-9_-]{1,32}:[a-f0-9]{64}$'
    ) into has_invalid;
    if has_invalid then
      raise exception 'Voice Lab OAuth raw subject rows require an offline keyed-partition migration before service startup';
    end if;
    if not exists (
      select 1 from pg_constraint
       where conname=item.constraint_name
         and conrelid=to_regclass(format('sophia_voice_lab.%I',item.table_name))
    ) then
      execute format(
        'alter table sophia_voice_lab.%I add constraint %I check (subject ~ %L)',
        item.table_name,
        item.constraint_name,
        '^cp1:[A-Za-z0-9_-]{1,32}:[a-f0-9]{64}$'
      );
    end if;
  end loop;
end $$;

create table if not exists sophia_voice_lab.oauth_client_assertion_jtis (
  client_id text not null,
  jti text not null,
  expires_at timestamptz not null,
  claimed_at timestamptz not null,
  primary key (client_id, jti)
);
create index if not exists voice_lab_oauth_assertion_expiry_idx on sophia_voice_lab.oauth_client_assertion_jtis (expires_at);

-- Durable, content-free fixed-window admission for public OAuth endpoints.
-- subject_hash is an HMAC of the direct socket address/client lane; raw
-- addresses, headers, authorization codes, and tokens are never persisted.
create table if not exists sophia_voice_lab.oauth_endpoint_admissions (
  action text not null check (action in ('authorize_get','authorize_post','token','revoke')),
  subject_hash text not null check (subject_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null,
  primary key (action, subject_hash, window_started_at)
);
create index if not exists voice_lab_oauth_endpoint_admission_expiry_idx on sophia_voice_lab.oauth_endpoint_admissions (updated_at);

create table if not exists sophia_voice_lab.suite_runs (
  id uuid primary key,
  caller_id text not null,
  idempotency_key text not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('accepted','running','completed','failed','cancelled')),
  scenario_ids jsonb not null default '[]'::jsonb,
  run_ids jsonb not null default '[]'::jsonb,
  definition jsonb not null default '{}'::jsonb,
  next_scenario_index integer not null default 0 check (next_scenario_index >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (caller_id, idempotency_key)
);
alter table sophia_voice_lab.suite_runs add column if not exists definition jsonb not null default '{}'::jsonb;
alter table sophia_voice_lab.suite_runs add column if not exists next_scenario_index integer not null default 0;

create table if not exists sophia_voice_lab.suite_evidence_manifests (
  suite_id uuid primary key references sophia_voice_lab.suite_runs(id) on delete cascade,
  manifest_id uuid not null unique,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  schema_version text not null,
  bytes bytea not null check (octet_length(bytes) <= 2000000),
  artifact_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists sophia_voice_lab.artifacts (
  id uuid primary key,
  run_id uuid not null references sophia_voice_lab.runs(id) on delete cascade,
  kind text not null check (kind in ('final_screenshot','capture_json','canonical_receipt','manifest_attachment')),
  content_type text not null check (content_type in ('image/jpeg','image/png','application/json','application/gzip')),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bytea not null check (octet_length(bytes) <= 2000000),
  created_at timestamptz not null default now(),
  unique (run_id, sha256)
);
create index if not exists voice_lab_artifacts_run_idx on sophia_voice_lab.artifacts (run_id, created_at);

create or replace function sophia_voice_lab.enforce_artifact_run_cap()
returns trigger language plpgsql as $$
declare existing_bytes bigint;
begin
  perform 1 from sophia_voice_lab.runs where id = new.run_id for update;
  select coalesce(sum(octet_length(bytes)), 0) into existing_bytes
  from sophia_voice_lab.artifacts
  where run_id = new.run_id and id <> new.id;
  if existing_bytes + octet_length(new.bytes) > 8000000 then
    raise exception 'voice lab artifact run cap exceeded' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists voice_lab_artifact_run_cap on sophia_voice_lab.artifacts;
create trigger voice_lab_artifact_run_cap before insert or update on sophia_voice_lab.artifacts for each row execute function sophia_voice_lab.enforce_artifact_run_cap();

create table if not exists sophia_voice_lab.evidence_manifests (
  run_id uuid primary key references sophia_voice_lab.runs(id) on delete cascade,
  manifest_id uuid not null unique,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  schema_version text not null,
  revision_seq bigint not null default 0 check (revision_seq >= 0),
  artifact_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table sophia_voice_lab.evidence_manifests add column if not exists revision_seq bigint not null default 0;

create table if not exists sophia_voice_lab.evidence_manifest_revisions (
  manifest_id uuid primary key,
  run_id uuid not null references sophia_voice_lab.runs(id) on delete cascade,
  revision_seq bigint not null check (revision_seq >= 0),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  schema_version text not null,
  artifact_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, revision_seq)
);
create index if not exists voice_lab_evidence_revisions_run_idx on sophia_voice_lab.evidence_manifest_revisions (run_id, revision_seq desc);

create table if not exists sophia_voice_lab.auth_audit (
  id bigint generated always as identity primary key,
  run_id uuid references sophia_voice_lab.runs(id) on delete cascade,
  caller_id text,
  caller_partition_id text not null constraint voice_lab_auth_audit_caller_partition_check check (caller_partition_id ~ '^cp1:[A-Za-z0-9_-]{1,32}:[a-f0-9]{64}$'),
  action text not null,
  capability_jti_hash text,
  argument_hash text not null default repeat('0', 64) check (argument_hash ~ '^[a-f0-9]{64}$'),
  outcome text not null check (outcome in ('allowed','denied')),
  detail jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  constraint voice_lab_auth_audit_caller_binding_check check ((run_id is null and caller_id is null) or (run_id is not null and caller_id is not null))
);
alter table sophia_voice_lab.auth_audit add column if not exists argument_hash text not null default repeat('0', 64);
alter table sophia_voice_lab.auth_audit add column if not exists caller_partition_id text;
do $$ begin
  if exists (select 1 from sophia_voice_lab.auth_audit where caller_partition_id is null) then
    raise exception 'Voice Lab auth audit raw caller rows require an offline keyed-partition migration before service startup';
  end if;
end $$;
alter table sophia_voice_lab.auth_audit alter column caller_partition_id set not null;
alter table sophia_voice_lab.auth_audit alter column caller_id drop not null;
alter table sophia_voice_lab.auth_audit drop constraint if exists auth_audit_run_id_fkey;
alter table sophia_voice_lab.auth_audit add constraint auth_audit_run_id_fkey foreign key (run_id) references sophia_voice_lab.runs(id) on delete cascade;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='voice_lab_auth_audit_caller_partition_check' and conrelid='sophia_voice_lab.auth_audit'::regclass) then
    alter table sophia_voice_lab.auth_audit add constraint voice_lab_auth_audit_caller_partition_check check (caller_partition_id ~ '^cp1:[A-Za-z0-9_-]{1,32}:[a-f0-9]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname='voice_lab_auth_audit_caller_binding_check' and conrelid='sophia_voice_lab.auth_audit'::regclass) then
    alter table sophia_voice_lab.auth_audit add constraint voice_lab_auth_audit_caller_binding_check check ((run_id is null and caller_id is null) or (run_id is not null and caller_id is not null));
  end if;
end $$;
create index if not exists voice_lab_auth_audit_partition_window_idx on sophia_voice_lab.auth_audit (caller_partition_id, observed_at);

-- Permanent, content-safe singleton controlling the one allowed synthetic
-- principal provisioning chain. It stores only digests plus the exact
-- capability entropy needed to reproduce the same signed token after process
-- loss; it never stores the principal, capability, or grant secret.
create table if not exists sophia_voice_lab.principal_provisions (
  singleton boolean primary key default true check (singleton),
  request_hash text not null unique check (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  principal_hash text not null check (principal_hash ~ '^[a-f0-9]{64}$'),
  caller_partition_id text not null constraint voice_lab_principal_provision_caller_partition_check check (caller_partition_id ~ '^cp1:[A-Za-z0-9_-]{1,32}:[a-f0-9]{64}$'),
  issued_at timestamptz not null,
  test_run_id uuid not null,
  cleanup_obligation_id uuid not null,
  capability_jti text not null check (capability_jti ~ '^[a-f0-9]{32}$'),
  capability_nonce text not null check (capability_nonce ~ '^[a-f0-9]{32}$'),
  capability_hash text not null check (capability_hash ~ '^[a-f0-9]{64}$'),
  provider_expires_at timestamptz not null check (provider_expires_at > issued_at),
  environment text not null check (environment in ('production','staging')),
  expected_deployment jsonb not null,
  mcp_build text not null check (mcp_build ~ '^[a-f0-9]{40}$'),
  operator_subject_hash text not null check (operator_subject_hash ~ '^[a-f0-9]{64}$'),
  auth_audit_id bigint not null unique,
  audit_observed_at timestamptz not null,
  state text not null check (state in ('prepared','completed')),
  lease_owner uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count > 0),
  receipt jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint voice_lab_principal_provision_state_check check (
    (state='prepared' and receipt is null)
    or (state='completed' and receipt is not null and lease_owner is null and lease_expires_at is null)
  ),
  constraint voice_lab_principal_provision_lease_check check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  )
);
create index if not exists voice_lab_principal_provision_lease_idx on sophia_voice_lab.principal_provisions (state,lease_expires_at);

revoke all on schema sophia_voice_lab from public;
revoke all on all tables in schema sophia_voice_lab from public;
revoke all on all sequences in schema sophia_voice_lab from public;
revoke all on all functions in schema sophia_voice_lab from public;

commit;
