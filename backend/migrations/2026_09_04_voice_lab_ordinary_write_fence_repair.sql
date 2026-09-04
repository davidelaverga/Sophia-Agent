-- sophia.voice-lab.ordinary-write-fence-repair.v1 migration_sha256=__SOPHIA_VOICE_LAB_ORDINARY_WRITE_FENCE_REPAIR_SHA256__
--
-- The cleanup fence is shared by synthetic and ordinary product rows.  SQL
-- comparisons against a missing JSON field evaluate to NULL, not FALSE.  The
-- original function therefore routed ordinary rows without a synthetic marker
-- into the synthetic cleanup-obligation checks.  Repair only those four
-- classifiers, against an exact source fingerprint, and preserve every other
-- fence invariant and ACL.
begin;

do $ordinary_write_fence_repair$
declare
  current_source text;
  repaired_source text;
  current_sha256 text;
  repaired_sha256 text;
  expected_current_sha256 constant text :=
    '4faacbb98b20ee4e955ae8343e55c163060f9963104c384dadb1263249d28fad';
  expected_repaired_sha256 constant text :=
    '0678607736ee21130257e2a87f79bc807d12a0f6d22295f55079ff6bbb4aa1b2';
  old_session_old constant text :=
    'old_synthetic := old_payload ->> ''synthetic'' = ''true'';';
  new_session_old constant text :=
    'new_synthetic := new_payload ->> ''synthetic'' = ''true'';';
  old_artifact_old constant text :=
    'old_synthetic := old_payload ->> ''synthetic_test'' = ''true'';';
  new_artifact_old constant text :=
    'new_synthetic := new_payload ->> ''synthetic_test'' = ''true'';';
  old_session_new constant text :=
    'old_synthetic := coalesce(old_payload ->> ''synthetic'' = ''true'', false);';
  new_session_new constant text :=
    'new_synthetic := coalesce(new_payload ->> ''synthetic'' = ''true'', false);';
  old_artifact_new constant text :=
    'old_synthetic := coalesce(old_payload ->> ''synthetic_test'' = ''true'', false);';
  new_artifact_new constant text :=
    'new_synthetic := coalesce(new_payload ->> ''synthetic_test'' = ''true'', false);';
begin
  select procedure.prosrc,
         encode(
           sha256(convert_to(procedure.prosrc, 'UTF8')),
           'hex'
         )
    into current_source, current_sha256
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
     and procedure.proname = 'sophia_voice_lab_cleanup_write_fence'
     and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = '';

  if current_source is null then
    raise exception 'Voice Lab cleanup write fence is unavailable';
  end if;

  if current_sha256 = expected_repaired_sha256 then
    return;
  end if;
  if current_sha256 <> expected_current_sha256 then
    raise exception 'Voice Lab cleanup write fence source drifted before repair';
  end if;

  repaired_source := replace(current_source, old_session_old, old_session_new);
  repaired_source := replace(repaired_source, new_session_old, new_session_new);
  repaired_source := replace(repaired_source, old_artifact_old, old_artifact_new);
  repaired_source := replace(repaired_source, new_artifact_old, new_artifact_new);
  repaired_sha256 := encode(
    sha256(convert_to(repaired_source, 'UTF8')),
    'hex'
  );

  if repaired_sha256 <> expected_repaired_sha256
     or position(old_session_old in repaired_source) <> 0
     or position(new_session_old in repaired_source) <> 0
     or position(old_artifact_old in repaired_source) <> 0
     or position(new_artifact_old in repaired_source) <> 0
     or position(old_session_new in repaired_source) = 0
     or position(new_session_new in repaired_source) = 0
     or position(old_artifact_new in repaired_source) = 0
     or position(new_artifact_new in repaired_source) = 0
  then
    raise exception 'Voice Lab cleanup write fence repair did not match the pinned transform';
  end if;

  execute format(
    'create or replace function public.sophia_voice_lab_cleanup_write_fence() '
      || 'returns trigger language plpgsql security definer '
      || 'set search_path = pg_catalog, public, pg_temp as %L',
    repaired_source
  );

  select encode(
           sha256(convert_to(procedure.prosrc, 'UTF8')),
           'hex'
         )
    into current_sha256
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
     and procedure.proname = 'sophia_voice_lab_cleanup_write_fence'
     and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = '';

  if current_sha256 <> expected_repaired_sha256 then
    raise exception 'Voice Lab cleanup write fence repair verification failed';
  end if;
end
$ordinary_write_fence_repair$;

commit;
