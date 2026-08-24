-- HMAC-only tombstones for the dedicated Better Auth Voice Lab principal.
-- Active rows bind the exact session. Cleanup immediately replaces raw
-- principal/run and secret hashes with domain-separated HMAC identities or
-- zero digests, preserving replay/order fencing only through signed expiry.
begin;

create table if not exists public.sophia_voice_lab_auth_grants (
  grant_fingerprint char(64) primary key check (grant_fingerprint ~ '^[a-f0-9]{64}$'),
  principal_id text not null,
  test_run_id text not null,
  tombstone_kid text not null check (tombstone_kid ~ '^[A-Za-z0-9._-]{1,32}$'),
  cleanup_obligation_id text not null constraint
    sophia_voice_lab_auth_grants_cleanup_obligation_check check (
    cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or cleanup_obligation_id ~ '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'
  ),
  issued_at bigint not null,
  expires_at timestamptz not null,
  provider_expires_at timestamptz not null,
  retention_hours integer not null check (retention_hours between 1 and 168),
  jti_sha256 char(64) not null check (jti_sha256 ~ '^[a-f0-9]{64}$'),
  nonce_sha256 char(64) not null check (nonce_sha256 ~ '^[a-f0-9]{64}$'),
  session_token_sha256 char(64) not null check (session_token_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table public.sophia_voice_lab_auth_grants
  add column if not exists cleanup_obligation_id text;
alter table public.sophia_voice_lab_auth_grants
  add column if not exists tombstone_kid text;
alter table public.sophia_voice_lab_auth_grants
  add column if not exists provider_expires_at timestamptz;
alter table public.sophia_voice_lab_auth_grants
  add column if not exists retention_hours integer;
do $$ begin
  if exists (
    select 1 from public.sophia_voice_lab_auth_grants
    where cleanup_obligation_id is null
       or tombstone_kid is null
       or provider_expires_at is null
       or retention_hours is null
  ) then
    raise exception 'Voice Lab auth rows require operator-authored cleanup and provider authority';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'sophia_voice_lab_auth_grants_cleanup_obligation_check'
      and conrelid = 'public.sophia_voice_lab_auth_grants'::regclass
  ) then
    alter table public.sophia_voice_lab_auth_grants
      add constraint sophia_voice_lab_auth_grants_cleanup_obligation_check
      check (
        cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or cleanup_obligation_id ~ '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'sophia_voice_lab_auth_grants_tombstone_kid_check'
      and conrelid = 'public.sophia_voice_lab_auth_grants'::regclass
  ) then
    alter table public.sophia_voice_lab_auth_grants
      add constraint sophia_voice_lab_auth_grants_tombstone_kid_check
      check (tombstone_kid ~ '^[A-Za-z0-9._-]{1,32}$');
  end if;
end $$;
alter table public.sophia_voice_lab_auth_grants
  drop constraint if exists sophia_voice_lab_auth_grants_cleanup_obligation_id_check;
alter table public.sophia_voice_lab_auth_grants
  alter column cleanup_obligation_id set not null;
alter table public.sophia_voice_lab_auth_grants
  alter column tombstone_kid set not null;
alter table public.sophia_voice_lab_auth_grants
  alter column provider_expires_at set not null;
alter table public.sophia_voice_lab_auth_grants
  alter column retention_hours set not null;
alter table public.sophia_voice_lab_auth_grants
  drop constraint if exists sophia_voice_lab_auth_grants_retention_hours_check;
alter table public.sophia_voice_lab_auth_grants
  add constraint sophia_voice_lab_auth_grants_retention_hours_check
  check (retention_hours between 1 and 168);

create index if not exists sophia_voice_lab_auth_grants_principal_order_idx
  on public.sophia_voice_lab_auth_grants (principal_id, issued_at desc);
create index if not exists sophia_voice_lab_auth_grants_expiry_idx
  on public.sophia_voice_lab_auth_grants (expires_at);
create index if not exists sophia_voice_lab_auth_grants_cleanup_obligation_idx
  on public.sophia_voice_lab_auth_grants (cleanup_obligation_id);
create index if not exists sophia_voice_lab_auth_grants_tombstone_kid_expiry_idx
  on public.sophia_voice_lab_auth_grants (tombstone_kid, expires_at);
create unique index if not exists sophia_voice_lab_auth_grants_active_cleanup_idx
  on public.sophia_voice_lab_auth_grants (cleanup_obligation_id)
  where status = 'active';

comment on table public.sophia_voice_lab_auth_grants is
  'sophia.voice-lab.auth-ledger.v1 migration_sha256=__SOPHIA_VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256__';

revoke all on public.sophia_voice_lab_auth_grants from public;
do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format(
        'revoke all on public.sophia_voice_lab_auth_grants from %I',
        client_role
      );
    end if;
  end loop;
end $$;

commit;
