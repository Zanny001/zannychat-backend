-- Conversation polls with single-choice voting. Multi-select and events are future work.
create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  question text not null check (char_length(btrim(question)) between 1 and 240),
  closes_at timestamptz,
  created_at timestamptz not null default now(),
  check (closes_at is null or closes_at > created_at)
);
create table if not exists public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  position integer not null check (position between 0 and 9),
  unique (poll_id, position), unique (poll_id, label)
);
create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  option_id uuid not null references public.poll_options(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);
create index if not exists polls_conversation_created_idx on public.polls(conversation_id, created_at desc);
create index if not exists poll_votes_option_idx on public.poll_votes(option_id);
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;

create policy "Conversation members read polls" on public.polls for select to authenticated using (
 exists (select 1 from public.conversation_participants cp where cp.conversation_id = polls.conversation_id and cp.user_id = (select auth.uid()))
);
create policy "Conversation members create polls" on public.polls for insert to authenticated with check (
 creator_id = (select auth.uid()) and exists (select 1 from public.conversation_participants cp where cp.conversation_id = polls.conversation_id and cp.user_id = (select auth.uid()))
);
create policy "Creators delete polls" on public.polls for delete to authenticated using (creator_id = (select auth.uid()));
create policy "Members read poll options" on public.poll_options for select to authenticated using (
 exists (select 1 from public.polls p join public.conversation_participants cp on cp.conversation_id = p.conversation_id where p.id = poll_options.poll_id and cp.user_id = (select auth.uid()))
);
create policy "Poll creators add options" on public.poll_options for insert to authenticated with check (
 exists (select 1 from public.polls p where p.id = poll_options.poll_id and p.creator_id = (select auth.uid()))
);
create policy "Members read poll votes" on public.poll_votes for select to authenticated using (
 exists (select 1 from public.polls p join public.conversation_participants cp on cp.conversation_id = p.conversation_id where p.id = poll_votes.poll_id and cp.user_id = (select auth.uid()))
);
create policy "Members vote once on open polls" on public.poll_votes for insert to authenticated with check (
 user_id = (select auth.uid())
 and exists (select 1 from public.polls p join public.conversation_participants cp on cp.conversation_id = p.conversation_id where p.id = poll_votes.poll_id and cp.user_id = (select auth.uid()) and (p.closes_at is null or p.closes_at > now()))
 and exists (select 1 from public.poll_options o where o.id = poll_votes.option_id and o.poll_id = poll_votes.poll_id)
);
create policy "Voters can change their vote on open polls" on public.poll_votes for update to authenticated using (user_id = (select auth.uid()) and exists (select 1 from public.polls p where p.id = poll_votes.poll_id and (p.closes_at is null or p.closes_at > now()))) with check (user_id = (select auth.uid()));
create policy "Voters can retract their vote" on public.poll_votes for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.polls, public.poll_options, public.poll_votes from anon;
grant select on public.polls, public.poll_options, public.poll_votes to authenticated;
-- Mutations are intentionally RPC-only so poll creation is atomic and votes are validated.

-- Atomic creation prevents orphan polls when an option insert fails.
create or replace function public.create_conversation_poll(p_conversation_id uuid, p_question text, p_options text[], p_closes_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_poll_id uuid; v_option text; v_position integer := 0; v_question text := btrim(coalesce(p_question, ''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(v_question) not between 1 and 240 then raise exception 'Question must be 1-240 characters'; end if;
  if p_options is null or cardinality(p_options) not between 2 and 10 then raise exception 'Provide 2-10 options'; end if;
  if p_closes_at is not null and p_closes_at <= now() then raise exception 'Poll closing time must be in the future'; end if;
  if not exists (select 1 from public.conversation_participants cp where cp.conversation_id = p_conversation_id and cp.user_id = auth.uid()) then raise exception 'Conversation membership required'; end if;
  if exists (select 1 from unnest(p_options) x where char_length(btrim(coalesce(x, ''))) not between 1 and 120) then raise exception 'Each option must be 1-120 characters'; end if;
  if (select count(distinct lower(btrim(x))) from unnest(p_options) x) <> cardinality(p_options) then raise exception 'Options must be unique'; end if;
  insert into public.polls(conversation_id, creator_id, question, closes_at) values (p_conversation_id, auth.uid(), v_question, p_closes_at) returning id into v_poll_id;
  foreach v_option in array p_options loop
    insert into public.poll_options(poll_id, label, position) values (v_poll_id, btrim(v_option), v_position);
    v_position := v_position + 1;
  end loop;
  return v_poll_id;
end; $$;
create or replace function public.cast_poll_vote(p_poll_id uuid, p_option_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.polls p join public.conversation_participants cp on cp.conversation_id = p.conversation_id where p.id = p_poll_id and cp.user_id = auth.uid() and (p.closes_at is null or p.closes_at > now())) then raise exception 'Poll is closed or unavailable'; end if;
  if not exists (select 1 from public.poll_options o where o.id = p_option_id and o.poll_id = p_poll_id) then raise exception 'Invalid option'; end if;
  insert into public.poll_votes(poll_id, option_id, user_id) values (p_poll_id, p_option_id, auth.uid())
  on conflict (poll_id, user_id) do update set option_id = excluded.option_id, created_at = now();
end; $$;
revoke all on function public.create_conversation_poll(uuid, text, text[], timestamptz) from public, anon;
revoke all on function public.cast_poll_vote(uuid, uuid) from public, anon;
grant execute on function public.create_conversation_poll(uuid, text, text[], timestamptz) to authenticated;
grant execute on function public.cast_poll_vote(uuid, uuid) to authenticated;
