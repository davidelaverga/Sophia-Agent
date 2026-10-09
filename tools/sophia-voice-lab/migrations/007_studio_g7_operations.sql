-- Additive Studio G7 operation type (Voice Lab schema v7).
-- Apply only through the independently attested, quiescent upgrade path
-- (src/bin/upgrade-studio-g7-operations.ts) or as part of the composed v7
-- bundle on a fresh schema. Every existing row and every legacy operation type
-- is unchanged; the operations type check admits one more value,
-- 'studio_action', used only by Studio LiveKit G7 runs for non-voice steps
-- (leave and return, a section-only revision, a stale edit, a withdrawal).
do $studio_g7_operations_upgrade$
declare
  target_constraint text;
  target_count integer;
begin
  select count(*), min(c.conname)
    into target_count, target_constraint
    from pg_constraint c
    where c.conrelid = 'sophia_voice_lab.operations'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%force_socket_rotation%';
  if target_count <> 1 then
    raise exception 'STUDIO_G7_OPERATIONS_SOURCE_CONSTRAINT_INVALID';
  end if;
  execute format('alter table sophia_voice_lab.operations drop constraint %I', target_constraint);
  execute format($constraint$
    alter table sophia_voice_lab.operations add constraint %I check (
      type in ('start','speak','barge_in','force_socket_rotation','end','studio_action')
    )
  $constraint$, target_constraint);
end
$studio_g7_operations_upgrade$;
