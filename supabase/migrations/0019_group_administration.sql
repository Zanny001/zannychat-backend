-- Group administration roles. Existing groups receive one initial admin: the
-- earliest joined participant. New groups explicitly mark their creator as admin.
alter table public.conversation_participants
  add column if not exists is_admin boolean not null default false;

with ranked_members as (
  select cp.conversation_id, cp.user_id,
         row_number() over (partition by cp.conversation_id order by cp.joined_at asc, cp.user_id asc) as member_rank
  from public.conversation_participants cp
  join public.conversations c on c.id = cp.conversation_id
  where c.is_group = true
)
update public.conversation_participants cp
set is_admin = true
from ranked_members rm
where rm.conversation_id = cp.conversation_id
  and rm.user_id = cp.user_id
  and rm.member_rank = 1
  and not exists (
    select 1 from public.conversation_participants existing_admin
    where existing_admin.conversation_id = cp.conversation_id and existing_admin.is_admin = true
  );

create index if not exists conversation_participants_group_admin_idx
  on public.conversation_participants (conversation_id, is_admin)
  where is_admin = true;
