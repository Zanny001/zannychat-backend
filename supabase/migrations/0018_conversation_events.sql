-- Conversation events with participant-scoped visibility and one RSVP per member.
create table if not exists public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 1000),
  starts_at timestamptz not null,
  location text not null default '' check (char_length(location) <= 240),
  created_at timestamptz not null default now(),
  check (starts_at > created_at)
);
create table if not exists public.conversation_event_rsvps (
  event_id uuid not null references public.conversation_events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  response text not null check (response in ('going','maybe','not_going')),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists conversation_events_start_idx on public.conversation_events(conversation_id, starts_at);
alter table public.conversation_events enable row level security;
alter table public.conversation_event_rsvps enable row level security;
create policy "Conversation members read events" on public.conversation_events for select to authenticated using (
 exists (select 1 from public.conversation_participants cp where cp.conversation_id = conversation_events.conversation_id and cp.user_id = (select auth.uid()))
);
create policy "Conversation members read event RSVPs" on public.conversation_event_rsvps for select to authenticated using (
 exists (select 1 from public.conversation_events e join public.conversation_participants cp on cp.conversation_id = e.conversation_id where e.id = conversation_event_rsvps.event_id and cp.user_id = (select auth.uid()))
);
revoke all on public.conversation_events, public.conversation_event_rsvps from anon;
grant select on public.conversation_events, public.conversation_event_rsvps to authenticated;
create or replace function public.create_conversation_event(p_conversation_id uuid, p_title text, p_starts_at timestamptz, p_description text default '', p_location text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_title text := btrim(coalesce(p_title,'')); v_description text := coalesce(p_description,''); v_location text := coalesce(p_location,'');
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if char_length(v_title) not between 1 and 160 then raise exception 'Event title must be 1-160 characters'; end if;
 if char_length(v_description) > 1000 or char_length(v_location) > 240 then raise exception 'Event details are too long'; end if;
 if p_starts_at is null or p_starts_at <= now() then raise exception 'Event time must be in the future'; end if;
 if not exists (select 1 from public.conversation_participants cp where cp.conversation_id=p_conversation_id and cp.user_id=auth.uid()) then raise exception 'Conversation membership required'; end if;
 insert into public.conversation_events(conversation_id,creator_id,title,description,starts_at,location) values(p_conversation_id,auth.uid(),v_title,v_description,v_location,p_starts_at) returning id into v_id;
 return v_id;
end; $$;
create or replace function public.respond_to_conversation_event(p_event_id uuid, p_response text)
returns void language plpgsql security definer set search_path = public as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_response not in ('going','maybe','not_going') then raise exception 'Invalid RSVP response'; end if;
 if not exists (select 1 from public.conversation_events e join public.conversation_participants cp on cp.conversation_id=e.conversation_id where e.id=p_event_id and cp.user_id=auth.uid()) then raise exception 'Event unavailable'; end if;
 insert into public.conversation_event_rsvps(event_id,user_id,response,updated_at) values(p_event_id,auth.uid(),p_response,now()) on conflict(event_id,user_id) do update set response=excluded.response,updated_at=now();
end; $$;
revoke all on function public.create_conversation_event(uuid,text,timestamptz,text,text) from public, anon;
revoke all on function public.respond_to_conversation_event(uuid,text) from public, anon;
grant execute on function public.create_conversation_event(uuid,text,timestamptz,text,text) to authenticated;
grant execute on function public.respond_to_conversation_event(uuid,text) to authenticated;
