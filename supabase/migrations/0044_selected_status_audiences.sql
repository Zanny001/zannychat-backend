-- Selected-contact Status audiences. Server-side policies remain the security boundary.
-- Apply after 0043_scheduled_messages.sql.

alter table public.status_updates drop constraint if exists status_updates_audience_check;
alter table public.status_updates add constraint status_updates_audience_check
  check (audience in ('contacts', 'only_me', 'selected_contacts'));

create table if not exists public.status_audience_recipients (
  status_id uuid not null references public.status_updates(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (status_id, recipient_id),
  constraint status_audience_recipients_no_self check (owner_id <> recipient_id)
);
create index if not exists status_audience_recipients_recipient_idx
  on public.status_audience_recipients(recipient_id, status_id);
create index if not exists status_audience_recipients_owner_idx
  on public.status_audience_recipients(owner_id, status_id);
alter table public.status_audience_recipients enable row level security;
revoke all on public.status_audience_recipients from anon, authenticated;
grant select, insert, delete on public.status_audience_recipients to authenticated;

drop policy if exists "Status owner manages audience recipients" on public.status_audience_recipients;
create policy "Status owner manages audience recipients" on public.status_audience_recipients
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and recipient_id <> (select auth.uid())
    and exists (
      select 1 from public.status_updates s
      where s.id = status_audience_recipients.status_id
        and s.user_id = (select auth.uid())
        and s.audience = 'selected_contacts'
    )
    and exists (
      select 1 from public.conversation_participants mine
      join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
      where mine.user_id = (select auth.uid())
        and theirs.user_id = status_audience_recipients.recipient_id
    )
  );
drop policy if exists "Recipients can identify statuses shared with them" on public.status_audience_recipients;
create policy "Recipients can identify statuses shared with them" on public.status_audience_recipients
  for select to authenticated using (recipient_id = (select auth.uid()));

-- SECURITY DEFINER avoids recursive RLS evaluation while centralizing visibility rules.
create or replace function public.can_view_status(p_status_id uuid, p_viewer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    p_viewer_id = (select auth.uid())
    and exists (
      select 1
      from public.status_updates s
      where s.id = p_status_id
        and s.expires_at > now()
        and (
          s.user_id = p_viewer_id
          or (
            s.user_id <> p_viewer_id
            and not exists (
              select 1 from public.status_excluded_users x
              where x.owner_id = s.user_id and x.excluded_user_id = p_viewer_id
            )
            and (
              (s.audience = 'contacts' and exists (
                select 1 from public.conversation_participants mine
                join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
                where mine.user_id = p_viewer_id and theirs.user_id = s.user_id
              ))
              or (s.audience = 'selected_contacts' and exists (
                select 1 from public.status_audience_recipients r
                where r.status_id = s.id and r.owner_id = s.user_id and r.recipient_id = p_viewer_id
              ))
            )
          )
        )
    ), false
  );
$$;
revoke all on function public.can_view_status(uuid, uuid) from public, anon;
grant execute on function public.can_view_status(uuid, uuid) to authenticated;

-- Status row reads use the same authorization check for text and media metadata.
drop policy if exists "Status author can read own updates" on public.status_updates;
drop policy if exists "Conversation contacts can read contact statuses" on public.status_updates;
create policy "Authorized viewers can read active statuses" on public.status_updates
  for select to authenticated using (public.can_view_status(id, (select auth.uid())));

-- Private media is only accessible when its parent status is currently visible.
drop policy if exists "Status media visible to authorized viewers" on storage.objects;
create policy "Status media visible to authorized viewers" on storage.objects
  for select to authenticated using (
    bucket_id = 'status-media'
    and exists (
      select 1 from public.status_updates s
      where s.id::text = (storage.foldername(name))[2]
        and s.user_id::text = (storage.foldername(name))[1]
        and s.media_path = name
        and s.media_kind in ('image', 'video')
        and public.can_view_status(s.id, (select auth.uid()))
    )
  );

-- Receipts, reactions and replies must not bypass the audience check.
drop policy if exists "Eligible viewers can record own view" on public.status_views;
create policy "Eligible viewers can record own view" on public.status_views
  for insert to authenticated with check (
    viewer_id = (select auth.uid())
    and exists (select 1 from public.status_updates s where s.id = status_views.status_id and s.user_id <> (select auth.uid()))
    and public.can_view_status(status_id, (select auth.uid()))
  );

drop policy if exists "Eligible viewers can read status reactions" on public.status_reactions;
create policy "Eligible viewers can read status reactions" on public.status_reactions
  for select to authenticated using (
    public.can_view_status(status_id, (select auth.uid()))
    or exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.user_id = (select auth.uid()) and s.expires_at > now())
  );
drop policy if exists "Eligible viewers can react to statuses" on public.status_reactions;
create policy "Eligible viewers can react to statuses" on public.status_reactions
  for insert to authenticated with check (
    viewer_id = (select auth.uid())
    and exists (select 1 from public.status_updates s where s.id = status_reactions.status_id and s.user_id <> (select auth.uid()))
    and public.can_view_status(status_id, (select auth.uid()))
  );
drop policy if exists "Viewers can change own status reaction" on public.status_reactions;
create policy "Viewers can change own status reaction" on public.status_reactions
  for update to authenticated using (
    viewer_id = (select auth.uid()) and public.can_view_status(status_id, (select auth.uid()))
  ) with check (
    viewer_id = (select auth.uid()) and public.can_view_status(status_id, (select auth.uid()))
  );

drop policy if exists "Status owner and sender can read replies" on public.status_replies;
create policy "Status owner and sender can read replies" on public.status_replies
  for select to authenticated using (
    exists (
      select 1 from public.status_updates s
      where s.id = status_replies.status_id and s.expires_at > now()
        and (s.user_id = (select auth.uid()) or status_replies.sender_id = (select auth.uid()))
        and public.can_view_status(s.id, (select auth.uid()))
    )
  );
drop policy if exists "Eligible viewers can reply to statuses" on public.status_replies;
create policy "Eligible viewers can reply to statuses" on public.status_replies
  for insert to authenticated with check (
    sender_id = (select auth.uid())
    and char_length(trim(body)) between 1 and 1000
    and exists (select 1 from public.status_updates s where s.id = status_replies.status_id and s.user_id <> (select auth.uid()))
    and public.can_view_status(status_id, (select auth.uid()))
  );
