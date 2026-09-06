-- MEM00 ordinary transcript deletion ordering. Requires explicit production approval.
-- No rows are changed by applying this migration. Existing synthetic fences remain intact.
begin;

do $pin$
declare
  actual text;
begin
  select encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') into actual
    from pg_catalog.pg_proc
   where oid = to_regprocedure('public.sophia_voice_lab_message_write_fence()');
  if actual is distinct from '11adcf09844e96acbdc00e76bd9d6504a9a834540a3d30774e09a45b15a032f3' then
    raise exception 'ordinary delete message fence contract drifted';
  end if;
  select encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') into actual
    from pg_catalog.pg_proc
   where oid = to_regprocedure('public.sophia_mem00_ordinary_session_delete_order()');
  if found and actual <> '4087a488f957a0fb77d758de1db94f9938644411103ecfc77c62f5b9664716ce' then
    raise exception 'ordinary delete order function drifted';
  end if;
  if exists (
    select 1 from pg_catalog.pg_trigger
     where tgrelid = 'public.sophia_sessions'::regclass
       and tgname = 'sophia_mem00_ordinary_session_delete_order'
       and tgfoid is distinct from to_regprocedure('public.sophia_mem00_ordinary_session_delete_order()')
  ) then
    raise exception 'ordinary delete order trigger drifted';
  end if;
end
$pin$;

create or replace function public.sophia_mem00_ordinary_session_delete_order()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  -- Do not take over governed synthetic deletion or its retention authority.
  if coalesce(old.metadata -> 'synthetic_voice_lab' ->> 'synthetic' = 'true', false) then
    return old;
  end if;
  -- A BEFORE DELETE trigger runs while the parent remains visible to the
  -- existing child fence. Both deletions roll back together on any failure.
  delete from public.sophia_session_messages
   where session_id = old.id and user_id = old.user_id;
  return old;
end;
$function$;

revoke all on function public.sophia_mem00_ordinary_session_delete_order()
  from public, anon, authenticated;

drop trigger if exists sophia_mem00_ordinary_session_delete_order on public.sophia_sessions;
create trigger sophia_mem00_ordinary_session_delete_order
before delete on public.sophia_sessions
for each row execute function public.sophia_mem00_ordinary_session_delete_order();

commit;
