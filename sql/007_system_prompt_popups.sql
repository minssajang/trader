-- trader 프로젝트: Claude 시스템 프롬프트 관리 + 팝업 관리 (fresh-season 이식)
-- Supabase SQL Editor에서 그대로 실행하세요. (006_doc_batch.sql 다음에 실행)

create table if not exists system_prompts (
  id text primary key default 'main',
  content text not null default '',
  updated_at timestamptz not null default now()
);
alter table system_prompts enable row level security;
insert into system_prompts (id, content, updated_at) values
  ('claude', '', now()),
  ('main', '', now()),
  ('main2', '', now()),
  ('month', '', now())
on conflict (id) do nothing;

create table if not exists popups (
  id text primary key,
  title text not null,
  content text not null,
  link_url text,
  link_label text default '자세히 보기',
  bg_color text default '#ffffff',
  text_color text default '#111827',
  expires_at date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
alter table popups enable row level security;
