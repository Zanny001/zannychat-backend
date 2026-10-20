-- Private replies to active contact-visible status updates.
create table if not exists public.status_replies (
  id uuid primary key default gen_random_uuid(),
  status_id uuid not null references public.status_updates(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists status_replies_status_created_idx on public.status_replies(status_id, created_at asc);
create index if not exists status_replies_sender_idx on public.status_replies(sender_id, created_at desc);
alter table public.status_replies enable row level security;
drop policy if exists "Status owner and sender can read replies" on public.status_replies;
create policy "Status owner and sender can read replies" on public.status_replies
 for select to authenticated using (
  exists (select 1 from public.status_updates s where s.id = status_replies.status_id and s.expires_at > now()
   and (s.user_id = (select auth.uid()) or status_replies.sender_id = (select auth.uid()))
   and (s.user_id = (select auth.uid()) or (s.audience = 'contacts' and exists (
    select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id
   )))
  )
 );
drop policy if exists "Eligible viewers can reply to statuses" on public.status_replies;
create policy "Eligible viewers can reply to statuses" on public.status_replies
 for insert to authenticated with check (
  sender_id = (select auth.uid()) and char_length(trim(body)) between 1 and 1000
  and exists (select 1 from public.status_updates s where s.id = status_replies.status_id
   and s.user_id <> (select auth.uid()) and s.expires_at > now() and s.audience = 'contacts'
   and exists (select 1 from public.conversation_participants mine join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = s.user_id))
 );
revoke all on public.status_replies from anon;
revoke all on public.status_replies from authenticated;
grant select, insert on public.status_replies to authenticated;
