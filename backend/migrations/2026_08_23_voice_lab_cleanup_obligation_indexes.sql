-- Exact opaque cleanup-obligation indexes for VT00 product-owned resources.
-- The expression indexes preserve ordinary schemas and are partial, so
-- ordinary Sophia sessions and artifacts pay no lookup/storage cost.
begin;

alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres
  revoke execute on functions from sophia_voice_lab_gateway;
alter default privileges for role postgres
  revoke all privileges on tables from public, sophia_voice_lab_gateway;
alter default privileges for role postgres
  revoke all privileges on sequences from public, sophia_voice_lab_gateway;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, sophia_voice_lab_gateway;
alter default privileges for role postgres in schema public
  revoke all privileges on tables from public, sophia_voice_lab_gateway;
alter default privileges for role postgres in schema public
  revoke all privileges on sequences from public, sophia_voice_lab_gateway;

create table if not exists public.sophia_voice_lab_cleanup_obligations (
  cleanup_obligation_id text primary key,
  state text not null default 'open',
  lifecycle_phase text not null default 'auth_provisional',
  retention_expires_at timestamptz not null,
  provider_expires_at timestamptz not null,
  provider_settlement_sha256 text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  live_cleanup_completed_at timestamptz,
  completed_at timestamptz,
  purge_after timestamptz,
  constraint sophia_voice_lab_cleanup_obligation_id_valid check (
    cleanup_obligation_id ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint sophia_voice_lab_cleanup_obligation_state_valid check (
    state in ('open', 'closed', 'complete')
  ),
  constraint sophia_voice_lab_cleanup_obligation_phase_valid check (
    lifecycle_phase in (
      'auth_provisional', 'session_provisional', 'finalizing', 'finalized'
    )
    and (lifecycle_phase <> 'auth_provisional'
      or retention_expires_at = provider_expires_at)
    and (lifecycle_phase <> 'finalizing' or state = 'open')
    and (lifecycle_phase <> 'finalized' or state in ('closed', 'complete'))
  ),
  constraint sophia_voice_lab_cleanup_obligation_lifecycle_valid check (
    provider_expires_at <= retention_expires_at
    and (provider_settlement_sha256 is null
      or provider_settlement_sha256 ~ '^[a-f0-9]{64}$')
    and (live_cleanup_completed_at is null
      or updated_at >= live_cleanup_completed_at)
    and ((state = 'open' and closed_at is null
      and live_cleanup_completed_at is null
      and completed_at is null and purge_after is null)
    or (state = 'closed' and closed_at is not null
      and (live_cleanup_completed_at is null
        or live_cleanup_completed_at >= closed_at)
      and completed_at is null and purge_after is null)
    or (state = 'complete' and closed_at is not null
        and live_cleanup_completed_at is not null
        and live_cleanup_completed_at >= closed_at
        and completed_at is not null
        and completed_at >= live_cleanup_completed_at
        and purge_after is not null
        and purge_after >= retention_expires_at + interval '10 minutes'))
  )
);

create table if not exists public.sophia_voice_lab_cleanup_admissions (
  admission_id uuid primary key,
  cleanup_obligation_id text not null references
    public.sophia_voice_lab_cleanup_obligations(cleanup_obligation_id),
  resource_kind text not null,
  resource_id text not null,
  status text not null default 'reserved',
  lease_expires_at timestamptz not null,
  resource_expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sophia_voice_lab_cleanup_admission_kind_valid check (
    resource_kind in ('session', 'provider', 'builder')
  ),
  constraint sophia_voice_lab_cleanup_admission_status_valid check (
    status in (
      'reserved', 'allocating', 'credential_minted', 'browser_active',
      'activation_aborted', 'browser_closed'
    )
  ),
  constraint sophia_voice_lab_cleanup_admission_resource_valid check (
    length(resource_id) between 1 and 256
    and resource_id !~ '[[:cntrl:]]'
  ),
  constraint sophia_voice_lab_cleanup_admission_lease_valid check (
    lease_expires_at > created_at
    and resource_expires_at >= lease_expires_at
  )
);

create table if not exists public.sophia_voice_lab_cleanup_scan_cursors (
  cursor_name text primary key,
  cursor_due_at timestamptz,
  cursor_source text,
  cursor_cleanup_obligation_id text,
  cursor_admission_id uuid,
  window_due_at timestamptz,
  window_source text,
  window_cleanup_obligation_id text,
  window_admission_id uuid,
  updated_at timestamptz not null default clock_timestamp(),
  constraint sophia_voice_lab_cleanup_scan_cursor_name_valid check (
    cursor_name in ('work_v1', 'complete_purge_v1')
  ),
  constraint sophia_voice_lab_cleanup_scan_cursor_shape_valid check (
    (
      cursor_due_at is null
      and cursor_source is null
      and cursor_cleanup_obligation_id is null
      and cursor_admission_id is null
      and window_due_at is null
      and window_source is null
      and window_cleanup_obligation_id is null
      and window_admission_id is null
    )
    or (
      cursor_due_at is not null
      and window_due_at is not null
      and cursor_source in ('obligation', 'admission', 'complete')
      and window_source in ('obligation', 'admission', 'complete')
      and cursor_cleanup_obligation_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and window_cleanup_obligation_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and (
        (cursor_name = 'work_v1' and cursor_source = 'obligation'
          and cursor_admission_id is null)
        or (cursor_name = 'work_v1' and cursor_source = 'admission'
          and cursor_admission_id is not null)
        or (cursor_name = 'complete_purge_v1' and cursor_source = 'complete'
          and cursor_admission_id is null)
      )
      and (
        (cursor_name = 'work_v1' and window_source = 'obligation'
          and window_admission_id is null)
        or (cursor_name = 'work_v1' and window_source = 'admission'
          and window_admission_id is not null)
        or (cursor_name = 'complete_purge_v1' and window_source = 'complete'
          and window_admission_id is null)
      )
    )
  )
);

create table if not exists public.sophia_voice_lab_d02_gateway_settlements (
  cleanup_obligation_id text not null references
    public.sophia_voice_lab_cleanup_obligations(cleanup_obligation_id)
    on delete cascade,
  termination_request_id_sha256 char(64) not null,
  provider_session_id text not null,
  provider_admission_id uuid not null,
  freeze_request_sha256 char(64) not null,
  freeze_capability_jti_sha256 char(64) not null,
  freeze_binding jsonb not null,
  frozen_at timestamptz not null default clock_timestamp(),
  voice_terminal_receipt_sha256 char(64),
  voice_terminal_receipt jsonb,
  voice_terminal_at timestamptz,
  settlement_request_sha256 char(64),
  settlement_capability_jti_sha256 char(64),
  provider_settlement_sha256 char(64),
  receipt_sha256 char(64),
  receipt jsonb,
  settled_at timestamptz,
  primary key (cleanup_obligation_id, termination_request_id_sha256),
  constraint sophia_voice_lab_d02_gateway_settlement_hashes_valid check (
    termination_request_id_sha256 ~ '^[a-f0-9]{64}$'
    and freeze_request_sha256 ~ '^[a-f0-9]{64}$'
    and freeze_capability_jti_sha256 ~ '^[a-f0-9]{64}$'
    and (voice_terminal_receipt_sha256 is null
      or voice_terminal_receipt_sha256 ~ '^[a-f0-9]{64}$')
    and (settlement_request_sha256 is null
      or settlement_request_sha256 ~ '^[a-f0-9]{64}$')
    and (settlement_capability_jti_sha256 is null
      or settlement_capability_jti_sha256 ~ '^[a-f0-9]{64}$')
    and (provider_settlement_sha256 is null
      or provider_settlement_sha256 ~ '^[a-f0-9]{64}$')
    and (receipt_sha256 is null or receipt_sha256 ~ '^[a-f0-9]{64}$')
  ),
  constraint sophia_voice_lab_d02_gateway_settlement_binding_valid check (
    length(provider_session_id) between 1 and 256
    and provider_session_id !~ '[[:cntrl:]]'
    and jsonb_typeof(freeze_binding) = 'object'
    and freeze_binding ->> 'schema' =
      'sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1'
  ),
  constraint sophia_voice_lab_d02_gateway_settlement_lifecycle_valid check (
    (
      voice_terminal_receipt_sha256 is null
      and voice_terminal_receipt is null
      and voice_terminal_at is null
      or voice_terminal_receipt_sha256 is not null
      and jsonb_typeof(voice_terminal_receipt) = 'object'
      and voice_terminal_receipt ->> 'schema' =
        'sophia_voice_lab_voice_provider_terminal_v1'
      and voice_terminal_at is not null
      and voice_terminal_at >= frozen_at
    )
    and (
      settlement_request_sha256 is null
      and settlement_capability_jti_sha256 is null
      and provider_settlement_sha256 is null
      and receipt_sha256 is null
      and receipt is null
      and settled_at is null
      or settlement_request_sha256 is not null
      and settlement_capability_jti_sha256 is not null
      and provider_settlement_sha256 is not null
      and voice_terminal_receipt_sha256 is not null
      and voice_terminal_receipt is not null
      and voice_terminal_at is not null
      and receipt_sha256 is not null
      and jsonb_typeof(receipt) = 'object'
      and receipt ->> 'schema' =
        'sophia_voice_lab_gateway_browser_worker_termination_settlement_v1'
      and settled_at is not null
      and settled_at >= voice_terminal_at
    )
  )
);

create table if not exists public.sophia_voice_lab_d02_gateway_capability_uses (
  capability_jti_sha256 char(64) primary key,
  operation text not null,
  request_sha256 char(64) not null,
  cleanup_obligation_id text not null references
    public.sophia_voice_lab_cleanup_obligations(cleanup_obligation_id)
    on delete cascade,
  termination_request_id_sha256 char(64) not null,
  used_at timestamptz not null default clock_timestamp(),
  constraint sophia_voice_lab_d02_gateway_capability_use_valid check (
    capability_jti_sha256 ~ '^[a-f0-9]{64}$'
    and operation in (
      'freeze', 'settle', 'observe_continuity',
      'relay_begin', 'relay_refresh', 'relay_end'
    )
    and request_sha256 ~ '^[a-f0-9]{64}$'
    and termination_request_id_sha256 ~ '^[a-f0-9]{64}$'
  )
);
alter table public.sophia_voice_lab_d02_gateway_capability_uses
  drop constraint if exists sophia_voice_lab_d02_gateway_capability_use_valid;
alter table public.sophia_voice_lab_d02_gateway_capability_uses
  add constraint sophia_voice_lab_d02_gateway_capability_use_valid check (
    capability_jti_sha256 ~ '^[a-f0-9]{64}$'
    and operation in (
      'freeze', 'settle', 'observe_continuity',
      'relay_begin', 'relay_refresh', 'relay_end'
    )
    and request_sha256 ~ '^[a-f0-9]{64}$'
    and termination_request_id_sha256 ~ '^[a-f0-9]{64}$'
  );

create table if not exists
  public.sophia_voice_lab_d02_product_continuity_observations (
  cleanup_obligation_id text not null references
    public.sophia_voice_lab_cleanup_obligations(cleanup_obligation_id)
    on delete cascade,
  restart_request_id_sha256 char(64) not null,
  phase text not null,
  request_sha256 char(64) not null,
  capability_jti_sha256 char(64) not null,
  product_service_boot_id_sha256 char(64) not null,
  render_action_request_sha256 char(64) not null,
  prior_observation_receipt_sha256 char(64),
  receipt_sha256 char(64) not null,
  receipt jsonb not null,
  observed_at timestamptz not null default clock_timestamp(),
  primary key (cleanup_obligation_id, restart_request_id_sha256, phase),
  constraint sophia_voice_lab_d02_product_continuity_hashes_valid check (
    restart_request_id_sha256 ~ '^[a-f0-9]{64}$'
    and request_sha256 ~ '^[a-f0-9]{64}$'
    and capability_jti_sha256 ~ '^[a-f0-9]{64}$'
    and product_service_boot_id_sha256 ~ '^[a-f0-9]{64}$'
    and render_action_request_sha256 ~ '^[a-f0-9]{64}$'
    and (prior_observation_receipt_sha256 is null
      or prior_observation_receipt_sha256 ~ '^[a-f0-9]{64}$')
    and receipt_sha256 ~ '^[a-f0-9]{64}$'
  ),
  constraint sophia_voice_lab_d02_product_continuity_shape_valid check (
    (phase = 'before_api_restart'
      and prior_observation_receipt_sha256 is null)
    or (phase = 'after_api_restart'
      and prior_observation_receipt_sha256 is not null)
  ),
  constraint sophia_voice_lab_d02_product_continuity_receipt_valid check (
    jsonb_typeof(receipt) = 'object'
    and receipt ->> 'schema' =
      'sophia_voice_lab_d02_product_continuity_observation_v1'
    and receipt ->> 'phase' = phase
    and receipt ->> 'receipt_sha256' = receipt_sha256
  )
);

create table if not exists public.sophia_voice_lab_d02_gateway_relay_leases (
  relay_id uuid primary key,
  cleanup_obligation_id text not null references
    public.sophia_voice_lab_cleanup_obligations(cleanup_obligation_id)
    on delete cascade,
  provider_session_id text not null,
  provider_connection_epoch integer not null,
  relay_kind text not null,
  owner_instance_id_sha256 char(64) not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint sophia_voice_lab_d02_gateway_relay_lease_valid check (
    length(provider_session_id) between 1 and 256
    and provider_session_id !~ '[[:cntrl:]]'
    and provider_connection_epoch > 0
    and relay_kind in ('provider_event', 'event_stream')
    and owner_instance_id_sha256 ~ '^[a-f0-9]{64}$'
    and expires_at > created_at
  )
);
-- Remove columns from the pre-freeze relay-CAS checkpoint. Operation-scoped
-- capability uses now make refresh/end replay one-shot without mutable relay
-- generations, and exact catalog readiness intentionally rejects residue.
alter table public.sophia_voice_lab_d02_gateway_relay_leases
  drop column if exists refresh_generation;
alter table public.sophia_voice_lab_d02_gateway_relay_leases
  drop column if exists last_refresh_proof_sha256;

create unique index if not exists
  sophia_voice_lab_d02_gateway_settlements_freeze_jti_idx
  on public.sophia_voice_lab_d02_gateway_settlements (
    freeze_capability_jti_sha256
  );
create unique index if not exists
  sophia_voice_lab_d02_gateway_settlements_settlement_jti_idx
  on public.sophia_voice_lab_d02_gateway_settlements (
    settlement_capability_jti_sha256
  ) where settlement_capability_jti_sha256 is not null;
create index if not exists sophia_voice_lab_d02_gateway_relay_expiry_idx
  on public.sophia_voice_lab_d02_gateway_relay_leases (
    cleanup_obligation_id, expires_at, owner_instance_id_sha256, relay_id
  );
create unique index if not exists
  sophia_voice_lab_d02_product_continuity_one_restart_idx
  on public.sophia_voice_lab_d02_product_continuity_observations (
    cleanup_obligation_id
  ) where phase = 'before_api_restart';

create table if not exists
  public.sophia_voice_lab_d02_gateway_finalize_authority (
  singleton boolean primary key default true,
  authority_key_id text not null,
  authority_secret text not null,
  installed_at timestamptz not null default clock_timestamp(),
  constraint sophia_voice_lab_d02_gateway_finalize_authority_singleton check (
    singleton
  ),
  constraint sophia_voice_lab_d02_gateway_finalize_authority_shape check (
    authority_key_id ~ '^[A-Za-z0-9._-]{1,64}$'
    and length(authority_secret) between 32 and 256
    and octet_length(authority_secret) = length(authority_secret)
    and authority_secret !~ '[[:cntrl:]]'
  )
);
alter table public.sophia_voice_lab_d02_gateway_finalize_authority
  drop constraint if exists
    sophia_voice_lab_d02_gateway_finalize_authority_shape;
do $$
declare
  configured_key_id text := current_setting(
    'sophia.voice_lab_d02_finalize_hmac_key_id', true
  );
  configured_secret text := current_setting(
    'sophia.voice_lab_d02_finalize_hmac_secret', true
  );
begin
  if configured_key_id is null
     or configured_key_id !~ '^[A-Za-z0-9._-]{1,64}$'
     or configured_secret is null
     or length(configured_secret) not between 32 and 256
     or octet_length(configured_secret) <> length(configured_secret)
     or configured_secret ~ '[[:cntrl:]]' then
    raise exception 'D02 database finalize authority is unavailable';
  end if;
  insert into public.sophia_voice_lab_d02_gateway_finalize_authority (
    singleton, authority_key_id, authority_secret, installed_at
  ) values (
    true, configured_key_id, configured_secret, clock_timestamp()
  ) on conflict (singleton) do update
    set authority_key_id = excluded.authority_key_id,
        authority_secret = excluded.authority_secret,
        installed_at = excluded.installed_at;
end
$$;
alter table public.sophia_voice_lab_d02_gateway_finalize_authority
  add constraint sophia_voice_lab_d02_gateway_finalize_authority_shape check (
    authority_key_id ~ '^[A-Za-z0-9._-]{1,64}$'
    and length(authority_secret) between 32 and 256
    and octet_length(authority_secret) = length(authority_secret)
    and authority_secret !~ '[[:cntrl:]]'
  );

create or replace function public.sophia_voice_lab_d02_canonical_json(
  p_value jsonb
) returns text
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  canonical text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(
        to_jsonb(item.key)::text || ':' ||
          public.sophia_voice_lab_d02_canonical_json(item.value),
        ',' order by item.key collate "C"
      ), '') || '}'
        into canonical
        from jsonb_each(p_value) item;
    when 'array' then
      select '[' || coalesce(string_agg(
        public.sophia_voice_lab_d02_canonical_json(item.value),
        ',' order by item.ordinality
      ), '') || ']'
        into canonical
        from jsonb_array_elements(p_value) with ordinality
          item(value, ordinality);
    else
      canonical := p_value::text;
  end case;
  return canonical;
end;
$$;

create or replace function public.sophia_voice_lab_d02_hmac_sha256(
  p_key bytea,
  p_data bytea
) returns bytea
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  normalized_key bytea := p_key;
  inner_pad bytea := decode(repeat('36', 64), 'hex');
  outer_pad bytea := decode(repeat('5c', 64), 'hex');
  position integer;
begin
  if octet_length(normalized_key) > 64 then
    normalized_key := pg_catalog.sha256(normalized_key);
  end if;
  normalized_key := normalized_key || decode(
    repeat('00', 64 - octet_length(normalized_key)), 'hex'
  );
  for position in 0..63 loop
    inner_pad := set_byte(
      inner_pad, position,
      get_byte(inner_pad, position) # get_byte(normalized_key, position)
    );
    outer_pad := set_byte(
      outer_pad, position,
      get_byte(outer_pad, position) # get_byte(normalized_key, position)
    );
  end loop;
  return pg_catalog.sha256(
    outer_pad || pg_catalog.sha256(inner_pad || p_data)
  );
end;
$$;

create or replace function public.sophia_voice_lab_d02_finalize_proof_valid(
  p_authority_key_id text,
  p_domain text,
  p_parts jsonb,
  p_value jsonb,
  p_proof_sha256 text
) returns boolean
language plpgsql
stable
strict
parallel restricted
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  authority_row record;
  proof_core jsonb;
  canonical_value text;
  expected_proof bytea;
  supplied_proof bytea;
  mismatch integer := 0;
  position integer;
begin
  select authority.authority_key_id, authority.authority_secret
    into strict authority_row
    from public.sophia_voice_lab_d02_gateway_finalize_authority authority
   where authority.singleton;
  if authority_row.authority_key_id is distinct from p_authority_key_id
     or p_domain not in (
       'freeze_finalize_v1', 'voice_terminal_finalize_v1',
       'settlement_finalize_v1', 'continuity_finalize_v1',
       'relay_begin_v1', 'relay_refresh_v1', 'relay_end_v1'
     )
     or jsonb_typeof(p_parts) <> 'array'
     or jsonb_array_length(p_parts) > 32
     or pg_column_size(p_parts) > 32768
     or pg_column_size(p_value) > 262144
     or exists (
       select 1 from jsonb_array_elements(p_parts) part
        where jsonb_typeof(part) <> 'string'
           or length(part #>> '{}') not between 1 and 512
           or octet_length(part #>> '{}') <> length(part #>> '{}')
     )
     or p_proof_sha256 !~ '^[a-f0-9]{64}$' then
    return false;
  end if;
  canonical_value := public.sophia_voice_lab_d02_canonical_json(p_value);
  if octet_length(canonical_value) <> length(canonical_value)
     or octet_length(canonical_value) > 262144 then
    return false;
  end if;
  proof_core := jsonb_build_object(
    'authority_key_id', p_authority_key_id,
    'domain', p_domain,
    'parts', p_parts,
    'value_sha256', encode(
      pg_catalog.sha256(pg_catalog.convert_to(canonical_value, 'UTF8')),
      'hex'
    )
  );
  expected_proof := public.sophia_voice_lab_d02_hmac_sha256(
    pg_catalog.convert_to(authority_row.authority_secret, 'UTF8'),
    pg_catalog.convert_to(
      public.sophia_voice_lab_d02_canonical_json(proof_core), 'UTF8'
    )
  );
  supplied_proof := decode(p_proof_sha256, 'hex');
  if octet_length(expected_proof) <> 32
     or octet_length(supplied_proof) <> 32 then
    return false;
  end if;
  for position in 0..31 loop
    mismatch := mismatch | (
      get_byte(expected_proof, position) # get_byte(supplied_proof, position)
    );
  end loop;
  return mismatch = 0;
exception
  when no_data_found or too_many_rows then
    return false;
end;
$$;

create or replace function public.sophia_voice_lab_d02_finalize_authority_ready(
  p_authority_key_id text,
  p_authority_secret_sha256 text
) returns boolean
language sql
stable
strict
parallel safe
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select count(*) = 1
         and bool_and(authority.authority_key_id = p_authority_key_id)
         and bool_and(
           encode(pg_catalog.sha256(pg_catalog.convert_to(
             authority.authority_secret, 'UTF8'
           )), 'hex') = p_authority_secret_sha256
         )
    from public.sophia_voice_lab_d02_gateway_finalize_authority authority
   where authority.singleton
$$;

create or replace function public.sophia_voice_lab_d02_register_capability_use_state(
  p_capability_jti_sha256 text,
  p_operation text,
  p_request_sha256 text,
  p_cleanup_obligation_id text,
  p_request_id_sha256 text
) returns text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  capability_row record;
  inserted_count bigint;
begin
  insert into public.sophia_voice_lab_d02_gateway_capability_uses (
    capability_jti_sha256, operation, request_sha256,
    cleanup_obligation_id, termination_request_id_sha256
  ) values (
    p_capability_jti_sha256, p_operation, p_request_sha256,
    p_cleanup_obligation_id, p_request_id_sha256
  ) on conflict (capability_jti_sha256) do nothing;
  get diagnostics inserted_count = row_count;

  begin
    select capability.operation, capability.request_sha256,
           capability.cleanup_obligation_id,
           capability.termination_request_id_sha256
      into strict capability_row
      from public.sophia_voice_lab_d02_gateway_capability_uses capability
     where capability.capability_jti_sha256 = p_capability_jti_sha256;
  exception
    when no_data_found or too_many_rows then
      return 'conflict';
  end;
  if capability_row.operation is distinct from p_operation
     or capability_row.request_sha256 is distinct from p_request_sha256
     or capability_row.cleanup_obligation_id is distinct from
       p_cleanup_obligation_id
     or capability_row.termination_request_id_sha256 is distinct from
       p_request_id_sha256 then
    return 'conflict';
  end if;
  if inserted_count = 1 then
    return 'created';
  end if;
  return 'replay';
end;
$$;

create or replace function public.sophia_voice_lab_d02_register_capability_use(
  p_capability_jti_sha256 text,
  p_operation text,
  p_request_sha256 text,
  p_cleanup_obligation_id text,
  p_request_id_sha256 text
) returns boolean
language sql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select public.sophia_voice_lab_d02_register_capability_use_state(
    p_capability_jti_sha256,
    p_operation,
    p_request_sha256,
    p_cleanup_obligation_id,
    p_request_id_sha256
  ) in ('created', 'replay')
$$;

create or replace function public.sophia_voice_lab_d02_freeze_authorize(
  p_cleanup_obligation_id text,
  p_termination_request_id_sha256 text,
  p_request_sha256 text,
  p_capability_jti_sha256 text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  existing_row record;
  candidate_row record;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  if public.sophia_voice_lab_d02_register_capability_use(
    p_capability_jti_sha256, 'freeze', p_request_sha256,
    p_cleanup_obligation_id, p_termination_request_id_sha256
  ) is distinct from true then
    return jsonb_build_object('status', 'capability_replay_conflict');
  end if;

  select settlement.freeze_request_sha256,
         settlement.freeze_capability_jti_sha256,
         settlement.freeze_binding
    into existing_row
    from public.sophia_voice_lab_d02_gateway_settlements settlement
   where settlement.cleanup_obligation_id = p_cleanup_obligation_id
     and settlement.termination_request_id_sha256 =
         p_termination_request_id_sha256
   for update;
  if found then
    return jsonb_build_object(
      'status', 'existing',
      'freeze_request_sha256', existing_row.freeze_request_sha256,
      'freeze_capability_jti_sha256',
        existing_row.freeze_capability_jti_sha256,
      'freeze_binding', existing_row.freeze_binding
    );
  end if;

  begin
    select session.user_id, session.run_id, session.metadata,
           obligation.state, obligation.lifecycle_phase,
           obligation.live_cleanup_completed_at,
           admission.admission_id::text as admission_id,
           admission.status as admission_status,
           admission.resource_id as admission_resource_id
      into strict candidate_row
      from public.sophia_sessions session
      join public.sophia_voice_lab_cleanup_obligations obligation
        on obligation.cleanup_obligation_id = p_cleanup_obligation_id
      join public.sophia_voice_lab_cleanup_admissions admission
        on admission.cleanup_obligation_id = obligation.cleanup_obligation_id
       and admission.resource_kind = 'provider'
     where session.metadata -> 'synthetic_voice_lab'
             ->> 'cleanup_obligation_id' = p_cleanup_obligation_id
     for update of session, obligation, admission;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'binding_unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  return jsonb_build_object(
    'status', 'candidate',
    'user_id', candidate_row.user_id,
    'run_id', candidate_row.run_id,
    'metadata', candidate_row.metadata,
    'obligation_state', candidate_row.state,
    'lifecycle_phase', candidate_row.lifecycle_phase,
    'live_cleanup_completed_at', candidate_row.live_cleanup_completed_at,
    'admission_id', candidate_row.admission_id,
    'admission_status', candidate_row.admission_status,
    'admission_resource_id', candidate_row.admission_resource_id
  );
end;
$$;

drop function if exists public.sophia_voice_lab_d02_freeze_finalize(
  text, text, text, uuid, text, text, jsonb
);
create or replace function public.sophia_voice_lab_d02_freeze_finalize(
  p_cleanup_obligation_id text,
  p_termination_request_id_sha256 text,
  p_provider_session_id text,
  p_provider_admission_id uuid,
  p_request_sha256 text,
  p_capability_jti_sha256 text,
  p_freeze_binding jsonb,
  p_authority_key_id text,
  p_finalize_proof_sha256 text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  existing_row record;
  candidate_row record;
  synthetic jsonb;
  expected_deployment jsonb;
  live_epochs jsonb;
  provider_admission_count bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  if public.sophia_voice_lab_d02_finalize_proof_valid(
    p_authority_key_id,
    'freeze_finalize_v1',
    jsonb_build_array(
      p_cleanup_obligation_id,
      p_termination_request_id_sha256,
      p_provider_session_id,
      p_provider_admission_id::text,
      p_request_sha256,
      p_capability_jti_sha256
    ),
    p_freeze_binding,
    p_finalize_proof_sha256
  ) is distinct from true then
    return jsonb_build_object('status', 'finalize_proof_invalid');
  end if;
  if not exists (
    select 1
      from public.sophia_voice_lab_d02_gateway_capability_uses capability
     where capability.capability_jti_sha256 = p_capability_jti_sha256
       and capability.operation = 'freeze'
       and capability.request_sha256 = p_request_sha256
       and capability.cleanup_obligation_id = p_cleanup_obligation_id
       and capability.termination_request_id_sha256 =
           p_termination_request_id_sha256
  ) then
    return jsonb_build_object('status', 'capability_prepare_required');
  end if;
  select settlement.provider_session_id, settlement.provider_admission_id,
         settlement.freeze_request_sha256, settlement.freeze_binding
    into existing_row
    from public.sophia_voice_lab_d02_gateway_settlements settlement
   where settlement.cleanup_obligation_id = p_cleanup_obligation_id
     and settlement.termination_request_id_sha256 =
         p_termination_request_id_sha256
   for update;
  if found then
    if existing_row.provider_session_id is not distinct from
         p_provider_session_id
       and existing_row.provider_admission_id is not distinct from
         p_provider_admission_id
       and existing_row.freeze_request_sha256 is not distinct from
         p_request_sha256
       and existing_row.freeze_binding is not distinct from p_freeze_binding then
      return jsonb_build_object('status', 'replay');
    end if;
    return jsonb_build_object('status', 'freeze_conflict');
  end if;

  begin
    select session.user_id, session.run_id, session.metadata,
           obligation.state, obligation.lifecycle_phase,
           obligation.live_cleanup_completed_at,
           admission.admission_id, admission.status,
           admission.resource_id
      into strict candidate_row
      from public.sophia_sessions session
      join public.sophia_voice_lab_cleanup_obligations obligation
        on obligation.cleanup_obligation_id = p_cleanup_obligation_id
      join public.sophia_voice_lab_cleanup_admissions admission
        on admission.cleanup_obligation_id = obligation.cleanup_obligation_id
       and admission.resource_kind = 'provider'
       and admission.admission_id = p_provider_admission_id
     where session.metadata -> 'synthetic_voice_lab'
             ->> 'cleanup_obligation_id' = p_cleanup_obligation_id
     for update of session, obligation, admission;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'binding_unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  select count(*)
    into provider_admission_count
    from public.sophia_voice_lab_cleanup_admissions admission
   where admission.cleanup_obligation_id = p_cleanup_obligation_id
     and admission.resource_kind = 'provider';
  if provider_admission_count is distinct from 1::bigint then
    return jsonb_build_object('status', 'binding_cardinality_invalid');
  end if;
  synthetic := candidate_row.metadata -> 'synthetic_voice_lab';
  expected_deployment := candidate_row.metadata -> 'expected_deployment';
  select coalesce(jsonb_agg(epoch order by epoch), '[]'::jsonb)
    into live_epochs
    from (
      select distinct epoch
        from (values
          (nullif(synthetic ->> 'voice_provider_connection_epoch', '')::integer),
          (nullif(synthetic ->> 'voice_provider_pending_connection_epoch', '')::integer)
        ) values_row(epoch)
       where epoch is not null and epoch > 0
    ) exact_epochs;
  if jsonb_typeof(p_freeze_binding) is distinct from 'object'
     or not (p_freeze_binding ?& array[
       'schema', 'termination_request_id', 'voice_lab_run_id_sha256',
       'test_run_id', 'cleanup_obligation_id', 'provider_session_id',
       'provider_admission_id_sha256', 'provider_connection_epoch',
       'frozen_provider_connection_epochs', 'browser_worker_id_sha256',
       'browser_lease_epoch', 'browser_context_id_sha256',
       'render_action_request_sha256', 'requested_at'
     ])
     or (p_freeze_binding - array[
       'schema', 'termination_request_id', 'voice_lab_run_id_sha256',
       'test_run_id', 'cleanup_obligation_id', 'provider_session_id',
       'provider_admission_id_sha256', 'provider_connection_epoch',
       'frozen_provider_connection_epochs', 'browser_worker_id_sha256',
       'browser_lease_epoch', 'browser_context_id_sha256',
       'render_action_request_sha256', 'requested_at'
     ]) is distinct from '{}'::jsonb
     or p_freeze_binding ->> 'schema' is distinct from
       'sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1'
     or synthetic -> 'synthetic' is distinct from 'true'::jsonb
     or synthetic ->> 'scenario_id' is distinct from 'V-D02'
     or candidate_row.state is distinct from 'open'
     or candidate_row.lifecycle_phase is distinct from 'session_provisional'
     or candidate_row.live_cleanup_completed_at is not null
     or candidate_row.status not in ('credential_minted', 'browser_active')
     or candidate_row.status is null
     or candidate_row.resource_id is distinct from p_provider_session_id
     or p_freeze_binding ->> 'cleanup_obligation_id' is distinct from
       p_cleanup_obligation_id
     or p_freeze_binding ->> 'provider_session_id' is distinct from
       p_provider_session_id
     or p_freeze_binding ->> 'provider_admission_id_sha256' is distinct from
       encode(pg_catalog.sha256(pg_catalog.convert_to(
         p_provider_admission_id::text, 'UTF8'
       )), 'hex')
     or p_freeze_binding ->> 'test_run_id' is distinct from
       synthetic ->> 'test_run_id'
     or candidate_row.run_id is distinct from synthetic ->> 'test_run_id'
     or candidate_row.user_id is distinct from synthetic ->> 'principal_id'
     or p_freeze_binding ->> 'voice_lab_run_id_sha256' is distinct from
       synthetic ->> 'voice_lab_run_id_sha256'
     or p_freeze_binding ->> 'browser_worker_id_sha256' is distinct from
       synthetic ->> 'browser_worker_id_sha256'
     or (p_freeze_binding ->> 'browser_lease_epoch')::bigint is distinct from
       (synthetic ->> 'browser_lease_epoch')::bigint
     or p_freeze_binding ->> 'browser_context_id_sha256' is distinct from
       synthetic ->> 'browser_context_id_sha256'
     or p_freeze_binding ->> 'provider_connection_epoch' is null
     or (p_freeze_binding ->> 'provider_connection_epoch')::integer
       is distinct from
       (synthetic ->> 'voice_provider_connection_epoch')::integer
     or p_freeze_binding -> 'frozen_provider_connection_epochs'
       is distinct from live_epochs
     or jsonb_typeof(expected_deployment) is distinct from 'object'
     or (expected_deployment - array['frontend', 'backend', 'voice'])
       is distinct from
       '{}'::jsonb
     or not (expected_deployment ?& array['frontend', 'backend', 'voice'])
     or synthetic ->> 'voice_runtime_owner_deployment_sha' is distinct from
       expected_deployment ->> 'voice'
     or (expected_deployment ->> 'frontend' ~ '^[a-f0-9]{40}$')
       is distinct from true
     or (expected_deployment ->> 'backend' ~ '^[a-f0-9]{40}$')
       is distinct from true
     or (expected_deployment ->> 'voice' ~ '^[a-f0-9]{40}$')
       is distinct from true
     or (synthetic ->> 'voice_runtime_instance_id_sha256' ~
       '^[a-f0-9]{64}$') is distinct from true
     or coalesce(
       length(synthetic ->> 'voice_runtime_instance_public_key_spki_base64'),
       0
     ) = 0
  then
    return jsonb_build_object('status', 'binding_mismatch');
  end if;

  update public.sophia_voice_lab_cleanup_obligations
     set state = 'closed', closed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where cleanup_obligation_id = p_cleanup_obligation_id
     and state = 'open' and lifecycle_phase = 'session_provisional'
     and live_cleanup_completed_at is null;
  if not found then
    return jsonb_build_object('status', 'fence_conflict');
  end if;
  insert into public.sophia_voice_lab_d02_gateway_settlements (
    cleanup_obligation_id, termination_request_id_sha256,
    provider_session_id, provider_admission_id,
    freeze_request_sha256, freeze_capability_jti_sha256, freeze_binding
  ) values (
    p_cleanup_obligation_id, p_termination_request_id_sha256,
    p_provider_session_id, p_provider_admission_id,
    p_request_sha256, p_capability_jti_sha256, p_freeze_binding
  );
  return jsonb_build_object('status', 'created');
end;
$$;

create or replace function public.sophia_voice_lab_d02_provider_freeze(
  p_cleanup_obligation_id text,
  p_provider_admission_id uuid,
  p_provider_session_id text
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  binding jsonb;
begin
  begin
    select settlement.freeze_binding
      into strict binding
      from public.sophia_voice_lab_d02_gateway_settlements settlement
      join public.sophia_voice_lab_cleanup_obligations obligation
        on obligation.cleanup_obligation_id = settlement.cleanup_obligation_id
     where settlement.cleanup_obligation_id = p_cleanup_obligation_id
       and settlement.provider_admission_id = p_provider_admission_id
       and settlement.provider_session_id = p_provider_session_id
       and obligation.state = 'closed'
       and settlement.receipt is null;
  exception
    when no_data_found or too_many_rows then
      return null;
  end;
  return binding;
end;
$$;

create or replace function public.sophia_voice_lab_d02_producer_open(
  p_cleanup_obligation_id text
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  is_open boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  select obligation.state = 'open'
         and not exists (
           select 1
             from public.sophia_voice_lab_d02_gateway_settlements settlement
            where settlement.cleanup_obligation_id =
                  obligation.cleanup_obligation_id
         )
    into is_open
    from public.sophia_voice_lab_cleanup_obligations obligation
   where obligation.cleanup_obligation_id = p_cleanup_obligation_id
   for update;
  return coalesce(is_open, false);
end;
$$;

create or replace function public.sophia_voice_lab_d02_sources_zero(
  p_cleanup_obligation_id text
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select not exists (
           select 1
             from public.sophia_voice_lab_d02_gateway_settlements settlement
            where settlement.cleanup_obligation_id = p_cleanup_obligation_id
              and settlement.receipt is null
         )
         and not exists (
           select 1
             from public.sophia_voice_lab_d02_gateway_relay_leases relay
            where relay.cleanup_obligation_id = p_cleanup_obligation_id
         )
$$;

create or replace function public.sophia_voice_lab_d02_browser_settlement(
  p_metadata jsonb,
  p_provider_session_id text
) returns jsonb
language plpgsql
stable
strict
parallel safe
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  synthetic jsonb := p_metadata -> 'synthetic_voice_lab';
  close_receipts jsonb;
  abort_receipts jsonb;
  item jsonb;
  item_epoch integer;
  previous_epoch integer := 0;
  close_epochs integer[] := '{}'::integer[];
  abort_epochs integer[] := '{}'::integer[];
  exact_epochs jsonb;
  settlement_sha256 text;
begin
  close_receipts := synthetic -> 'voice_provider_browser_close_receipts';
  abort_receipts := synthetic -> 'voice_provider_activation_abort_receipts';
  if jsonb_typeof(close_receipts) is distinct from 'array'
     or jsonb_typeof(abort_receipts) is distinct from 'array'
     or jsonb_array_length(close_receipts) > 8
     or jsonb_array_length(abort_receipts) > 8 then
    return jsonb_build_object('valid', false);
  end if;

  for item in select value from jsonb_array_elements(close_receipts) loop
    if jsonb_typeof(item) is distinct from 'object'
       or not (item ?& array[
         'schema', 'receipt_id', 'session_id',
         'provider_connection_epoch', 'websocket_close_observed',
         'websocket_close_code', 'websocket_closed_at'
       ])
       or (item - array[
         'schema', 'receipt_id', 'session_id',
         'provider_connection_epoch', 'websocket_close_observed',
         'websocket_close_code', 'websocket_closed_at'
       ]) is distinct from '{}'::jsonb
       or item ->> 'schema' is distinct from
         'sophia_gemini_browser_provider_close_v1'
       or item ->> 'session_id' is distinct from p_provider_session_id
       or length(item ->> 'session_id') not between 1 and 128
       or jsonb_typeof(item -> 'provider_connection_epoch')
         is distinct from 'number'
       or (item ->> 'provider_connection_epoch' ~ '^[1-9][0-9]*$')
         is distinct from true
       or item -> 'websocket_close_observed' is distinct from 'true'::jsonb
       or jsonb_typeof(item -> 'websocket_close_code')
         is distinct from 'number'
       or (item ->> 'websocket_close_code' ~ '^[0-9]+$')
         is distinct from true
       or (item ->> 'websocket_closed_at' ~
         '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
         is distinct from true then
      return jsonb_build_object('valid', false);
    end if;
    begin
      if (item ->> 'receipt_id')::uuid::text is distinct from
           item ->> 'receipt_id'
         or (item ->> 'websocket_close_code')::integer not between 1000 and 4999
      then
        return jsonb_build_object('valid', false);
      end if;
      perform (item ->> 'websocket_closed_at')::timestamptz;
      item_epoch := (item ->> 'provider_connection_epoch')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range
        or invalid_datetime_format or datetime_field_overflow then
        return jsonb_build_object('valid', false);
    end;
    if item_epoch <= previous_epoch then
      return jsonb_build_object('valid', false);
    end if;
    close_epochs := array_append(close_epochs, item_epoch);
    previous_epoch := item_epoch;
  end loop;

  previous_epoch := 0;
  for item in select value from jsonb_array_elements(abort_receipts) loop
    if jsonb_typeof(item) is distinct from 'object'
       or not (item ?& array[
         'schema', 'receipt_id', 'session_id', 'previous_activated_epoch',
         'candidate_epoch', 'websocket_created', 'aborted_at'
       ])
       or (item - array[
         'schema', 'receipt_id', 'session_id', 'previous_activated_epoch',
         'candidate_epoch', 'websocket_created', 'aborted_at'
       ]) is distinct from '{}'::jsonb
       or item ->> 'schema' is distinct from
         'sophia_gemini_browser_provider_activation_abort_v1'
       or item ->> 'session_id' is distinct from p_provider_session_id
       or length(item ->> 'session_id') not between 1 and 128
       or jsonb_typeof(item -> 'previous_activated_epoch')
         is distinct from 'number'
       or (item ->> 'previous_activated_epoch' ~ '^(0|[1-9][0-9]*)$')
         is distinct from true
       or jsonb_typeof(item -> 'candidate_epoch')
         is distinct from 'number'
       or (item ->> 'candidate_epoch' ~ '^[1-9][0-9]*$')
         is distinct from true
       or item -> 'websocket_created' is distinct from 'false'::jsonb
       or (item ->> 'aborted_at' ~
         '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
         is distinct from true then
      return jsonb_build_object('valid', false);
    end if;
    begin
      if (item ->> 'receipt_id')::uuid::text is distinct from
           item ->> 'receipt_id'
         or (item ->> 'candidate_epoch')::integer is distinct from
           (item ->> 'previous_activated_epoch')::integer + 1
      then
        return jsonb_build_object('valid', false);
      end if;
      perform (item ->> 'aborted_at')::timestamptz;
      item_epoch := (item ->> 'candidate_epoch')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range
        or invalid_datetime_format or datetime_field_overflow then
        return jsonb_build_object('valid', false);
    end;
    if item_epoch <= previous_epoch
       or item_epoch = any(close_epochs) then
      return jsonb_build_object('valid', false);
    end if;
    abort_epochs := array_append(abort_epochs, item_epoch);
    previous_epoch := item_epoch;
  end loop;

  select coalesce(jsonb_agg(epoch order by epoch), '[]'::jsonb)
    into exact_epochs
    from (
      select unnest(close_epochs || abort_epochs) as epoch
    ) all_epochs;
  settlement_sha256 := encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      public.sophia_voice_lab_d02_canonical_json(jsonb_build_object(
        'browser_provider_close_receipts', close_receipts,
        'browser_provider_activation_abort_receipts', abort_receipts
      )),
      'UTF8'
    )),
    'hex'
  );
  return jsonb_build_object(
    'valid', true,
    'epochs', exact_epochs,
    'settlement_sha256', settlement_sha256
  );
exception
  when others then
    return jsonb_build_object('valid', false);
end;
$$;

create or replace function public.sophia_voice_lab_d02_voice_terminal_authorize(
  p_cleanup_obligation_id text,
  p_provider_admission_id uuid,
  p_provider_session_id text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  candidate_row record;
  admission_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  begin
    select settlement.freeze_binding, settlement.voice_terminal_receipt,
           session.metadata, obligation.state,
           obligation.provider_settlement_sha256
      into strict candidate_row
      from public.sophia_voice_lab_d02_gateway_settlements settlement
      join public.sophia_voice_lab_cleanup_obligations obligation
        on obligation.cleanup_obligation_id = settlement.cleanup_obligation_id
      join public.sophia_sessions session
        on session.metadata -> 'synthetic_voice_lab'
             ->> 'cleanup_obligation_id' = settlement.cleanup_obligation_id
     where settlement.cleanup_obligation_id = p_cleanup_obligation_id
       and settlement.provider_admission_id = p_provider_admission_id
       and settlement.provider_session_id = p_provider_session_id
     for update of settlement, obligation, session;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'binding_unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  if candidate_row.voice_terminal_receipt is not null then
    return jsonb_build_object(
      'status', 'existing',
      'freeze_binding', candidate_row.freeze_binding,
      'voice_terminal_receipt', candidate_row.voice_terminal_receipt,
      'metadata', candidate_row.metadata,
      'obligation_state', candidate_row.state,
      'provider_settlement_sha256',
        candidate_row.provider_settlement_sha256,
      'admission_status', null
    );
  end if;
  begin
    select admission.status
      into strict admission_status
      from public.sophia_voice_lab_cleanup_admissions admission
     where admission.cleanup_obligation_id = p_cleanup_obligation_id
       and admission.admission_id = p_provider_admission_id
       and admission.resource_kind = 'provider'
       and admission.resource_id = p_provider_session_id
     for update;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'binding_unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  return jsonb_build_object(
    'status', 'candidate',
    'freeze_binding', candidate_row.freeze_binding,
    'voice_terminal_receipt', candidate_row.voice_terminal_receipt,
    'metadata', candidate_row.metadata,
    'obligation_state', candidate_row.state,
    'provider_settlement_sha256',
      candidate_row.provider_settlement_sha256,
    'admission_status', admission_status
  );
end;
$$;

drop function if exists public.sophia_voice_lab_d02_voice_terminal_finalize(
  text, uuid, text, text, jsonb
);
create or replace function public.sophia_voice_lab_d02_voice_terminal_finalize(
  p_cleanup_obligation_id text,
  p_provider_admission_id uuid,
  p_provider_session_id text,
  p_receipt_sha256 text,
  p_receipt jsonb,
  p_authority_key_id text,
  p_finalize_proof_sha256 text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  candidate_row record;
  admission_status text;
  synthetic jsonb;
  browser_settlement jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  if public.sophia_voice_lab_d02_finalize_proof_valid(
    p_authority_key_id,
    'voice_terminal_finalize_v1',
    jsonb_build_array(
      p_cleanup_obligation_id,
      p_provider_admission_id::text,
      p_provider_session_id
    ),
    p_receipt,
    p_finalize_proof_sha256
  ) is distinct from true then
    return jsonb_build_object('status', 'finalize_proof_invalid');
  end if;
  begin
    select settlement.voice_terminal_receipt,
           settlement.voice_terminal_receipt_sha256,
           settlement.freeze_binding,
           obligation.state, obligation.provider_settlement_sha256,
           session.metadata
      into strict candidate_row
      from public.sophia_voice_lab_d02_gateway_settlements settlement
      join public.sophia_voice_lab_cleanup_obligations obligation
        on obligation.cleanup_obligation_id = settlement.cleanup_obligation_id
      join public.sophia_sessions session
        on session.metadata -> 'synthetic_voice_lab'
             ->> 'cleanup_obligation_id' = settlement.cleanup_obligation_id
     where settlement.cleanup_obligation_id = p_cleanup_obligation_id
       and settlement.provider_admission_id = p_provider_admission_id
       and settlement.provider_session_id = p_provider_session_id
     for update of settlement, obligation, session;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'binding_unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  if candidate_row.voice_terminal_receipt is not null then
    if candidate_row.voice_terminal_receipt is not distinct from p_receipt
       and candidate_row.voice_terminal_receipt_sha256 is not distinct from
         p_receipt_sha256
       and (p_receipt_sha256 ~ '^[a-f0-9]{64}$') is not distinct from true
       and p_receipt_sha256 is not distinct from encode(
         pg_catalog.sha256(pg_catalog.convert_to(
           public.sophia_voice_lab_d02_canonical_json(
             p_receipt - array['receipt_sha256', 'signature']
           ),
           'UTF8'
         )),
         'hex'
       )
       and candidate_row.voice_terminal_receipt_sha256 is not distinct from
         encode(
           pg_catalog.sha256(pg_catalog.convert_to(
             public.sophia_voice_lab_d02_canonical_json(
               candidate_row.voice_terminal_receipt -
                 array['receipt_sha256', 'signature']
             ),
             'UTF8'
           )),
           'hex'
         ) then
      return jsonb_build_object('status', 'replay');
    end if;
    return jsonb_build_object('status', 'replay_conflict');
  end if;
  begin
    select admission.status
      into strict admission_status
      from public.sophia_voice_lab_cleanup_admissions admission
     where admission.cleanup_obligation_id = p_cleanup_obligation_id
       and admission.admission_id = p_provider_admission_id
       and admission.resource_kind = 'provider'
       and admission.resource_id = p_provider_session_id
     for update;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'binding_unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  synthetic := candidate_row.metadata -> 'synthetic_voice_lab';
  browser_settlement := public.sophia_voice_lab_d02_browser_settlement(
    candidate_row.metadata,
    p_provider_session_id
  );
  if candidate_row.state is distinct from 'closed'
     or synthetic -> 'synthetic' is distinct from 'true'::jsonb
     or synthetic ->> 'scenario_id' is distinct from 'V-D02'
     or admission_status not in (
       'credential_minted', 'browser_active',
       'activation_aborted', 'browser_closed'
     )
     or admission_status is null
     or p_receipt ->> 'schema' is distinct from
       'sophia_voice_lab_voice_provider_terminal_v1'
     or p_receipt ->> 'cleanup_obligation_id' is distinct from
       p_cleanup_obligation_id
     or p_receipt ->> 'provider_admission_id' is distinct from
       p_provider_admission_id::text
     or p_receipt ->> 'provider_session_id' is distinct from
       p_provider_session_id
     or (p_receipt_sha256 ~ '^[a-f0-9]{64}$') is distinct from true
     or p_receipt_sha256 is distinct from encode(
       pg_catalog.sha256(pg_catalog.convert_to(
         public.sophia_voice_lab_d02_canonical_json(
           p_receipt - array['receipt_sha256', 'signature']
         ),
         'UTF8'
       )),
       'hex'
     )
     or (
       admission_status in ('activation_aborted', 'browser_closed')
       and (
         synthetic ->> 'voice_provider_resource_state'
           is distinct from 'closed'
         or candidate_row.provider_settlement_sha256 is null
         or browser_settlement -> 'valid' is distinct from 'true'::jsonb
         or browser_settlement -> 'epochs' is distinct from
           candidate_row.freeze_binding ->
             'frozen_provider_connection_epochs'
         or browser_settlement ->> 'settlement_sha256' is distinct from
           candidate_row.provider_settlement_sha256
       )
     )
  then
    return jsonb_build_object('status', 'binding_mismatch');
  end if;
  update public.sophia_voice_lab_d02_gateway_settlements
     set voice_terminal_receipt_sha256 = p_receipt_sha256,
         voice_terminal_receipt = p_receipt,
         voice_terminal_at = clock_timestamp()
   where cleanup_obligation_id = p_cleanup_obligation_id
     and provider_admission_id = p_provider_admission_id
     and provider_session_id = p_provider_session_id
     and voice_terminal_receipt is null;
  if not found then
    return jsonb_build_object('status', 'write_conflict');
  end if;
  return jsonb_build_object('status', 'created');
end;
$$;

create or replace function public.sophia_voice_lab_d02_settlement_authorize(
  p_cleanup_obligation_id text,
  p_termination_request_id_sha256 text,
  p_request_sha256 text,
  p_capability_jti_sha256 text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  settlement_row record;
  candidate_row record;
  relay_zero boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  if public.sophia_voice_lab_d02_register_capability_use(
    p_capability_jti_sha256, 'settle', p_request_sha256,
    p_cleanup_obligation_id, p_termination_request_id_sha256
  ) is distinct from true then
    return jsonb_build_object('status', 'capability_replay_conflict');
  end if;
  select settlement.freeze_binding, settlement.provider_session_id,
         settlement.provider_admission_id::text as provider_admission_id,
         settlement.settlement_request_sha256,
         settlement.settlement_capability_jti_sha256,
         settlement.receipt, settlement.voice_terminal_receipt,
         settlement.freeze_request_sha256
    into settlement_row
    from public.sophia_voice_lab_d02_gateway_settlements settlement
   where settlement.cleanup_obligation_id = p_cleanup_obligation_id
     and settlement.termination_request_id_sha256 =
         p_termination_request_id_sha256
   for update;
  if not found then
    return jsonb_build_object('status', 'freeze_required');
  end if;
  if settlement_row.receipt is not null then
    return jsonb_build_object(
      'status', 'existing',
      'settlement_request_sha256', settlement_row.settlement_request_sha256,
      'receipt', settlement_row.receipt
    );
  end if;

  begin
    select session.user_id, session.run_id, session.metadata,
           obligation.state,
           obligation.provider_settlement_sha256,
           admission.status as admission_status,
           admission.admission_id::text as admission_id,
           to_char(
             clock_timestamp() at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           ) as database_now
      into strict candidate_row
      from public.sophia_sessions session
      join public.sophia_voice_lab_cleanup_obligations obligation
        on obligation.cleanup_obligation_id = p_cleanup_obligation_id
      join public.sophia_voice_lab_cleanup_admissions admission
        on admission.cleanup_obligation_id = obligation.cleanup_obligation_id
       and admission.resource_kind = 'provider'
       and admission.admission_id = settlement_row.provider_admission_id::uuid
       and admission.resource_id = settlement_row.provider_session_id
     where session.metadata -> 'synthetic_voice_lab'
             ->> 'cleanup_obligation_id' = p_cleanup_obligation_id
     for update of session, obligation, admission;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'session_unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  select not exists (
           select 1
             from public.sophia_voice_lab_d02_gateway_relay_leases relay
            where relay.cleanup_obligation_id = p_cleanup_obligation_id
         ) into relay_zero;
  return jsonb_build_object(
    'status', 'candidate',
    'freeze_binding', settlement_row.freeze_binding,
    'provider_session_id', settlement_row.provider_session_id,
    'provider_admission_id', settlement_row.provider_admission_id,
    'voice_terminal_receipt', settlement_row.voice_terminal_receipt,
    'freeze_request_sha256', settlement_row.freeze_request_sha256,
    'user_id', candidate_row.user_id,
    'run_id', candidate_row.run_id,
    'metadata', candidate_row.metadata,
    'obligation_state', candidate_row.state,
    'provider_settlement_sha256',
      candidate_row.provider_settlement_sha256,
    'admission_status', candidate_row.admission_status,
    'admission_id', candidate_row.admission_id,
    'database_now', candidate_row.database_now,
    'relay_zero', relay_zero
  );
end;
$$;

drop function if exists public.sophia_voice_lab_d02_settlement_finalize(
  text, text, text, uuid, text, text, text, jsonb, text, jsonb
);
create or replace function public.sophia_voice_lab_d02_settlement_finalize(
  p_cleanup_obligation_id text,
  p_termination_request_id_sha256 text,
  p_provider_session_id text,
  p_provider_admission_id uuid,
  p_request_sha256 text,
  p_capability_jti_sha256 text,
  p_provider_settlement_sha256 text,
  p_next_metadata jsonb,
  p_receipt_sha256 text,
  p_receipt jsonb,
  p_authority_key_id text,
  p_finalize_proof_sha256 text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  candidate_row record;
  existing_receipt jsonb;
  existing_request text;
  existing_provider_settlement text;
  existing_receipt_sha256 text;
  existing_voice_receipt jsonb;
  synthetic jsonb;
  expected_synthetic jsonb;
  expected_metadata jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  if public.sophia_voice_lab_d02_finalize_proof_valid(
    p_authority_key_id,
    'settlement_finalize_v1',
    jsonb_build_array(
      p_cleanup_obligation_id,
      p_termination_request_id_sha256,
      p_provider_session_id,
      p_provider_admission_id::text,
      p_request_sha256,
      p_capability_jti_sha256,
      p_provider_settlement_sha256
    ),
    p_receipt,
    p_finalize_proof_sha256
  ) is distinct from true then
    return jsonb_build_object('status', 'finalize_proof_invalid');
  end if;
  if not exists (
    select 1
      from public.sophia_voice_lab_d02_gateway_capability_uses capability
     where capability.capability_jti_sha256 = p_capability_jti_sha256
       and capability.operation = 'settle'
       and capability.request_sha256 = p_request_sha256
       and capability.cleanup_obligation_id = p_cleanup_obligation_id
       and capability.termination_request_id_sha256 =
           p_termination_request_id_sha256
  ) then
    return jsonb_build_object('status', 'capability_prepare_required');
  end if;
  select settlement.receipt, settlement.settlement_request_sha256,
         settlement.provider_settlement_sha256,
         settlement.receipt_sha256,
         settlement.voice_terminal_receipt
    into existing_receipt, existing_request,
         existing_provider_settlement, existing_receipt_sha256,
         existing_voice_receipt
    from public.sophia_voice_lab_d02_gateway_settlements settlement
   where settlement.cleanup_obligation_id = p_cleanup_obligation_id
     and settlement.termination_request_id_sha256 =
         p_termination_request_id_sha256
     and settlement.provider_session_id = p_provider_session_id
     and settlement.provider_admission_id = p_provider_admission_id
   for update;
  if not found then
    return jsonb_build_object('status', 'freeze_required');
  end if;
  if existing_receipt is not null then
    if existing_request is not distinct from p_request_sha256
       and existing_provider_settlement is not distinct from
         p_provider_settlement_sha256
       and existing_receipt_sha256 is not distinct from p_receipt_sha256
       and existing_receipt is not distinct from p_receipt
       and (p_receipt_sha256 ~ '^[a-f0-9]{64}$') is not distinct from true
       and p_receipt_sha256 is not distinct from encode(
         pg_catalog.sha256(pg_catalog.convert_to(
           public.sophia_voice_lab_d02_canonical_json(p_receipt), 'UTF8'
         )),
         'hex'
       )
       and existing_receipt_sha256 is not distinct from encode(
         pg_catalog.sha256(pg_catalog.convert_to(
           public.sophia_voice_lab_d02_canonical_json(existing_receipt),
           'UTF8'
         )),
         'hex'
       ) then
      return jsonb_build_object('status', 'replay');
    end if;
    return jsonb_build_object('status', 'replay_conflict');
  end if;

  begin
    select session.id, session.metadata,
           obligation.state, obligation.provider_settlement_sha256,
           admission.status as admission_status,
           settlement.voice_terminal_receipt
      into strict candidate_row
      from public.sophia_voice_lab_d02_gateway_settlements settlement
      join public.sophia_voice_lab_cleanup_obligations obligation
        on obligation.cleanup_obligation_id = settlement.cleanup_obligation_id
      join public.sophia_voice_lab_cleanup_admissions admission
        on admission.cleanup_obligation_id = settlement.cleanup_obligation_id
       and admission.admission_id = settlement.provider_admission_id
       and admission.resource_kind = 'provider'
       and admission.resource_id = settlement.provider_session_id
      join public.sophia_sessions session
        on session.metadata -> 'synthetic_voice_lab'
             ->> 'cleanup_obligation_id' = settlement.cleanup_obligation_id
     where settlement.cleanup_obligation_id = p_cleanup_obligation_id
       and settlement.termination_request_id_sha256 =
           p_termination_request_id_sha256
       and settlement.provider_session_id = p_provider_session_id
       and settlement.provider_admission_id = p_provider_admission_id
     for update of settlement, obligation, admission, session;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'session_unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  synthetic := candidate_row.metadata -> 'synthetic_voice_lab';
  expected_synthetic := synthetic || jsonb_build_object(
    'voice_d02_voice_terminal_receipt',
      candidate_row.voice_terminal_receipt,
    'voice_d02_gateway_provider_settlement_sha256',
      p_provider_settlement_sha256
  );
  expected_metadata := jsonb_set(
    candidate_row.metadata,
    array['synthetic_voice_lab'],
    expected_synthetic,
    false
  );
  if candidate_row.state is distinct from 'closed'
     or candidate_row.provider_settlement_sha256 is distinct from
       p_provider_settlement_sha256
     or candidate_row.admission_status not in (
       'activation_aborted', 'browser_closed'
     )
     or candidate_row.admission_status is null
     or candidate_row.voice_terminal_receipt is null
     or synthetic -> 'synthetic' is distinct from 'true'::jsonb
     or synthetic ->> 'scenario_id' is distinct from 'V-D02'
     or synthetic ->> 'cleanup_obligation_id' is distinct from
       p_cleanup_obligation_id
     or synthetic ->> 'voice_runtime_session_id' is distinct from
       p_provider_session_id
     or synthetic ->> 'voice_provider_resource_state' is distinct from 'closed'
     or p_next_metadata is distinct from expected_metadata
     or exists (
       select 1
         from public.sophia_voice_lab_d02_gateway_relay_leases relay
        where relay.cleanup_obligation_id = p_cleanup_obligation_id
     )
     or (p_receipt_sha256 ~ '^[a-f0-9]{64}$') is distinct from true
     or p_receipt_sha256 is distinct from encode(
       pg_catalog.sha256(pg_catalog.convert_to(
         public.sophia_voice_lab_d02_canonical_json(p_receipt), 'UTF8'
       )),
       'hex'
     )
     or p_receipt ->> 'schema' is distinct from
       'sophia_voice_lab_gateway_browser_worker_termination_settlement_v1'
     or p_receipt ->> 'termination_request_id_sha256' is distinct from
       p_termination_request_id_sha256
     or p_receipt ->> 'provider_session_id_sha256' is distinct from
       encode(pg_catalog.sha256(pg_catalog.convert_to(
         p_provider_session_id, 'UTF8'
       )), 'hex')
     or p_receipt ->> 'provider_admission_id_sha256' is distinct from
       encode(pg_catalog.sha256(pg_catalog.convert_to(
         p_provider_admission_id::text, 'UTF8'
       )), 'hex')
     or p_receipt ->> 'provider_settlement_sha256' is distinct from
       p_provider_settlement_sha256
  then
    return jsonb_build_object('status', 'binding_mismatch');
  end if;

  update public.sophia_sessions
     set metadata = p_next_metadata, updated_at = clock_timestamp()
   where id = candidate_row.id;
  if not found then
    return jsonb_build_object('status', 'session_conflict');
  end if;
  delete from public.sophia_voice_lab_cleanup_admissions
   where admission_id = p_provider_admission_id
     and cleanup_obligation_id = p_cleanup_obligation_id
     and resource_kind = 'provider'
     and resource_id = p_provider_session_id
     and status in ('activation_aborted', 'browser_closed');
  if not found then
    return jsonb_build_object('status', 'admission_conflict');
  end if;
  update public.sophia_voice_lab_d02_gateway_settlements
     set settlement_request_sha256 = p_request_sha256,
         settlement_capability_jti_sha256 = p_capability_jti_sha256,
         provider_settlement_sha256 = p_provider_settlement_sha256,
         receipt_sha256 = p_receipt_sha256,
         receipt = p_receipt,
         settled_at = clock_timestamp()
   where cleanup_obligation_id = p_cleanup_obligation_id
     and termination_request_id_sha256 = p_termination_request_id_sha256
     and settlement_request_sha256 is null and receipt is null;
  if not found then
    return jsonb_build_object('status', 'settlement_conflict');
  end if;
  return jsonb_build_object('status', 'created');
end;
$$;

drop function if exists public.sophia_voice_lab_d02_relay_begin(
  uuid, text, text, integer, text, text, integer
);
create or replace function public.sophia_voice_lab_d02_relay_begin(
  p_relay_id uuid,
  p_cleanup_obligation_id text,
  p_provider_session_id text,
  p_provider_connection_epoch integer,
  p_relay_kind text,
  p_owner_instance_id_sha256 text,
  p_lease_seconds integer,
  p_authority_key_id text,
  p_operation_proof_sha256 text
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  candidate_row record;
  capability_state text;
  action_sha256 text;
  relay_request_id_sha256 text;
begin
  if p_provider_connection_epoch is null
     or p_provider_connection_epoch <= 0
     or p_relay_kind not in ('provider_event', 'event_stream')
     or p_relay_kind is null
     or p_lease_seconds is null
     or p_lease_seconds < 3 or p_lease_seconds > 300
     or (p_owner_instance_id_sha256 ~ '^[a-f0-9]{64}$')
       is distinct from true
     or public.sophia_voice_lab_d02_finalize_proof_valid(
       p_authority_key_id,
       'relay_begin_v1',
       jsonb_build_array(
         p_cleanup_obligation_id,
         p_relay_id::text,
         p_provider_session_id,
         p_provider_connection_epoch::text,
         p_relay_kind,
         p_owner_instance_id_sha256,
         p_lease_seconds::text
       ),
       '{}'::jsonb,
       p_operation_proof_sha256
     ) is distinct from true then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  action_sha256 := encode(pg_catalog.sha256(pg_catalog.convert_to(
    public.sophia_voice_lab_d02_canonical_json(jsonb_build_object(
      'cleanup_obligation_id', p_cleanup_obligation_id,
      'lease_seconds', p_lease_seconds,
      'owner_instance_id_sha256', p_owner_instance_id_sha256,
      'provider_connection_epoch', p_provider_connection_epoch,
      'provider_session_id', p_provider_session_id,
      'relay_id', p_relay_id::text,
      'relay_kind', p_relay_kind
    )), 'UTF8'
  )), 'hex');
  relay_request_id_sha256 := encode(pg_catalog.sha256(
    pg_catalog.convert_to(p_relay_id::text, 'UTF8')
  ), 'hex');
  capability_state :=
    public.sophia_voice_lab_d02_register_capability_use_state(
    p_operation_proof_sha256, 'relay_begin', action_sha256,
    p_cleanup_obligation_id, relay_request_id_sha256
  );
  if capability_state is distinct from 'created'
     and capability_state is distinct from 'replay' then
    return false;
  end if;
  if capability_state = 'replay' then
    return exists (
      select 1
        from public.sophia_voice_lab_d02_gateway_relay_leases relay
       where relay.relay_id = p_relay_id
         and relay.cleanup_obligation_id = p_cleanup_obligation_id
         and relay.provider_session_id = p_provider_session_id
         and relay.provider_connection_epoch = p_provider_connection_epoch
         and relay.relay_kind = p_relay_kind
         and relay.owner_instance_id_sha256 = p_owner_instance_id_sha256
         and relay.expires_at > clock_timestamp()
    );
  end if;
  begin
    select obligation.cleanup_obligation_id
      into strict candidate_row
      from public.sophia_voice_lab_cleanup_obligations obligation
      join public.sophia_voice_lab_cleanup_admissions admission
        on admission.cleanup_obligation_id = obligation.cleanup_obligation_id
       and admission.resource_kind = 'provider'
       and admission.resource_id = p_provider_session_id
       and (
         admission.status = 'browser_active'
         or (p_relay_kind = 'event_stream'
             and admission.status = 'credential_minted')
       )
      join public.sophia_sessions session
        on session.metadata -> 'synthetic_voice_lab'
             ->> 'cleanup_obligation_id' = obligation.cleanup_obligation_id
     where obligation.cleanup_obligation_id = p_cleanup_obligation_id
       and obligation.state = 'open'
       and session.metadata -> 'synthetic_voice_lab' -> 'synthetic' =
         'true'::jsonb
       and session.metadata -> 'synthetic_voice_lab' ->> 'scenario_id' =
         'V-D02'
       and p_provider_connection_epoch in (
         (session.metadata -> 'synthetic_voice_lab'
           ->> 'voice_provider_connection_epoch')::integer,
         (session.metadata -> 'synthetic_voice_lab'
           ->> 'voice_provider_pending_connection_epoch')::integer
       )
       and not exists (
         select 1
           from public.sophia_voice_lab_d02_gateway_settlements settlement
          where settlement.cleanup_obligation_id =
                obligation.cleanup_obligation_id
       )
     for update of obligation, admission, session;
  exception
    when no_data_found or too_many_rows then
      return false;
  end;
  insert into public.sophia_voice_lab_d02_gateway_relay_leases (
    relay_id, cleanup_obligation_id, provider_session_id,
    provider_connection_epoch, relay_kind, owner_instance_id_sha256,
    expires_at
  ) values (
    p_relay_id, p_cleanup_obligation_id, p_provider_session_id,
    p_provider_connection_epoch, p_relay_kind, p_owner_instance_id_sha256,
    clock_timestamp() + make_interval(secs => p_lease_seconds)
  );
  return true;
exception
  when unique_violation then
    return false;
end;
$$;

drop function if exists public.sophia_voice_lab_d02_relay_refresh(
  uuid, text, integer
);
drop function if exists public.sophia_voice_lab_d02_relay_refresh(
  uuid, text, text, integer, bigint, text, text
);
create or replace function public.sophia_voice_lab_d02_relay_refresh(
  p_relay_id uuid,
  p_cleanup_obligation_id text,
  p_owner_instance_id_sha256 text,
  p_lease_seconds integer,
  p_operation_id_sha256 text,
  p_authority_key_id text,
  p_operation_proof_sha256 text
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  capability_state text;
  action_sha256 text;
  relay_request_id_sha256 text;
begin
  if p_lease_seconds is null
     or p_lease_seconds < 3 or p_lease_seconds > 300
     or (p_operation_id_sha256 ~ '^[a-f0-9]{64}$')
       is distinct from true
     or (p_owner_instance_id_sha256 ~ '^[a-f0-9]{64}$')
       is distinct from true
     or public.sophia_voice_lab_d02_finalize_proof_valid(
       p_authority_key_id,
       'relay_refresh_v1',
       jsonb_build_array(
         p_cleanup_obligation_id,
         p_relay_id::text,
         p_owner_instance_id_sha256,
         p_lease_seconds::text,
         p_operation_id_sha256
       ),
       '{}'::jsonb,
       p_operation_proof_sha256
     ) is distinct from true then
    return false;
  end if;
  action_sha256 := encode(pg_catalog.sha256(pg_catalog.convert_to(
    public.sophia_voice_lab_d02_canonical_json(jsonb_build_object(
      'cleanup_obligation_id', p_cleanup_obligation_id,
      'lease_seconds', p_lease_seconds,
      'operation_id_sha256', p_operation_id_sha256,
      'owner_instance_id_sha256', p_owner_instance_id_sha256,
      'relay_id', p_relay_id::text
    )), 'UTF8'
  )), 'hex');
  relay_request_id_sha256 := encode(pg_catalog.sha256(
    pg_catalog.convert_to(p_relay_id::text, 'UTF8')
  ), 'hex');
  capability_state :=
    public.sophia_voice_lab_d02_register_capability_use_state(
    p_operation_id_sha256, 'relay_refresh', action_sha256,
    p_cleanup_obligation_id, relay_request_id_sha256
  );
  if capability_state is distinct from 'created'
     and capability_state is distinct from 'replay' then
    return false;
  end if;
  if capability_state = 'replay' then
    return exists (
      select 1
        from public.sophia_voice_lab_d02_gateway_relay_leases relay
       where relay.relay_id = p_relay_id
         and relay.cleanup_obligation_id = p_cleanup_obligation_id
         and relay.owner_instance_id_sha256 = p_owner_instance_id_sha256
         and relay.expires_at > clock_timestamp()
    );
  end if;
  update public.sophia_voice_lab_d02_gateway_relay_leases
     set expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   where relay_id = p_relay_id
     and cleanup_obligation_id = p_cleanup_obligation_id
     and owner_instance_id_sha256 = p_owner_instance_id_sha256
     and expires_at > clock_timestamp();
  return found;
end;
$$;

drop function if exists public.sophia_voice_lab_d02_relay_end(
  uuid, text
);
drop function if exists public.sophia_voice_lab_d02_relay_end(
  uuid, text, text, bigint, text, text
);
create or replace function public.sophia_voice_lab_d02_relay_end(
  p_relay_id uuid,
  p_cleanup_obligation_id text,
  p_owner_instance_id_sha256 text,
  p_operation_id_sha256 text,
  p_authority_key_id text,
  p_operation_proof_sha256 text
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  capability_state text;
  action_sha256 text;
  relay_request_id_sha256 text;
begin
  if (p_operation_id_sha256 ~ '^[a-f0-9]{64}$')
       is distinct from true
     or (p_owner_instance_id_sha256 ~ '^[a-f0-9]{64}$')
       is distinct from true
     or public.sophia_voice_lab_d02_finalize_proof_valid(
       p_authority_key_id,
       'relay_end_v1',
       jsonb_build_array(
         p_cleanup_obligation_id,
         p_relay_id::text,
         p_owner_instance_id_sha256,
         p_operation_id_sha256
       ),
       '{}'::jsonb,
       p_operation_proof_sha256
     ) is distinct from true then
    return false;
  end if;
  action_sha256 := encode(pg_catalog.sha256(pg_catalog.convert_to(
    public.sophia_voice_lab_d02_canonical_json(jsonb_build_object(
      'cleanup_obligation_id', p_cleanup_obligation_id,
      'operation_id_sha256', p_operation_id_sha256,
      'owner_instance_id_sha256', p_owner_instance_id_sha256,
      'relay_id', p_relay_id::text
    )), 'UTF8'
  )), 'hex');
  relay_request_id_sha256 := encode(pg_catalog.sha256(
    pg_catalog.convert_to(p_relay_id::text, 'UTF8')
  ), 'hex');
  capability_state :=
    public.sophia_voice_lab_d02_register_capability_use_state(
    p_operation_id_sha256, 'relay_end', action_sha256,
    p_cleanup_obligation_id, relay_request_id_sha256
  );
  if capability_state is distinct from 'created'
     and capability_state is distinct from 'replay' then
    return false;
  end if;
  if capability_state = 'replay' then
    return not exists (
      select 1
        from public.sophia_voice_lab_d02_gateway_relay_leases relay
       where relay.relay_id = p_relay_id
    );
  end if;
  delete from public.sophia_voice_lab_d02_gateway_relay_leases
   where relay_id = p_relay_id
     and cleanup_obligation_id = p_cleanup_obligation_id
     and owner_instance_id_sha256 = p_owner_instance_id_sha256;
  if found then
    return true;
  end if;
  return false;
end;
$$;

drop function if exists public.sophia_voice_lab_d02_continuity_authorize(
  text, text, text, text, text
);
create or replace function public.sophia_voice_lab_d02_continuity_authorize(
  p_cleanup_obligation_id text,
  p_restart_request_id_sha256 text,
  p_phase text,
  p_request_sha256 text,
  p_capability_jti_sha256 text,
  p_observed_at timestamptz
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  existing_row record;
  candidate_row record;
  before_receipt jsonb;
  freshness_now timestamptz;
begin
  if p_phase is null
     or p_phase not in ('before_api_restart', 'after_api_restart') then
    return jsonb_build_object('status', 'phase_invalid');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  select observation.request_sha256,
         observation.product_service_boot_id_sha256,
         observation.render_action_request_sha256,
         observation.prior_observation_receipt_sha256,
         observation.receipt_sha256,
         observation.receipt
    into existing_row
    from public.sophia_voice_lab_d02_product_continuity_observations observation
   where observation.cleanup_obligation_id = p_cleanup_obligation_id
     and observation.restart_request_id_sha256 = p_restart_request_id_sha256
     and observation.phase = p_phase
   for update;
  if found then
    if public.sophia_voice_lab_d02_register_capability_use(
      p_capability_jti_sha256, 'observe_continuity', p_request_sha256,
      p_cleanup_obligation_id, p_restart_request_id_sha256
    ) is distinct from true then
      return jsonb_build_object('status', 'capability_replay_conflict');
    end if;
    return jsonb_build_object(
      'status', 'existing',
      'request_sha256', existing_row.request_sha256,
      'receipt', existing_row.receipt
    );
  end if;
  freshness_now := clock_timestamp();
  if p_observed_at is null
     or p_observed_at > freshness_now + interval '10 seconds'
     or p_observed_at < freshness_now - interval '5 minutes 10 seconds' then
    return jsonb_build_object('status', 'stale');
  end if;
  if public.sophia_voice_lab_d02_register_capability_use(
    p_capability_jti_sha256, 'observe_continuity', p_request_sha256,
    p_cleanup_obligation_id, p_restart_request_id_sha256
  ) is distinct from true then
    return jsonb_build_object('status', 'capability_replay_conflict');
  end if;
  if p_phase = 'before_api_restart' and exists (
    select 1
      from public.sophia_voice_lab_d02_product_continuity_observations observation
     where observation.cleanup_obligation_id = p_cleanup_obligation_id
       and observation.phase = 'before_api_restart'
  ) then
    return jsonb_build_object('status', 'restart_conflict');
  end if;

  begin
    select session.id, session.thread_id, session.user_id, session.run_id,
           session.status, session.message_revision, session.metadata,
           obligation.state, obligation.lifecycle_phase,
           admission.admission_id::text as admission_id,
           admission.status as admission_status,
           admission.resource_id as admission_resource_id,
           to_char(
             freshness_now at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           ) as database_now
      into strict candidate_row
      from public.sophia_sessions session
      join public.sophia_voice_lab_cleanup_obligations obligation
        on obligation.cleanup_obligation_id = p_cleanup_obligation_id
      join public.sophia_voice_lab_cleanup_admissions admission
        on admission.cleanup_obligation_id = obligation.cleanup_obligation_id
       and admission.resource_kind = 'provider'
     where session.metadata -> 'synthetic_voice_lab'
             ->> 'cleanup_obligation_id' = p_cleanup_obligation_id
       and session.metadata -> 'synthetic_voice_lab' -> 'synthetic' =
         'true'::jsonb
       and session.metadata -> 'synthetic_voice_lab' ->> 'scenario_id' =
         'V-D02'
       and session.status in ('active', 'open', 'paused', 'resumable')
       and obligation.state = 'open'
       and obligation.lifecycle_phase = 'session_provisional'
       and not exists (
         select 1
           from public.sophia_voice_lab_d02_gateway_settlements settlement
          where settlement.cleanup_obligation_id =
                obligation.cleanup_obligation_id
       )
     for update of session, obligation, admission;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  if p_phase = 'after_api_restart' then
    begin
      select observation.receipt
        into strict before_receipt
        from public.sophia_voice_lab_d02_product_continuity_observations observation
       where observation.cleanup_obligation_id = p_cleanup_obligation_id
         and observation.restart_request_id_sha256 = p_restart_request_id_sha256
         and observation.phase = 'before_api_restart'
       for update;
    exception
      when no_data_found then
        return jsonb_build_object('status', 'before_missing');
      when too_many_rows then
        return jsonb_build_object('status', 'binding_cardinality_invalid');
    end;
  end if;
  return jsonb_build_object(
    'status', 'candidate',
    'session_id', candidate_row.id,
    'thread_id', candidate_row.thread_id,
    'user_id', candidate_row.user_id,
    'run_id', candidate_row.run_id,
    'session_status', candidate_row.status,
    'message_revision', candidate_row.message_revision,
    'metadata', candidate_row.metadata,
    'obligation_state', candidate_row.state,
    'lifecycle_phase', candidate_row.lifecycle_phase,
    'admission_id', candidate_row.admission_id,
    'admission_status', candidate_row.admission_status,
    'admission_resource_id', candidate_row.admission_resource_id,
    'database_now', candidate_row.database_now,
    'before_receipt', before_receipt
  );
end;
$$;

drop function if exists public.sophia_voice_lab_d02_continuity_finalize(
  text, text, text, text, text, text, text, text, text, jsonb
);
create or replace function public.sophia_voice_lab_d02_continuity_finalize(
  p_cleanup_obligation_id text,
  p_restart_request_id_sha256 text,
  p_phase text,
  p_request_sha256 text,
  p_capability_jti_sha256 text,
  p_product_service_boot_id_sha256 text,
  p_render_action_request_sha256 text,
  p_prior_observation_receipt_sha256 text,
  p_receipt_sha256 text,
  p_receipt jsonb,
  p_authority_key_id text,
  p_finalize_proof_sha256 text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  existing_row record;
  candidate_row record;
  before_receipt jsonb;
  projection jsonb;
  synthetic jsonb;
begin
  if p_phase is null
     or p_phase not in ('before_api_restart', 'after_api_restart') then
    return jsonb_build_object('status', 'phase_invalid');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_cleanup_obligation_id, 731944)
  );
  if public.sophia_voice_lab_d02_finalize_proof_valid(
    p_authority_key_id,
    'continuity_finalize_v1',
    jsonb_build_array(
      p_cleanup_obligation_id,
      p_restart_request_id_sha256,
      p_phase,
      p_request_sha256,
      p_capability_jti_sha256,
      p_product_service_boot_id_sha256,
      p_render_action_request_sha256,
      coalesce(p_prior_observation_receipt_sha256, '<none>'),
      p_receipt_sha256
    ),
    p_receipt,
    p_finalize_proof_sha256
  ) is distinct from true then
    return jsonb_build_object('status', 'finalize_proof_invalid');
  end if;
  if not exists (
    select 1
      from public.sophia_voice_lab_d02_gateway_capability_uses capability
     where capability.capability_jti_sha256 = p_capability_jti_sha256
       and capability.operation = 'observe_continuity'
       and capability.request_sha256 = p_request_sha256
       and capability.cleanup_obligation_id = p_cleanup_obligation_id
       and capability.termination_request_id_sha256 =
           p_restart_request_id_sha256
  ) then
    return jsonb_build_object('status', 'capability_prepare_required');
  end if;
  select observation.request_sha256,
         observation.product_service_boot_id_sha256,
         observation.render_action_request_sha256,
         observation.prior_observation_receipt_sha256,
         observation.receipt_sha256,
         observation.receipt
    into existing_row
    from public.sophia_voice_lab_d02_product_continuity_observations observation
   where observation.cleanup_obligation_id = p_cleanup_obligation_id
     and observation.restart_request_id_sha256 = p_restart_request_id_sha256
     and observation.phase = p_phase
   for update;
  if found then
    if existing_row.request_sha256 is not distinct from p_request_sha256
       and existing_row.product_service_boot_id_sha256 is not distinct from
         p_product_service_boot_id_sha256
       and existing_row.render_action_request_sha256 is not distinct from
         p_render_action_request_sha256
       and existing_row.prior_observation_receipt_sha256 is not distinct from
         p_prior_observation_receipt_sha256
       and existing_row.receipt_sha256 is not distinct from p_receipt_sha256
       and existing_row.receipt is not distinct from p_receipt
       and (p_receipt_sha256 ~ '^[a-f0-9]{64}$') is not distinct from true
       and p_receipt_sha256 is not distinct from encode(
         pg_catalog.sha256(pg_catalog.convert_to(
           public.sophia_voice_lab_d02_canonical_json(
             p_receipt - array['receipt_sha256', 'signature']
           ),
           'UTF8'
         )),
         'hex'
       )
       and existing_row.receipt_sha256 is not distinct from encode(
         pg_catalog.sha256(pg_catalog.convert_to(
           public.sophia_voice_lab_d02_canonical_json(
             existing_row.receipt - array['receipt_sha256', 'signature']
           ),
           'UTF8'
         )),
         'hex'
       ) then
      return jsonb_build_object('status', 'replay');
    end if;
    return jsonb_build_object('status', 'replay_conflict');
  end if;
  if p_phase = 'before_api_restart' and exists (
    select 1
      from public.sophia_voice_lab_d02_product_continuity_observations observation
     where observation.cleanup_obligation_id = p_cleanup_obligation_id
       and observation.phase = 'before_api_restart'
  ) then
    return jsonb_build_object('status', 'restart_conflict');
  end if;
  begin
    select session.id, session.thread_id, session.user_id, session.run_id,
           session.status, session.message_revision, session.metadata,
           admission.admission_id::text as admission_id,
           admission.status as admission_status,
           admission.resource_id as admission_resource_id
      into strict candidate_row
      from public.sophia_sessions session
      join public.sophia_voice_lab_cleanup_obligations obligation
        on obligation.cleanup_obligation_id = p_cleanup_obligation_id
      join public.sophia_voice_lab_cleanup_admissions admission
        on admission.cleanup_obligation_id = obligation.cleanup_obligation_id
       and admission.resource_kind = 'provider'
     where session.metadata -> 'synthetic_voice_lab'
             ->> 'cleanup_obligation_id' = p_cleanup_obligation_id
       and session.status in ('active', 'open', 'paused', 'resumable')
       and obligation.state = 'open'
       and obligation.lifecycle_phase = 'session_provisional'
       and not exists (
         select 1
           from public.sophia_voice_lab_d02_gateway_settlements settlement
          where settlement.cleanup_obligation_id =
                obligation.cleanup_obligation_id
       )
     for update of session, obligation, admission;
  exception
    when no_data_found then
      return jsonb_build_object('status', 'unavailable');
    when too_many_rows then
      return jsonb_build_object('status', 'binding_cardinality_invalid');
  end;
  synthetic := candidate_row.metadata -> 'synthetic_voice_lab';
  projection := p_receipt -> 'continuity_projection';
  if jsonb_typeof(projection) is distinct from 'object'
     or synthetic -> 'synthetic' is distinct from 'true'::jsonb
     or synthetic ->> 'scenario_id' is distinct from 'V-D02'
     or candidate_row.admission_status is distinct from 'browser_active'
     or candidate_row.admission_resource_id is distinct from
       synthetic ->> 'voice_runtime_session_id'
     or p_receipt ->> 'schema' is distinct from
       'sophia_voice_lab_d02_product_continuity_observation_v1'
     or p_receipt ->> 'phase' is distinct from p_phase
     or p_receipt ->> 'request_sha256' is distinct from p_request_sha256
     or p_receipt ->> 'receipt_sha256' is distinct from p_receipt_sha256
     or p_receipt_sha256 is distinct from encode(
       pg_catalog.sha256(pg_catalog.convert_to(
         public.sophia_voice_lab_d02_canonical_json(
           p_receipt - array['receipt_sha256', 'signature']
         ),
         'UTF8'
       )),
       'hex'
     )
     or p_receipt ->> 'restart_request_id_sha256' is distinct from
       p_restart_request_id_sha256
     or projection ->> 'session_id_sha256' is distinct from
       encode(pg_catalog.sha256(pg_catalog.convert_to(
         candidate_row.id, 'UTF8'
       )), 'hex')
     or projection ->> 'thread_id_sha256' is distinct from
       encode(pg_catalog.sha256(pg_catalog.convert_to(
         candidate_row.thread_id, 'UTF8'
       )), 'hex')
     or projection ->> 'cleanup_obligation_id_sha256' is distinct from
       encode(pg_catalog.sha256(pg_catalog.convert_to(
         p_cleanup_obligation_id, 'UTF8'
       )), 'hex')
     or projection ->> 'provider_session_id_sha256' is distinct from
       encode(pg_catalog.sha256(pg_catalog.convert_to(
         candidate_row.admission_resource_id, 'UTF8'
       )), 'hex')
     or projection ->> 'provider_admission_id_sha256' is distinct from
       encode(pg_catalog.sha256(pg_catalog.convert_to(
         candidate_row.admission_id, 'UTF8'
       )), 'hex')
     or projection ->> 'session_status' is distinct from candidate_row.status
     or (projection ->> 'message_revision')::bigint is distinct from
       candidate_row.message_revision
     or projection ->> 'voice_lab_run_id_sha256' is distinct from
       synthetic ->> 'voice_lab_run_id_sha256'
     or projection ->> 'browser_worker_id_sha256' is distinct from
       synthetic ->> 'browser_worker_id_sha256'
     or (projection ->> 'browser_lease_epoch')::bigint is distinct from
       (synthetic ->> 'browser_lease_epoch')::bigint
     or projection ->> 'browser_context_id_sha256' is distinct from
       synthetic ->> 'browser_context_id_sha256'
     or (projection ->> 'provider_connection_epoch')::integer
       is distinct from
       (synthetic ->> 'voice_provider_connection_epoch')::integer
  then
    return jsonb_build_object('status', 'binding_mismatch');
  end if;
  if p_phase = 'before_api_restart' then
    if p_prior_observation_receipt_sha256 is not null then
      return jsonb_build_object('status', 'phase_chain_conflict');
    end if;
  else
    begin
      select observation.receipt
        into strict before_receipt
        from public.sophia_voice_lab_d02_product_continuity_observations observation
       where observation.cleanup_obligation_id = p_cleanup_obligation_id
         and observation.restart_request_id_sha256 = p_restart_request_id_sha256
         and observation.phase = 'before_api_restart'
       for update;
    exception
      when no_data_found then
        return jsonb_build_object('status', 'before_missing');
      when too_many_rows then
        return jsonb_build_object('status', 'binding_cardinality_invalid');
    end;
    if before_receipt ->> 'receipt_sha256' is distinct from
          p_prior_observation_receipt_sha256
       or before_receipt -> 'continuity_projection'
         is distinct from projection then
      return jsonb_build_object('status', 'continuity_changed');
    end if;
  end if;

  insert into public.sophia_voice_lab_d02_product_continuity_observations (
    cleanup_obligation_id, restart_request_id_sha256, phase,
    request_sha256, capability_jti_sha256,
    product_service_boot_id_sha256, render_action_request_sha256,
    prior_observation_receipt_sha256, receipt_sha256, receipt
  ) values (
    p_cleanup_obligation_id, p_restart_request_id_sha256, p_phase,
    p_request_sha256, p_capability_jti_sha256,
    p_product_service_boot_id_sha256, p_render_action_request_sha256,
    p_prior_observation_receipt_sha256, p_receipt_sha256, p_receipt
  );
  return jsonb_build_object('status', 'created');
end;
$$;

alter table public.sophia_voice_lab_cleanup_scan_cursors
  add column if not exists window_due_at timestamptz;
alter table public.sophia_voice_lab_cleanup_scan_cursors
  add column if not exists window_source text;
alter table public.sophia_voice_lab_cleanup_scan_cursors
  add column if not exists window_cleanup_obligation_id text;
alter table public.sophia_voice_lab_cleanup_scan_cursors
  add column if not exists window_admission_id uuid;
update public.sophia_voice_lab_cleanup_scan_cursors
   set cursor_due_at = null,
       cursor_source = null,
       cursor_cleanup_obligation_id = null,
       cursor_admission_id = null,
       window_due_at = null,
       window_source = null,
       window_cleanup_obligation_id = null,
       window_admission_id = null,
       updated_at = clock_timestamp()
 where window_due_at is null
   and cursor_due_at is not null;
alter table public.sophia_voice_lab_cleanup_scan_cursors
  alter column updated_at set default clock_timestamp();
alter table public.sophia_voice_lab_cleanup_scan_cursors
  drop constraint if exists sophia_voice_lab_cleanup_scan_cursor_name_valid;
alter table public.sophia_voice_lab_cleanup_scan_cursors
  add constraint sophia_voice_lab_cleanup_scan_cursor_name_valid check (
    cursor_name in ('work_v1', 'complete_purge_v1')
  );
alter table public.sophia_voice_lab_cleanup_scan_cursors
  drop constraint if exists sophia_voice_lab_cleanup_scan_cursor_shape_valid;
alter table public.sophia_voice_lab_cleanup_scan_cursors
  add constraint sophia_voice_lab_cleanup_scan_cursor_shape_valid check (
    (
      cursor_due_at is null
      and cursor_source is null
      and cursor_cleanup_obligation_id is null
      and cursor_admission_id is null
      and window_due_at is null
      and window_source is null
      and window_cleanup_obligation_id is null
      and window_admission_id is null
    )
    or (
      cursor_due_at is not null
      and window_due_at is not null
      and cursor_source in ('obligation', 'admission', 'complete')
      and window_source in ('obligation', 'admission', 'complete')
      and cursor_cleanup_obligation_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and window_cleanup_obligation_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and (
        (cursor_name = 'work_v1' and cursor_source = 'obligation'
          and cursor_admission_id is null)
        or (cursor_name = 'work_v1' and cursor_source = 'admission'
          and cursor_admission_id is not null)
        or (cursor_name = 'complete_purge_v1' and cursor_source = 'complete'
          and cursor_admission_id is null)
      )
      and (
        (cursor_name = 'work_v1' and window_source = 'obligation'
          and window_admission_id is null)
        or (cursor_name = 'work_v1' and window_source = 'admission'
          and window_admission_id is not null)
        or (cursor_name = 'complete_purge_v1' and window_source = 'complete'
          and window_admission_id is null)
      )
    )
  );
insert into public.sophia_voice_lab_cleanup_scan_cursors (cursor_name)
values ('work_v1'), ('complete_purge_v1')
on conflict (cursor_name) do nothing;

alter table public.sophia_voice_lab_cleanup_obligations
  add column if not exists completed_at timestamptz;
alter table public.sophia_voice_lab_cleanup_obligations
  add column if not exists live_cleanup_completed_at timestamptz;
alter table public.sophia_voice_lab_cleanup_obligations
  add column if not exists purge_after timestamptz;
alter table public.sophia_voice_lab_cleanup_obligations
  add column if not exists provider_expires_at timestamptz;
alter table public.sophia_voice_lab_cleanup_obligations
  add column if not exists provider_settlement_sha256 text;
alter table public.sophia_voice_lab_cleanup_obligations
  add column if not exists lifecycle_phase text;
do $$
begin
  if exists (
    select 1
      from public.sophia_voice_lab_cleanup_obligations
     where provider_expires_at is null
  ) then
    raise exception 'cleanup obligations require an exact provider deadline before upgrade';
  end if;
end
$$;
alter table public.sophia_voice_lab_cleanup_obligations
  alter column provider_expires_at set not null;
update public.sophia_voice_lab_cleanup_obligations
   set lifecycle_phase = case
     when state = 'open' then 'session_provisional'
     else 'session_provisional'
   end
 where lifecycle_phase is null;
alter table public.sophia_voice_lab_cleanup_obligations
  alter column lifecycle_phase set not null;
alter table public.sophia_voice_lab_cleanup_obligations
  alter column lifecycle_phase set default 'auth_provisional';
alter table public.sophia_voice_lab_cleanup_obligations
  alter column state set default 'open';
alter table public.sophia_voice_lab_cleanup_obligations
  alter column created_at set default clock_timestamp();
alter table public.sophia_voice_lab_cleanup_obligations
  alter column updated_at set default clock_timestamp();
alter table public.sophia_voice_lab_cleanup_obligations
  drop constraint if exists sophia_voice_lab_cleanup_obligation_id_valid;
alter table public.sophia_voice_lab_cleanup_obligations
  add constraint sophia_voice_lab_cleanup_obligation_id_valid check (
    cleanup_obligation_id ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );
alter table public.sophia_voice_lab_cleanup_obligations
  drop constraint if exists sophia_voice_lab_cleanup_obligation_state_valid;
alter table public.sophia_voice_lab_cleanup_obligations
  add constraint sophia_voice_lab_cleanup_obligation_state_valid check (
    state in ('open', 'closed', 'complete')
  );
alter table public.sophia_voice_lab_cleanup_obligations
  drop constraint if exists sophia_voice_lab_cleanup_obligation_phase_valid;
alter table public.sophia_voice_lab_cleanup_obligations
  add constraint sophia_voice_lab_cleanup_obligation_phase_valid check (
    lifecycle_phase in (
      'auth_provisional', 'session_provisional', 'finalizing', 'finalized'
    )
    and (lifecycle_phase <> 'auth_provisional'
      or retention_expires_at = provider_expires_at)
    and (lifecycle_phase <> 'finalizing' or state = 'open')
    and (lifecycle_phase <> 'finalized' or state in ('closed', 'complete'))
  );
alter table public.sophia_voice_lab_cleanup_obligations
  drop constraint if exists sophia_voice_lab_cleanup_obligation_lifecycle_valid;
alter table public.sophia_voice_lab_cleanup_obligations
  add constraint sophia_voice_lab_cleanup_obligation_lifecycle_valid check (
    updated_at >= created_at
    and provider_expires_at <= retention_expires_at
    and (provider_settlement_sha256 is null
      or provider_settlement_sha256 ~ '^[a-f0-9]{64}$')
    and (live_cleanup_completed_at is null
      or updated_at >= live_cleanup_completed_at)
    and (
      (state = 'open' and closed_at is null
        and live_cleanup_completed_at is null
        and completed_at is null and purge_after is null)
      or (state = 'closed' and closed_at is not null and closed_at >= created_at
        and (live_cleanup_completed_at is null
          or live_cleanup_completed_at >= closed_at)
        and completed_at is null and purge_after is null)
      or (state = 'complete' and closed_at is not null
        and live_cleanup_completed_at is not null
        and live_cleanup_completed_at >= closed_at
        and completed_at is not null
        and completed_at >= live_cleanup_completed_at
        and purge_after is not null
        and purge_after >= retention_expires_at + interval '10 minutes')
    )
  );

alter table public.sophia_voice_lab_cleanup_admissions
  add column if not exists status text not null default 'reserved';
alter table public.sophia_voice_lab_cleanup_admissions
  add column if not exists resource_expires_at timestamptz;
do $$
begin
  if exists (select 1 from public.sophia_voice_lab_cleanup_admissions)
     and not exists (
       select 1
         from pg_constraint
        where conrelid =
              'public.sophia_voice_lab_cleanup_admissions'::regclass
          and conname = 'sophia_voice_lab_cleanup_admission_status_valid'
          and pg_get_constraintdef(oid) like '%allocating%'
     )
  then
    raise exception 'live legacy cleanup admissions require authoritative quiescence before upgrade';
  end if;
end
$$;
update public.sophia_voice_lab_cleanup_admissions as admission
   set lease_expires_at = obligation.retention_expires_at,
       updated_at = clock_timestamp()
  from public.sophia_voice_lab_cleanup_obligations as obligation
 where obligation.cleanup_obligation_id = admission.cleanup_obligation_id
   and admission.lease_expires_at > obligation.retention_expires_at;
update public.sophia_voice_lab_cleanup_admissions as admission
   set resource_expires_at = obligation.retention_expires_at
  from public.sophia_voice_lab_cleanup_obligations as obligation
 where obligation.cleanup_obligation_id = admission.cleanup_obligation_id
   and admission.resource_expires_at is null;
alter table public.sophia_voice_lab_cleanup_admissions
  alter column resource_expires_at set not null;
alter table public.sophia_voice_lab_cleanup_admissions
  alter column status set default 'reserved';
alter table public.sophia_voice_lab_cleanup_admissions
  alter column created_at set default clock_timestamp();
alter table public.sophia_voice_lab_cleanup_admissions
  alter column updated_at set default clock_timestamp();
alter table public.sophia_voice_lab_cleanup_admissions
  drop constraint if exists sophia_voice_lab_cleanup_admission_kind_valid;
alter table public.sophia_voice_lab_cleanup_admissions
  add constraint sophia_voice_lab_cleanup_admission_kind_valid check (
    resource_kind in ('session', 'provider', 'builder')
  );
alter table public.sophia_voice_lab_cleanup_admissions
  drop constraint if exists sophia_voice_lab_cleanup_admission_status_valid;
alter table public.sophia_voice_lab_cleanup_admissions
  add constraint sophia_voice_lab_cleanup_admission_status_valid check (
    status in (
      'reserved', 'allocating', 'credential_minted', 'browser_active',
      'activation_aborted', 'browser_closed'
    )
  );
alter table public.sophia_voice_lab_cleanup_admissions
  drop constraint if exists sophia_voice_lab_cleanup_admission_lease_valid;
alter table public.sophia_voice_lab_cleanup_admissions
  add constraint sophia_voice_lab_cleanup_admission_lease_valid check (
    lease_expires_at > created_at
    and resource_expires_at >= lease_expires_at
  );

create index if not exists sophia_voice_lab_cleanup_admissions_obligation_idx
  on public.sophia_voice_lab_cleanup_admissions (
    cleanup_obligation_id,
    lease_expires_at,
    admission_id
  );

create index if not exists sophia_voice_lab_cleanup_admissions_expiry_idx
  on public.sophia_voice_lab_cleanup_admissions (
    lease_expires_at,
    cleanup_obligation_id,
    admission_id
  );

create unique index if not exists
  sophia_voice_lab_cleanup_admissions_single_provider_idx
  on public.sophia_voice_lab_cleanup_admissions (cleanup_obligation_id)
  where resource_kind = 'provider';

create index if not exists sophia_voice_lab_cleanup_obligations_purge_idx
  on public.sophia_voice_lab_cleanup_obligations (
    purge_after,
    cleanup_obligation_id
  )
  where state = 'complete';

drop index if exists public.sophia_voice_lab_cleanup_obligations_work_idx;
create index sophia_voice_lab_cleanup_obligations_work_idx
  on public.sophia_voice_lab_cleanup_obligations (
    (
      case
        when state = 'closed' and live_cleanup_completed_at is null
          then closed_at
        when state = 'closed' then retention_expires_at
        else provider_expires_at
      end
    ),
    cleanup_obligation_id
  )
  where state <> 'complete';

create unique index if not exists sophia_sessions_voice_lab_cleanup_obligation_idx
  on public.sophia_sessions (
    ((metadata -> 'synthetic_voice_lab' ->> 'cleanup_obligation_id'))
  )
  where metadata -> 'synthetic_voice_lab' ->> 'synthetic' = 'true'
    and metadata -> 'synthetic_voice_lab' ->> 'cleanup_obligation_id' is not null;

create index if not exists artifact_registry_voice_lab_cleanup_obligation_idx
  on public.artifact_registry_records (
    (record_payload ->> 'cleanup_obligation_id'),
    artifact_id
  )
  where record_payload ->> 'synthetic_test' = 'true'
    and record_payload ->> 'cleanup_obligation_id' is not null;

create or replace function public.sophia_voice_lab_receipt_part(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public, pg_temp
as $$
  select octet_length(convert_to(coalesce(p_value, ''), 'UTF8'))::text
    || ':' || coalesce(p_value, '') || ';'
$$;

create or replace function public.sophia_voice_lab_finalization_receipt_sha256(
  p_user_id text,
  p_session_id text,
  p_thread_id text,
  p_synthetic jsonb,
  p_expected_deployment jsonb,
  p_finalized_at text,
  p_retention_hours integer,
  p_retention_expires_at text,
  p_provider_expires_at text,
  p_message_revision bigint,
  p_message_count integer,
  p_transcript_sha256 text,
  p_started_at text,
  p_turn_count integer,
  p_capability_jti_sha256 text,
  p_object_path text
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public, pg_temp
as $$
  select encode(
    sha256(convert_to(
      public.sophia_voice_lab_receipt_part(
        'sophia_voice_lab_postgres_finalization_receipt_v1'
      )
      || public.sophia_voice_lab_receipt_part(
           p_synthetic ->> 'cleanup_obligation_id'
         )
      || public.sophia_voice_lab_receipt_part(p_user_id)
      || public.sophia_voice_lab_receipt_part(p_session_id)
      || public.sophia_voice_lab_receipt_part(p_thread_id)
      || public.sophia_voice_lab_receipt_part(
           p_synthetic ->> 'principal_id'
         )
      || public.sophia_voice_lab_receipt_part(
           p_synthetic ->> 'test_run_id'
         )
      || public.sophia_voice_lab_receipt_part(
           p_synthetic ->> 'scenario_id'
         )
      || public.sophia_voice_lab_receipt_part(
           p_synthetic ->> 'scenario_version'
         )
      || public.sophia_voice_lab_receipt_part(
           p_synthetic ->> 'environment'
         )
      || public.sophia_voice_lab_receipt_part(
           p_expected_deployment ->> 'frontend'
         )
      || public.sophia_voice_lab_receipt_part(
           p_expected_deployment ->> 'backend'
         )
      || public.sophia_voice_lab_receipt_part(
           p_expected_deployment ->> 'voice'
         )
      || public.sophia_voice_lab_receipt_part(p_finalized_at)
      || public.sophia_voice_lab_receipt_part(p_retention_hours::text)
      || public.sophia_voice_lab_receipt_part(p_retention_expires_at)
      || public.sophia_voice_lab_receipt_part(p_provider_expires_at)
      || public.sophia_voice_lab_receipt_part(p_message_revision::text)
      || public.sophia_voice_lab_receipt_part(p_message_count::text)
      || public.sophia_voice_lab_receipt_part(p_transcript_sha256)
      || public.sophia_voice_lab_receipt_part(p_started_at)
      || public.sophia_voice_lab_receipt_part(p_turn_count::text)
      || public.sophia_voice_lab_receipt_part(p_capability_jti_sha256)
      || public.sophia_voice_lab_receipt_part(p_object_path),
      'UTF8'
    )),
    'hex'
  )
$$;

create or replace function public.sophia_finalize_voice_lab_session(
  p_user_id text,
  p_session_id text,
  p_expected_revision bigint,
  p_cleanup_obligation_id text,
  p_provider_expires_at text,
  p_retention_hours integer,
  p_expected_synthetic_binding jsonb,
  p_expected_deployment jsonb,
  p_message_metadata_base jsonb,
  p_canonical_transcript_sha256 text,
  p_canonical_transcript_json text,
  p_finalization_started_at text,
  p_turn_count integer,
  p_capability_jti_sha256 text,
  p_messages jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  obligation_row public.sophia_voice_lab_cleanup_obligations%rowtype;
  session_row public.sophia_sessions%rowtype;
  synthetic jsonb;
  stored_receipt jsonb;
  final_receipt jsonb;
  final_message_metadata jsonb;
  locked_synthetic_binding jsonb;
  expected_message_metadata_base jsonb;
  projected_messages jsonb;
  stored_messages_projection jsonb;
  provider_deadline timestamptz;
  provisional_deadline timestamptz;
  finalized_at timestamptz;
  retention_deadline timestamptz;
  finalized_text text;
  retention_text text;
  object_path text;
  receipt_sha256 text;
  next_revision bigint;
  incoming_count integer;
  stored_count integer;
begin
  if p_user_id is null
     or p_session_id is null
     or p_expected_revision is null
     or p_cleanup_obligation_id is null
     or p_provider_expires_at is null
     or p_retention_hours is null
     or p_expected_synthetic_binding is null
     or p_expected_deployment is null
     or p_message_metadata_base is null
     or p_canonical_transcript_sha256 is null
     or p_canonical_transcript_json is null
     or p_finalization_started_at is null
     or p_turn_count is null
     or p_capability_jti_sha256 is null
     or p_messages is null
     or p_cleanup_obligation_id !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_retention_hours not between 1 and 168
     or p_expected_revision < 0
     or p_canonical_transcript_sha256 !~ '^[a-f0-9]{64}$'
     or p_capability_jti_sha256 !~ '^[a-f0-9]{64}$'
     or p_turn_count < 0
     or jsonb_typeof(p_expected_synthetic_binding) <> 'object'
     or jsonb_typeof(p_expected_deployment) <> 'object'
     or jsonb_typeof(p_message_metadata_base) <> 'object'
     or jsonb_typeof(p_messages) <> 'array'
     or octet_length(p_canonical_transcript_json) > 2097152
     or octet_length(p_messages::text) > 2097152
     or octet_length(p_message_metadata_base::text) > 32768
  then
    raise exception 'synthetic finalization request is malformed';
  end if;
  begin
    provider_deadline := p_provider_expires_at::timestamptz;
    if to_char(
         date_trunc('milliseconds', provider_deadline) at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) <> p_provider_expires_at
       or to_char(
         date_trunc(
           'milliseconds', p_finalization_started_at::timestamptz
         ) at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) <> p_finalization_started_at
    then
      raise exception 'synthetic finalization timestamp is not canonical';
    end if;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'synthetic finalization timestamp is malformed';
  end;
  if encode(
       sha256(convert_to(p_canonical_transcript_json, 'UTF8')),
       'hex'
     ) <> p_canonical_transcript_sha256
  then
    raise exception 'synthetic finalization transcript digest conflicts';
  end if;

  incoming_count := jsonb_array_length(p_messages);
  if incoming_count > 512
     or exists (
       select 1
         from jsonb_array_elements(p_messages) item
        where jsonb_typeof(item) <> 'object'
           or item - array[
                'id', 'message_id', 'session_id', 'user_id', 'thread_id',
                'role', 'content', 'source', 'final', 'approximate',
                'turn_id', 'provider_event_id', 'sequence', 'created_at',
                'metadata'
              ] <> '{}'::jsonb
           or item ->> 'user_id' is distinct from p_user_id
           or item ->> 'session_id' is distinct from p_session_id
           or nullif(item ->> 'thread_id', '') is null
           or nullif(item ->> 'id', '') is null
           or nullif(item ->> 'message_id', '') is null
           or item ->> 'role' not in ('user', 'assistant')
           or nullif(btrim(item ->> 'content'), '') is null
           or octet_length(item ->> 'content') > 32768
           or jsonb_typeof(item -> 'final') <> 'boolean'
           or jsonb_typeof(item -> 'approximate') <> 'boolean'
           or coalesce((item ->> 'final')::boolean, false) is not true
           or jsonb_typeof(item -> 'sequence') <> 'number'
           or (item ->> 'sequence') !~ '^[1-9][0-9]*$'
           or (item ->> 'sequence')::integer < 1
           or item ->> 'created_at' is null
           or jsonb_typeof(item -> 'metadata') <> 'object'
           or octet_length((item -> 'metadata')::text) > 32768
     )
     or coalesce((
       select sum(octet_length(item ->> 'content'))
         from jsonb_array_elements(p_messages) item
     ), 0) > 1048576
     or incoming_count <> (
       select count(distinct item ->> 'id')
         from jsonb_array_elements(p_messages) item
     )
     or incoming_count <> (
       select count(distinct item ->> 'message_id')
         from jsonb_array_elements(p_messages) item
     )
     or incoming_count <> (
       select count(distinct (item ->> 'sequence')::integer)
         from jsonb_array_elements(p_messages) item
     )
     or coalesce((
       select min((item ->> 'sequence')::integer)
         from jsonb_array_elements(p_messages) item
     ), 1) <> 1
     or coalesce((
       select max((item ->> 'sequence')::integer)
         from jsonb_array_elements(p_messages) item
     ), 0) <> incoming_count
  then
    raise exception 'synthetic finalization messages are invalid';
  end if;
  begin
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'message_id', item ->> 'message_id',
          'sequence', (item ->> 'sequence')::integer,
          'role', item ->> 'role',
          'content', item ->> 'content',
          'created_at', to_char(
            date_trunc(
              'milliseconds', (item ->> 'created_at')::timestamptz
            ) at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'source', coalesce(item ->> 'source', 'text'),
          'final', coalesce((item ->> 'final')::boolean, true),
          'approximate', coalesce(
            (item ->> 'approximate')::boolean, false
          ),
          'turn_id', item ->> 'turn_id',
          'provider_event_id', item ->> 'provider_event_id',
          'redaction_level', coalesce(
            item -> 'metadata' ->> 'redaction_level', 'none'
          )
        ) order by
          (item ->> 'sequence')::integer,
          (item ->> 'created_at')::timestamptz,
          item ->> 'message_id'
      ),
      '[]'::jsonb
    ) into projected_messages
      from jsonb_array_elements(p_messages) item;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'synthetic finalization message timestamp is malformed';
  end;
  begin
    if p_canonical_transcript_json::jsonb is distinct from projected_messages
    then
      raise exception 'synthetic finalization transcript projection conflicts';
    end if;
  exception when invalid_text_representation then
    raise exception 'synthetic finalization transcript projection is malformed';
  end;

  perform pg_advisory_xact_lock(
    hashtextextended(p_cleanup_obligation_id, 731944)
  );
  select * into obligation_row
    from public.sophia_voice_lab_cleanup_obligations
   where cleanup_obligation_id = p_cleanup_obligation_id
   for update;
  if not found then
    raise exception 'synthetic finalization cleanup obligation is unavailable';
  end if;
  select * into session_row
    from public.sophia_sessions
   where id = p_session_id and user_id = p_user_id
   for update;
  if not found then
    raise exception 'synthetic finalization session is unavailable';
  end if;
  synthetic := session_row.metadata -> 'synthetic_voice_lab';
  locked_synthetic_binding := jsonb_build_object(
    'synthetic', true,
    'principal_id', synthetic ->> 'principal_id',
    'test_run_id', synthetic ->> 'test_run_id',
    'environment', synthetic ->> 'environment',
    'retention_hours', p_retention_hours,
    'cleanup_obligation_id', p_cleanup_obligation_id,
    'provider_expires_at', p_provider_expires_at
  );
  if synthetic ? 'scenario_id' then
    locked_synthetic_binding := locked_synthetic_binding
      || jsonb_build_object('scenario_id', synthetic ->> 'scenario_id');
  end if;
  if synthetic ? 'scenario_version' then
    locked_synthetic_binding := locked_synthetic_binding
      || jsonb_build_object(
        'scenario_version', synthetic ->> 'scenario_version'
      );
  end if;
  expected_message_metadata_base := locked_synthetic_binding
    || jsonb_build_object(
      'scenario_version', locked_synthetic_binding -> 'scenario_version',
      'expected_deployment', p_expected_deployment,
      'memory_retrieval_excluded', true,
      'memory_learning_excluded', true,
      'offline_pipeline_excluded', true,
      'ordinary_analytics_excluded', true,
      'ordinary_projects_excluded', true,
      'shared_spaces_excluded', true
    );
  if jsonb_typeof(synthetic) <> 'object'
     or synthetic -> 'synthetic' is distinct from 'true'::jsonb
     or synthetic ->> 'cleanup_obligation_id' is distinct from
          p_cleanup_obligation_id
     or synthetic ->> 'provider_expires_at' is distinct from
          p_provider_expires_at
     or synthetic ->> 'retention_hours' is distinct from
          p_retention_hours::text
     or synthetic ->> 'principal_id' is distinct from
          p_expected_synthetic_binding ->> 'principal_id'
     or synthetic ->> 'test_run_id' is distinct from
          p_expected_synthetic_binding ->> 'test_run_id'
     or synthetic ->> 'scenario_id' is distinct from
          p_expected_synthetic_binding ->> 'scenario_id'
     or synthetic ->> 'scenario_version' is distinct from
          p_expected_synthetic_binding ->> 'scenario_version'
     or synthetic ->> 'environment' is distinct from
          p_expected_synthetic_binding ->> 'environment'
     or p_expected_synthetic_binding is distinct from locked_synthetic_binding
     or session_row.metadata -> 'expected_deployment' is distinct from
          p_expected_deployment
     or p_expected_synthetic_binding - array[
          'synthetic', 'principal_id', 'test_run_id', 'scenario_id',
          'scenario_version', 'environment', 'retention_hours',
          'cleanup_obligation_id', 'provider_expires_at'
        ] <> '{}'::jsonb
     or p_expected_deployment - array['frontend', 'backend', 'voice']
          <> '{}'::jsonb
     or (select count(*) from jsonb_object_keys(p_expected_deployment)) <> 3
     or p_expected_deployment ->> 'frontend' !~ '^[a-f0-9]{40}$'
     or p_expected_deployment ->> 'backend' !~ '^[a-f0-9]{40}$'
     or p_expected_deployment ->> 'voice' !~ '^[a-f0-9]{40}$'
     or p_message_metadata_base is distinct from
          expected_message_metadata_base
     or exists (
       select 1
         from jsonb_array_elements(p_messages) item
        where item ->> 'thread_id' is distinct from session_row.thread_id
     )
     or obligation_row.provider_expires_at is distinct from provider_deadline
  then
    raise exception 'synthetic finalization binding conflicts';
  end if;

  stored_receipt := synthetic -> 'finalization_receipt';
  if session_row.status = 'ended' and stored_receipt is not null then
    if obligation_row.state <> 'closed'
       or obligation_row.lifecycle_phase <> 'finalized'
       or session_row.ended_at is distinct from
            (stored_receipt ->> 'finalized_at')::timestamptz
       or synthetic ->> 'retention_anchor' <> 'finalized_at'
       or synthetic ->> 'finalized_at' is distinct from
            stored_receipt ->> 'finalized_at'
       or synthetic ->> 'retention_expires_at' is distinct from
            stored_receipt ->> 'retention_expires_at'
       or obligation_row.retention_expires_at is distinct from
            (stored_receipt ->> 'retention_expires_at')::timestamptz
       or stored_receipt ->> 'transcript_sha256' is distinct from
            p_canonical_transcript_sha256
       or session_row.message_revision is distinct from
            (stored_receipt ->> 'message_revision')::bigint
       or session_row.message_count is distinct from
            (stored_receipt ->> 'message_count')::integer
       or p_expected_revision not in (
            session_row.message_revision,
            session_row.message_revision - 1
          )
    then
      raise exception 'synthetic finalization replay conflicts';
    end if;
    final_message_metadata := p_message_metadata_base || jsonb_build_object(
      'retention_hours', p_retention_hours,
      'retention_anchor', 'finalized_at',
      'finalized_at', stored_receipt ->> 'finalized_at',
      'retention_expires_at', stored_receipt ->> 'retention_expires_at'
    );
    select count(*), coalesce(
      jsonb_agg(
        jsonb_build_object(
          'message_id', message.message_id,
          'sequence', message.sequence,
          'role', message.role,
          'content', message.content,
          'created_at', to_char(
            date_trunc('milliseconds', message.created_at) at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'source', message.source,
          'final', message.final,
          'approximate', message.approximate,
          'turn_id', message.turn_id,
          'provider_event_id', message.provider_event_id,
          'redaction_level', coalesce(
            message.metadata ->> 'redaction_level', 'none'
          )
        ) order by message.sequence, message.created_at, message.message_id
      ),
      '[]'::jsonb
    ) into stored_count, stored_messages_projection
      from public.sophia_session_messages message
     where message.session_id = p_session_id;
    if stored_count <> incoming_count
       or stored_messages_projection is distinct from projected_messages
       or exists (
         select 1
           from public.sophia_session_messages message
           left join lateral (
             select item
               from jsonb_array_elements(p_messages) item
              where item ->> 'id' = message.id
           ) incoming on true
          where message.session_id = p_session_id
            and (
              incoming.item is null
              or message.user_id is distinct from p_user_id
              or message.thread_id is distinct from session_row.thread_id
              or message.message_id is distinct from incoming.item ->> 'message_id'
              or message.metadata is distinct from
                   final_message_metadata || jsonb_build_object(
                     'redaction_level', coalesce(
                       incoming.item -> 'metadata' ->> 'redaction_level',
                       'none'
                     )
                   )
            )
       )
       or stored_receipt ->> 'sha256' is distinct from
          public.sophia_voice_lab_finalization_receipt_sha256(
            p_user_id,
            p_session_id,
            session_row.thread_id,
            synthetic,
            p_expected_deployment,
            stored_receipt ->> 'finalized_at',
            p_retention_hours,
            stored_receipt ->> 'retention_expires_at',
            p_provider_expires_at,
            session_row.message_revision,
            session_row.message_count,
            p_canonical_transcript_sha256,
            stored_receipt ->> 'started_at',
            (stored_receipt ->> 'turn_count')::integer,
            stored_receipt ->> 'capability_jti_sha256',
            stored_receipt ->> 'object_path'
          )
    then
      raise exception 'synthetic finalization replay receipt conflicts';
    end if;
    return jsonb_build_object(
      'duplicate', true,
      'cleanup_state', obligation_row.state,
      'finalized_at', stored_receipt ->> 'finalized_at',
      'retention_expires_at', stored_receipt ->> 'retention_expires_at',
      'object_path', stored_receipt ->> 'object_path',
      'sha256', stored_receipt ->> 'sha256'
    );
  end if;

  begin
    provisional_deadline :=
      (synthetic ->> 'retention_expires_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'synthetic provisional retention binding is malformed';
  end;
  if obligation_row.state <> 'open'
     or obligation_row.lifecycle_phase <> 'session_provisional'
     or obligation_row.retention_expires_at is distinct from
          provisional_deadline
     or clock_timestamp() >= provisional_deadline
     or session_row.status <> 'active'
     or session_row.ended_at is not null
     or synthetic ->> 'retention_anchor' <>
          'session_created_at_provisional'
     or synthetic ->> 'finalized_at' is not null
     or stored_receipt is not null
     or session_row.message_revision <> p_expected_revision
  then
    raise exception 'synthetic provisional finalization is unavailable';
  end if;

  finalized_at := date_trunc('milliseconds', clock_timestamp());
  retention_deadline := finalized_at
    + make_interval(hours => p_retention_hours);
  finalized_text := to_char(
    finalized_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  retention_text := to_char(
    retention_deadline at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  next_revision := session_row.message_revision + 1;
  object_path := 'public.sophia_sessions/' || p_session_id
    || '/metadata/synthetic_voice_lab/finalization_receipt';
  receipt_sha256 := public.sophia_voice_lab_finalization_receipt_sha256(
    p_user_id,
    p_session_id,
    session_row.thread_id,
    synthetic,
    p_expected_deployment,
    finalized_text,
    p_retention_hours,
    retention_text,
    p_provider_expires_at,
    next_revision,
    incoming_count,
    p_canonical_transcript_sha256,
    p_finalization_started_at,
    p_turn_count,
    p_capability_jti_sha256,
    object_path
  );
  final_receipt := jsonb_build_object(
    'schema', 'sophia_voice_lab_postgres_finalization_receipt_v1',
    'storage', 'postgres_session',
    'object_path', object_path,
    'sha256', receipt_sha256,
    'cleanup_obligation_id', p_cleanup_obligation_id,
    'transcript_sha256', p_canonical_transcript_sha256,
    'finalized_at', finalized_text,
    'retention_expires_at', retention_text,
    'provider_expires_at', p_provider_expires_at,
    'message_revision', next_revision,
    'message_count', incoming_count,
    'started_at', p_finalization_started_at,
    'turn_count', p_turn_count,
    'capability_jti_sha256', p_capability_jti_sha256
  );
  final_message_metadata := p_message_metadata_base || jsonb_build_object(
    'retention_hours', p_retention_hours,
    'retention_anchor', 'finalized_at',
    'finalized_at', finalized_text,
    'retention_expires_at', retention_text
  );

  update public.sophia_voice_lab_cleanup_obligations
     set lifecycle_phase = 'finalizing',
         updated_at = finalized_at
   where cleanup_obligation_id = p_cleanup_obligation_id
     and state = 'open'
     and lifecycle_phase = 'session_provisional'
     and retention_expires_at = provisional_deadline
     and provider_expires_at = provider_deadline;
  if not found then
    raise exception 'synthetic finalization phase transition conflicts';
  end if;

  delete from public.sophia_session_messages
   where session_id = p_session_id;
  insert into public.sophia_session_messages (
    id, message_id, session_id, user_id, thread_id, role, content,
    source, final, approximate, turn_id, provider_event_id, sequence,
    created_at, metadata
  )
  select
    item ->> 'id',
    item ->> 'message_id',
    p_session_id,
    p_user_id,
    item ->> 'thread_id',
    item ->> 'role',
    item ->> 'content',
    coalesce(item ->> 'source', 'text'),
    true,
    coalesce((item ->> 'approximate')::boolean, false),
    item ->> 'turn_id',
    item ->> 'provider_event_id',
    (item ->> 'sequence')::integer,
    (item ->> 'created_at')::timestamptz,
    final_message_metadata || jsonb_build_object(
      'redaction_level', coalesce(
        item -> 'metadata' ->> 'redaction_level', 'none'
      )
    )
  from jsonb_array_elements(p_messages) item;

  synthetic := synthetic || jsonb_build_object(
    'retention_anchor', 'finalized_at',
    'finalized_at', finalized_text,
    'retention_expires_at', retention_text,
    'finalization_receipt', final_receipt
  );
  update public.sophia_voice_lab_cleanup_obligations
     set state = 'closed',
         lifecycle_phase = 'finalized',
         retention_expires_at = retention_deadline,
         closed_at = finalized_at,
         updated_at = finalized_at
   where cleanup_obligation_id = p_cleanup_obligation_id
     and state = 'open'
     and lifecycle_phase = 'finalizing'
     and retention_expires_at = provisional_deadline
     and provider_expires_at = provider_deadline;
  if not found then
    raise exception 'synthetic finalization cleanup close conflicts';
  end if;
  update public.sophia_sessions
     set status = 'ended',
         ended_at = finalized_at,
         message_revision = next_revision,
         message_count = incoming_count,
         transcript_available = incoming_count > 0,
         metadata = jsonb_set(
           session_row.metadata,
           '{synthetic_voice_lab}',
           synthetic,
           true
         ),
         updated_at = finalized_at
   where id = p_session_id
     and user_id = p_user_id
     and message_revision = p_expected_revision;
  if not found then
    raise exception 'synthetic finalization parent update conflicts';
  end if;
  return jsonb_build_object(
    'duplicate', false,
    'cleanup_state', 'closed',
    'finalized_at', finalized_text,
    'retention_expires_at', retention_text,
    'object_path', object_path,
    'sha256', receipt_sha256
  );
end;
$$;

create or replace function public.sophia_purge_voice_lab_session(
  p_user_id text,
  p_session_id text,
  p_cleanup_obligation_id text,
  p_retention_expires_at text,
  p_provider_expires_at text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  obligation_row public.sophia_voice_lab_cleanup_obligations%rowtype;
  session_row public.sophia_sessions%rowtype;
  synthetic jsonb;
  retention_deadline timestamptz;
  provider_deadline timestamptz;
begin
  if p_user_id is null
     or p_session_id is null
     or p_cleanup_obligation_id is null
     or p_retention_expires_at is null
     or p_provider_expires_at is null
     or octet_length(p_user_id) not between 1 and 256
     or octet_length(p_session_id) not between 1 and 256
     or p_user_id ~ '[[:cntrl:]]'
     or p_session_id ~ '[[:cntrl:]]'
     or p_cleanup_obligation_id !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception 'synthetic retention purge request is malformed';
  end if;
  begin
    retention_deadline := p_retention_expires_at::timestamptz;
    provider_deadline := p_provider_expires_at::timestamptz;
    if to_char(
         date_trunc('milliseconds', retention_deadline) at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) <> p_retention_expires_at
       or to_char(
         date_trunc('milliseconds', provider_deadline) at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) <> p_provider_expires_at
       or provider_deadline > retention_deadline
    then
      raise exception 'synthetic retention purge deadline is not canonical';
    end if;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'synthetic retention purge deadline is malformed';
  end;

  perform pg_advisory_xact_lock(
    hashtextextended(p_cleanup_obligation_id, 731944)
  );
  select * into obligation_row
    from public.sophia_voice_lab_cleanup_obligations
   where cleanup_obligation_id = p_cleanup_obligation_id
   for update;
  if not found
     or obligation_row.state <> 'closed'
     or obligation_row.lifecycle_phase not in ('session_provisional', 'finalized')
     or obligation_row.retention_expires_at is distinct from retention_deadline
     or obligation_row.provider_expires_at is distinct from provider_deadline
     or clock_timestamp() < obligation_row.retention_expires_at
     or exists (
       select 1
         from public.sophia_voice_lab_cleanup_admissions admission
        where admission.cleanup_obligation_id = p_cleanup_obligation_id
     )
  then
    raise exception 'synthetic retention purge fence is unavailable';
  end if;

  select * into session_row
    from public.sophia_sessions
   where id = p_session_id
   for update;
  if not found then
    if exists (
      select 1
        from public.sophia_session_messages message
       where message.session_id = p_session_id
    ) then
      raise exception 'synthetic retention purge left orphan transcript rows';
    end if;
    return true;
  end if;
  synthetic := session_row.metadata -> 'synthetic_voice_lab';
  if session_row.user_id is distinct from p_user_id
     or jsonb_typeof(synthetic) <> 'object'
     or synthetic -> 'synthetic' is distinct from 'true'::jsonb
     or synthetic ->> 'cleanup_obligation_id' is distinct from
          p_cleanup_obligation_id
     or synthetic ->> 'retention_expires_at' is distinct from
          p_retention_expires_at
     or synthetic ->> 'provider_expires_at' is distinct from
          p_provider_expires_at
     or not (
       (
         obligation_row.lifecycle_phase = 'finalized'
         and session_row.status = 'ended'
         and synthetic ->> 'retention_anchor' = 'finalized_at'
         and synthetic ->> 'finalized_at' is not null
         and session_row.ended_at is not distinct from
              (synthetic ->> 'finalized_at')::timestamptz
         and jsonb_typeof(synthetic -> 'finalization_receipt') = 'object'
         and synthetic -> 'finalization_receipt' ->> 'storage' =
              'postgres_session'
         and synthetic -> 'finalization_receipt'
               ->> 'cleanup_obligation_id' = p_cleanup_obligation_id
       )
       or (
         obligation_row.lifecycle_phase = 'session_provisional'
         and session_row.status in ('active', 'resumable')
         and session_row.ended_at is null
         and synthetic ->> 'retention_anchor' =
              'session_created_at_provisional'
         and synthetic ->> 'finalized_at' is null
         and coalesce(
               jsonb_typeof(synthetic -> 'finalization_receipt'), 'null'
             ) = 'null'
       )
     )
  then
    raise exception 'synthetic retention purge session binding conflicts';
  end if;

  delete from public.sophia_session_messages
   where session_id = p_session_id;
  delete from public.sophia_sessions
   where id = p_session_id
     and user_id = p_user_id;
  if not found
     or exists (
       select 1 from public.sophia_sessions where id = p_session_id
     )
     or exists (
       select 1
         from public.sophia_session_messages message
        where message.session_id = p_session_id
     )
  then
    raise exception 'synthetic retention purge read-zero conflicts';
  end if;
  return true;
end;
$$;

create or replace function public.sophia_voice_lab_cleanup_write_fence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  old_payload jsonb;
  new_payload jsonb;
  old_cleanup_id text;
  new_cleanup_id text;
  cleanup_id text;
  retention_deadline timestamptz;
  provider_deadline timestamptz;
  phase_now timestamptz;
  phase_deadline timestamptz;
  obligation_state text;
  obligation_phase text;
  obligation_retention timestamptz;
  obligation_provider timestamptz;
  obligation_provider_settlement_sha256 text;
  old_synthetic boolean := false;
  new_synthetic boolean := false;
  finalization_transition boolean := false;
  provider_bind_transition boolean := false;
  provider_activation_transition boolean := false;
  provider_stage_transition boolean := false;
  provider_cleanup_transition boolean := false;
  provider_receipt_transition boolean := false;
  d02_terminal_transition boolean := false;
  auth_cleanup_transition boolean := false;
  changed_keys text[] := array[]::text[];
  provider_keys text[] := array[
    'voice_runtime_session_id', 'cleanup_provider_admission_id',
    'voice_runtime_owner_deployment_sha',
    'voice_runtime_instance_id_sha256',
    'voice_runtime_instance_public_key_spki_base64',
    'voice_provider_resource_state', 'voice_provider_connection_epoch',
    'voice_provider_pending_connection_epoch',
    'voice_provider_resource_expires_at',
    'voice_provider_credential_minted_at', 'voice_provider_activated_at',
    'voice_provider_activation_receipt', 'voice_provider_closed_at',
    'voice_provider_browser_close_receipts',
    'voice_provider_activation_abort_receipts',
    'voice_provider_trace_fault_restore_receipt',
    'voice_provider_trace_fault_restore_receipt_history',
    'voice_d02_voice_terminal_receipt',
    'voice_d02_gateway_provider_settlement_sha256'
  ];
  requested_admission_id text;
  admission_status text;
  admission_resource text;
  admission_lease_expired boolean;
  receipt jsonb;
  expected_receipt jsonb;
  auth_grant public.sophia_voice_lab_auth_grants%rowtype;
  auth_session_token text;
begin
  if tg_table_name = 'sophia_sessions' then
    if tg_op <> 'INSERT' then
      old_payload := old.metadata -> 'synthetic_voice_lab';
      old_synthetic := old_payload ->> 'synthetic' = 'true';
      old_cleanup_id := old_payload ->> 'cleanup_obligation_id';
      if tg_op = 'DELETE' then
        begin
          retention_deadline :=
            (old_payload ->> 'retention_expires_at')::timestamptz;
          provider_deadline :=
            (old_payload ->> 'provider_expires_at')::timestamptz;
        exception when invalid_datetime_format or datetime_field_overflow then
          raise exception 'synthetic session retention binding is malformed';
        end;
      end if;
    end if;
    if tg_op <> 'DELETE' then
      new_payload := new.metadata -> 'synthetic_voice_lab';
      new_synthetic := new_payload ->> 'synthetic' = 'true';
      new_cleanup_id := new_payload ->> 'cleanup_obligation_id';
      begin
        retention_deadline :=
          (new_payload ->> 'retention_expires_at')::timestamptz;
        provider_deadline :=
          (new_payload ->> 'provider_expires_at')::timestamptz;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception 'synthetic session retention binding is malformed';
      end;
    end if;
    if tg_op = 'UPDATE' and (old_synthetic or new_synthetic) then
      if not old_synthetic or not new_synthetic then
        raise exception 'synthetic session isolation state is immutable';
      end if;
      if old_cleanup_id is distinct from new_cleanup_id
         or old_payload ->> 'principal_id' is distinct from
              new_payload ->> 'principal_id'
         or old_payload ->> 'test_run_id' is distinct from
              new_payload ->> 'test_run_id'
         or old_payload ->> 'scenario_id' is distinct from
              new_payload ->> 'scenario_id'
         or old_payload ->> 'scenario_version' is distinct from
              new_payload ->> 'scenario_version'
         or old_payload ->> 'environment' is distinct from
              new_payload ->> 'environment'
         or old_payload ->> 'retention_hours' is distinct from
              new_payload ->> 'retention_hours'
         or old_payload ->> 'provider_expires_at' is distinct from
              new_payload ->> 'provider_expires_at'
         or old.metadata -> 'expected_deployment' is distinct from
              new.metadata -> 'expected_deployment'
      then
        raise exception 'synthetic session signed binding is immutable';
      end if;
      select coalesce(array_agg(key order by key), array[]::text[])
        into changed_keys
        from (
          select key
            from jsonb_object_keys(old_payload || new_payload) key
           where old_payload -> key is distinct from new_payload -> key
        ) changed;

      finalization_transition :=
        changed_keys <@ array[
          'retention_anchor', 'finalized_at', 'retention_expires_at',
          'finalization_receipt'
        ]
        and old.status = 'active' and old.ended_at is null
        and old_payload ->> 'retention_anchor' =
              'session_created_at_provisional'
        and old_payload ->> 'finalized_at' is null
        and new.status = 'ended'
        and new_payload ->> 'retention_anchor' = 'finalized_at'
        and new.ended_at = (new_payload ->> 'finalized_at')::timestamptz
        and (new_payload ->> 'retention_expires_at')::timestamptz
          = new.ended_at + make_interval(
              hours => (new_payload ->> 'retention_hours')::integer
            )
        and new.message_revision = old.message_revision + 1
        and new.message_count >= 0
        and new.transcript_available = (new.message_count > 0)
        and new.updated_at = new.ended_at
        and old.metadata - 'synthetic_voice_lab'
              is not distinct from new.metadata - 'synthetic_voice_lab'
        and to_jsonb(old) - array[
              'status', 'ended_at', 'message_revision', 'message_count',
              'transcript_available', 'metadata', 'updated_at'
            ] is not distinct from to_jsonb(new) - array[
              'status', 'ended_at', 'message_revision', 'message_count',
              'transcript_available', 'metadata', 'updated_at'
            ];
      provider_bind_transition :=
        changed_keys <@ array[
          'voice_runtime_session_id', 'cleanup_provider_admission_id',
          'voice_runtime_owner_deployment_sha',
          'voice_runtime_instance_id_sha256',
          'voice_runtime_instance_public_key_spki_base64',
          'voice_provider_resource_state',
          'voice_provider_pending_connection_epoch',
          'voice_provider_resource_expires_at',
          'voice_provider_credential_minted_at',
          'voice_provider_trace_fault_restore_receipt',
          'voice_provider_trace_fault_restore_receipt_history'
        ]
        and old_payload ->> 'voice_runtime_session_id' is null
        and old_payload ->> 'cleanup_provider_admission_id' is null
        and new_payload ->> 'voice_provider_resource_state' =
              'credential_minted'
        and nullif(new_payload ->> 'voice_runtime_session_id', '') is not null
        and nullif(
              new_payload ->> 'cleanup_provider_admission_id', ''
            ) is not null
        and (new_payload ->> 'voice_provider_pending_connection_epoch')::integer
              > 0
        and new_payload ->> 'voice_provider_resource_expires_at'
              = new_payload ->> 'provider_expires_at'
        and (
          (
            new_payload ->> 'scenario_id' = 'V-D02'
            and new_payload ->> 'voice_runtime_owner_deployment_sha'
                  = new.metadata -> 'expected_deployment' ->> 'voice'
            and new_payload ->> 'voice_runtime_owner_deployment_sha'
                  ~ '^[a-f0-9]{40}$'
            and new_payload ->> 'voice_runtime_instance_id_sha256'
                  ~ '^[a-f0-9]{64}$'
            and new_payload ->> 'voice_runtime_instance_public_key_spki_base64'
                  ~ '^[A-Za-z0-9+/]{59}=$'
          )
          or (
            new_payload ->> 'scenario_id' <> 'V-D02'
            and new_payload ->> 'voice_runtime_owner_deployment_sha' is null
            and new_payload ->> 'voice_runtime_instance_id_sha256' is null
            and new_payload ->> 'voice_runtime_instance_public_key_spki_base64'
                  is null
          )
        );
      provider_activation_transition :=
        changed_keys <@ array[
          'voice_provider_resource_state', 'voice_provider_connection_epoch',
          'voice_provider_pending_connection_epoch',
          'voice_provider_activated_at', 'voice_provider_activation_receipt'
        ]
        and old_payload ->> 'voice_provider_resource_state'
              in ('credential_minted', 'active')
        and new_payload ->> 'voice_provider_resource_state' = 'active'
        and (old_payload ->> 'voice_provider_pending_connection_epoch')::integer
              > 0
        and (new_payload ->> 'voice_provider_connection_epoch')::integer
              = (old_payload ->>
                   'voice_provider_pending_connection_epoch')::integer
        and new_payload ->> 'voice_provider_pending_connection_epoch' is null
        and jsonb_typeof(
              new_payload -> 'voice_provider_activation_receipt'
            ) = 'object';
      provider_stage_transition :=
        changed_keys = array['voice_provider_pending_connection_epoch']
        and old_payload ->> 'voice_provider_resource_state' = 'active'
        and old_payload ->> 'voice_provider_pending_connection_epoch' is null
        and (new_payload ->> 'voice_provider_pending_connection_epoch')::integer
              = (old_payload ->> 'voice_provider_connection_epoch')::integer + 1;
      provider_cleanup_transition :=
        changed_keys <@ array[
          'voice_provider_resource_state', 'voice_provider_closed_at',
          'voice_provider_pending_connection_epoch',
          'voice_provider_browser_close_receipts',
          'voice_provider_activation_abort_receipts'
        ]
        and old_payload ->> 'voice_provider_resource_state'
              in ('credential_minted', 'active', 'closed')
        and new_payload ->> 'voice_provider_resource_state' = 'closed'
        and new_payload ->> 'voice_provider_pending_connection_epoch' is null
        and new_payload ->> 'voice_provider_closed_at' is not null
        and jsonb_typeof(
              new_payload -> 'voice_provider_browser_close_receipts'
            ) = 'array'
        and jsonb_typeof(
              new_payload -> 'voice_provider_activation_abort_receipts'
            ) = 'array';
      provider_receipt_transition :=
        changed_keys = array['voice_provider_trace_fault_restore_receipt']
        and jsonb_typeof(
              new_payload -> 'voice_provider_trace_fault_restore_receipt'
            ) = 'object';
      d02_terminal_transition :=
        changed_keys <@ array[
          'voice_d02_voice_terminal_receipt',
          'voice_d02_gateway_provider_settlement_sha256'
        ]
        and old_payload ->> 'scenario_id' = 'V-D02'
        and old_payload ->> 'voice_provider_resource_state' = 'closed'
        and new_payload ->> 'voice_provider_resource_state' = 'closed'
        and new_payload ->> 'voice_provider_pending_connection_epoch' is null
        and jsonb_typeof(
              new_payload -> 'voice_d02_voice_terminal_receipt'
            ) = 'object'
        and new_payload ->> 'voice_d02_gateway_provider_settlement_sha256'
              ~ '^[a-f0-9]{64}$';

      if not finalization_transition and (
        old_payload ->> 'retention_anchor' is distinct from
          new_payload ->> 'retention_anchor'
        or old_payload ->> 'retention_expires_at' is distinct from
          new_payload ->> 'retention_expires_at'
        or old_payload ->> 'finalized_at' is distinct from
          new_payload ->> 'finalized_at'
        or old_payload -> 'finalization_receipt' is distinct from
          new_payload -> 'finalization_receipt'
      ) then
        raise exception 'synthetic session retention binding is immutable';
      end if;
      if changed_keys && provider_keys and not (
        provider_bind_transition or provider_activation_transition
        or provider_stage_transition or provider_cleanup_transition
        or provider_receipt_transition or d02_terminal_transition
      ) then
        raise exception 'synthetic provider transition is invalid';
      end if;
      if (provider_bind_transition or provider_activation_transition
          or provider_stage_transition or provider_cleanup_transition
          or provider_receipt_transition or d02_terminal_transition)
         and (
           to_jsonb(old) - array['metadata', 'updated_at']
             is distinct from to_jsonb(new) - array['metadata', 'updated_at']
           or old.metadata - 'synthetic_voice_lab'
             is distinct from new.metadata - 'synthetic_voice_lab'
         )
      then
        raise exception 'synthetic provider transition changed unrelated session fields';
      end if;
    end if;
  elsif tg_table_name = 'artifact_registry_records' then
    if tg_op <> 'INSERT' then
      old_payload := old.record_payload;
      old_synthetic := old_payload ->> 'synthetic_test' = 'true';
      old_cleanup_id := old_payload ->> 'cleanup_obligation_id';
      if tg_op = 'DELETE' then
        begin
          retention_deadline :=
            (old_payload ->> 'retention_expires_at')::timestamptz;
          provider_deadline :=
            (old_payload ->> 'provider_expires_at')::timestamptz;
        exception when invalid_datetime_format or datetime_field_overflow then
          raise exception 'synthetic artifact retention binding is malformed';
        end;
      end if;
    end if;
    if tg_op <> 'DELETE' then
      new_payload := new.record_payload;
      new_synthetic := new_payload ->> 'synthetic_test' = 'true';
      new_cleanup_id := new_payload ->> 'cleanup_obligation_id';
      retention_deadline :=
        (new_payload ->> 'retention_expires_at')::timestamptz;
      provider_deadline :=
        (new_payload ->> 'provider_expires_at')::timestamptz;
    end if;
    if tg_op = 'UPDATE' and (old_synthetic or new_synthetic) then
      if not old_synthetic or not new_synthetic then
        raise exception 'synthetic artifact isolation state is immutable';
      end if;
      if old_cleanup_id is distinct from new_cleanup_id
         or old_payload ->> 'user_id' is distinct from new_payload ->> 'user_id'
         or old_payload ->> 'test_principal_id' is distinct from
              new_payload ->> 'test_principal_id'
         or old_payload ->> 'test_run_id' is distinct from
              new_payload ->> 'test_run_id'
         or old_payload ->> 'scenario_id' is distinct from
              new_payload ->> 'scenario_id'
         or old_payload ->> 'scenario_version' is distinct from
              new_payload ->> 'scenario_version'
         or old_payload ->> 'environment' is distinct from
              new_payload ->> 'environment'
         or old_payload ->> 'retention_hours' is distinct from
              new_payload ->> 'retention_hours'
         or old_payload ->> 'retention_anchor' is distinct from
              new_payload ->> 'retention_anchor'
         or old_payload ->> 'retention_anchor_at' is distinct from
              new_payload ->> 'retention_anchor_at'
         or old_payload ->> 'retention_expires_at' is distinct from
              new_payload ->> 'retention_expires_at'
         or old_payload ->> 'provider_expires_at' is distinct from
              new_payload ->> 'provider_expires_at'
         or old_payload -> 'deployment_identity' is distinct from
              new_payload -> 'deployment_identity'
      then
        raise exception 'synthetic artifact signed binding is immutable';
      end if;
    end if;
  elsif tg_table_name = 'sophia_voice_lab_auth_grants' then
    old_synthetic := tg_op <> 'INSERT';
    new_synthetic := tg_op <> 'DELETE';
    if tg_op <> 'INSERT' then
      old_cleanup_id := old.cleanup_obligation_id;
    end if;
    if tg_op <> 'DELETE' then
      new_cleanup_id := new.cleanup_obligation_id;
      retention_deadline := new.provider_expires_at;
      provider_deadline := new.provider_expires_at;
    end if;
    if tg_op = 'UPDATE' then
      auth_cleanup_transition := old.status = 'active'
        and new.status = 'revoked';
      if auth_cleanup_transition then
        if old.cleanup_obligation_id !~
             '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           or new.cleanup_obligation_id !~
             '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'
           or new.principal_id !~
             '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'
           or new.test_run_id !~
             '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'
           or new.jti_sha256 <> repeat('0', 64)
           or new.nonce_sha256 <> repeat('0', 64)
           or new.session_token_sha256 <> repeat('0', 64)
           or new.revoked_at is null
           or old.grant_fingerprint is distinct from new.grant_fingerprint
           or old.tombstone_kid is distinct from new.tombstone_kid
           or old.issued_at is distinct from new.issued_at
           or old.expires_at is distinct from new.expires_at
           or old.provider_expires_at is distinct from new.provider_expires_at
           or old.retention_hours is distinct from new.retention_hours
           or old.created_at is distinct from new.created_at
        then
          raise exception 'synthetic auth tombstone transition is invalid';
        end if;
      elsif to_jsonb(old) is distinct from to_jsonb(new) then
        raise exception 'synthetic auth signed binding is immutable';
      end if;
    end if;
  end if;

  if not old_synthetic and not new_synthetic then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'sophia_voice_lab_auth_grants' and tg_op = 'DELETE' then
    if old.status <> 'revoked'
       or old.cleanup_obligation_id !~
            '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'
       or old.principal_id !~
            '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'
       or old.test_run_id !~
            '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'
       or split_part(old.cleanup_obligation_id, ':', 2) <>
            old.tombstone_kid
       or split_part(old.principal_id, ':', 2) <> old.tombstone_kid
       or split_part(old.test_run_id, ':', 2) <> old.tombstone_kid
       or old.jti_sha256 <> repeat('0', 64)
       or old.nonce_sha256 <> repeat('0', 64)
       or old.session_token_sha256 <> repeat('0', 64)
       or old.revoked_at is null
       or old.expires_at > clock_timestamp()
    then
      raise exception 'synthetic auth tombstone deletion is invalid';
    end if;
    return old;
  end if;
  cleanup_id := case
    when old_cleanup_id ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then old_cleanup_id
    when new_cleanup_id ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then new_cleanup_id
    else null
  end;
  if tg_table_name = 'sophia_voice_lab_auth_grants' and cleanup_id is null then
    if coalesce(old_cleanup_id, new_cleanup_id, '') !~
         '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'
    then
      raise exception 'synthetic auth cleanup identity is malformed';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if cleanup_id is null then
    raise exception 'synthetic cleanup obligation id is missing or malformed';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(cleanup_id, 731944));
  select state, lifecycle_phase, retention_expires_at, provider_expires_at,
         provider_settlement_sha256
    into obligation_state, obligation_phase,
         obligation_retention, obligation_provider,
         obligation_provider_settlement_sha256
    from public.sophia_voice_lab_cleanup_obligations
   where cleanup_obligation_id = cleanup_id
   for update;
  if obligation_state is null then
    raise exception 'synthetic cleanup obligation fence is unavailable';
  end if;
  if tg_op = 'DELETE' then
    if obligation_state <> 'closed'
       or obligation_retention is distinct from retention_deadline
       or obligation_provider is distinct from provider_deadline
       or clock_timestamp() < obligation_retention
       or exists (
         select 1
           from public.sophia_voice_lab_cleanup_admissions admission
          where admission.cleanup_obligation_id = cleanup_id
       )
    then
      raise exception 'synthetic cleanup retention deletion is unavailable';
    end if;
    return old;
  end if;

  if tg_table_name = 'sophia_sessions' and tg_op = 'INSERT' then
    if obligation_state <> 'open'
       or obligation_phase <> 'auth_provisional'
       or obligation_provider is distinct from provider_deadline
       or obligation_retention is distinct from provider_deadline
       or clock_timestamp() >= provider_deadline
       or jsonb_typeof(new_payload) <> 'object'
       or new_payload ->> 'synthetic' <> 'true'
       or new_payload ->> 'principal_id' is distinct from new.user_id
       or new_payload ->> 'test_run_id' is distinct from new.run_id
       or jsonb_typeof(new_payload -> 'retention_hours') <> 'number'
       or (new_payload ->> 'retention_hours')::integer not between 1 and 168
       or new.status <> 'active'
       or new.ended_at is not null
       or new.metadata ->> 'memory_retrieval_disabled' <> 'true'
       or new.metadata ->> 'inactivity_finalization_disabled' <> 'true'
       or new.metadata ->> 'offline_pipeline_disabled' <> 'true'
       or new.metadata ->> 'memory_learning_disabled' <> 'true'
       or new.metadata ->> 'ordinary_analytics_disabled' <> 'true'
       or new.metadata ->> 'ordinary_projects_disabled' <> 'true'
       or new.metadata ->> 'shared_spaces_disabled' <> 'true'
       or jsonb_typeof(new.metadata -> 'expected_deployment') <> 'object'
       or (select count(*) from jsonb_object_keys(
             new.metadata -> 'expected_deployment'
           )) <> 3
       or new.metadata -> 'expected_deployment' ->> 'frontend' !~ '^[a-f0-9]{40}$'
       or new.metadata -> 'expected_deployment' ->> 'backend' !~ '^[a-f0-9]{40}$'
       or new.metadata -> 'expected_deployment' ->> 'voice' !~ '^[a-f0-9]{40}$'
    then
      raise exception 'synthetic cleanup obligation admission is closed';
    end if;
    select * into auth_grant
      from public.sophia_voice_lab_auth_grants
     where cleanup_obligation_id = cleanup_id
       and status = 'active'
       and principal_id = new.user_id
       and test_run_id = new.run_id
       and provider_expires_at = provider_deadline
       and retention_hours = (new_payload ->> 'retention_hours')::integer
       and expires_at > clock_timestamp()
     for update;
    if not found then
      raise exception 'synthetic session auth grant binding is unavailable';
    end if;
    select auth_session.token into auth_session_token
      from public."session" auth_session
     where auth_session."userId" = new.user_id
       and auth_session."expiresAt" > clock_timestamp()
       and encode(
             sha256(convert_to(auth_session.token, 'UTF8')),
             'hex'
           ) = auth_grant.session_token_sha256
     for update;
    if not found then
      raise exception 'synthetic session auth owner binding is unavailable';
    end if;
    phase_now := date_trunc('milliseconds', clock_timestamp());
    phase_deadline := phase_now + make_interval(
      hours => (new_payload ->> 'retention_hours')::integer
    );
    if provider_deadline > phase_deadline then
      raise exception 'synthetic provider deadline exceeds session retention';
    end if;
    retention_deadline := phase_deadline;
    new.created_at := phase_now;
    new.updated_at := phase_now;
    new_payload := new_payload || jsonb_build_object(
      'retention_anchor', 'session_created_at_provisional',
      'finalized_at', null,
      'retention_expires_at', to_char(
        phase_deadline at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    );
    new.metadata := jsonb_set(
      new.metadata, '{synthetic_voice_lab}', new_payload, true
    );
    update public.sophia_voice_lab_cleanup_obligations
       set lifecycle_phase = 'session_provisional',
           retention_expires_at = phase_deadline,
           updated_at = phase_now
     where cleanup_obligation_id = cleanup_id
       and state = 'open'
       and lifecycle_phase = 'auth_provisional'
       and provider_expires_at = provider_deadline;
    if not found then
      raise exception 'synthetic session phase promotion conflicts';
    end if;
    requested_admission_id := new_payload ->> 'cleanup_admission_id';
    delete from public.sophia_voice_lab_cleanup_admissions
     where sophia_voice_lab_cleanup_admissions.admission_id::text =
           requested_admission_id
       and cleanup_obligation_id = cleanup_id
       and resource_kind = 'session'
       and resource_id = new.thread_id
       and status = 'reserved'
       and lease_expires_at > clock_timestamp();
    if not found then
      raise exception 'synthetic cleanup allocation admission is missing or expired';
    end if;
  elsif tg_table_name = 'sophia_sessions' and tg_op = 'UPDATE' then
    receipt := new_payload -> 'voice_provider_trace_fault_restore_receipt';
    requested_admission_id := coalesce(
      new_payload ->> 'cleanup_provider_admission_id',
      receipt ->> 'cleanup_provider_admission_id'
    );
    if requested_admission_id is not null then
      select status, resource_id, lease_expires_at <= clock_timestamp()
        into admission_status, admission_resource, admission_lease_expired
        from public.sophia_voice_lab_cleanup_admissions
       where sophia_voice_lab_cleanup_admissions.admission_id::text =
             requested_admission_id
         and cleanup_obligation_id = cleanup_id
         and resource_kind = 'provider';
    end if;
    if finalization_transition then
      receipt := new_payload -> 'finalization_receipt';
      expected_receipt := jsonb_build_object(
        'schema', 'sophia_voice_lab_postgres_finalization_receipt_v1',
        'storage', 'postgres_session',
        'object_path', 'public.sophia_sessions/' || new.id
          || '/metadata/synthetic_voice_lab/finalization_receipt',
        'sha256', public.sophia_voice_lab_finalization_receipt_sha256(
          new.user_id, new.id, new.thread_id, new_payload,
          new.metadata -> 'expected_deployment',
          new_payload ->> 'finalized_at',
          (new_payload ->> 'retention_hours')::integer,
          new_payload ->> 'retention_expires_at',
          new_payload ->> 'provider_expires_at',
          new.message_revision, new.message_count,
          receipt ->> 'transcript_sha256', receipt ->> 'started_at',
          (receipt ->> 'turn_count')::integer,
          receipt ->> 'capability_jti_sha256', receipt ->> 'object_path'
        ),
        'cleanup_obligation_id', cleanup_id,
        'transcript_sha256', receipt ->> 'transcript_sha256',
        'finalized_at', new_payload ->> 'finalized_at',
        'retention_expires_at', new_payload ->> 'retention_expires_at',
        'provider_expires_at', new_payload ->> 'provider_expires_at',
        'message_revision', new.message_revision,
        'message_count', new.message_count,
        'started_at', receipt ->> 'started_at',
        'turn_count', (receipt ->> 'turn_count')::integer,
        'capability_jti_sha256', receipt ->> 'capability_jti_sha256'
      );
      if obligation_state <> 'closed'
         or obligation_phase <> 'finalized'
         or obligation_retention is distinct from retention_deadline
         or obligation_provider is distinct from provider_deadline
         or receipt is distinct from expected_receipt
         or receipt ->> 'transcript_sha256' !~ '^[a-f0-9]{64}$'
         or receipt ->> 'capability_jti_sha256' !~ '^[a-f0-9]{64}$'
         or (select count(*) from public.sophia_session_messages
              where session_id = new.id and user_id = new.user_id)
              <> new.message_count
      then
        raise exception 'synthetic finalization transition is invalid';
      end if;
    elsif provider_bind_transition then
      if obligation_state <> 'open'
         or admission_status <> 'credential_minted'
         or admission_resource is distinct from
              new_payload ->> 'voice_runtime_session_id'
         or obligation_provider_settlement_sha256 is distinct from
              new_payload ->> 'voice_d02_gateway_provider_settlement_sha256'
      then
        raise exception 'synthetic provider credential transition is invalid';
      end if;
    elsif provider_activation_transition or provider_stage_transition then
      if obligation_state <> 'open'
         or admission_status <> 'browser_active'
         or admission_resource is distinct from
              new_payload ->> 'voice_runtime_session_id'
      then
        raise exception 'synthetic provider active transition is invalid';
      end if;
    elsif d02_terminal_transition then
      if obligation_state <> 'closed'
         or obligation_provider_settlement_sha256 is distinct from
              new_payload ->> 'voice_d02_gateway_provider_settlement_sha256'
         or admission_status not in ('activation_aborted', 'browser_closed')
         or admission_resource is distinct from
              new_payload ->> 'voice_runtime_session_id'
         or not exists (
           select 1
             from public.sophia_voice_lab_d02_gateway_settlements d02_settlement
            where d02_settlement.cleanup_obligation_id = cleanup_id
              and d02_settlement.provider_admission_id::text = requested_admission_id
              and d02_settlement.provider_session_id = admission_resource
              and d02_settlement.voice_terminal_receipt =
                    new_payload -> 'voice_d02_voice_terminal_receipt'
              and d02_settlement.receipt is null
         )
      then
        raise exception 'synthetic D02 provider terminal transition is invalid';
      end if;
    elsif provider_cleanup_transition then
      if obligation_state <> 'closed'
         or admission_status not in ('activation_aborted', 'browser_closed')
         or admission_resource is distinct from
              new_payload ->> 'voice_runtime_session_id'
      then
        raise exception 'synthetic provider cleanup transition is invalid';
      end if;
    elsif provider_receipt_transition then
      if receipt ->> 'schema' is distinct from
           'sophia_voice_lab_provider_trace_fault_terminal_v1'
         or (select array_agg(key order by key)
               from jsonb_object_keys(receipt) key) is distinct from array[
              'cleanup_obligation_id', 'cleanup_provider_admission_id',
              'provider_session_id', 'schema', 'trace_fault'
            ]::text[]
         or jsonb_typeof(receipt -> 'trace_fault') <> 'object'
         or receipt ->> 'cleanup_obligation_id' is distinct from cleanup_id
         or receipt ->> 'cleanup_provider_admission_id' is distinct from
              requested_admission_id
         or receipt ->> 'provider_session_id' is distinct from admission_resource
         or not (
           (
             new_payload ->> 'voice_runtime_session_id' is null
             and new_payload ->> 'cleanup_provider_admission_id' is null
             and new_payload ->> 'voice_provider_resource_state' is null
             and admission_status in ('reserved', 'allocating')
             and (admission_status <> 'reserved' or admission_lease_expired)
             and obligation_state in ('open', 'closed')
           )
           or (
             new_payload ->> 'voice_provider_resource_state' = 'closed'
             and admission_status in ('activation_aborted', 'browser_closed')
             and new_payload ->> 'cleanup_provider_admission_id' =
                   requested_admission_id
             and new_payload ->> 'voice_runtime_session_id' =
                   admission_resource
             and obligation_state = 'closed'
           )
         )
      then
        raise exception 'synthetic provider terminal receipt transition is invalid';
      end if;
    elsif obligation_state <> 'open' then
      raise exception 'synthetic cleanup obligation admission is closed';
    end if;
    if (
         not finalization_transition
         and obligation_retention is distinct from retention_deadline
       )
       or obligation_provider is distinct from provider_deadline
    then
      raise exception 'synthetic cleanup deadline binding conflicts';
    end if;
  elsif tg_table_name = 'artifact_registry_records' then
    if obligation_state <> 'open'
       or obligation_retention is distinct from retention_deadline
       or obligation_provider is distinct from provider_deadline
       or clock_timestamp() >= retention_deadline
    then
      raise exception 'synthetic cleanup obligation admission is closed';
    end if;
  elsif tg_table_name = 'sophia_voice_lab_auth_grants' then
    if not auth_cleanup_transition then
      if obligation_state <> 'open'
         or obligation_phase <> 'auth_provisional'
         or obligation_retention is distinct from provider_deadline
         or obligation_provider is distinct from provider_deadline
         or clock_timestamp() >= provider_deadline
         or new.expires_at > provider_deadline
         or new.retention_hours not between 1 and 168
         or not exists (
           select 1
             from public."session" auth_session
            where auth_session."userId" = new.principal_id
              and auth_session."expiresAt" > clock_timestamp()
              and encode(
                    sha256(convert_to(auth_session.token, 'UTF8')),
                    'hex'
                  ) = new.session_token_sha256
         )
      then
        raise exception 'synthetic cleanup obligation admission is closed';
      end if;
    elsif obligation_state <> 'closed'
       or obligation_provider is distinct from provider_deadline
    then
      raise exception 'synthetic auth cleanup requires a closed obligation';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.sophia_voice_lab_message_write_fence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  parent_row public.sophia_sessions%rowtype;
  old_parent public.sophia_sessions%rowtype;
  new_parent public.sophia_sessions%rowtype;
  old_governed boolean := false;
  new_governed boolean := false;
  cleanup_id text;
  obligation_state text;
  obligation_phase text;
  obligation_retention timestamptz;
  obligation_provider timestamptz;
  parent_retention timestamptz;
  parent_provider timestamptz;
  target_session_id text;
begin
  if tg_op <> 'INSERT' then
    select * into old_parent
      from public.sophia_sessions
     where id = old.session_id;
    old_governed := found
      and old_parent.metadata -> 'synthetic_voice_lab' ->> 'synthetic' = 'true';
  end if;
  if tg_op <> 'DELETE' then
    select * into new_parent
      from public.sophia_sessions
     where id = new.session_id;
    new_governed := found
      and new_parent.metadata -> 'synthetic_voice_lab' ->> 'synthetic' = 'true';
  end if;
  if tg_op = 'UPDATE'
     and (old_governed or new_governed)
     and (
       old.session_id is distinct from new.session_id
       or old_governed is distinct from new_governed
     )
  then
    raise exception 'synthetic transcript parent binding is immutable';
  end if;
  target_session_id := case
    when tg_op = 'DELETE' then old.session_id
    else new.session_id
  end;
  if tg_op = 'DELETE' then
    parent_row := old_parent;
  else
    parent_row := new_parent;
  end if;
  if parent_row.id is null then
    raise exception 'synthetic transcript parent session is unavailable';
  end if;
  cleanup_id := parent_row.metadata -> 'synthetic_voice_lab'
    ->> 'cleanup_obligation_id';
  if parent_row.metadata -> 'synthetic_voice_lab' ->> 'synthetic' <> 'true'
     or cleanup_id is null
  then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if cleanup_id !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception 'synthetic transcript cleanup identity is malformed';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(cleanup_id, 731944));
  select * into parent_row
    from public.sophia_sessions
   where id = target_session_id
   for key share;
  if not found
     or parent_row.metadata -> 'synthetic_voice_lab'
          ->> 'cleanup_obligation_id' is distinct from cleanup_id
  then
    raise exception 'synthetic transcript parent binding conflicts';
  end if;
  begin
    parent_retention := (
      parent_row.metadata -> 'synthetic_voice_lab'
        ->> 'retention_expires_at'
    )::timestamptz;
    parent_provider := (
      parent_row.metadata -> 'synthetic_voice_lab'
        ->> 'provider_expires_at'
    )::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'synthetic transcript cleanup deadline is malformed';
  end;
  select state, lifecycle_phase, retention_expires_at, provider_expires_at
    into obligation_state, obligation_phase,
         obligation_retention, obligation_provider
    from public.sophia_voice_lab_cleanup_obligations
   where cleanup_obligation_id = cleanup_id
   for update;
  if obligation_state is null then
    raise exception 'synthetic transcript cleanup fence is unavailable';
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if obligation_state <> 'open'
       or obligation_phase not in ('session_provisional', 'finalizing')
       or new.user_id is distinct from parent_row.user_id
       or new.thread_id is distinct from parent_row.thread_id
    then
      raise exception 'synthetic transcript cleanup obligation is closed';
    end if;
    return new;
  end if;
  if not (
       obligation_state = 'open'
       and obligation_phase = 'finalizing'
     )
     and not (
       obligation_state = 'closed'
       and obligation_retention is not distinct from parent_retention
       and obligation_provider is not distinct from parent_provider
       and clock_timestamp() >= obligation_retention
       and not exists (
         select 1
           from public.sophia_voice_lab_cleanup_admissions admission
          where admission.cleanup_obligation_id = cleanup_id
       )
     )
  then
    raise exception 'synthetic transcript retention deletion is unavailable';
  end if;
  return old;
end;
$$;

revoke all on function public.sophia_voice_lab_receipt_part(text) from public;
revoke all on function public.sophia_voice_lab_finalization_receipt_sha256(
  text, text, text, jsonb, jsonb, text, integer, text, text, bigint,
  integer, text, text, integer, text, text
) from public;
revoke all on function public.sophia_finalize_voice_lab_session(
  text, text, bigint, text, text, integer, jsonb, jsonb, jsonb, text,
  text, text, integer, text, jsonb
) from public;
revoke all on function public.sophia_purge_voice_lab_session(
  text, text, text, text, text
) from public;
revoke all on function public.sophia_voice_lab_cleanup_write_fence() from public;
revoke all on function public.sophia_voice_lab_message_write_fence() from public;
revoke all on function public.sophia_voice_lab_d02_canonical_json(jsonb)
  from public;
revoke all on function public.sophia_voice_lab_d02_hmac_sha256(bytea, bytea)
  from public;
revoke all on function public.sophia_voice_lab_d02_finalize_proof_valid(
  text, text, jsonb, jsonb, text
) from public;
revoke all on function public.sophia_voice_lab_d02_finalize_authority_ready(
  text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_register_capability_use_state(
  text, text, text, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_register_capability_use(
  text, text, text, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_freeze_authorize(
  text, text, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_freeze_finalize(
  text, text, text, uuid, text, text, jsonb, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_provider_freeze(
  text, uuid, text
) from public;
revoke all on function public.sophia_voice_lab_d02_producer_open(text)
  from public;
revoke all on function public.sophia_voice_lab_d02_sources_zero(text)
  from public;
revoke all on function public.sophia_voice_lab_d02_browser_settlement(
  jsonb, text
) from public;
revoke all on function public.sophia_voice_lab_d02_voice_terminal_authorize(
  text, uuid, text
) from public;
revoke all on function public.sophia_voice_lab_d02_voice_terminal_finalize(
  text, uuid, text, text, jsonb, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_settlement_authorize(
  text, text, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_settlement_finalize(
  text, text, text, uuid, text, text, text, jsonb, text, jsonb, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_relay_begin(
  uuid, text, text, integer, text, text, integer, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_relay_refresh(
  uuid, text, text, integer, text, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_relay_end(
  uuid, text, text, text, text, text
) from public;
revoke all on function public.sophia_voice_lab_d02_continuity_authorize(
  text, text, text, text, text, timestamptz
) from public;
revoke all on function public.sophia_voice_lab_d02_continuity_finalize(
  text, text, text, text, text, text, text, text, text, jsonb, text, text
) from public;
revoke all on public.sophia_voice_lab_cleanup_obligations from public;
revoke all on public.sophia_voice_lab_cleanup_admissions from public;
revoke all on public.sophia_voice_lab_cleanup_scan_cursors from public;
revoke all on public.sophia_voice_lab_d02_gateway_settlements from public;
revoke all on public.sophia_voice_lab_d02_gateway_capability_uses from public;
revoke all on public.sophia_voice_lab_d02_gateway_relay_leases from public;
revoke all
  on public.sophia_voice_lab_d02_product_continuity_observations from public;
revoke all
  on public.sophia_voice_lab_d02_gateway_finalize_authority from public;
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles
     where rolname = 'sophia_voice_lab_gateway'
  ) then
    raise exception
      'required role sophia_voice_lab_gateway must be provisioned before migration';
  end if;
end
$$;
do $$
declare
  role_name text;
  function_signature text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'revoke all on function public.sophia_voice_lab_receipt_part(text) from %I',
        role_name
      );
      execute format(
        'revoke all on function public.sophia_voice_lab_finalization_receipt_sha256(text,text,text,jsonb,jsonb,text,integer,text,text,bigint,integer,text,text,integer,text,text) from %I',
        role_name
      );
      execute format(
        'revoke all on function public.sophia_finalize_voice_lab_session(text,text,bigint,text,text,integer,jsonb,jsonb,jsonb,text,text,text,integer,text,jsonb) from %I',
        role_name
      );
      execute format(
        'revoke all on function public.sophia_purge_voice_lab_session(text,text,text,text,text) from %I',
        role_name
      );
      execute format(
        'revoke all on function public.sophia_voice_lab_cleanup_write_fence() from %I',
        role_name
      );
      execute format(
        'revoke all on function public.sophia_voice_lab_message_write_fence() from %I',
        role_name
      );
      execute format(
        'revoke all on public.sophia_voice_lab_cleanup_obligations from %I',
        role_name
      );
      execute format(
        'revoke all on public.sophia_voice_lab_cleanup_admissions from %I',
        role_name
      );
      execute format(
        'revoke all on public.sophia_voice_lab_cleanup_scan_cursors from %I',
        role_name
      );
      execute format(
        'revoke all on public.sophia_voice_lab_d02_gateway_settlements from %I',
        role_name
      );
      execute format(
        'revoke all on public.sophia_voice_lab_d02_gateway_capability_uses from %I',
        role_name
      );
      execute format(
        'revoke all on public.sophia_voice_lab_d02_gateway_relay_leases from %I',
        role_name
      );
      execute format(
        'revoke all on public.sophia_voice_lab_d02_product_continuity_observations from %I',
        role_name
      );
      execute format(
        'revoke all on public.sophia_voice_lab_d02_gateway_finalize_authority from %I',
        role_name
      );
    end if;
  end loop;
  foreach role_name in array array[
    'anon', 'authenticated', 'service_role',
    'better_auth_app', 'sophia_voice_lab_gateway'
  ] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      foreach function_signature in array array[
        'public.sophia_voice_lab_d02_canonical_json(jsonb)',
        'public.sophia_voice_lab_d02_hmac_sha256(bytea,bytea)',
        'public.sophia_voice_lab_d02_finalize_proof_valid(text,text,jsonb,jsonb,text)',
        'public.sophia_voice_lab_d02_finalize_authority_ready(text,text)',
        'public.sophia_voice_lab_d02_register_capability_use_state(text,text,text,text,text)',
        'public.sophia_voice_lab_d02_register_capability_use(text,text,text,text,text)',
        'public.sophia_voice_lab_d02_freeze_authorize(text,text,text,text)',
        'public.sophia_voice_lab_d02_freeze_finalize(text,text,text,uuid,text,text,jsonb,text,text)',
        'public.sophia_voice_lab_d02_provider_freeze(text,uuid,text)',
        'public.sophia_voice_lab_d02_producer_open(text)',
        'public.sophia_voice_lab_d02_sources_zero(text)',
        'public.sophia_voice_lab_d02_browser_settlement(jsonb,text)',
        'public.sophia_voice_lab_d02_voice_terminal_authorize(text,uuid,text)',
        'public.sophia_voice_lab_d02_voice_terminal_finalize(text,uuid,text,text,jsonb,text,text)',
        'public.sophia_voice_lab_d02_settlement_authorize(text,text,text,text)',
        'public.sophia_voice_lab_d02_settlement_finalize(text,text,text,uuid,text,text,text,jsonb,text,jsonb,text,text)',
        'public.sophia_voice_lab_d02_relay_begin(uuid,text,text,integer,text,text,integer,text,text)',
        'public.sophia_voice_lab_d02_relay_refresh(uuid,text,text,integer,text,text,text)',
        'public.sophia_voice_lab_d02_relay_end(uuid,text,text,text,text,text)',
        'public.sophia_voice_lab_d02_continuity_authorize(text,text,text,text,text,timestamptz)',
        'public.sophia_voice_lab_d02_continuity_finalize(text,text,text,text,text,text,text,text,text,jsonb,text,text)'
      ] loop
        execute format(
          'revoke all on function %s from %I',
          function_signature,
          role_name
        );
      end loop;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'better_auth_app') then
    revoke create on schema public from better_auth_app;
    revoke all
      on public.sophia_sessions,
         public.sophia_session_messages,
         public.artifact_registry_records,
         public.sophia_voice_lab_auth_grants,
         public.sophia_voice_lab_cleanup_obligations,
         public.sophia_voice_lab_cleanup_admissions,
         public.sophia_voice_lab_cleanup_scan_cursors,
         public.sophia_voice_lab_d02_gateway_settlements,
         public.sophia_voice_lab_d02_gateway_capability_uses,
         public.sophia_voice_lab_d02_gateway_relay_leases,
         public.sophia_voice_lab_d02_product_continuity_observations,
         public.sophia_voice_lab_d02_gateway_finalize_authority
      from better_auth_app;
    grant select, insert, update, delete
      on public.sophia_voice_lab_auth_grants
      to better_auth_app;
    grant select, update
      on public.sophia_sessions
      to better_auth_app;
    grant select, insert, update, delete
      on public.sophia_voice_lab_cleanup_obligations
      to better_auth_app;
    grant select, insert, update, delete
      on public.sophia_voice_lab_cleanup_admissions
      to better_auth_app;
    grant select, update
      on public.sophia_voice_lab_cleanup_scan_cursors
      to better_auth_app;
    grant execute on function
      public.sophia_voice_lab_d02_sources_zero(text)
      to better_auth_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all
      on public.sophia_voice_lab_d02_gateway_settlements,
         public.sophia_voice_lab_d02_gateway_capability_uses,
         public.sophia_voice_lab_d02_gateway_relay_leases,
         public.sophia_voice_lab_d02_product_continuity_observations,
         public.sophia_voice_lab_d02_gateway_finalize_authority
      from service_role;
    grant execute on function public.sophia_finalize_voice_lab_session(
      text, text, bigint, text, text, integer, jsonb, jsonb, jsonb, text,
      text, text, integer, text, jsonb
    ) to service_role;
    grant execute on function public.sophia_purge_voice_lab_session(
      text, text, text, text, text
    ) to service_role;
  end if;
  if exists (
    select 1 from pg_roles where rolname = 'sophia_voice_lab_gateway'
  ) then
    revoke create on schema public from sophia_voice_lab_gateway;
    revoke all on all tables in schema public from sophia_voice_lab_gateway;
    revoke all on all sequences in schema public from sophia_voice_lab_gateway;
    revoke all on all functions in schema public from sophia_voice_lab_gateway;
    grant usage on schema public to sophia_voice_lab_gateway;
    grant execute on function
      public.sophia_voice_lab_d02_finalize_authority_ready(text,text),
      public.sophia_voice_lab_d02_freeze_authorize(text,text,text,text),
      public.sophia_voice_lab_d02_freeze_finalize(
        text,text,text,uuid,text,text,jsonb,text,text
      ),
      public.sophia_voice_lab_d02_provider_freeze(text,uuid,text),
      public.sophia_voice_lab_d02_producer_open(text),
      public.sophia_voice_lab_d02_sources_zero(text),
      public.sophia_voice_lab_d02_voice_terminal_authorize(text,uuid,text),
      public.sophia_voice_lab_d02_voice_terminal_finalize(
        text,uuid,text,text,jsonb,text,text
      ),
      public.sophia_voice_lab_d02_settlement_authorize(text,text,text,text),
      public.sophia_voice_lab_d02_settlement_finalize(
        text,text,text,uuid,text,text,text,jsonb,text,jsonb,text,text
      ),
      public.sophia_voice_lab_d02_relay_begin(
        uuid,text,text,integer,text,text,integer,text,text
      ),
      public.sophia_voice_lab_d02_relay_refresh(
        uuid,text,text,integer,text,text,text
      ),
      public.sophia_voice_lab_d02_relay_end(
        uuid,text,text,text,text,text
      ),
      public.sophia_voice_lab_d02_continuity_authorize(
        text,text,text,text,text,timestamptz
      ),
      public.sophia_voice_lab_d02_continuity_finalize(
        text,text,text,text,text,text,text,text,text,jsonb,text,text
      ) to sophia_voice_lab_gateway;
  end if;
end
$$;

drop trigger if exists sophia_voice_lab_cleanup_write_fence on public.sophia_sessions;
create trigger sophia_voice_lab_cleanup_write_fence
before insert or update or delete on public.sophia_sessions
for each row execute function public.sophia_voice_lab_cleanup_write_fence();

drop trigger if exists sophia_voice_lab_message_write_fence
  on public.sophia_session_messages;
create trigger sophia_voice_lab_message_write_fence
before insert or update or delete on public.sophia_session_messages
for each row execute function public.sophia_voice_lab_message_write_fence();

drop trigger if exists artifact_registry_voice_lab_cleanup_write_fence
  on public.artifact_registry_records;
create trigger artifact_registry_voice_lab_cleanup_write_fence
before insert or update or delete on public.artifact_registry_records
for each row execute function public.sophia_voice_lab_cleanup_write_fence();

drop trigger if exists sophia_voice_lab_auth_cleanup_write_fence
  on public.sophia_voice_lab_auth_grants;
create trigger sophia_voice_lab_auth_cleanup_write_fence
before insert or update or delete on public.sophia_voice_lab_auth_grants
for each row execute function public.sophia_voice_lab_cleanup_write_fence();

comment on index public.sophia_sessions_voice_lab_cleanup_obligation_idx is
  'sophia.voice-lab.cleanup-obligation-index.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ resource=sessions';
comment on index public.artifact_registry_voice_lab_cleanup_obligation_idx is
  'sophia.voice-lab.cleanup-obligation-index.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ resource=artifacts';
comment on function public.sophia_voice_lab_cleanup_write_fence() is
  'sophia.voice-lab.cleanup-obligation-write-fence.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__';
comment on function public.sophia_voice_lab_message_write_fence() is
  'sophia.voice-lab.cleanup-obligation-message-write-fence.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__';
comment on table public.sophia_voice_lab_cleanup_obligations is
  'sophia.voice-lab.cleanup-obligation-state.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ content=opaque-control-only';
comment on table public.sophia_voice_lab_cleanup_admissions is
  'sophia.voice-lab.cleanup-admission-state.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ content=bounded-opaque-resource-locator-no-principal-run-secret';
comment on table public.sophia_voice_lab_cleanup_scan_cursors is
  'sophia.voice-lab.cleanup-scan-cursor.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ content=opaque-control-keyset-only';
comment on table public.sophia_voice_lab_d02_gateway_settlements is
  'sophia.voice-lab.d02-gateway-settlement.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ content=bounded-authority-receipt-no-raw-principal';
comment on table public.sophia_voice_lab_d02_gateway_capability_uses is
  'sophia.voice-lab.d02-gateway-capability-use.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ content=opaque-replay-binding-only';
comment on table public.sophia_voice_lab_d02_gateway_relay_leases is
  'sophia.voice-lab.d02-gateway-relay-lease.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ content=opaque-live-relay-authority-only';
comment on table public.sophia_voice_lab_d02_product_continuity_observations is
  'sophia.voice-lab.d02-product-continuity-observation.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ content=hashed-product-projection-signed-receipt-only';
comment on table public.sophia_voice_lab_d02_gateway_finalize_authority is
  'sophia.voice-lab.d02-database-finalize-authority.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ content=owner-only-key-material-never-runtime-readable';
comment on function public.sophia_voice_lab_d02_canonical_json(jsonb) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=canonical-json exposure=owner-internal';
comment on function public.sophia_voice_lab_d02_hmac_sha256(bytea,bytea) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=hmac-sha256 exposure=owner-internal';
comment on function public.sophia_voice_lab_d02_finalize_proof_valid(
  text,text,jsonb,jsonb,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=finalize-proof-valid exposure=owner-internal';
comment on function public.sophia_voice_lab_d02_finalize_authority_ready(
  text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=authority-ready exposure=gateway-readback';
comment on function public.sophia_voice_lab_d02_register_capability_use_state(
  text,text,text,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=capability-state exposure=owner-internal';
comment on function public.sophia_voice_lab_d02_register_capability_use(
  text,text,text,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=capability-use exposure=owner-internal';
comment on function public.sophia_voice_lab_d02_freeze_authorize(
  text,text,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=freeze-authorize exposure=gateway-execute';
comment on function public.sophia_voice_lab_d02_freeze_finalize(
  text,text,text,uuid,text,text,jsonb,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=freeze-finalize exposure=gateway-execute-hmac';
comment on function public.sophia_voice_lab_d02_provider_freeze(
  text,uuid,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=provider-freeze exposure=gateway-readback';
comment on function public.sophia_voice_lab_d02_producer_open(text) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=producer-open exposure=gateway-readback';
comment on function public.sophia_voice_lab_d02_sources_zero(text) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=sources-zero exposure=gateway-runtime-readback';
comment on function public.sophia_voice_lab_d02_browser_settlement(
  jsonb,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=browser-settlement exposure=owner-internal';
comment on function public.sophia_voice_lab_d02_voice_terminal_authorize(
  text,uuid,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=voice-terminal-authorize exposure=gateway-execute';
comment on function public.sophia_voice_lab_d02_voice_terminal_finalize(
  text,uuid,text,text,jsonb,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=voice-terminal-finalize exposure=gateway-execute-hmac';
comment on function public.sophia_voice_lab_d02_settlement_authorize(
  text,text,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=settlement-authorize exposure=gateway-execute';
comment on function public.sophia_voice_lab_d02_settlement_finalize(
  text,text,text,uuid,text,text,text,jsonb,text,jsonb,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=settlement-finalize exposure=gateway-execute-hmac';
comment on function public.sophia_voice_lab_d02_relay_begin(
  uuid,text,text,integer,text,text,integer,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=relay-begin exposure=gateway-execute-hmac';
comment on function public.sophia_voice_lab_d02_relay_refresh(
  uuid,text,text,integer,text,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=relay-refresh exposure=gateway-execute-hmac';
comment on function public.sophia_voice_lab_d02_relay_end(
  uuid,text,text,text,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=relay-end exposure=gateway-execute-hmac';
comment on function public.sophia_voice_lab_d02_continuity_authorize(
  text,text,text,text,text,timestamptz
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=continuity-authorize exposure=gateway-execute';
comment on function public.sophia_voice_lab_d02_continuity_finalize(
  text,text,text,text,text,text,text,text,text,jsonb,text,text
) is
  'sophia.voice-lab.d02-database-rpc.v1 migration_sha256=__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__ operation=continuity-finalize exposure=gateway-execute-hmac';

notify pgrst, 'reload schema';

commit;
