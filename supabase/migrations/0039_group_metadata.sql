-- Optional group topic and description. Existing conversations remain unchanged.
alter table public.conversations
  add column if not exists group_topic text not null default '',
  add column if not exists group_description text not null default '';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversations_group_topic_length_check'
      and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations
      add constraint conversations_group_topic_length_check
      check (char_length(group_topic) <= 80);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversations_group_description_length_check'
      and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations
      add constraint conversations_group_description_length_check
      check (char_length(group_description) <= 500);
  end if;
end $$;
